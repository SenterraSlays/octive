// OCTIVE rankings API: a Cloudflare Worker (free plan) between the GitHub Pages site and Unity Gaming
// Services. It keeps the Unity service-account key secret and serves:
//   GET /leaderboard            the global PP ranking with each player's public card (JSON)
//   GET /avatar/<playerId>?v=…  a player's public avatar (JPG)
//   GET /releases/<file>         game updates from the R2 bucket bound as RELEASES (latest.json + builds)
//   GET /scores/<songId>/<chartId>, POST /scores/submit   leaderboards of OCTIVE Official charts
//   /support/... /stripe/webhook  supporter purchases (Stripe), status and looks; /social/<id>, /follow
//   POST /discord                Discord slash commands (/profile, /leaderboard, /online, /download, /link, /unlink)
//   /account/...                 website sign-in, profile editing, email linking and password resets
//                                (see "accounts" below; email needs BREVO_API_KEY + MAIL_FROM)
// Secrets (Worker → Settings → Variables and Secrets): UGS_KEY_ID, UGS_SECRET_KEY, UGS_PROJECT_ID,
// UGS_ENVIRONMENT_ID. Results are kept in memory (ranking 60 s, cards 3 min, avatars until they
// change) so the site stays fast and inside Unity's request limits; if Unity can't be reached the
// last ranking is served.
//
// Developers moderate from inside the game: their public "moderation" data (bans, forced names and
// pictures, badges) is read here too, so banned players disappear from the site as well.

const LEADERBOARD = "global-pp";
const TOP = 100;                   // players shown
const BOARD_TTL = 60_000;          // ranking refresh
const CARD_TTL = 3 * 60_000;       // public card + online status refresh
const CARD_FETCH_BUDGET = 40;      // cards fetched per request (Cloudflare free plan: 50 subrequests)
const ONLINE_MS = 5 * 60_000;
const PP_VERSION = 3;              // the game's PP formula (Performance.Version); older totals are listed after      // "online" when the game wrote its heartbeat this recently
const DEVELOPERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE"]; // same list as the game's PlayerRoles

let board = null, boardAt = 0, boardPromise = null;
const cards = new Map();           // playerId -> { card, seen, at }
const avatars = new Map();         // playerId:hash -> Uint8Array
let moderation = { bans: {}, overrides: {}, roles: {}, badges: {} };
const BADGE_ORDER = ["DEV", "MOD", "CREATOR", "CHARTER", "VIP", "TESTER"];
const SOCIAL_KEYS = ["youtube", "twitch", "tiktok", "x", "instagram", "bluesky", "discord", "website"];

/** Every badge of a player, most important first (DEV is built in; others come from the developers' list). */
/** The check beside a name: "official" (OCTIVE's own accounts), "verified" (known people) or null. */
function checkOf(id) {
  const granted = moderation.badges[id] || [];
  if (id === "o2quUJmLzZujIpPomajHJ7oW07aI" || granted.includes("OFFICIAL")) return "official";
  if (DEVELOPERS.includes(id) || granted.includes("VERIFIED")) return "verified";
  return null;
}

function badgesOf(id) {
  const list = DEVELOPERS.includes(id) ? ["DEV"] : [];
  const granted = moderation.badges[id] || (moderation.roles[id] ? [moderation.roles[id]] : []);
  for (const b of granted) if (typeof b === "string" && BADGE_ORDER.includes(b) && !list.includes(b)) list.push(b);
  return list.sort((a, b) => BADGE_ORDER.indexOf(a) - BADGE_ORDER.indexOf(b));
}

/** A content creator's links from their card: known platforms, short strings only (the site builds the URLs). */
function socialsOf(card) {
  const out = {};
  const s = card && typeof card.socials === "object" && card.socials ? card.socials : {};
  for (const k of SOCIAL_KEYS) if (typeof s[k] === "string" && s[k].length > 0 && s[k].length <= 200) out[k] = s[k];
  return out;
}

const stripTag = (n) => { if (!n) return "Player"; const i = n.lastIndexOf("#"); return i > 0 ? n.slice(0, i) : n; };

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(body, maxAge, status = 200) {
  return cors(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
  }));
}

function config(env) {
  for (const k of ["UGS_KEY_ID", "UGS_SECRET_KEY", "UGS_PROJECT_ID", "UGS_ENVIRONMENT_ID"])
    if (!env[k]) throw new Error(`The Worker secret ${k} is missing (Settings → Variables and Secrets).`);
  const scope = `projects/${env.UGS_PROJECT_ID}/environments/${env.UGS_ENVIRONMENT_ID}`;
  return {
    auth: "Basic " + btoa(`${env.UGS_KEY_ID}:${env.UGS_SECRET_KEY}`),
    scores: `https://services.api.unity.com/leaderboards/v1/${scope}/leaderboards/${LEADERBOARD}/scores`,
    save: `https://services.api.unity.com/cloud-save/v1/data/${scope}`,
  };
}

async function api(url, auth) {
  const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Unity returned ${res.status} for ${new URL(url).pathname}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Several public Cloud Save items of a player (values parsed when they are JSON). */
async function publicItems(cfg, playerId, keys) {
  const q = keys.map((k) => "keys=" + encodeURIComponent(k)).join("&");
  const body = await api(`${cfg.save}/players/${encodeURIComponent(playerId)}/public/items?${q}`, cfg.auth);
  const out = {};
  for (const it of body?.results ?? []) {
    let v = it.value;
    if (typeof v === "string" && it.key !== "avatar" && it.key !== "seen") { try { v = JSON.parse(v); } catch { /* keep the string */ } }
    out[it.key] = v;
  }
  return out;
}

async function loadModeration(cfg) {
  const merged = { bans: {}, overrides: {}, roles: {}, badges: {} };
  await Promise.all(DEVELOPERS.map(async (dev) => {
    try {
      const m = (await publicItems(cfg, dev, ["moderation"])).moderation;
      if (!m) return;
      Object.assign(merged.bans, m.bans || {});
      for (const [id, o] of Object.entries(m.overrides || {}))
        if (!merged.overrides[id] || new Date(o.at) > new Date(merged.overrides[id].at)) merged.overrides[id] = o;
      Object.assign(merged.roles, m.roles || {});
      Object.assign(merged.badges, m.badges || {});
    } catch { /* keep the previous lists */ }
  }));
  moderation = merged;
}

async function buildBoard(env) {
  const cfg = config(env);
  const page = await api(`${cfg.scores}?offset=0&limit=${TOP + 10}`, cfg.auth);
  if (!page) throw new Error(`Leaderboard "${LEADERBOARD}" not found: create it in the Unity dashboard.`);
  await loadModeration(cfg);
  const entries = (page.results ?? []).filter((e) => !moderation.bans[e.playerId] && !isOfficial(e.playerId)).slice(0, TOP);
  const now = Date.now();

  const stale = entries.map((e) => e.playerId)
    .filter((id) => !cards.has(id) || now - cards.get(id).at > CARD_TTL)
    .sort((a, b) => (cards.get(a)?.at ?? 0) - (cards.get(b)?.at ?? 0))
    .slice(0, CARD_FETCH_BUDGET);
  await Promise.all(stale.map(async (id) => {
    try {
      const items = await publicItems(cfg, id, ["card", "seen", "platform"]);
      cards.set(id, { card: items.card ?? null, seen: items.seen || "", platform: items.platform || "", at: now });
    } catch (e) { if (!cards.has(id)) cards.set(id, { card: null, seen: "", platform: "", at: 0 }); }
  }));
  const players = entries.map((e, i) => {
    const c = cards.get(e.playerId) || {};
    const card = c.card || {};
    let meta = {};
    try { meta = e.metadata ? JSON.parse(e.metadata) : {}; } catch { /* none */ }
    const ov = moderation.overrides[e.playerId] || {};
    const seen = c.seen ? Date.parse(c.seen) : 0;
    let avatarHash = card.avatar || "";
    if (ov.avatar === "default") avatarHash = "";
    else if (ov.avatar) avatarHash = "mod-" + Date.parse(ov.at);
    return {
      id: e.playerId,
      rank: i + 1,
      // a recalculated total on the card (PP rework) wins over an older leaderboard entry
      pp: Number(card.ppVersion) >= PP_VERSION && typeof card.pp === "number" ? Math.round(card.pp * 100) / 100 : Math.round(e.score * 100) / 100,
      name: ov.name || card.name || meta.n || stripTag(e.playerName),
      accuracy: card.accuracy ?? meta.a ?? 0,
      level: card.level ?? meta.l ?? 1,
      levelProgress: card.levelProgress ?? meta.lp ?? 0,
      totalScore: card.totalScore ?? meta.ts ?? 0,
      xp: card.xp ?? 0,
      playCount: card.playCount ?? meta.pc ?? 0,
      fullCombos: card.fullCombos ?? meta.fc ?? 0,
      maxCombo: card.maxCombo ?? 0,
      playTimeMs: card.playTimeMs ?? 0,
      bio: typeof card.bio === "string" ? card.bio : "",
      achievements: card.achievements && typeof card.achievements === "object" ? card.achievements : {},
      devFriend: !!card.devFriend,
      role: DEVELOPERS.includes(e.playerId) ? "DEV" : (badgesOf(e.playerId)[0] || moderation.roles[e.playerId] || null),
      badges: badgesOf(e.playerId), check: checkOf(e.playerId),
      socials: badgesOf(e.playerId).includes("CREATOR") ? socialsOf(card) : {},
      online: seen > 0 && now - seen < ONLINE_MS,
      lastSeen: seen > 0 ? new Date(seen).toISOString() : null,
      platform: c.platform || "",
      ppVersion: Number(card.ppVersion) || Number(meta.pv) || 2,
      status: seen > 0 && now - seen < ONLINE_MS ? platformStatus(c.platform) : null,
      avatarHash,
    };
  });
  // totals from before the PP rework (games older than 1.3.3) go after the recalculated ones
  players.sort((a, b) => ((b.ppVersion >= PP_VERSION) - (a.ppVersion >= PP_VERSION)) || b.pp - a.pp);
  players.forEach((p, i) => { p.rank = i + 1; });
  return { updated: new Date(now).toISOString(), leaderboard: LEADERBOARD, total: players.length, online: players.filter((p) => p.online).length, players };
}

// the official OCTIVE account: never ranked, can message anyone (and anyone can answer it), level 1000
const OFFICIAL_ID = "o2quUJmLzZujIpPomajHJ7oW07aI";
const isOfficial = (id) => id === OFFICIAL_ID;
/** How long each number of the official account's status line shows (everyone sees the same one at once). */
const OFFICIAL_ROTATE_MS = 12_000;

const verParts = (v) => String(v || "0").split(".").map((x) => parseInt(x, 10) || 0);
const verNewer = (a, b) => { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function countPrefix(env, prefix) {
  let n = 0, cursor;
  do { const list = await env.RELEASES.list({ prefix, cursor }); n += list.objects.length; cursor = list.truncated ? list.cursor : undefined; } while (cursor);
  return n;
}

let officialStats = null, officialStatsAt = 0;
/**
 * The official account's status: "Octive • v1.5.0 • 8 players online", the number changing every 12 seconds
 * (players online, registered users, Workshop creations, scores submitted, active supporters). Cached a minute.
 */
async function officialStatus(env) {
  if (officialStats && Date.now() - officialStatsAt < 60_000) return officialStats;
  const cfg = config(env);
  const [board, sup, web, items, inboxes, accounts, latest, card] = await Promise.all([
    leaderboard(env).catch(() => ({ players: [], total: 0 })),
    supporters(env).catch(() => ({})),
    webVisitors(env).catch(() => ({})),
    r2json(env, WS_DB, { items: [] }).catch(() => ({ items: [] })),
    countPrefix(env, "dm/inbox/").catch(() => 0),
    countPrefix(env, "accounts/").catch(() => 0),
    env.RELEASES.get("latest.json").then((o) => (o ? o.json() : null)).catch(() => null),
    publicItems(cfg, OFFICIAL_ID, ["card"]).then((x) => x.card || null).catch(() => null),
  ]);
  const now = Date.now();
  const online = new Set(board.players.filter((p) => p.online).map((p) => p.id));
  for (const [id, at] of Object.entries(web)) if (now - at < WEB_MS && !isOfficial(id)) online.add(id);
  // the newest of the released version and the one the official account last played on
  let version = latest?.version || "1.0.0";
  if (card?.version && verNewer(card.version, version)) version = card.version;
  const stats = [
    { key: "online", label: "players online", value: online.size },
    { key: "users", label: "registered users", value: Math.max(board.total || 0, inboxes, accounts) },
    { key: "workshop", label: "workshop creations", value: (items.items || []).length },
    { key: "scores", label: "scores submitted", value: board.players.reduce((n, p) => n + (p.playCount || 0), 0) },
    { key: "supporters", label: "active supporters", value: Object.values(sup).filter((x) => x.active).length },
  ];
  officialStats = { version, stats, rotateMs: OFFICIAL_ROTATE_MS };
  officialStatsAt = now;
  return officialStats;
}

/** The official account as a search result (it isn't on the ranking). */
async function officialProfile(env) {
  try {
    const p = await profileOf(env, OFFICIAL_ID);
    if (!p) return null;
    // the official account has every achievement (secret ones too)
    const all = {};
    for (const d of await achievementDefs()) all[d.id] = (p.achievements && p.achievements[d.id]) || "2026-11-12T00:00:00Z";
    return { ...p, rank: 0, official: true, achievements: all };
  } catch { return null; }
}

async function leaderboard(env) {
  if (board && Date.now() - boardAt < BOARD_TTL) return board;
  // one refresh at a time; other requests wait for it
  boardPromise ??= buildBoard(env)
    .then((b) => { board = b; boardAt = Date.now(); return b; })
    .catch((e) => { if (board) return { ...board, stale: true, error: e.message }; throw e; })
    .finally(() => { boardPromise = null; });
  return boardPromise;
}

function b64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function avatar(env, playerId, hash) {
  const key = `${playerId}:${hash || "latest"}`;
  let bytes = avatars.get(key);
  if (!bytes) {
    const ov = moderation.overrides[playerId];
    if (ov && ov.avatar === "default") return cors(new Response("No avatar", { status: 404 }));
    let b64 = ov && ov.avatar ? ov.avatar : (await publicItems(config(env), playerId, ["avatar"])).avatar;
    if (typeof b64 !== "string" || !b64.length) return cors(new Response("No avatar", { status: 404 }));
    bytes = b64Bytes(b64);
    if (avatars.size > 300) avatars.delete(avatars.keys().next().value);
    avatars.set(key, bytes);
  }
  return cors(new Response(bytes, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": hash ? "public, max-age=31536000, immutable" : "public, max-age=600" },
  }));
}

// ---------------------------------------------------------------- game updates
// The game checks /releases/latest.json and downloads the files it names from the R2 bucket bound as
// RELEASES (Worker → Settings → Bindings → R2 bucket, variable name RELEASES).
const RELEASE_TYPES = { json: "application/json; charset=utf-8", zip: "application/zip", apk: "application/vnd.android.package-archive", exe: "application/vnd.microsoft.portable-executable" };

async function release(env, key, request) {
  if (!env.RELEASES) return cors(new Response("Updates aren't set up: bind the R2 bucket as RELEASES.", { status: 503 }));
  const range = request.headers.get("Range");
  const obj = await env.RELEASES.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return cors(new Response("Not found", { status: 404 }));
  const ext = key.split(".").pop().toLowerCase();
  const h = new Headers();
  h.set("Content-Type", RELEASE_TYPES[ext] || "application/octet-stream");
  // latest.json changes with every release; the builds themselves are versioned and never change
  // (the installer keeps one name and is replaced when it changes)
  const mutable = key === "latest.json" || key === "history.json" || key === "OCTIVE-Installer.exe";
  h.set("Cache-Control", mutable ? "no-cache, max-age=0" : "public, max-age=31536000, immutable");
  if (ext !== "json") h.set("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
  h.set("ETag", obj.httpEtag);
  if (obj.range && range) {
    const off = obj.range.offset ?? 0, len = obj.range.length ?? obj.size - off;
    h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set("Content-Length", String(len));
    return cors(new Response(obj.body, { status: 206, headers: h }));
  }
  h.set("Content-Length", String(obj.size));
  return cors(new Response(obj.body, { headers: h }));
}

// ---------------------------------------------------------------- accounts (website sign-in)
// Players sign in on the site with their OCTIVE username and password (Unity Authentication). The site
// keeps the Unity id token and sends it as "Authorization: Bearer"; every request checks it with Unity.
// Profile edits are written to the player's public card at once, and to the private "webEdits" item so
// the game picks them up on its next start (newest edit wins).
// Email: a player links an address (confirmed with a 6-digit code); "Forgot password" mails a code to
// that address and sets the new password through Unity's admin API (service-account role needed:
// Player Authentication Admin, scopes player_auth.users.list / users.get / password.update).
// Mail is sent with Brevo (free plan; secret BREVO_API_KEY, variable MAIL_FROM = a sender address
// verified in Brevo, optional MAIL_FROM_NAME). Linked emails and codes live in R2 under accounts/.

const PLAYER_AUTH = "https://player-auth.services.api.unity.com";
const CODE_TTL = 15 * 60_000;
const CODE_TRIES = 5;
const tokens = new Map();          // id token -> { playerId, username, until }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.expose = true; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function reply(body, status = 200) {
  return cors(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  }));
}

async function bodyOf(request, max = 400_000) {
  if (request.method !== "POST") fail(405, "Use POST.");
  const text = await request.text();
  if (text.length > max) fail(413, "That's too big.");
  try { return text ? JSON.parse(text) : {}; } catch { fail(400, "The request wasn't valid JSON."); }
}

/** Unity's player-facing Authentication API. Returns the JSON body; throws a readable error. */
async function playerAuth(env, path, body, idToken) {
  const headers = { "Content-Type": "application/json", ProjectId: env.UGS_PROJECT_ID };
  if (idToken) headers.Authorization = "Bearer " + idToken;
  const res = await fetch(PLAYER_AUTH + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = data.detail || data.title || data.message || text.slice(0, 200) || `Unity returned ${res.status}`;
    const e = new HttpError(res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status, detail);
    e.unity = res.status;
    throw e;
  }
  return data;
}

/** Unity admin APIs (service account). */
async function admin(env, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: config(env).auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) {
    const e = new Error(`Unity returned ${res.status} for ${new URL(url).pathname}: ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

const identity = (env) => `https://services.api.unity.com/player-identity/v1/projects/${env.UGS_PROJECT_ID}`;

async function privateItems(env, playerId, keys) {
  const q = keys.map((k) => "keys=" + encodeURIComponent(k)).join("&");
  const body = await admin(env, "GET", `${config(env).save}/players/${encodeURIComponent(playerId)}/items?${q}`);
  const out = {};
  for (const it of body?.results ?? []) {
    let v = it.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* keep */ } }
    out[it.key] = v;
  }
  return out;
}

/**
 * Saves one Cloud Save item as the signed-in player (their own token, like the game does), so the
 * service account only needs read access.
 */
async function saveAsPlayer(env, token, playerId, key, value, isPublic) {
  const url = `https://cloud-save.services.api.unity.com/v1/data/projects/${env.UGS_PROJECT_ID}/players/${encodeURIComponent(playerId)}/${isPublic ? "public/" : ""}items`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) fail(401, "Your sign-in ran out. Sign in again.");
    const e = new Error(`Unity returned ${res.status} saving ${key}: ${text.slice(0, 200)}`);
    e.status = 502;
    throw e;
  }
}

async function saveItem(env, playerId, key, value, isPublic) {
  await admin(env, "POST", `${config(env).save}/players/${encodeURIComponent(playerId)}/${isPublic ? "public/" : ""}items`, { key, value });
}

/** The signed-in player behind the request's Bearer token (checked with Unity, cached until it expires). */
async function signedIn(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) fail(401, "Sign in first.");
  const c = tokens.get(token);
  if (c && c.until > Date.now()) return c;
  let payload;
  try { payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { fail(401, "Your sign-in isn't valid. Sign in again."); }
  if (!payload.sub || (payload.exp && payload.exp * 1000 < Date.now())) fail(401, "Your sign-in ran out. Sign in again.");
  let user;
  try { user = await playerAuth(env, `/v1/users/${encodeURIComponent(payload.sub)}`, undefined, token); }
  catch (e) { if (e.unity === 401 || e.unity === 403 || e.unity === 404) fail(401, "Your sign-in ran out. Sign in again."); throw e; }
  const who = { playerId: payload.sub, username: user.username || user.usernamePasswordLoginMetadata?.username || "", until: Math.min((payload.exp || 0) * 1000, Date.now() + 30 * 60_000) };
  if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
  tokens.set(token, who);
  return who;
}

// ---- password and email rules (the same as the game's)

function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 8 || p.length > 30) return "The password needs 8–30 characters.";
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p))
    return "The password needs an upper case letter, a lower case letter, a number and a symbol.";
  return null;
}

const EMAIL_RE = /^[^\s@<>()"',;:\\]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const maskEmail = (e) => { const [u, d] = e.split("@"); return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d; };

async function sha256Hex(text) {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}
const codeHash = (env, playerId, purpose, code) => sha256Hex(`${purpose}:${playerId}:${code}:${env.UGS_SECRET_KEY}`);

// ---- per-player account record in R2 (linked email, pending codes, send history)

async function record(env, playerId) {
  if (!env.RELEASES) return {};
  const o = await env.RELEASES.get(`accounts/${playerId}.json`);
  if (!o) return {};
  try { return await o.json(); } catch { return {}; }
}
async function saveRecord(env, playerId, rec) {
  await env.RELEASES.put(`accounts/${playerId}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
}

function allowSend(rec) {
  const now = Date.now();
  rec.sends = (rec.sends || []).filter((t) => now - t < 24 * 3600_000);
  if (rec.sends.length && now - rec.sends[rec.sends.length - 1] < 60_000) fail(429, "A code was just sent. Wait a minute before asking for another.");
  if (rec.sends.length >= 8) fail(429, "Too many codes today. Try again tomorrow.");
  rec.sends.push(now);
}

async function sendMail(env, to, subject, text) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) fail(503, "Email isn't set up on the OCTIVE server yet. Ask the developer.");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;background:#0b0d14;color:#eef0f8;padding:28px;border-radius:14px;max-width:520px">
<div style="font-weight:800;letter-spacing:.3em;font-size:18px;color:#8b7bff">OCTIVE</div>
${text.split("\n\n").map((p) => `<p style="font-size:15px;line-height:1.5;margin:14px 0">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\b(\d{6})\b/, '<b style="font-size:28px;letter-spacing:.25em;color:#4fd6e8">$1</b>')}</p>`).join("")}
</div>`;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "OCTIVE" }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
  });
  if (!res.ok) fail(502, "The email couldn't be sent: " + (await res.text()).slice(0, 200));
}

// ---- social links (the same rules as the game's SocialLinks)

const SOCIAL_RULES = {
  youtube: "https://www.youtube.com/@{0}", twitch: "https://www.twitch.tv/{0}", tiktok: "https://www.tiktok.com/@{0}",
  x: "https://x.com/{0}", instagram: "https://www.instagram.com/{0}", bluesky: "https://bsky.app/profile/{0}", discord: null, website: null,
};
function socialOk(id, value) {
  if (!(id in SOCIAL_RULES) || typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > 200) return false;
  const link = (s) => { try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname; } catch { return false; } };
  if (/^https?:\/\//i.test(v)) return link(v);
  if (SOCIAL_RULES[id] === null) return v.includes(".") && !v.includes(" ") && link("https://" + v);
  return /^[A-Za-z0-9._-]{1,60}$/.test(v.replace(/^@+/, ""));
}

// ---- the account routes

async function me(env, who) {
  const cfg = config(env);
  if (Date.now() - boardAt > BOARD_TTL) { try { await loadModeration(cfg); } catch { /* keep the last lists */ } }
  const [pub, priv, rec] = await Promise.all([
    publicItems(cfg, who.playerId, ["card"]),
    privateItems(env, who.playerId, ["account"]),
    record(env, who.playerId),
  ]);
  const card = pub.card || null;
  const ov = moderation.overrides[who.playerId] || {};
  const badges = badgesOf(who.playerId);
  return {
    playerId: who.playerId,
    username: who.username,
    name: ov.name || card?.name || who.username,
    hasCard: !!card,
    check: checkOf(who.playerId),
    card: card ? {
      pp: card.pp ?? 0, accuracy: card.accuracy ?? 0, level: card.level ?? 1, levelProgress: card.levelProgress ?? 0,
      totalScore: card.totalScore ?? 0, xp: card.xp ?? 0, playCount: card.playCount ?? 0, fullCombos: card.fullCombos ?? 0,
      maxCombo: card.maxCombo ?? 0, playTimeMs: card.playTimeMs ?? 0, rank: card.rank ?? 0, version: card.version || "",
    } : null,
    bio: typeof card?.bio === "string" ? card.bio : "",
    socials: socialsOf(card),
    avatarHash: ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : (card?.avatar || ""),
    avatarLocked: !!ov.avatar,
    nameLocked: !!ov.name,
    badges,
    creator: badges.includes("CREATOR"),
    banned: !!moderation.bans[who.playerId],
    nameChangedAt: priv.account?.nameChangedAt || null,
    email: rec.email ? rec.email : null,
    emailVerified: !!rec.verified,
    pendingEmail: rec.pending && rec.pending.exp > Date.now() ? rec.pending.email : null,
    discord: rec.discord ? { name: rec.discord.name || "", at: rec.discord.at || null } : null,
    supporter: supportStatus(await r2json(env, `supporters/${who.playerId}.json`, null), who.playerId, await r2json(env, `boosters/${who.playerId}.json`, null)),
    gifts: await pendingGifts(env, who.playerId),
    looks: await r2json(env, `looks/${who.playerId}.json`, {}),
  };
}

function tokenReply(t) {
  return { token: t.idToken, sessionToken: t.sessionToken, playerId: t.userId || t.user?.id, expiresIn: t.expiresIn || 3600 };
}

async function account(request, env, route) {
  if (!env.UGS_PROJECT_ID) fail(503, "The server isn't set up.");
  switch (route) {
    case "sign-in": {
      const b = await bodyOf(request);
      const username = String(b.username || "").trim().toLowerCase();
      if (!username || !b.password) fail(400, "Type your username and password.");
      let t;
      try { t = await playerAuth(env, "/v1/authentication/usernamepassword/sign-in", { username, password: String(b.password) }); }
      catch (e) { if (e.unity === 400 || e.unity === 401 || e.unity === 404) fail(401, "Wrong username or password."); throw e; }
      const out = tokenReply(t);
      tokens.set(out.token, { playerId: out.playerId, username, until: Date.now() + Math.min(out.expiresIn * 1000, 30 * 60_000) });
      return reply({ ...out, me: await me(env, { playerId: out.playerId, username }) });
    }
    case "refresh": {
      const b = await bodyOf(request);
      if (!b.sessionToken) fail(400, "No session.");
      let t;
      try { t = await playerAuth(env, "/v1/authentication/session-token", { sessionToken: String(b.sessionToken) }); }
      catch (e) { if (e.unity >= 400 && e.unity < 500 && e.unity !== 429) fail(401, "Your sign-in ran out. Sign in again."); throw e; }
      return reply(tokenReply(t));
    }
    case "me": {
      const who = await signedIn(request, env);
      return reply(await me(env, who));
    }
    case "seen": {
      // the website, signed in and open: "Viewing Website" in the ranking for a few minutes
      const who = await signedIn(request, env);
      await env.RELEASES.put(`webseen/${who.playerId}`, "1");
      return reply({ ok: true });
    }
    case "profile": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const cfg = config(env);
      await loadModeration(cfg);
      if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
      const card = (await publicItems(cfg, who.playerId, ["card"])).card;
      if (!card) fail(409, "Play a chart in the game while signed in first, so your profile exists online.");
      const now = new Date().toISOString();
      const edits = (await privateItems(env, who.playerId, ["webEdits"])).webEdits || {};
      if (b.bio !== undefined) {
        const bio = String(b.bio).replace(/\r\n/g, "\n");
        if (bio.length > 400) fail(400, "The bio can be at most 400 characters.");
        if (bio.split("\n").length > 8) fail(400, "The bio can have at most 8 lines.");
        card.bio = bio; edits.bio = bio; edits.bioAt = now;
      }
      if (b.socials !== undefined) {
        if (!badgesOf(who.playerId).includes("CREATOR")) fail(403, "Socials are for content creators.");
        const clean = {};
        for (const [k, v] of Object.entries(b.socials || {})) {
          if (typeof v !== "string" || !v.trim()) continue;
          if (!socialOk(k, v)) fail(400, `Check your ${k} link (a handle like @name, or a full https:// link).`);
          clean[k] = v.trim();
        }
        card.socials = clean; edits.socials = clean; edits.socialsAt = now;
      }
      let small = null;
      if (b.avatar !== undefined) {
        if (moderation.overrides[who.playerId]?.avatar) fail(403, "A developer set your picture; it can't be changed.");
        const full = String(b.avatar || ""), sm = String(b.avatarSmall || "");
        if (!/^[A-Za-z0-9+/=]{100,300000}$/.test(full) || !/^[A-Za-z0-9+/=]{100,120000}$/.test(sm)) fail(400, "That picture couldn't be used.");
        const bytes = b64Bytes(full);
        if (!(bytes[0] === 0xff && bytes[1] === 0xd8) && !(bytes[0] === 0x89 && bytes[1] === 0x50)) fail(400, "Pictures must be JPG or PNG.");
        card.avatar = (await sha256Hex(bytes)).slice(0, 16);
        edits.avatar = full; edits.avatarAt = now;
        small = sm;
      }
      edits.at = now;
      const token = request.headers.get("Authorization").slice(7).trim();
      await saveAsPlayer(env, token, who.playerId, "webEdits", edits, false);
      await saveAsPlayer(env, token, who.playerId, "card", card, true);
      if (small) await saveAsPlayer(env, token, who.playerId, "avatar", small, true);
      cards.delete(who.playerId); boardAt = 0;
      return reply(await me(env, who));
    }
    case "password": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const problem = passwordProblem(b.newPassword);
      if (problem) fail(400, problem);
      const token = request.headers.get("Authorization").slice(7).trim();
      try { await playerAuth(env, "/v1/authentication/usernamepassword/update-password", { password: String(b.password || ""), newPassword: b.newPassword }, token); }
      catch (e) { if (e.unity === 400 || e.unity === 401) fail(400, "Your current password isn't right."); throw e; }
      tokens.delete(token);
      return reply({ ok: true });
    }
    case "email": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const email = String(b.email || "").trim();
      if (email.length > 254 || !EMAIL_RE.test(email)) fail(400, "That doesn't look like an email address.");
      const rec = await record(env, who.playerId);
      allowSend(rec);
      const code = newCode();
      rec.pending = { email, hash: await codeHash(env, who.playerId, "email", code), exp: Date.now() + CODE_TTL, tries: 0 };
      await sendMail(env, email, `OCTIVE code: ${code}`,
        `Hi ${who.username}! Use this code to link this email to your OCTIVE account:\n\n${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.`);
      await saveRecord(env, who.playerId, rec);
      return reply({ ok: true, pendingEmail: email });
    }
    case "email/verify": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      const p = rec.pending;
      if (!p || p.exp < Date.now()) fail(400, "That code ran out. Ask for a new one.");
      if (p.tries >= CODE_TRIES) fail(429, "Too many wrong codes. Ask for a new one.");
      if (await codeHash(env, who.playerId, "email", String(b.code || "").trim()) !== p.hash) {
        p.tries++; await saveRecord(env, who.playerId, rec);
        fail(400, `That code isn't right (${CODE_TRIES - p.tries} tries left).`);
      }
      rec.email = p.email; rec.verified = true; rec.verifiedAt = new Date().toISOString(); delete rec.pending;
      await saveRecord(env, who.playerId, rec);
      return reply(await me(env, who));
    }
    case "email/remove": {
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      delete rec.email; delete rec.verified; delete rec.pending; delete rec.reset;
      await saveRecord(env, who.playerId, rec);
      return reply(await me(env, who));
    }
    case "discord/code": {
      // a one-time code for /link in Discord (10 minutes)
      await bodyOf(request);
      const who = await signedIn(request, env);
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const code = [...bytes].map((b) => abc[b % abc.length]).join("");
      const exp = Date.now() + 10 * 60_000;
      await env.RELEASES.put(`discord-codes/${code}.json`, JSON.stringify({ playerId: who.playerId, exp }), { httpMetadata: { contentType: "application/json" } });
      return reply({ code, exp });
    }
    case "discord/status": {
      // the game's Discord settings: who's linked and the Discord options
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      const p = rec.discordPrefs || {};
      return reply({ linked: rec.discord?.id ? { name: rec.discord.name || "", at: rec.discord.at } : null, prefs: { dmAlerts: !!p.dmAlerts, updates: !!p.updates, show: !!p.show } });
    }
    case "discord/prefs": {
      // the Discord options (linked accounts only): DMs from the bot, the updates role, Discord on the profile
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      if (!rec.discord?.id) fail(400, "Link your Discord first.");
      const p = rec.discordPrefs || {};
      if ("dmAlerts" in b) p.dmAlerts = !!b.dmAlerts;
      if ("show" in b) p.show = !!b.show;
      let note = null;
      if ("updates" in b && env.DISCORD_GUILD_ID && env.DISCORD_BOT_TOKEN) {
        // the @Octive Updates role: pinged when a new version is announced
        const roleId = env.DISCORD_UPDATES_ROLE_ID || "1569905255766822953";
        const res = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${rec.discord.id}/roles/${roleId}`, {
          method: b.updates ? "PUT" : "DELETE", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "X-Audit-Log-Reason": "OCTIVE settings", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" },
        });
        if (res.status === 404) fail(400, "Join the OCTIVE Discord server first, then switch this on again.");
        if (!res.ok) fail(502, "Discord didn't let the bot change your role right now.");
        p.updates = !!b.updates;
        note = b.updates ? "You'll be pinged for OCTIVE updates." : "No more update pings.";
      }
      rec.discordPrefs = p;
      await saveRecord(env, who.playerId, rec);
      return reply({ ok: true, prefs: { dmAlerts: !!p.dmAlerts, updates: !!p.updates, show: !!p.show }, note });
    }
    case "discord/unlink": {
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      if (rec.discord?.id) await syncSupporterRole(env, who.playerId, rec.discord.id, undefined, true);
      if (rec.discord?.id) await env.RELEASES.delete(`discord/${rec.discord.id}.json`);
      delete rec.discord;
      await saveRecord(env, who.playerId, rec);
      return reply(await me(env, who));
    }
    case "reset/start": {
      const b = await bodyOf(request);
      const username = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._@-]{3,20}$/.test(username)) fail(400, "Type your OCTIVE username.");
      const generic = { ok: true, message: "If that account has a confirmed email, a code is on its way. Check your inbox (and spam)." };
      const id = await findPlayer(env, username);
      if (!id) return reply(generic);
      const rec = await record(env, id);
      if (!rec.email || !rec.verified) return reply(generic);
      allowSend(rec);
      const code = newCode();
      rec.reset = { hash: await codeHash(env, id, "reset", code), exp: Date.now() + CODE_TTL, tries: 0 };
      await sendMail(env, rec.email, `OCTIVE password reset code: ${code}`,
        `Someone (hopefully you) asked to reset the password of the OCTIVE account "${username}". Your code:\n\n${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email: your password stays the same.`);
      await saveRecord(env, id, rec);
      return reply(generic);
    }
    case "reset/finish": {
      const b = await bodyOf(request);
      const username = String(b.username || "").trim().toLowerCase();
      const problem = passwordProblem(b.newPassword);
      if (problem) fail(400, problem);
      const id = /^[a-z0-9._@-]{3,20}$/.test(username) ? await findPlayer(env, username) : null;
      const rec = id ? await record(env, id) : {};
      const r = rec.reset;
      if (!r || r.exp < Date.now()) fail(400, "That code isn't right or ran out. Ask for a new one.");
      if (r.tries >= CODE_TRIES) fail(429, "Too many wrong codes. Ask for a new one.");
      if (await codeHash(env, id, "reset", String(b.code || "").trim()) !== r.hash) {
        r.tries++; await saveRecord(env, id, rec);
        fail(400, `That code isn't right (${CODE_TRIES - r.tries} tries left).`);
      }
      try { await admin(env, "POST", `${identity(env)}/users/${encodeURIComponent(id)}/change-password`, { newPassword: b.newPassword }); }
      catch (e) {
        if (e.status === 401 || e.status === 403) fail(503, "Password resets aren't switched on yet (the server's Unity service account needs the Player Authentication admin role).");
        if (e.status === 400) fail(400, "Unity didn't accept that password: " + e.message.replace(/^.*?: /, "").slice(0, 160));
        throw e;
      }
      delete rec.reset;
      await saveRecord(env, id, rec);
      return reply({ ok: true, message: "Your password was changed. Sign in with the new one." });
    }
    default:
      fail(404, "Not found");
  }
}

/** A player's id from their username (Unity admin API). */
async function findPlayer(env, username) {
  let list;
  try { list = await admin(env, "GET", `${identity(env)}/users?username=${encodeURIComponent(username)}&limit=5`); }
  catch (e) {
    if (e.status === 401 || e.status === 403) fail(503, "Password resets aren't switched on yet (the server's Unity service account needs the Player Authentication admin role).");
    throw e;
  }
  for (const u of list?.results ?? []) {
    const p = await admin(env, "GET", `${identity(env)}/users/${encodeURIComponent(u.id)}`);
    const name = p?.usernamePasswordLoginMetadata?.username || p?.username;
    if (name && name.toLowerCase() === username) return u.id;
  }
  return null;
}

// ---------------------------------------------------------------- browser version
// The web build lives in R2 under web/<version>/ (Build/… and StreamingAssets/…, uploaded by
// Tools/publish_release.py). Unity's Brotli files are sent as they are with Content-Encoding: br, so the
// browser decompresses them; the page on GitHub Pages (play/) loads them from here.
const WEB_TYPES = { js: "application/javascript", wasm: "application/wasm", data: "application/octet-stream", json: "application/json", txt: "text/plain; charset=utf-8", oct: "application/octet-stream" };

async function webFile(env, version, path, request) {
  if (!env.RELEASES) return cors(new Response("Not set up", { status: 503 }));
  const obj = await env.RELEASES.get(`web/${version}/${path}`);
  if (!obj) return cors(new Response("Not found", { status: 404 }));
  const h = new Headers();
  let name = path.split("/").pop();
  const br = name.endsWith(".br");
  if (br) { name = name.slice(0, -3); h.set("Content-Encoding", "br"); }
  const ext = name.split(".").pop().toLowerCase();
  h.set("Content-Type", WEB_TYPES[ext] || "application/octet-stream");
  h.set("Cache-Control", "public, max-age=31536000, immutable"); // every version has its own folder
  h.set("ETag", obj.httpEtag);
  // CORS headers set here: re-wrapping the response (cors()) would drop encodeBody and compress it twice
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers: h, encodeBody: br ? "manual" : "automatic" });
}

// ---------------------------------------------------------------- Discord app (slash commands)
// Discord sends slash commands here (Developer Portal → Interactions Endpoint URL = <worker>/discord).
// Every request is checked against the application's public key. Commands: /profile, /leaderboard,
// /online, /download, /link, /unlink (registered by Tools/discord_commands.py).
// Linking: the website's Account page makes a one-time code; /link code:<code> ties the Discord user to
// that OCTIVE account (R2: discord/<discordId>.json and the account record's "discord").

const DISCORD_APP_ID = "1569883934827745330";
const DISCORD_PUBLIC_KEY = "57eae870ba2f5c8833c8c2df8ee0552e5a2d034eb3409d2a747545921c491e6b";
const SITE = "https://senterraslays.github.io/octive/";
const WORKER_BASE = "https://octive-rankings-api.lunalazum18.workers.dev";
const EPHEMERAL = 64;
const BADGE_EMOJI = { DEV: "🛠️ DEV", MOD: "🛡️ MOD", CREATOR: "🎬 CREATOR", CHARTER: "🎼 CHARTER", VIP: "⭐ VIP", TESTER: "🧪 TESTER" };

function hexBytes(hex) { const b = new Uint8Array(hex.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16); return b; }

async function discordVerified(request, body) {
  const sig = request.headers.get("X-Signature-Ed25519"), ts = request.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexBytes(DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexBytes(sig), new TextEncoder().encode(ts + body));
  } catch { return false; }
}

const dReply = (data) => new Response(JSON.stringify({ type: 4, data }), { headers: { "Content-Type": "application/json" } });
const fmtN = (n, d = 0) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Gives the visible letters of a coloured name the capitals of the real name ("#ff0000senterra" -> "#ff0000Senterra"). */
function fixNameCase(style, name) {
  const code = /##|#\[[0-9a-fA-F]{6}\]|#[0-9a-fA-F]{6}|#[0-9a-fA-FlonmkgrLONMKGR]/y;
  let out = "", k = 0;
  for (let i = 0; i < style.length;) {
    code.lastIndex = i;
    const m = code.exec(style);
    if (m) {
      if (m[0] === "##") { out += "##"; k++; } else out += m[0];
      i += m[0].length;
      continue;
    }
    out += k < name.length && style[i].toLowerCase() === name[k].toLowerCase() ? name[k] : style[i];
    k++; i++;
  }
  return out;
}
const stripBio = (s) => String(s || "").replace(/#\[[0-9a-fA-F]{6}\]|#[0-9a-fA-F]{6}|#[0-9a-fA-FlonmkgrLONMKGR]/g, "").replace(/##/g, "#").trim();

function playTimeText(ms) { const m = Math.floor((ms || 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; }
function agoText(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 120) return "just now"; if (s < 3600) return Math.floor(s / 60) + " minutes ago";
  if (s < 86400) return Math.floor(s / 3600) + " hours ago"; return Math.floor(s / 86400) + " days ago";
}

/** A player's profile as the site shows it: from the ranking when they're in it, else their public card. */
async function profileOf(env, playerId) {
  let board = null;
  try { board = await leaderboard(env); } catch { /* card only */ }
  const ranked = board?.players?.find((p) => p.id === playerId);
  if (ranked) return ranked;
  const items = await publicItems(config(env), playerId, ["card", "seen", "platform"]);
  const card = items.card;
  if (!card || moderation.bans[playerId]) return null;
  const seen = items.seen ? Date.parse(items.seen) : 0;
  const ov = moderation.overrides[playerId] || {};
  return {
    id: playerId, rank: card.rank || 0, pp: card.pp || 0, name: ov.name || card.name || "Player", accuracy: card.accuracy || 0,
    level: isOfficial(playerId) ? 1000 : card.level || 1, levelProgress: isOfficial(playerId) ? 1 : card.levelProgress || 0, playCount: card.playCount || 0, maxCombo: card.maxCombo || 0,
    fullCombos: card.fullCombos || 0, playTimeMs: card.playTimeMs || 0, totalScore: card.totalScore || 0, bio: card.bio || "", achievements: card.achievements || {},
    badges: badgesOf(playerId), check: checkOf(playerId), online: isOfficial(playerId) || (seen > 0 && Date.now() - seen < ONLINE_MS), lastSeen: seen ? new Date(seen).toISOString() : null,
    platform: items.platform || "", status: isOfficial(playerId) ? "official" : seen > 0 && Date.now() - seen < ONLINE_MS ? platformStatus(items.platform) : null,
    avatarHash: ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : (card.avatar || ""),
  };
}

// ---------------------------------------------------------------- the commands' look
const C_ACCENT = 0x8B7BFF, C_PINK = 0xFF6FAE, C_GREEN = 0x3DDC84, C_GOLD = 0xF2C14E, C_DEV = 0xB69BFF, C_CREATOR = 0xFF2133;
const FOOTER = { text: "OCTIVE · senterraslays.github.io/octive" };
const clean = (s) => String(s || "").replace(/[*_`~|>\\]/g, "").slice(0, 60) || "Player";
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const bar = (f, n = 12) => { const k = Math.max(0, Math.min(n, Math.round((f || 0) * n))); return "█".repeat(k) + "░".repeat(n - k); };
const linkButton = (label, url, emoji) => ({ type: 2, style: 5, label, url, ...(emoji ? { emoji: { name: emoji } } : {}) });
const row = (...buttons) => ({ type: 1, components: buttons.filter(Boolean).slice(0, 5) });
const GIFTER_TIERS = [[36, "Star Gifter", "🌟"], [24, "Platinum Gifter", "💎"], [12, "Gold Gifter", "🥇"], [6, "Silver Gifter", "🥈"], [3, "Bronze Gifter", "🥉"], [1, "Gift Starter", "🎁"]];
const gifterTier = (m) => GIFTER_TIERS.find(([n]) => m >= n) || null;
const supNo = (n) => "#" + String(n).padStart(4, "0");

function discordStatus(p) {
  if (!p.online) return p.lastSeen ? `Last online <t:${unix(p.lastSeen)}:R>` : "Offline";
  const dev = /-dev$/.test(p.status || "");
  return "🟢 " + (STATUS_TEXT[(p.status || "").replace(/-dev$/, "")] || "Online") + (dev ? " · DEV build" : "");
}

/** The supporter line for a profile: tier, Supporter number, gifting. */
function supporterLine(p, st) {
  const parts = [];
  if (st?.active) parts.push(st.lifetime ? "💖 Lifetime supporter" : st.booster ? "💖 Supporter · Server Booster" : `💖 Supporter (${fmtN(st.months)} month${st.months === 1 ? "" : "s"})`);
  else if (st?.days > 0) parts.push("🤍 Former supporter");
  if (p.supporterNo != null) parts.push(`Supporter ${supNo(p.supporterNo)}`);
  const g = gifterTier(p.gifted || 0);
  if (g) parts.push(`${g[2]} ${g[1]} · ${fmtN(p.gifted)} month${p.gifted === 1 ? "" : "s"} gifted`);
  return parts.join("  ·  ");
}

let achCache = null, achAt = 0;
async function achievementDefs() {
  if (achCache && Date.now() - achAt < 3600_000) return achCache;
  try { const r = await fetch(SITE + "data/achievements.json"); if (r.ok) { achCache = await r.json(); achAt = Date.now(); } } catch { /* keep the old */ }
  return achCache || [];
}

function profileEmbed(p, st, achTotal) {
  const badges = (p.badges || []).map((b) => BADGE_EMOJI[b] || b).join("  ");
  const color = (p.badges || []).includes("DEV") ? C_DEV : st?.active ? C_PINK : (p.badges || []).includes("CREATOR") ? C_CREATOR : C_ACCENT;
  const bio = stripBio(p.bio);
  const sup = supporterLine(p, st);
  const got = Object.keys(p.achievements || {}).length;
  const e = {
    author: { name: p.rank ? `#${fmtN(p.rank)} on the OCTIVE ranking` : "OCTIVE player" },
    title: clean(p.name),
    url: `${SITE}#/u/${encodeURIComponent(p.id)}`,
    color,
    description: [badges || null, sup || null, bio ? `> ${bio.slice(0, 280).replace(/\n/g, "\n> ")}` : null].filter(Boolean).join("\n") || undefined,
    fields: [
      { name: "Performance", value: `**${fmtN(p.pp)} PR**`, inline: true },
      { name: "Accuracy", value: `${fmtN(p.accuracy, 2)}%`, inline: true },
      { name: "Level", value: `Lv${p.level}`, inline: true },
      { name: `Progress to Lv${(p.level || 1) + 1}`, value: `\`${bar(p.levelProgress)}\` ${Math.round((p.levelProgress || 0) * 100)}%`, inline: false },
      { name: "Plays", value: fmtN(p.playCount), inline: true },
      { name: "Full combos", value: fmtN(p.fullCombos), inline: true },
      { name: "Max combo", value: p.maxCombo ? `${fmtN(p.maxCombo)}x` : "—", inline: true },
      { name: "Play time", value: playTimeText(p.playTimeMs), inline: true },
      { name: "Achievements", value: achTotal ? `${got} / ${achTotal}` : fmtN(got), inline: true },
      { name: "Status", value: discordStatus(p), inline: true },
    ],
    footer: FOOTER,
  };
  if (st?.gif) e.thumbnail = { url: `${WORKER_BASE}/looks/gif/${encodeURIComponent(p.id)}?v=${encodeURIComponent(st.gif)}` };
  else if (p.avatarHash) e.thumbnail = { url: `${WORKER_BASE}/avatar/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.avatarHash)}` };
  if (st?.active && st.banner) e.image = { url: `${WORKER_BASE}/looks/banner/${encodeURIComponent(p.id)}?v=${encodeURIComponent(st.banner)}` };
  return e;
}

async function linkedPlayer(env, discordId) {
  if (!env.RELEASES) return null;
  const o = await env.RELEASES.get(`discord/${discordId}.json`);
  if (!o) return null;
  try { return (await o.json()).playerId || null; } catch { return null; }
}

const opt = (data, name) => (data.options || []).find((o) => o.name === name)?.value;
const notLinked = (who, self) => ({
  content: self
    ? `Your Discord isn't linked to an OCTIVE account yet. Sign in at ${SITE}#/account?tab=preferences, press **Link Discord**, then use \`/link\` with the code.`
    : `<@${who}> hasn't linked an OCTIVE account.`,
  flags: EPHEMERAL, allowed_mentions: { parse: [] },
});

/** A ranked player by name: exact first, then the start of a name, then anywhere in it. */
async function findByName(env, name) {
  const board = await leaderboard(env);
  const q = String(name).trim().toLowerCase();
  const byId = board.players.find((x) => x.id === name);
  if (byId) return byId;
  return board.players.find((x) => (x.name || "").toLowerCase() === q)
    || board.players.find((x) => (x.name || "").toLowerCase().startsWith(q))
    || board.players.find((x) => (x.name || "").toLowerCase().includes(q)) || null;
}

/**
 * Who a command is about: a player name (option), a Discord user (option) who linked their account, or
 * the caller. Returns { id } or { error: reply }.
 */
async function target(env, data, user, nameOpt = "player", userOpt = "user") {
  const name = opt(data, nameOpt), mention = opt(data, userOpt);
  if (name) {
    const p = await findByName(env, name);
    if (!p) return { error: { content: `Nobody called **${clean(name)}** is on the ranking. Unranked players can be found once they've linked Discord: \`/profile user:@them\`.`, flags: EPHEMERAL } };
    return { id: p.id };
  }
  const who = mention || user.id;
  const id = await linkedPlayer(env, who);
  if (!id) return { error: notLinked(who, who === user.id) };
  return { id };
}

async function withSupport(env, p) {
  let st = null;
  try { st = (await supporters(env))[p.id] || null; } catch { /* none */ }
  const gi = giftInfo(p.id);
  return { p: { ...p, gifted: p.gifted ?? gi.gifted, supporterNo: p.supporterNo ?? gi.supporterNo }, st };
}

// ---------------------------------------------------------------- leaderboard pages (with buttons)
const LB_PAGES = 10;
async function leaderboardMessage(env, page, callerId) {
  const board = await leaderboard(env);
  const pages = Math.max(1, Math.min(LB_PAGES, Math.ceil(board.players.length / 10)));
  page = Math.max(1, Math.min(pages, page));
  const rows = board.players.slice((page - 1) * 10, page * 10);
  const mine = callerId ? await linkedPlayer(env, callerId) : null;
  const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `\`#${String(r).padStart(2, " ")}\``);
  const lines = rows.map((p) => {
    const me = p.id === mine;
    const name = me ? `__**${clean(p.name)}**__` : `**${clean(p.name)}**`;
    return `${medal(p.rank)} ${name}${p.online ? " 🟢" : ""}\n　 ${fmtN(p.pp)} PR · ${fmtN(p.accuracy, 2)}% · Lv${p.level}`;
  });
  const meRow = mine && !rows.some((p) => p.id === mine) ? board.players.find((p) => p.id === mine) : null;
  if (meRow) lines.push(`\n**You:** #${fmtN(meRow.rank)} · ${fmtN(meRow.pp)} PR · ${fmtN(meRow.accuracy, 2)}%`);
  return {
    embeds: [{
      title: "🏆 OCTIVE Performance Ranking", url: `${SITE}#/rankings`, color: C_ACCENT,
      description: lines.join("\n") || "No ranked players yet.",
      footer: { text: `Page ${page} of ${pages} · ${fmtN(board.total)} ranked · ${fmtN(board.online)} online` },
    }],
    components: [row(
      { type: 2, style: 2, label: "First", custom_id: "lb:1", disabled: page <= 1, emoji: { name: "⏮️" } },
      { type: 2, style: 1, label: "Previous", custom_id: `lb:${page - 1}`, disabled: page <= 1 },
      { type: 2, style: 1, label: "Next", custom_id: `lb:${page + 1}`, disabled: page >= pages },
      linkButton("Full ranking", `${SITE}#/rankings`),
    )],
    allowed_mentions: { parse: [] },
  };
}

const HELP = [
  ["/profile", "A player's profile: rank, PR, accuracy, level, supporter status (yours when you leave it empty)"],
  ["/compare", "Two players side by side"],
  ["/leaderboard", "The performance ranking, with page buttons"],
  ["/online", "Who's playing OCTIVE right now"],
  ["/achievements", "A player's achievements, by group"],
  ["/supporter", "Supporter status, Supporter number and gifter badge"],
  ["/stats", "OCTIVE in numbers"],
  ["/download", "Get OCTIVE for Windows, Android or the browser"],
  ["/link · /unlink", "Connect your Discord to your OCTIVE account"],
  ["/update", "Re-check your supporter status, boost and role"],
];

async function discordCommand(env, it) {
  const data = it.data || {};
  const user = it.member?.user || it.user || {};
  switch (data.name) {
    case "profile": {
      const t = await target(env, data, user);
      if (t.error) return t.error;
      const raw = await profileOf(env, t.id);
      if (!raw) return { content: "That profile isn't available (no plays online yet).", flags: EPHEMERAL };
      const { p, st } = await withSupport(env, raw);
      const defs = await achievementDefs();
      return {
        embeds: [profileEmbed(p, st, defs.length)],
        components: [row(
          linkButton("View profile", `${SITE}#/u/${encodeURIComponent(p.id)}`, "👤"),
          (it.member?.user?.id || it.user?.id) && !st?.lifetime ? linkButton("Gift supporter", `${SITE}#/supporter?gift=${encodeURIComponent(p.id)}`, "🎁") : null,
        )],
        allowed_mentions: { parse: [] },
      };
    }
    case "compare": {
      const a = await target(env, data, user, "player", "user");
      if (a.error) return a.error;
      const otherName = opt(data, "with"), otherUser = opt(data, "with_user");
      let bId = null;
      if (otherName || otherUser) {
        const b = await target(env, { options: [otherName ? { name: "player", value: otherName } : { name: "user", value: otherUser }] }, user);
        if (b.error) return b.error;
        bId = b.id;
      } else {
        bId = await linkedPlayer(env, user.id);
        if (!bId) return notLinked(user.id, true);
      }
      if (a.id === bId) return { content: "Pick two different players.", flags: EPHEMERAL };
      const [pa, pb] = await Promise.all([profileOf(env, a.id), profileOf(env, bId)]);
      if (!pa || !pb) return { content: "One of those profiles isn't available yet.", flags: EPHEMERAL };
      const stats = [
        ["Rank", (p) => p.rank || 1e9, (p) => (p.rank ? "#" + fmtN(p.rank) : "—"), true],
        ["Performance", (p) => p.pp, (p) => fmtN(p.pp) + " PR"],
        ["Accuracy", (p) => p.accuracy, (p) => fmtN(p.accuracy, 2) + "%"],
        ["Level", (p) => p.level + (p.levelProgress || 0), (p) => "Lv" + p.level],
        ["Plays", (p) => p.playCount, (p) => fmtN(p.playCount)],
        ["Full combos", (p) => p.fullCombos, (p) => fmtN(p.fullCombos)],
        ["Max combo", (p) => p.maxCombo, (p) => fmtN(p.maxCombo) + "x"],
        ["Play time", (p) => p.playTimeMs, (p) => playTimeText(p.playTimeMs)],
        ["Total score", (p) => p.totalScore, (p) => fmtN(p.totalScore)],
      ];
      let wa = 0, wb = 0;
      const left = [], right = [], names = [];
      for (const [label, val, show, lowWins] of stats) {
        const va = val(pa), vb = val(pb);
        const aWins = lowWins ? va < vb : va > vb, bWins = lowWins ? vb < va : vb > va;
        if (aWins) wa++; if (bWins) wb++;
        names.push(label);
        left.push((aWins ? "▲ " : "　") + show(pa));
        right.push((bWins ? "▲ " : "　") + show(pb));
      }
      return {
        embeds: [{
          title: `⚔️ ${clean(pa.name)} vs ${clean(pb.name)}`, color: C_ACCENT, url: `${SITE}#/u/${encodeURIComponent(pa.id)}`,
          description: wa === wb ? "Neck and neck!" : `**${clean(wa > wb ? pa.name : pb.name)}** leads ${Math.max(wa, wb)}–${Math.min(wa, wb)}.`,
          fields: [
            { name: "　", value: names.map((n) => `**${n}**`).join("\n"), inline: true },
            { name: clean(pa.name), value: left.join("\n"), inline: true },
            { name: clean(pb.name), value: right.join("\n"), inline: true },
          ],
          footer: FOOTER,
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "leaderboard":
      return leaderboardMessage(env, Number(opt(data, "page") || 1), user.id);
    case "online": {
      const board = await leaderboard(env);
      let web = {};
      try { web = await webVisitors(env); } catch { /* none */ }
      const all = board.players.map((p) => withWeb(p, web)).filter((p) => p.online);
      const groups = [["🖥️ Desktop", (s) => /^desktop/.test(s)], ["📱 Mobile", (s) => /^mobile/.test(s)], ["🌐 Browser", (s) => /^web/.test(s)], ["👀 On the website", (s) => s === "site"]];
      const fields = [];
      for (const [label, test] of groups) {
        const list = all.filter((p) => test(p.status || ""));
        if (list.length) fields.push({ name: `${label} — ${list.length}`, value: list.slice(0, 15).map((p) => `**${clean(p.name)}** · #${p.rank}${/-dev$/.test(p.status || "") ? " · 🧪" : ""}`).join("\n").slice(0, 1024), inline: true });
      }
      const rest = all.filter((p) => !groups.some(([, t]) => t(p.status || "")));
      if (rest.length) fields.push({ name: `🎮 In game — ${rest.length}`, value: rest.slice(0, 15).map((p) => `**${clean(p.name)}** · #${p.rank}`).join("\n").slice(0, 1024), inline: true });
      return {
        embeds: [{
          title: `🟢 ${all.length} player${all.length === 1 ? "" : "s"} online`, color: C_GREEN, url: `${SITE}#/rankings`,
          description: all.length ? undefined : "Nobody on the ranking is online right now.",
          fields, footer: { text: "🧪 = playing a DEV / test build" },
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "achievements": {
      const t = await target(env, data, user);
      if (t.error) return t.error;
      const p = await profileOf(env, t.id);
      if (!p) return { content: "That profile isn't available yet.", flags: EPHEMERAL };
      const defs = await achievementDefs();
      const got = p.achievements || {};
      const groups = [...new Set(defs.map((d) => d.group))];
      const icon = { Milestones: "⭐", Skill: "✅", Supporter: "💖", "OCTIVE Remixes": "🎵" };
      const fields = groups.map((g) => {
        const list = defs.filter((d) => d.group === g);
        const n = list.filter((d) => got[d.id]).length;
        return { name: `${icon[g] || "🏅"} ${g}`, value: `\`${bar(list.length ? n / list.length : 0, 10)}\` ${n}/${list.length}`, inline: true };
      });
      const recent = Object.entries(got).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, 5)
        .map(([id, at]) => { const d = defs.find((x) => x.id === id); return d ? `**${d.title}** — ${d.desc} · <t:${unix(at)}:R>` : null; }).filter(Boolean);
      const total = defs.length, have = defs.filter((d) => got[d.id]).length;
      return {
        embeds: [{
          title: `🏅 ${clean(p.name)}'s achievements`, url: `${SITE}#/u/${encodeURIComponent(p.id)}`, color: C_GOLD,
          description: `**${have} of ${total}** unlocked (${total ? Math.round(have / total * 100) : 0}%)` + (recent.length ? `\n\n**Latest**\n${recent.join("\n")}` : ""),
          fields, footer: FOOTER,
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "supporter": {
      const t = await target(env, data, user);
      if (t.error) return t.error;
      const raw = await profileOf(env, t.id);
      if (!raw) return { content: "That profile isn't available yet.", flags: EPHEMERAL };
      const { p, st } = await withSupport(env, raw);
      const g = gifterTier(p.gifted || 0);
      const fields = [];
      if (st && (st.active || st.days > 0)) {
        fields.push({ name: "Status", value: st.lifetime ? "Lifetime supporter" : st.booster ? "Supporter · Server Booster" : st.active ? "Supporter" : "Former supporter", inline: true });
        fields.push({ name: "Supported for", value: `${fmtN(st.months)} month${st.months === 1 ? "" : "s"} (${fmtN(st.days)} days)`, inline: true });
        if (st.since) fields.push({ name: "Since", value: `<t:${unix(st.since)}:D>`, inline: true });
        if (!st.lifetime && st.active && st.until) fields.push({ name: "Until", value: `<t:${unix(st.until)}:D>`, inline: true });
      }
      if (p.supporterNo != null) fields.push({ name: "Supporter number", value: supNo(p.supporterNo), inline: true });
      fields.push({ name: "Gifted to others", value: g ? `${g[2]} **${g[1]}** · ${fmtN(p.gifted)} month${p.gifted === 1 ? "" : "s"}` : "Nothing yet", inline: true });
      const isSup = st?.active;
      return {
        embeds: [{
          title: `💖 ${clean(p.name)}`, url: `${SITE}#/u/${encodeURIComponent(p.id)}`, color: isSup ? C_PINK : C_ACCENT,
          description: isSup ? "Thank you for supporting OCTIVE!" : st?.days > 0 ? "A former OCTIVE supporter." : "Not an OCTIVE supporter (yet).",
          fields, footer: { text: "Supporters get a badge, banner, name colours, profile effects and an animated picture" },
          ...(st?.active && st.banner ? { image: { url: `${WORKER_BASE}/looks/banner/${encodeURIComponent(p.id)}?v=${encodeURIComponent(st.banner)}` } } : {}),
        }],
        components: [row(
          linkButton("Become a supporter", `${SITE}#/supporter`, "💖"),
          st?.lifetime ? null : linkButton(`Gift ${clean(p.name).slice(0, 30)}`, `${SITE}#/supporter?gift=${encodeURIComponent(p.id)}`, "🎁"),
        )],
        allowed_mentions: { parse: [] },
      };
    }
    case "workshop": {
      // the newest shared items (all four channels, or one kind), with links to their posts and downloads
      const type = opt(data, "type"), q = String(opt(data, "search") || "").trim().toLowerCase();
      const db = await r2json(env, WS_DB, { items: [] });
      const creator = url.searchParams.get("creator");
    let items = (db.items || []).filter((it) => !it.removed && (!type || it.type === type) && (!creator || it.creatorId === creator));
      if (q) items = items.filter((it) => `${it.title} ${it.creator} ${it.description}`.toLowerCase().includes(q));
      items.sort((a, b) => b.at - a.at);
      const shown = items.slice(0, 8);
      const label = type ? WS_LABEL[type] + "s" : "Workshop";
      if (!shown.length) return { embeds: [{ color: C_ACCENT, title: `🧰 ${label}`, description: q ? `Nothing matches **${clean(q)}**.` : "Nothing shared yet. Share yours from OCTIVE: Play → Workshop → Share yours." }] };
      const lines = shown.map((it) => {
        const post = it.channelId && it.messageId ? `https://discord.com/channels/${it.guildId || env.DISCORD_GUILD_ID}/${it.channelId}/${it.messageId}` : null;
        const mb = (it.size / 1048576).toFixed(it.size < 1048576 ? 2 : 1);
        return `**${clean(it.title)}** · ${WS_LABEL[it.type]} by ${clean(it.creator)}
　${post ? `[Post](${post}) · ` : ""}[Download](${WORKER_BASE}/api/download/${it.id}?redirect=1) · ${mb} MB · ${fmtN(it.downloads || 0)} ⬇ · <t:${unix(new Date(it.at).toISOString())}:R>`;
      });
      return {
        embeds: [{ color: type ? WS_COLOR[type] : C_ACCENT, title: `🧰 ${label}`, url: `${SITE}#/workshop`, description: lines.join("\n\n"),
          footer: { text: `${items.length} shared${q ? " matching" : ""} · get them in OCTIVE: Play → Workshop` } }],
        components: [row(linkButton("Open the Workshop", `${SITE}#/workshop`, "🧰"))],
      };
    }
    case "stats": {
      const board = await leaderboard(env);
      let sup = {}, m = null;
      try { sup = await supporters(env); } catch { /* none */ }
      try { const o = await env.RELEASES.get("latest.json"); m = o ? await o.json() : null; } catch { /* none */ }
      const ps = board.players;
      const sum = (f) => ps.reduce((n, p) => n + (f(p) || 0), 0);
      const supporters = Object.values(sup).filter((s) => s.active).length;
      const gifted = Object.values(giftedIndex).reduce((n, x) => n + x, 0);
      return {
        embeds: [{
          title: "📊 OCTIVE in numbers", url: SITE, color: C_ACCENT,
          fields: [
            { name: "Ranked players", value: fmtN(board.total), inline: true },
            { name: "Online now", value: fmtN(board.online), inline: true },
            { name: "Supporters", value: fmtN(supporters), inline: true },
            { name: "Songs played", value: fmtN(sum((p) => p.playCount)), inline: true },
            { name: "Time played", value: playTimeText(sum((p) => p.playTimeMs)), inline: true },
            { name: "Full combos", value: fmtN(sum((p) => p.fullCombos)), inline: true },
            { name: "Months gifted", value: fmtN(gifted), inline: true },
            { name: "Top player", value: ps[0] ? `**${clean(ps[0].name)}** · ${fmtN(ps[0].pp)} PR` : "—", inline: true },
            { name: "Latest version", value: m ? `v${m.version}` + (m.published ? ` · <t:${unix(m.published)}:R>` : "") : "—", inline: true },
          ],
          footer: FOOTER,
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "help":
      return {
        embeds: [{
          title: "OCTIVE bot", url: SITE, color: C_ACCENT,
          description: HELP.map(([c, d]) => `**${c}** — ${d}`).join("\n") + `\n\nMost commands take a player's name, or a Discord user who linked their account. Leave it empty for yourself once you've used \`/link\`.`,
          footer: FOOTER,
        }],
        components: [row(linkButton("Website", SITE, "🌐"), linkButton("Download", `${SITE}#/download`, "⬇️"), linkButton("Link Discord", `${SITE}#/account?tab=preferences`, "🔗"))],
        flags: EPHEMERAL,
      };
    case "download": {
      let m = null;
      try { const o = await env.RELEASES.get("latest.json"); m = o ? await o.json() : null; } catch { /* none */ }
      return {
        embeds: [{
          title: m ? `⬇️ Download OCTIVE ${m.version}` : "⬇️ Download OCTIVE", url: `${SITE}#/download`, color: C_ACCENT,
          description: "Free on Windows and Android, or play right in your browser. The game updates itself."
            + (m?.notes ? `\n\n**What's new in ${m.version}**\n${String(m.notes).slice(0, 1500)}` : ""),
          footer: m?.published ? { text: `Released ${new Date(m.published).toLocaleDateString("en-GB", { dateStyle: "long" })}` } : FOOTER,
        }],
        components: [row(
          linkButton("Windows", `${WORKER_BASE}/releases/OCTIVE-Installer.exe`, "🪟"),
          m?.android ? linkButton("Android", `${WORKER_BASE}/releases/${m.android.file}`, "🤖") : null,
          m?.web ? linkButton("Play in browser", `${SITE}play/`, "🌐") : null,
        )],
      };
    }
    case "link": {
      const code = String(opt(data, "code") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 8) return { content: `That code doesn't look right. Get one at ${SITE}#/account?tab=preferences → **Link Discord**.`, flags: EPHEMERAL };
      const o = await env.RELEASES.get(`discord-codes/${code}.json`);
      const c = o ? await o.json() : null;
      if (!c || c.exp < Date.now()) return { content: `That code isn't valid or ran out (codes work for 10 minutes). Make a new one at ${SITE}#/account?tab=preferences.`, flags: EPHEMERAL };
      await env.RELEASES.delete(`discord-codes/${code}.json`);
      const old = await linkedPlayer(env, user.id);
      if (old && old !== c.playerId) {
        const orec = await record(env, old); delete orec.discord; await saveRecord(env, old, orec);
      }
      const rec = await record(env, c.playerId);
      if (rec.discord && rec.discord.id !== user.id) await env.RELEASES.delete(`discord/${rec.discord.id}.json`);
      rec.discord = { id: user.id, name: user.global_name || user.username || "", username: user.username || "", at: new Date().toISOString() };
      if (env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID && it.member) await setBooster(env, c.playerId, user.id, it.member.premium_since || null);
      await saveRecord(env, c.playerId, rec);
      await env.RELEASES.put(`discord/${user.id}.json`, JSON.stringify({ playerId: c.playerId, at: rec.discord.at }), { httpMetadata: { contentType: "application/json" } });
      await syncSupporterRole(env, c.playerId, user.id, env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID ? it.member : undefined);
      let name = "your account";
      try { const p = await profileOf(env, c.playerId); if (p) name = `**${clean(p.name)}**`; } catch { /* fine */ }
      return { embeds: [{ color: C_GREEN, title: "✅ Linked", description: `Your Discord is now linked to ${name}.\nTry \`/profile\`, \`/achievements\` or \`/compare\`.` }], flags: EPHEMERAL };
    }
    case "update": {
      // re-checks the server boost and gives or takes the OCTIVE Supporter role right now
      const id = await linkedPlayer(env, user.id);
      if (!id) return notLinked(user.id, true);
      const member = env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID && it.member ? it.member : await memberOf(env, user.id);
      if (member) await setBooster(env, id, user.id, member.premium_since || null);
      supportIndex = null;
      const st = supportStatus(await r2json(env, `supporters/${id}.json`, null), id, await r2json(env, `boosters/${id}.json`, null));
      if (member) await syncSupporterRole(env, id, user.id, member);
      let name = "your account";
      try { const p = await profileOf(env, id); if (p) name = `**${clean(p.name)}**`; } catch { /* fine */ }
      const what = st.lifetime ? "a lifetime supporter"
        : st.booster ? "a supporter while you boost the server" + (st.until ? ` (your paid time is paused and continues until <t:${unix(st.until)}:D> after)` : "")
        : st.active ? `a supporter until <t:${unix(st.until)}:D>`
        : "not a supporter right now";
      const role = !env.DISCORD_SUPPORTER_ROLE_ID ? "" : !member ? "\nJoin the OCTIVE Discord server to get the supporter role." : st.active ? "\nYou have the **OCTIVE Supporter** role." : "\nThe supporter role was removed.";
      return { embeds: [{ color: st.active ? C_PINK : C_ACCENT, title: "🔄 Updated", description: `${name}: you're ${what}.${role}` }], flags: EPHEMERAL };
    }
    case "unlink": {
      const id = await linkedPlayer(env, user.id);
      if (!id) return { content: "Your Discord isn't linked to an OCTIVE account.", flags: EPHEMERAL };
      await syncSupporterRole(env, id, user.id, undefined, true);
      await env.RELEASES.delete(`discord/${user.id}.json`);
      const rec = await record(env, id); delete rec.discord; await saveRecord(env, id, rec);
      return { embeds: [{ color: C_ACCENT, title: "Unlinked", description: "Your OCTIVE account and Discord aren't connected any more." }], flags: EPHEMERAL };
    }
    default:
      return { content: "I don't know that command (yet). Try `/help`.", flags: EPHEMERAL };
  }
}

/** Player-name suggestions while typing (any option called player or with). */
async function discordAutocomplete(env, it) {
  const focused = (it.data?.options || []).find((o) => o.focused);
  const q = String(focused?.value || "").trim().toLowerCase();
  let players = [];
  try { players = (await leaderboard(env)).players; } catch { /* none */ }
  const hits = (q ? players.filter((p) => (p.name || "").toLowerCase().includes(q)).sort((a, b) => ((b.name || "").toLowerCase().startsWith(q) ? 1 : 0) - ((a.name || "").toLowerCase().startsWith(q) ? 1 : 0) || a.rank - b.rank) : players)
    .slice(0, 25).map((p) => ({ name: `${clean(p.name)} · #${p.rank} · ${fmtN(p.pp)} PR`.slice(0, 100), value: String(p.name).slice(0, 100) }));
  return new Response(JSON.stringify({ type: 8, data: { choices: hits } }), { headers: { "Content-Type": "application/json" } });
}

/** Buttons on our messages: the leaderboard's pages. */
async function discordComponent(env, it) {
  const id = String(it.data?.custom_id || "");
  const m = id.match(/^lb:(\d{1,2})$/);
  if (m) {
    const msg = await leaderboardMessage(env, Number(m[1]), (it.member?.user || it.user || {}).id);
    return new Response(JSON.stringify({ type: 7, data: msg }), { headers: { "Content-Type": "application/json" } });
  }
  return dReply({ content: "That button doesn't work any more.", flags: EPHEMERAL });
}

async function discordInteraction(request, env, ctx) {
  const body = await request.text();
  if (!(await discordVerified(request, body))) return new Response("invalid request signature", { status: 401 });
  const it = JSON.parse(body);
  // any command used in the OCTIVE server tells us whether that member boosts it
  if (env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID && it.member?.user?.id)
    ctx.waitUntil((async () => {
      const link = await r2json(env, `discord/${it.member.user.id}.json`, null);
      if (link?.playerId) {
        await setBooster(env, link.playerId, it.member.user.id, it.member.premium_since || null);
        await syncSupporterRole(env, link.playerId, it.member.user.id, it.member);
      }
    })().catch(() => {}));
  if (it.type === 1) return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } }); // PING
  if (it.type === 4) return await discordAutocomplete(env, it); // name suggestions while typing
  if (it.type === 3) return await discordComponent(env, it); // buttons
  if (it.type !== 2) return dReply({ content: "Not supported.", flags: EPHEMERAL });
  // answer straight away when the result is ready within ~2.5 s (Discord allows 3 s); otherwise answer
  // "thinking…" and edit the reply when it's done (the ranking can be slow on a cold start)
  const ephemeral = ["link", "unlink", "update", "help"].includes(it.data?.name);
  const result = discordCommand(env, it).catch((e) => {
    console.log("discord command failed", e && e.stack || e);
    return { content: "Something went wrong: " + String(e.message || e).slice(0, 300) };
  });
  const quick = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 2500))]);
  if (quick) {
    if (ephemeral) quick.flags = EPHEMERAL;
    return dReply(quick);
  }
  const work = (async () => {
    const msg = await result;
    // the "thinking…" message's visibility was chosen when deferring; an edit can't change it
    delete msg.flags;
    const res = await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${it.token}/messages/@original`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" }, body: JSON.stringify(msg),
    });
    if (!res.ok) {
      console.log("discord edit failed", res.status, (await res.text()).slice(0, 500));
      // last try: plain text, so the command never hangs on "thinking"
      await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${it.token}/messages/@original`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" },
        body: JSON.stringify({ content: msg.content || "Something went wrong showing that. Try again in a moment.", embeds: [] }),
      });
    }
  })();
  ctx.waitUntil(work);
  return new Response(JSON.stringify({ type: 5, data: ephemeral ? { flags: EPHEMERAL } : {} }), { headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------- chart leaderboards (official songs)
// Every OCTIVE Official chart (song id "octive-…") has a top-100 leaderboard: one entry per player, their
// best. The game submits a play with the player's Unity token (checked like the website's sign-in);
// the board lives in R2 at scores/<songId>/<chartId>.json and is cached for a few seconds.
const BOARD_SIZE = 100;
const SCORE_MAX = 1_000_000;
const boards = new Map(); // key -> { data, at }

const officialSong = (id) => /^octive-[a-z0-9-]{1,80}$/.test(id || "");
const chartIdOk = (id) => /^[A-Za-z0-9_-]{1,80}$/.test(id || "");

async function readBoard(env, songId, chartId) {
  const key = `scores/${songId}/${chartId}.json`;
  const c = boards.get(key);
  if (c && Date.now() - c.at < 15_000) return c.data;
  const o = await env.RELEASES.get(key);
  let data = { entries: [] };
  if (o) { try { data = await o.json(); } catch { /* start over */ } }
  data.entries ||= [];
  boards.set(key, { data, at: Date.now() });
  if (boards.size > 500) boards.delete(boards.keys().next().value);
  return data;
}

async function chartScores(request, env, url) {
  const m = url.pathname.match(/^\/scores\/([a-z0-9-]{1,90})\/([A-Za-z0-9_-]{1,80})$/);
  if (m && request.method === "GET") {
    if (!officialSong(m[1])) return reply({ entries: [], official: false });
    const data = await readBoard(env, m[1], m[2]);
    if (Date.now() - boardAt > BOARD_TTL) { try { await loadModeration(config(env)); } catch { /* keep */ } }
    let sup = {};
    try { sup = await supporters(env); } catch { /* none */ }
    const entries = data.entries.filter((e) => !moderation.bans[e.playerId] && !isOfficial(e.playerId)).slice(0, 50).map((e, i) => ({ ...e, rank: i + 1, supporter: !!sup[e.playerId]?.active }));
    return reply({ official: true, entries, total: data.entries.length });
  }
  if (url.pathname === "/scores/submit") {
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const songId = String(b.songId || ""), chartId = String(b.chartId || "");
    if (!officialSong(songId) || !chartIdOk(chartId)) fail(400, "Only OCTIVE Official charts have online leaderboards.");
    const score = Math.round(Number(b.score)), acc = Number(b.accuracy);
    if (!(score >= 0 && score <= SCORE_MAX) || !(acc >= 0 && acc <= 100)) fail(400, "That score isn't valid.");
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    const card = (await publicItems(cfg, who.playerId, ["card"])).card || {};
    const ov = moderation.overrides[who.playerId] || {};
    const entry = {
      playerId: who.playerId,
      name: String(ov.name || card.name || who.username || "Player").slice(0, 40),
      avatarHash: ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : String(card.avatar || ""),
      score, accuracy: Math.round(acc * 100) / 100,
      grade: String(b.grade || "").slice(0, 3),
      maxCombo: Math.max(0, Math.round(Number(b.maxCombo) || 0)),
      fullCombo: !!b.fullCombo,
      pp: Math.max(0, Math.round((Number(b.pp) || 0) * 100) / 100),
      counts: Array.isArray(b.counts) ? b.counts.slice(0, 6).map((n) => Math.max(0, Math.round(Number(n) || 0))) : [],
      badges: badgesOf(who.playerId),
      date: new Date().toISOString(),
      version: String(b.version || "").slice(0, 12),
      mods: String(b.mods || "").replace(/[^A-Z ]/g, "").slice(0, 40),
    };
    const key = `scores/${songId}/${chartId}.json`;
    boards.delete(key);
    const data = await readBoard(env, songId, chartId);
    const i = data.entries.findIndex((e) => e.playerId === who.playerId);
    let improved = true;
    if (i >= 0) {
      if (data.entries[i].score >= score) improved = false;
      else data.entries.splice(i, 1);
    }
    if (improved) {
      data.entries.push(entry);
      data.entries.sort((a, c) => c.score - a.score || c.accuracy - a.accuracy || Date.parse(a.date) - Date.parse(c.date));
      data.entries = data.entries.slice(0, BOARD_SIZE);
      await env.RELEASES.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
      boards.set(key, { data, at: Date.now() });
    }
    const rank = data.entries.findIndex((e) => e.playerId === who.playerId) + 1;
    return reply({ ok: true, improved, rank: rank || null, total: data.entries.length });
  }
  fail(404, "Not found");
}

// ---------------------------------------------------------------- what a player is on
/** The game's "platform" tag: desktop, mobile or web (the browser build). */
// "desktop", "mobile", "web", and the same with "-dev" for test builds ("Online Desktop - Playing DEV Build")
function platformStatus(tag) { return /^(desktop|mobile|web)(-dev)?$/.test(tag || "") ? tag : "game"; }
const WEB_MS = 4 * 60_000; // "Viewing Website" while the site pinged this recently
let webIndex = null, webIndexAt = 0;
/** Signed-in website visitors: webseen/<playerId> objects, by upload time (cached 30 s). */
async function webVisitors(env) {
  if (webIndex && Date.now() - webIndexAt < 30_000) return webIndex;
  const out = {};
  let cursor;
  do {
    const list = await env.RELEASES.list({ prefix: "webseen/", cursor });
    for (const o of list.objects) out[o.key.slice(8)] = o.uploaded.getTime();
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  webIndex = out; webIndexAt = Date.now();
  return out;
}
const STATUS_TEXT = { desktop: "Online Desktop", mobile: "Online Mobile", web: "Online Website", site: "Viewing Website" };
function statusText(p) {
  if (!p.online) return "Offline";
  const dev = /-dev$/.test(p.status || "");
  return (STATUS_TEXT[(p.status || "").replace(/-dev$/, "")] || "Online") + (dev ? " - Playing DEV Build" : "");
}
/** Playing beats browsing; someone appearing offline in the game isn't shown on the website either. */
function withWeb(p, web) {
  if (p.online || p.platform === "hidden") return p;
  const at = web[p.id] || 0;
  if (Date.now() - at < WEB_MS) return { ...p, online: true, status: "site", lastSeen: new Date(at).toISOString() };
  if (at && (!p.lastSeen || at > Date.parse(p.lastSeen))) return { ...p, lastSeen: new Date(at).toISOString() };
  return p;
}

// ---------------------------------------------------------------- supporters (Stripe) and following
// Supporter: $2.50 a month, bought on the website (Stripe Checkout) in blocks of 1–24 months with a
// discount for longer blocks. Membership time adds up across purchases; anniversary badges and the
// lifetime statistics use the total time actually supported (gaps don't reset it).
// R2: supporters/<playerId>.json  { periods: [{ start, end }], purchases: [...], lifetime }
//     looks/<playerId>.json       { nameStyle, effect, banner (hash), gif (hash) }  (supporters only)
//     looks/banner/<id>.jpg, looks/gif/<id>.gif
//     follows/<playerId>.json     { following: [ids] }   followers/<playerId>.json { followers: [ids] }
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (Tools/stripe_setup.py sets both).
const MONTH_MS = 30.4375 * 86_400_000;
const PRICE_CENTS = 250;
const MAX_MONTHS = 120; // any number of months (up to 10 years) for yourself or as a gift
const GIF_MAX = 8 * 1048576; // supporters' animated pictures
const LIFETIME_SUPPORTERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE"]; // Senterra
const OWNER = "PlwcYVKV9y7NBFWfUaC263XpCFbE"; // everyone follows the developer
const MILESTONES = [[0, "new"], [1, "1 month"], [3, "3 months"], [6, "6 months"], [12, "1 year"], [24, "2 years"], [36, "3 years"], [48, "4 years"], [60, "5 years"], [120, "10 years"]];
const EFFECTS = ["none", "sparkles", "snow", "hearts", "embers", "stars", "aurora", "rain"];

// longer blocks cost less, never more than 50% off
function discountFor(m) { return Math.min(0.5, m >= 36 ? 0.5 : m >= 24 ? 0.4 : m >= 12 ? 0.3 : m >= 6 ? 0.2 : m >= 3 ? 0.1 : 0); }
function priceFor(m) { return Math.round(PRICE_CENTS * m * (1 - discountFor(m))); }

async function r2json(env, key, fallback) {
  const o = await env.RELEASES.get(key);
  if (!o) return fallback;
  try { return await o.json(); } catch { return fallback; }
}
const r2put = (env, key, v) => env.RELEASES.put(key, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });

/** Status of a supporter record: active, until, days supported in total, milestone. */
// ---------------------------------------------------------------- Discord server boosters
// A player who linked Discord and boosts the OCTIVE Discord server is a supporter while the boost lasts.
// Needs the variable DISCORD_GUILD_ID (the server) and the secret DISCORD_BOT_TOKEN (the bot must be in
// the server). Boosts are checked every 6 hours (cron) and whenever the player uses a command there.
//   boosters/<playerId>.json  { discordId, since, checked }   (only while boosting)

/** Paid or gifted supporter time that fell while boosting (it's paused, not used up), in ms. */
function pausedDuringBoost(rec, boostSince, until = Date.now()) {
  const b = Date.parse(boostSince || "");
  if (!b || !rec?.periods) return 0;
  let ms = 0;
  for (const p of rec.periods) {
    if (p.boostCredit) continue;
    const s = Math.max(Date.parse(p.start), b), e = Math.min(Date.parse(p.end), until);
    if (e > s) ms += e - s;
  }
  return ms;
}

async function setBooster(env, playerId, discordId, premiumSince) {
  if (!playerId) return;
  const key = `boosters/${playerId}.json`;
  const old = await r2json(env, key, null);
  if (premiumSince) {
    await env.RELEASES.put(key, JSON.stringify({ discordId, since: premiumSince, checked: new Date().toISOString() }), { httpMetadata: { contentType: "application/json" } });
  } else if (old) {
    // the boost ended: give back the paid / gifted time that was paused while it lasted
    const rec = await r2json(env, `supporters/${playerId}.json`, null);
    const credit = pausedDuringBoost(rec, old.since);
    if (rec && credit > 60_000) {
      const now = Date.now();
      const until = Math.max(now, ...rec.periods.filter((x) => !x.boostCredit).map((x) => Date.parse(x.end)));
      rec.periods.push({ start: new Date(until).toISOString(), end: new Date(until + credit).toISOString(), boostCredit: true, note: "supporter time paused while boosting" });
      await env.RELEASES.put(`supporters/${playerId}.json`, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
    }
    await env.RELEASES.delete(key);
  }
  supportIndex = null; // the supporter list changes
}

/** A member of the OCTIVE Discord server: the member object, null when they aren't in it, undefined if unknown. */
async function memberOf(env, discordId) {
  if (!env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN || !discordId) return undefined;
  const res = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`, { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } });
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  return await res.json();
}

/**
 * The "OCTIVE Supporter" role in the Discord server follows supporter status in the game: linked players get
 * it while they're supporters (paid, gifted, lifetime or boosting) and lose it when that ends or they unlink.
 * Needs the variable DISCORD_SUPPORTER_ROLE_ID; the bot needs Manage Roles and a role above that one.
 */
async function syncSupporterRole(env, playerId, discordId, member, forceRemove = false) {
  const role = env.DISCORD_SUPPORTER_ROLE_ID;
  if (!role || !env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  try {
    if (!discordId && playerId) discordId = (await record(env, playerId))?.discord?.id;
    if (!discordId) return;
    if (member === undefined) member = await memberOf(env, discordId);
    if (!member) return; // not in the server (or Discord didn't answer)
    let active = false;
    if (!forceRemove && playerId) {
      const st = supportStatus(await r2json(env, `supporters/${playerId}.json`, null), playerId, await r2json(env, `boosters/${playerId}.json`, null));
      active = st.active;
    }
    const has = (member.roles || []).includes(role);
    if (active === has) return;
    const res = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}/roles/${role}`,
      { method: active ? "PUT" : "DELETE", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "X-Audit-Log-Reason": active ? "OCTIVE supporter" : "No longer an OCTIVE supporter" } });
    if (!res.ok) console.log("supporter role", res.status, (await res.text()).slice(0, 200));
  } catch (e) { console.log("supporter role failed", e && e.message); }
}

/** Re-checks every linked Discord account (the cron job): boosts and the supporter role. */
async function refreshBoosters(env) {
  if (!env.DISCORD_GUILD_ID || !env.DISCORD_BOT_TOKEN) return;
  let cursor;
  do {
    const list = await env.RELEASES.list({ prefix: "discord/", cursor });
    for (const o of list.objects) {
      const discordId = o.key.slice(8, -5);
      const link = await r2json(env, o.key, null);
      if (!link?.playerId) continue;
      const member = await memberOf(env, discordId);
      if (member !== undefined) {
        await setBooster(env, link.playerId, discordId, member ? member.premium_since || null : null);
        if (member) await syncSupporterRole(env, link.playerId, discordId, member);
      }
      await new Promise((r) => setTimeout(r, 120)); // stay under Discord's rate limit
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

function supportStatus(rec, playerId, boost) {
  const now = Date.now();
  const lifetime = LIFETIME_SUPPORTERS.includes(playerId) || !!rec?.lifetime;
  const periods = rec?.periods || [];
  let days = 0, until = 0, since = null;
  for (const p of periods) {
    const s = Date.parse(p.start), e = Date.parse(p.end);
    if (!since || s < Date.parse(since)) since = p.start;
    days += Math.max(0, Math.min(e, now) - s) / 86_400_000;
    until = Math.max(until, e);
  }
  if (lifetime) { const first = since ? Date.parse(since) : Date.parse("2026-11-09"); days = Math.max(days, (now - first) / 86_400_000); since = since || "2026-11-09T00:00:00Z"; }
  const booster = !!boost;
  // while boosting, paid / gifted time is paused: its end moves later by the time spent boosting
  const paused = booster && !lifetime ? pausedDuringBoost(rec, boost.since, now) : 0;
  if (paused > 0 && until > Date.parse(boost.since)) until += paused;
  const active = lifetime || until > now || booster;
  const months = Math.floor(days / 30.4375);
  let milestone = null;
  if (active || days > 0) for (const [m, label] of MILESTONES) if (months >= m) milestone = { months: m, label };
  return {
    active, lifetime, booster, boostingSince: boost?.since || null,
    until: lifetime ? null : until > now ? new Date(until).toISOString() : booster ? null : until ? new Date(until).toISOString() : null,
    days: Math.floor(days), months, since,
    milestone, purchases: (rec?.purchases || []).length,
    totalMonthsBought: (rec?.purchases || []).filter((p) => !p.gift).reduce((n, p) => n + (p.months || 0), 0),
    monthsReceived: (rec?.purchases || []).filter((p) => p.gift).reduce((n, p) => n + (p.months || 0), 0),
  };
}

let supportIndex = null, supportIndexAt = 0;
/** Months each player gifted to others (paid gifts, claimed or waiting) and Supporter numbers. */
let giftedIndex = {}, numberIndex = {};

/**
 * Supporter numbers: everyone who has bought supporter (for themselves or as a gift) gets one, in the order
 * of their first purchase, and keeps it (supporter-ids.json). The developer is Supporter #0000.
 */
async function assignNumbers(env, firstBuy) {
  const book = await r2json(env, "supporter-ids.json", { next: 1, ids: {} });
  book.ids ||= {}; book.next ||= 1;
  book.ids[OWNER] = 0;
  const fresh = Object.entries(firstBuy).filter(([id]) => !(id in book.ids)).sort((a, b) => a[1] - b[1]);
  for (const [id] of fresh) book.ids[id] = book.next++;
  if (fresh.length || book.ids[OWNER] !== 0) await r2put(env, "supporter-ids.json", book);
  return book.ids;
}

/** Every supporter (active or with time on record) and their looks, cached a minute. */
async function supporters(env) {
  if (supportIndex && Date.now() - supportIndexAt < 60_000) return supportIndex;
  const out = {};
  const ids = new Set(LIFETIME_SUPPORTERS);
  const gifted = {}, firstBuy = {}, firstSeen = {};
  const seen = (id, at) => { const t = Date.parse(at) || 0; if (t && (!(id in firstSeen) || t < firstSeen[id])) firstSeen[id] = t; };
  const bought = (id, at, months, gift, paid = true) => {
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
    const t = Date.parse(at) || Date.now();
    if (paid && (!(id in firstBuy) || t < firstBuy[id])) firstBuy[id] = t;
    if (gift) gifted[id] = (gifted[id] || 0) + (months || 0);
  };
  let cursor;
  do {
    const list = await env.RELEASES.list({ prefix: "supporters/", cursor });
    for (const o of list.objects) ids.add(o.key.slice(11, -5));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  const boosts = {};
  do {
    const list = await env.RELEASES.list({ prefix: "boosters/", cursor });
    for (const o of list.objects) { const id = o.key.slice(9, -5); ids.add(id); boosts[id] = true; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  // gifts bought but not claimed yet
  do {
    const list = await env.RELEASES.list({ prefix: "gifts/", cursor });
    await Promise.all(list.objects.map(async (o) => {
      const g = await r2json(env, o.key, { pending: [] });
      for (const x of g.pending || []) bought(x.from, x.at, x.months, true, !x.free && x.amount > 0);
    }));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await Promise.all([...ids].map(async (id) => {
    const rec = await r2json(env, `supporters/${id}.json`, null);
    for (const p of rec?.purchases || []) {
      seen(id, p.at); // when they first had supporter (bought, gifted to them, or given)
      const paid = p.amount > 0; // free gifts from the developer count as gifted, not as purchases
      if (p.gift) bought(p.gift, p.at, p.months, true, paid);
      else if (paid) bought(id, p.at, p.months, false);
    }
    const boost = boosts[id] ? await r2json(env, `boosters/${id}.json`, null) : null;
    if (boost) seen(id, boost.since || boost.at);
    const st = supportStatus(rec, id, boost);
    if (!st.active && st.days <= 0) return;
    const looks = st.active ? await r2json(env, `looks/${id}.json`, {}) : {};
    out[id] = { ...st, nameStyle: looks.nameStyle || "", effect: looks.effect || "none", banner: looks.banner || "", gif: looks.gif || "" };
  }));
  // every supporter gets a number like the developer's #0000: buyers in the order they first bought, and anyone
  // who became a supporter another way (a gift, a server boost, lifetime) in the order they first had it
  const order = { ...firstBuy };
  for (const id of Object.keys(out)) if (!(id in order)) order[id] = firstSeen[id] || Date.now();
  try { numberIndex = await assignNumbers(env, order); } catch (e) { console.log("supporter numbers", e && e.message); }
  giftedIndex = gifted;
  for (const [id, st] of Object.entries(out)) { st.gifted = gifted[id] || 0; if (id in numberIndex) st.number = numberIndex[id]; }
  supportIndex = out; supportIndexAt = Date.now();
  return out;
}

/** What the website shows for any player: months gifted to others and their Supporter number. */
function giftInfo(id) {
  return { gifted: giftedIndex[id] || 0, supporterNo: id in numberIndex ? numberIndex[id] : null };
}

/** Following: everyone follows the developer (can't be undone); anyone else can be followed. */
async function followingOf(env, id) {
  const f = await r2json(env, `follows/${id}.json`, { following: [] });
  const list = (f.following || []).filter((x) => x !== OWNER && x !== id);
  return id === OWNER ? list : [OWNER, ...list];
}
async function followerCount(env, id) {
  if (id === OWNER) {
    // every player follows the developer: count everyone on the ranking (and anyone with an explicit follow)
    try { const b = await leaderboard(env); return Math.max(b.total || 0, (await r2json(env, `followers/${id}.json`, { followers: [] })).followers.length); } catch { return 0; }
  }
  return ((await r2json(env, `followers/${id}.json`, { followers: [] })).followers || []).length;
}

// ---- Stripe

async function stripe(env, path, form) {
  if (!env.STRIPE_SECRET_KEY) fail(503, "Payments aren't set up yet.");
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) fail(502, "Stripe: " + (data.error?.message || res.status));
  return data;
}

async function stripeSignatureOk(env, header, body) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = parts.t;
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.includes(hex);
}

/** Adds bought months to a player's record (once per checkout session). */
/** Gifts wait in gifts/<playerId>.json until the player claims them on the website. */
async function addGift(env, playerId, gift) {
  const key = `gifts/${playerId}.json`;
  const g = await r2json(env, key, { pending: [] });
  g.pending ||= [];
  if (g.pending.some((x) => x.id === gift.id)) return;
  const rec = await r2json(env, `supporters/${playerId}.json`, null);
  if (rec?.purchases?.some((p) => p.session === gift.id)) return; // already claimed
  let fromName = "";
  try { const ov = moderation.overrides[gift.from] || {}; fromName = ov.name || (await publicItems(config(env), gift.from, ["card"])).card?.name || ""; } catch { /* unknown */ }
  g.pending.push({ ...gift, fromName, at: new Date().toISOString() });
  await r2put(env, key, g);
}
async function pendingGifts(env, playerId) {
  const g = await r2json(env, `gifts/${playerId}.json`, { pending: [] });
  return (g.pending || []).map((x) => ({ id: x.id, from: x.from, fromName: x.fromName || "Someone", months: x.months, free: !!x.free, at: x.at }));
}

async function grantMonths(env, playerId, months, session) {
  const key = `supporters/${playerId}.json`;
  const rec = await r2json(env, key, { periods: [], purchases: [] });
  rec.periods ||= []; rec.purchases ||= [];
  if (rec.purchases.some((p) => p.session === session.id)) return rec;
  const now = Date.now();
  const last = rec.periods[rec.periods.length - 1];
  const add = months * MONTH_MS;
  if (last && Date.parse(last.end) > now) last.end = new Date(Date.parse(last.end) + add).toISOString();
  else rec.periods.push({ start: new Date(now).toISOString(), end: new Date(now + add).toISOString() });
  rec.purchases.push({ at: new Date(now).toISOString(), months, amount: session.amount_total, currency: session.currency, session: session.id, gift: session.metadata?.gift === "1" ? session.metadata?.buyer || "" : undefined });
  await r2put(env, key, rec);
  supportIndex = null;
  return rec;
}

async function supportRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (path === "/support/prices") {
    const tiers = [];
    for (let m = 1; m <= MAX_MONTHS; m++) tiers.push({ months: m, cents: priceFor(m), discount: discountFor(m) });
    return reply({ monthly: PRICE_CENTS, currency: "usd", tiers, effects: EFFECTS });
  }
  if (path === "/support/all") { const all = await supporters(env); return reply({ supporters: all, owner: OWNER, gifted: giftedIndex, numbers: numberIndex }); }
  if (path === "/stripe/webhook" && request.method === "POST") {
    const body = await request.text();
    if (!(await stripeSignatureOk(env, request.headers.get("Stripe-Signature"), body))) return new Response("bad signature", { status: 400 });
    const ev = JSON.parse(body);
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
      const s = ev.data.object;
      const id = s.metadata?.playerId, months = Number(s.metadata?.months);
      if (s.payment_status === "paid" && id && months >= 1 && months <= MAX_MONTHS) {
        if (s.metadata?.gift === "1") await addGift(env, id, { id: s.id, from: s.metadata?.buyer || "", months, amount: s.amount_total, currency: s.currency, free: false });
        else { await grantMonths(env, id, months, s); supportIndex = null; await syncSupporterRole(env, id); }
      }
    }
    return new Response("ok");
  }
  if (path === "/support/checkout") {
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const months = Math.round(Number(b.months));
    if (!(months >= 1 && months <= MAX_MONTHS)) fail(400, `Choose 1 to ${MAX_MONTHS} months.`);
    // gifting: someone else's account by player id (from their profile)
    let target = who.playerId;
    if (b.giftTo) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(b.giftTo))) fail(400, "That player can't be found.");
      target = String(b.giftTo);
      if (target !== who.playerId) {
        const card = (await publicItems(config(env), target, ["card"])).card;
        if (!card || moderation.bans[target]) fail(400, "That player can't be found (they need to have played online once).");
      }
    }
    const cents = priceFor(months), pct = Math.round(discountFor(months) * 100);
    const s = await stripe(env, "checkout/sessions", {
      mode: "payment",
      success_url: `${SITE}#/supporter?thanks=1`,
      cancel_url: `${SITE}#/supporter`,
      client_reference_id: target,
      "metadata[playerId]": target,
      "metadata[months]": String(months),
      "metadata[buyer]": who.playerId,
      "metadata[gift]": target !== who.playerId ? "1" : "0",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(cents),
      "line_items[0][price_data][product_data][name]": `OCTIVE Supporter · ${months} month${months === 1 ? "" : "s"}${target !== who.playerId ? " (gift)" : ""}`,
      "line_items[0][price_data][product_data][description]": pct ? `${pct}% off · $2.50 a month` : "$2.50 a month",
      "payment_intent_data[metadata][playerId]": target,
      "payment_intent_data[metadata][months]": String(months),
    });
    return reply({ url: s.url });
  }
  if (path === "/support/grant") {
    // the developer (Senterra) gives supporter time for free
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    if (who.playerId !== OWNER) fail(403, "Only the OCTIVE developer can gift supporter for free.");
    const months = Math.round(Number(b.months));
    if (!(months >= 1 && months <= 120)) fail(400, "Choose 1 to 120 months.");
    const target = String(b.playerId || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(target)) fail(400, "That player can't be found.");
    const card = (await publicItems(config(env), target, ["card"])).card;
    if (!card || moderation.bans[target]) fail(400, "That player can't be found (they need to have played online once).");
    await addGift(env, target, { id: "free-" + crypto.randomUUID(), from: who.playerId, months, amount: 0, currency: "usd", free: true });
    return reply({ ok: true, name: card.name || "", pending: true });
  }
  if (path === "/support/gifts") {
    const who = await signedIn(request, env);
    return reply({ gifts: await pendingGifts(env, who.playerId) });
  }
  if (path === "/support/claim") {
    // a gift (paid or free) starts when its player claims it on the website
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const key = `gifts/${who.playerId}.json`;
    const g = await r2json(env, key, { pending: [] });
    const list = g.pending || [];
    const want = b.id ? list.filter((x) => x.id === String(b.id)) : list;
    if (!want.length) fail(404, "That gift was already claimed.");
    let rec = null;
    for (const x of want) rec = await grantMonths(env, who.playerId, x.months, { id: x.id, amount_total: x.amount, currency: x.currency, metadata: { gift: "1", buyer: x.from } });
    g.pending = list.filter((x) => !want.includes(x));
    await r2put(env, key, g);
    supportIndex = null;
    await syncSupporterRole(env, who.playerId);
    return reply({ ok: true, claimed: want.length, months: want.reduce((n, x) => n + x.months, 0), status: supportStatus(rec, who.playerId, await r2json(env, `boosters/${who.playerId}.json`, null)), gifts: g.pending });
  }
  if (path === "/support/me") {
    const who = await signedIn(request, env);
    const rec = await r2json(env, `supporters/${who.playerId}.json`, null);
    const looks = await r2json(env, `looks/${who.playerId}.json`, {});
    return reply({ ...supportStatus(rec, who.playerId, await r2json(env, `boosters/${who.playerId}.json`, null)), looks, history: (rec?.purchases || []).map((p) => ({ at: p.at, months: p.months, amount: p.amount, currency: p.currency })) });
  }
  if (path === "/support/gif") {
    // a supporter's animated picture, sent as the raw file (up to 8 MB; base64 JSON would be too slow)
    if (request.method !== "POST") fail(405, "Use POST.");
    const who = await signedIn(request, env);
    const st = supportStatus(await r2json(env, `supporters/${who.playerId}.json`, null), who.playerId, await r2json(env, `boosters/${who.playerId}.json`, null));
    if (!st.active) fail(403, "This is a supporter perk.");
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > GIF_MAX) fail(413, "That GIF is too big (8 MB at most).");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > GIF_MAX) fail(413, "That GIF is too big (8 MB at most).");
    if (bytes.length < 20 || !(bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) fail(400, "That isn't a GIF.");
    await env.RELEASES.put(`looks/gif/${who.playerId}.gif`, bytes, { httpMetadata: { contentType: "image/gif" } });
    const looks = await r2json(env, `looks/${who.playerId}.json`, {});
    looks.gif = Date.now().toString(36) + bytes.length.toString(36); // a version for caches
    await r2put(env, `looks/${who.playerId}.json`, looks);
    supportIndex = null;
    return reply({ ok: true, looks });
  }
  if (path === "/support/looks") {
    // supporters: name colours (bio codes), profile effect, banner picture, animated GIF profile picture
    const b = await bodyOf(request, 2_500_000);
    const who = await signedIn(request, env);
    const st = supportStatus(await r2json(env, `supporters/${who.playerId}.json`, null), who.playerId, await r2json(env, `boosters/${who.playerId}.json`, null));
    if (!st.active) fail(403, "This is a supporter perk.");
    const looks = await r2json(env, `looks/${who.playerId}.json`, {});
    if (b.nameStyle !== undefined) {
      let style = String(b.nameStyle || "").slice(0, 200);
      const plain = stripBio(style);
      const card = (await publicItems(config(env), who.playerId, ["card"])).card || {};
      const name = String(card.name || who.username || "");
      // capitals don't have to match: they're taken from the real name
      if (style && plain !== name && plain.toLowerCase() === name.toLowerCase()) style = fixNameCase(style, name);
      if (style && stripBio(style) !== name) fail(400, `The coloured name has to spell your name ("${name}"). Got "${plain}".`);
      looks.nameStyle = style;
    }
    if (b.effect !== undefined) {
      if (!EFFECTS.includes(b.effect)) fail(400, "Unknown effect.");
      looks.effect = b.effect;
    }
    if (b.banner !== undefined) {
      if (!b.banner) { looks.banner = ""; await env.RELEASES.delete(`looks/banner/${who.playerId}.jpg`); }
      else {
        if (!/^[A-Za-z0-9+/=]{100,1400000}$/.test(String(b.banner))) fail(400, "That banner couldn't be used.");
        const bytes = b64Bytes(String(b.banner));
        if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) fail(400, "Banners must be JPG.");
        await env.RELEASES.put(`looks/banner/${who.playerId}.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        looks.banner = (await sha256Hex(bytes)).slice(0, 16);
      }
    }
    if (b.gif !== undefined) {
      if (!b.gif) { looks.gif = ""; await env.RELEASES.delete(`looks/gif/${who.playerId}.gif`); }
      else {
        if (!/^[A-Za-z0-9+/=]{100,2400000}$/.test(String(b.gif))) fail(400, "That GIF is too big here; upload it with the GIF button.");
        const bytes = b64Bytes(String(b.gif));
        if (!(bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) fail(400, "That isn't a GIF.");
        await env.RELEASES.put(`looks/gif/${who.playerId}.gif`, bytes, { httpMetadata: { contentType: "image/gif" } });
        looks.gif = (await sha256Hex(bytes)).slice(0, 16);
      }
    }
    await r2put(env, `looks/${who.playerId}.json`, looks);
    supportIndex = null;
    return reply({ ok: true, looks });
  }
  let m = path.match(/^\/looks\/(banner|gif)\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    const o = await env.RELEASES.get(`looks/${m[1]}/${m[2]}.${m[1] === "gif" ? "gif" : "jpg"}`);
    if (!o) return cors(new Response("Not found", { status: 404 }));
    return cors(new Response(o.body, { headers: { "Content-Type": m[1] === "gif" ? "image/gif" : "image/jpeg", "Cache-Control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300" } }));
  }
  // who: followers, following or friends of a player (names and ranking numbers where known)
  m = path.match(/^\/social\/([A-Za-z0-9_-]{1,64})\/(followers|following|friends)$/);
  if (m) {
    const [, id, kind] = m;
    let board = { players: [] };
    try { board = await leaderboard(env); } catch { /* no names from the ranking */ }
    const byId = new Map(board.players.map((p) => [p.id, p]));
    let ids = [];
    const names = new Map();
    if (kind === "following") ids = await followingOf(env, id);
    else if (kind === "followers") ids = id === OWNER ? board.players.map((p) => p.id) : ((await r2json(env, `followers/${id}.json`, { followers: [] })).followers || []);
    else {
      const box = await r2json(env, dmInboxKey(id), dmEmptyInbox());
      for (const f of box.friends || []) { ids.push(f.id); names.set(f.id, f.name); }
    }
    ids = [...new Set(ids)].filter((x) => !moderation.bans[x]).slice(0, 1000);
    const players = ids.map((x) => {
      const b = byId.get(x);
      return { id: x, name: b?.name || names.get(x) || "Player", rank: b?.rank || null, pp: b?.pp || null, level: b?.level || null, online: b?.online || false };
    }).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    let mine = null;
    const h = request.headers.get("Authorization") || "";
    if (h.startsWith("Bearer ")) { try { const who = await signedIn(request, env); mine = who.playerId === id; } catch { /* signed out */ } }
    return reply({ kind, players, mine });
  }
  // following
  m = path.match(/^\/social\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    const id = m[1];
    const [following, followers] = await Promise.all([followingOf(env, id), followerCount(env, id)]);
    let youFollow = null;
    const h = request.headers.get("Authorization") || "";
    if (h.startsWith("Bearer ")) { try { const who = await signedIn(request, env); youFollow = (await followingOf(env, who.playerId)).includes(id); } catch { /* signed out */ } }
    let friends = null;
    try { friends = ((await r2json(env, dmInboxKey(id), dmEmptyInbox())).friends || []).length; } catch { /* none */ }
    let discord = null, discordUser = null;
    try {
      const rec = await record(env, id);
      if (rec.discord?.id && rec.discordPrefs?.show) {
        discord = rec.discord.name || null;
        // the username (what people type to add them); links made before 1.5 get it from Discord once
        if (!rec.discord.username && env.DISCORD_BOT_TOKEN) {
          try { const u = await discordApi(env, "GET", `/users/${rec.discord.id}`); if (u && u.username) { rec.discord.username = u.username; await saveRecord(env, id, rec); } } catch { /* later */ }
        }
        discordUser = rec.discord.username || null;
      }
    } catch { /* none */ }
    return reply({ following, followers, friends, youFollow, owner: OWNER, discord, discordUser });
  }
  if (path === "/follow") {
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const target = String(b.playerId || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(target) || target === who.playerId) fail(400, "You can't follow that player.");
    if (target === OWNER && !b.follow) fail(400, "Everyone follows the OCTIVE developer.");
    const f = await r2json(env, `follows/${who.playerId}.json`, { following: [] });
    const fr = await r2json(env, `followers/${target}.json`, { followers: [] });
    f.following = (f.following || []).filter((x) => x !== target);
    fr.followers = (fr.followers || []).filter((x) => x !== who.playerId);
    if (b.follow) { if (f.following.length >= 2000) fail(400, "You follow too many players."); f.following.push(target); fr.followers.push(who.playerId); }
    await Promise.all([r2put(env, `follows/${who.playerId}.json`, f), r2put(env, `followers/${target}.json`, fr)]);
    return reply({ ok: true, following: await followingOf(env, who.playerId), followers: await followerCount(env, target) });
  }
  return null;
}

// ---------------------------------------------------------------- private messages
// Messages between friends are kept here (R2), so they reach a friend who is offline, follow the player
// to every device and can be read and sent on the website. The game also pings an online friend through
// Unity Friends so a message shows at once; both copies carry the same id.
//   dm/inbox/<player>.json   { name, friends:[{id,name}], blocked:[id], synced, threads:{ <other>: {name,last,unread,preview,fromMe} } }
//   dm/thread/<a>__<b>.json  { msgs:[{id,from,text,at}] }   (a < b, the newest DM_KEEP messages)
// Only friends can message each other: the game uploads the player's friend and block lists
// (POST /dm/friends) and a message needs the RECEIVER's list to include the sender.

const DM_KEEP = 500;
const DM_FILE_DAYS = 7;   // sent files nobody opened are removed after this

/** Removes sent files nobody downloaded within a week (the cron job). */
async function cleanDmFiles(env) {
  let cursor;
  const now = Date.now();
  do {
    const list = await env.RELEASES.list({ prefix: "dm/files/", cursor, include: ["customMetadata"] });
    const old = list.objects.filter((o) => now - Number(o.customMetadata?.at || Date.parse(o.uploaded) || 0) > DM_FILE_DAYS * 86_400_000).map((o) => o.key);
    if (old.length) await env.RELEASES.delete(old);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
const DM_THREADS = 300;
const DM_ID = /^[A-Za-z0-9_-]{8,64}$/;
const dmRate = new Map();           // player -> recent send times (per Worker instance)
let dmModerationAt = 0;

const dmPair = (a, b) => (a < b ? `${a}__${b}` : `${b}__${a}`);
const dmInboxKey = (id) => `dm/inbox/${id}.json`;
const dmThreadKey = (a, b) => `dm/thread/${dmPair(a, b)}.json`;
const dmEmptyInbox = () => ({ name: "", friends: [], blocked: [], threads: {} });
const dmName = (s) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);

/** Reads, changes and writes an R2 JSON object, retrying when another request wrote it in between. */
async function r2update(env, key, fallback, change) {
  for (let i = 0; i < 6; i++) {
    const o = await env.RELEASES.get(key);
    let v = fallback();
    if (o) { try { v = await o.json(); } catch { /* start again */ } }
    if (change(v) === false) return v;
    const opts = { httpMetadata: { contentType: "application/json" } };
    if (o) opts.onlyIf = { etagMatches: o.etag };
    const put = await env.RELEASES.put(key, JSON.stringify(v), opts);
    if (put) return v;
  }
  fail(503, "The message server is busy. Try again in a moment.");
}

function dmTrim(box) {
  const ids = Object.keys(box.threads || {});
  if (ids.length <= DM_THREADS) return;
  ids.sort((a, b) => (box.threads[b].last || 0) - (box.threads[a].last || 0));
  for (const id of ids.slice(DM_THREADS)) delete box.threads[id];
}

// ---------------------------------------------------------------- global chat (game <-> Discord #octive-chat)
// One public room. Messages from the game are stored in R2 (chat/global.json, the newest CHAT_KEEP) and posted
// to the Discord channel through a webhook (the player's name and picture). Discord messages are pulled into
// the room when someone reads it (at most every CHAT_PULL_MS) with the bot. Set up by Tools/discord_chat_setup.py
// (secrets DISCORD_CHAT_CHANNEL_ID and DISCORD_CHAT_WEBHOOK); without them the chat is game-only.
const CHAT_KEY = "chat/global.json";
const CHAT_KEEP = 200;
const CHAT_MAX = 300;
const CHAT_PULL_MS = 4000;
let chatPulledAt = 0, chatPulling = null;
const chatEmpty = () => ({ seq: 0, msgs: [], lastDiscord: null });

/** Discord text as plain text for the game: mentions, channels, roles and custom emoji become readable. */
function discordToText(m) {
  let t = String(m.content || "");
  for (const u of m.mentions || []) t = t.split(`<@${u.id}>`).join("@" + (u.global_name || u.username)).split(`<@!${u.id}>`).join("@" + (u.global_name || u.username));
  t = t.replace(/<@!?\d+>/g, "@someone").replace(/<@&\d+>/g, "@role").replace(/<#\d+>/g, "#channel")
    .replace(/<a?:(\w+):\d+>/g, ":$1:").replace(/<t:(\d+)(:\w)?>/g, (_, s) => new Date(Number(s) * 1000).toUTCString());
  if (!t.trim() && (m.attachments || []).length) t = "[sent " + (m.attachments.length === 1 ? "a file" : m.attachments.length + " files") + "]";
  if (!t.trim() && (m.sticker_items || []).length) t = "[sticker: " + m.sticker_items[0].name + "]";
  return t.slice(0, CHAT_MAX);
}

const webhookId = (env) => (String(env.DISCORD_CHAT_WEBHOOK || "").match(/webhooks\/(\d+)\//) || [])[1] || null;

/** How a player shows in the chat: their OCTIVE name, picture and badges (moderation overrides first). */
async function chatIdentity(cfg, playerId, fallbackName) {
  let card = {};
  try { card = (await publicItems(cfg, playerId, ["card"])).card || {}; } catch { /* fallback */ }
  const ov = moderation.overrides[playerId] || {};
  const name = String(ov.name || card.name || fallbackName || "Player").slice(0, 40);
  const avatarHash = ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : String(card.avatar || "");
  return { id: playerId, name, badges: badgesOf(playerId), check: checkOf(playerId), avatar: avatarHash ? `${WORKER_BASE}/avatar/${encodeURIComponent(playerId)}?v=${encodeURIComponent(avatarHash)}` : null };
}

/** Discord markdown as plain text (bold, code, timestamps, custom emoji). */
const chatPlain = (t) => discordToText({ content: String(t || "") }).replace(/\*\*|__|~~|`/g, "").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1").trim();

/** An OCTIVE command answer posted in the channel, short enough for the game's chat. */
function commandCard(m) {
  const name = m.interaction_metadata?.name || m.interaction?.name || "command";
  const e = (m.embeds || [])[0] || null;
  const title = e ? chatPlain(e.title || e.author?.name || "") : "";
  let lines = [];
  if (e) {
    lines = chatPlain(e.description || "").split("\n").map((x) => x.trim()).filter((x) => x && x !== "\u3000");
    for (const f of e.fields || []) if (lines.length < 6) lines.push(`${chatPlain(f.name)}: ${chatPlain(f.value).split("\n")[0]}`);
  } else lines = chatPlain(m.content || "").split("\n").filter(Boolean);
  lines = lines.slice(0, 6).map((x) => x.slice(0, 120));
  return { name: String(name).split(" ")[0].slice(0, 32), title: title.slice(0, 100), lines, url: e?.url || null };
}

/** New messages from the Discord channel into the room. */
async function chatPull(env) {
  if (!env.DISCORD_CHAT_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) return;
  if (Date.now() - chatPulledAt < CHAT_PULL_MS) return chatPulling;
  chatPulledAt = Date.now();
  chatPulling = (async () => {
    const box = await r2json(env, CHAT_KEY, chatEmpty());
    const after = box.lastDiscord ? `&after=${box.lastDiscord}` : "";
    const res = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages?limit=50${after}`, {
      headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" },
    });
    if (!res.ok) { console.log("chat pull", res.status); return; }
    let list = (await res.json()).filter((m) => m && m.id).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    // a command still "thinking": wait for its answer (but never longer than a minute)
    const thinking = list.findIndex((m) => m.type === 20 && (Number(m.flags || 0) & 128) && Date.now() - Date.parse(m.timestamp) < 60_000);
    if (thinking >= 0) list = list.slice(0, thinking);
    if (!list.length) return;
    const ours = webhookId(env);
    const isCommand = (m) => m.type === 20 && (m.application_id === DISCORD_APP_ID || m.author?.id === DISCORD_APP_ID);
    // Discord people who linked their OCTIVE account appear as their OCTIVE player
    const who = new Map();
    const cfg = config(env);
    try { await loadModeration(cfg); } catch { /* badges may be missing */ }
    for (const m of list) {
      const u = isCommand(m) ? (m.interaction_metadata?.user || m.interaction?.user) : m.author;
      if (!u?.id || who.has(u.id) || (u.bot && !isCommand(m))) continue;
      who.set(u.id, null);
      const pid = await linkedPlayer(env, u.id);
      if (pid) who.set(u.id, await chatIdentity(cfg, pid, u.global_name || u.username));
    }
    const discordFrom = (u, member) => {
      const shown = String(member?.nick || u?.global_name || u?.username || "Discord user").slice(0, 40);
      const linked = u?.id ? who.get(u.id) : null;
      if (linked) return { ...linked, discord: shown, discordId: u.id };
      return { id: "discord:" + (u?.id || "0"), name: shown, discordId: u?.id || null, avatar: u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null };
    };
    await r2update(env, CHAT_KEY, chatEmpty, (b) => {
      let changed = false;
      for (const m of list) {
        if (b.lastDiscord && BigInt(m.id) <= BigInt(b.lastDiscord)) continue;
        b.lastDiscord = m.id; changed = true;
        if (m.webhook_id && m.webhook_id === ours) continue; // our own copy of a game message
        if (isCommand(m)) {
          // someone used an OCTIVE command in the channel: show who and the answer
          const u = m.interaction_metadata?.user || m.interaction?.user || {};
          const cmd = commandCard(m);
          b.msgs.push({ seq: ++b.seq, id: "d" + m.id, at: m.timestamp || new Date().toISOString(), src: "command", text: "/" + cmd.name, cmd, from: discordFrom(u, m.interaction?.member) });
          continue;
        }
        if (m.author?.bot || (m.type !== 0 && m.type !== 19)) continue; // bots and system messages
        const text = discordToText(m);
        if (!text.trim()) continue;
        const from = discordFrom(m.author || {}, m.member);
        b.msgs.push({ seq: ++b.seq, id: "d" + m.id, at: m.timestamp || new Date().toISOString(), src: "discord", text, from, linked: !from.id.startsWith("discord:") });
      }
      if (!changed) return false;
      if (b.msgs.length > CHAT_KEEP) b.msgs = b.msgs.slice(-CHAT_KEEP);
    });
  })().catch((e) => console.log("chat pull failed", e && e.message)).finally(() => { chatPulling = null; });
  return chatPulling;
}

async function chatRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (path === "/chat/global" && request.method === "GET") {
    await chatPull(env);
    const after = Number(url.searchParams.get("after") || 0);
    const box = await r2json(env, CHAT_KEY, chatEmpty());
    const msgs = (box.msgs || []).filter((m) => m.seq > after && !moderation.bans[m.from?.id]);
    return reply({ seq: box.seq || 0, msgs: after ? msgs : msgs.slice(-80), discord: !!env.DISCORD_CHAT_CHANNEL_ID, channel: env.DISCORD_CHAT_CHANNEL_ID || null, guild: env.DISCORD_GUILD_ID || null });
  }
  if (path === "/chat/send" && request.method === "POST") {
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    let text = String(b.text || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) fail(400, "Type a message first.");
    if (text.length > CHAT_MAX) fail(400, `Messages can be ${CHAT_MAX} characters at most.`);
    // a little slow-down: 1 message every 1.5 s and 12 a minute per player
    const rl = await r2json(env, `chat/rate/${who.playerId}.json`, { at: [] });
    const now = Date.now();
    rl.at = (rl.at || []).filter((t) => now - t < 60_000);
    if (rl.at.length && now - rl.at[rl.at.length - 1] < 1500) fail(429, "Slow down a little.");
    if (rl.at.length >= 12) fail(429, "You're sending a lot of messages. Wait a minute.");
    rl.at.push(now);
    await r2put(env, `chat/rate/${who.playerId}.json`, rl);
    const from = await chatIdentity(cfg, who.playerId, who.username);
    const name = from.name;
    const msg = { id: "g" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), at: new Date().toISOString(), src: "game", text, from };
    const box = await r2update(env, CHAT_KEY, chatEmpty, (bx) => {
      msg.seq = ++bx.seq;
      bx.msgs.push(msg);
      if (bx.msgs.length > CHAT_KEEP) bx.msgs = bx.msgs.slice(-CHAT_KEEP);
    });
    // and into the Discord channel, as the player (no pings)
    if (env.DISCORD_CHAT_WEBHOOK) ctx.waitUntil((async () => {
      const badge = (msg.from.badges || []).includes("DEV") ? " 🛠️" : (msg.from.badges || []).includes("MOD") ? " 🛡️" : "";
      const r = await fetch(env.DISCORD_CHAT_WEBHOOK + "?wait=true", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" },
        body: JSON.stringify({ content: text, username: `${name}${badge} · OCTIVE`.slice(0, 80), avatar_url: msg.from.avatar || `${SITE}logo-512.png`, allowed_mentions: { parse: [] } }),
      });
      if (!r.ok) { console.log("chat webhook", r.status, (await r.text()).slice(0, 200)); return; }
      const posted = await r.json();
      await r2update(env, CHAT_KEY, chatEmpty, (bx) => {
        const m = bx.msgs.find((x) => x.id === msg.id);
        if (!m) return false;
        m.discordId = posted.id;
        if (!bx.lastDiscord || BigInt(posted.id) > BigInt(bx.lastDiscord)) { /* pulled later and skipped as our own */ }
      });
    })().catch((e) => console.log("chat webhook failed", e && e.message)));
    return reply({ ok: true, msg, seq: box.seq });
  }
  if (path === "/chat/delete" && request.method === "POST") {
    // developers and moderators: remove a message (and its Discord copy)
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    await loadModeration(config(env));
    const badges = badgesOf(who.playerId);
    if (!(badges.includes("DEV") || badges.includes("MOD") || who.playerId === OWNER)) fail(403, "Only moderators can remove messages.");
    let removed = null;
    await r2update(env, CHAT_KEY, chatEmpty, (bx) => {
      const i = bx.msgs.findIndex((x) => x.id === String(b.id || ""));
      if (i < 0) return false;
      removed = bx.msgs.splice(i, 1)[0];
    });
    if (!removed) fail(404, "That message is already gone.");
    if (removed.discordId && env.DISCORD_CHAT_WEBHOOK) ctx.waitUntil(fetch(`${env.DISCORD_CHAT_WEBHOOK}/messages/${removed.discordId}`, { method: "DELETE" }).catch(() => {}));
    else if ((removed.src === "discord" || removed.src === "command") && env.DISCORD_BOT_TOKEN && env.DISCORD_CHAT_CHANNEL_ID)
      ctx.waitUntil(fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages/${removed.id.slice(1)}`, { method: "DELETE", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } }).catch(() => {}));
    return reply({ ok: true });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- workshop: charts, skins, themes and styles shared from the game
// The game uploads a file (POST /api/upload, multipart); the bot posts it to the matching read-only channel
// (#octive-charts / -skins / -themes / -styles) with the file attached and an embed with the details and a
// preview. Only the channel and message ids are kept (Discord's file links expire): a download asks Discord for
// the message again and caches the fresh link for up to 12 hours. Previews are kept in R2 for the item lists.
const WS_TYPES = { ".oct": "charts", ".octskin": "skins", ".octtheme": "themes", ".octstyle": "styles" };
const WS_CHANNEL = { charts: "octive-charts", skins: "octive-skins", themes: "octive-themes", styles: "octive-styles" };
const WS_LABEL = { charts: "Chart", skins: "Skin", themes: "Theme", styles: "Style" };
const WS_COLOR = { charts: 0x8b7bff, skins: 0xff5c8a, themes: 0x4fd6e8, styles: 0xffb84f };
const WS_DB = "workshop/items.json";
const WS_URL_TTL = 12 * 3600_000;
let wsChannels = null, wsChannelsAt = 0, wsTier = null, wsTierAt = 0;
const wsUrls = new Map(); // item id -> { url, until }

async function discordApi(env, method, path, body, isForm) {
  const headers = { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" };
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  const res = await fetch("https://discord.com/api/v10" + path, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) { const e = new Error(`Discord ${res.status}: ${(data && data.message) || text.slice(0, 200)}`); e.status = res.status; throw e; }
  return data;
}

const scoreShareAt = new Map();
let scoresChannel = null, scoresChannelAt = 0;
/** #octive-scores, found by name (cached 10 minutes). */
async function scoresChannelId(env) {
  if (scoresChannel && Date.now() - scoresChannelAt < 600_000) return scoresChannel;
  const list = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  const c = (list || []).find((x) => x.name === "octive-scores" && (x.type === 0 || x.type === 5));
  scoresChannel = c ? c.id : null; scoresChannelAt = Date.now();
  return scoresChannel;
}

/** The four channels, found by name (cached 10 minutes). */
async function wsChannelIds(env) {
  if (wsChannels && Date.now() - wsChannelsAt < 600_000) return wsChannels;
  const list = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  const out = {};
  for (const [type, name] of Object.entries(WS_CHANNEL)) { const c = (list || []).find((x) => x.name === name && (x.type === 0 || x.type === 5)); if (c) out[type] = c.id; }
  wsChannels = out; wsChannelsAt = Date.now();
  return out;
}

/** The biggest file the server takes now (it follows the boost level, checked every 10 minutes), less a safety margin. */
async function wsMaxBytes(env) {
  if (wsTier === null || Date.now() - wsTierAt > 600_000) {
    try { const g = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}`); wsTier = Number(g.premium_tier || 0); wsTierAt = Date.now(); }
    catch { wsTier = wsTier ?? 0; }
  }
  const limitMB = wsTier >= 3 ? 100 : wsTier === 2 ? 50 : 10;
  return limitMB * 1048576 - 1_000_000; // room for the preview and the message itself
}

// ---- zip archives, read in memory (only what's needed: the file list and one picture)

/** The entries of a zip; throws on anything unsafe (paths that climb out, absolute paths, too many files). */
function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail(400, "That file isn't a valid OCTIVE package (not a zip archive).");
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count > 20000) fail(400, "That package has too many files.");
  const dec = new TextDecoder();
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) fail(400, "That package is damaged (its file list is broken).");
    const method = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    // Zip Slip: nothing may climb out of the folder it's unpacked into
    const parts = name.replace(/\\/g, "/").split("/");
    if (!name || name.includes("\0") || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || parts.includes("..")) fail(400, `That package has an unsafe path inside ("${name.slice(0, 80)}").`);
    out.push({ name: name.replace(/\\/g, "/"), method, comp, size, local });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function zipRead(u8, e, max = 8 * 1048576) {
  if (e.size > max || e.comp > max) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (e.local + 30 > u8.length || dv.getUint32(e.local, true) !== 0x04034b50) return null;
  const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  const raw = u8.subarray(start, start + e.comp);
  if (e.method === 0) return raw;
  if (e.method !== 8) return null;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return buf.length > max ? null : buf;
}

const isImageName = (n) => /\.(png|jpe?g)$/i.test(n);
const imageType = (b) => b && b.length > 4 && b[0] === 0x89 && b[1] === 0x50 ? "png" : b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 ? "jpg" : null;

/** The preview of a package: preview.png/.jpg, else the song's cover / the skin's note picture. */
async function zipPreview(u8, entries, kind) {
  const by = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const tryName = async (n) => { const e = n && by.get(String(n).replace(/\\/g, "/").toLowerCase()); if (!e) return null; const b = await zipRead(u8, e); return imageType(b) ? b : null; };
  for (const n of ["preview.png", "preview.jpg", "preview.jpeg"]) { const b = await tryName(n); if (b) return b; }
  const anyPreview = entries.find((e) => /(^|\/)preview\.(png|jpe?g)$/i.test(e.name));
  if (anyPreview) { const b = await tryName(anyPreview.name); if (b) return b; }
  // what the package's manifest points at
  const man = by.get(kind === "skins" ? "skin.json" : "manifest.json");
  if (man) {
    try {
      const m = JSON.parse(new TextDecoder().decode(await zipRead(u8, man, 2 * 1048576)));
      const wanted = kind === "skins"
        ? [m.images?.note, m.images?.receptor, m.images?.background]
        : [m.song?.cover, m.song?.background, m.cover, m.artwork?.cover, m.song?.artwork?.cover, m.background];
      for (const n of wanted) { const b = await tryName(n); if (b) return b; }
    } catch { /* no manifest picture */ }
  }
  const guess = entries.filter((e) => isImageName(e.name) && /cover|bg|background|note/i.test(e.name)).sort((a, b) => a.size - b.size)[0];
  return guess ? await tryName(guess.name) : null;
}

/** Checks a file and finds its preview; returns { preview } or throws a readable error. */
async function wsInspect(kind, u8) {
  if (kind === "charts" || kind === "skins") {
    const entries = zipEntries(u8);
    const need = kind === "skins" ? "skin.json" : "manifest.json";
    if (!entries.some((e) => e.name.toLowerCase() === need)) fail(400, `That doesn't look like an OCTIVE ${kind === "skins" ? "skin" : "song"}: ${need} is missing.`);
    return { preview: await zipPreview(u8, entries, kind) };
  }
  // themes and styles are JSON
  let o;
  try { o = JSON.parse(new TextDecoder().decode(u8)); } catch { fail(400, `That ${kind === "themes" ? "theme" : "style"} file isn't valid.`); }
  if (kind === "styles") {
    if (o.format !== "octive.style") fail(400, "That isn't an OCTIVE style (.octstyle).");
    // a style's skin is inside it: its preview is the skin's
    if (typeof o.skin === "string" && o.skin.length < 60_000_000) {
      try {
        const bin = Uint8Array.from(atob(o.skin), (c) => c.charCodeAt(0));
        const entries = zipEntries(bin);
        return { preview: await zipPreview(bin, entries, "skins") };
      } catch (e) { if (e.status) throw e; }
    }
    return { preview: null };
  }
  if (!o || typeof o !== "object" || !(o.colors || o.Colors)) fail(400, "That isn't an OCTIVE theme (.octtheme).");
  return { preview: null };
}

const wsPublic = (it) => ({
  id: it.id, type: it.type, title: it.title, description: it.description, creator: it.creator, creatorId: it.creatorId,
  fileName: it.fileName, size: it.size, at: it.at, downloads: it.downloads || 0, updated: it.updatedAt || null, version: it.version || 1,
  preview: it.preview ? `${WORKER_BASE}/api/preview/${it.id}` : null,
  discord: it.channelId && it.messageId && it.guildId ? `https://discord.com/channels/${it.guildId}/${it.channelId}/${it.messageId}` : null,
});

async function workshopRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  // ---- list
  if (path === "/api/items" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const sort = url.searchParams.get("sort") || "new";
    const db = await r2json(env, WS_DB, { items: [] });
    // ?creator=<playerId>: only that player's uploads (their profile and their Workshop page)
    const creator = String(url.searchParams.get("creator") || "").trim();
    let items = (db.items || []).filter((it) => !it.removed && (!type || it.type === type) && (!creator || it.creatorId === creator));
    if (q) items = items.filter((it) => `${it.title} ${it.creator} ${it.description}`.toLowerCase().includes(q));
    items.sort(sort === "popular" ? (a, b) => (b.downloads || 0) - (a.downloads || 0) || b.at - a.at : (a, b) => b.at - a.at);
    const counts = {};
    for (const it of db.items || []) if (!it.removed) counts[it.type] = (counts[it.type] || 0) + 1;
    return reply({ items: items.slice(0, 300).map(wsPublic), counts, maxBytes: await wsMaxBytes(env).catch(() => null) });
  }

  // ---- a preview picture (kept in R2, so lists never depend on Discord's expiring links)
  let m = path.match(/^\/api\/preview\/([a-z0-9]{16,40})$/);
  if (m && request.method === "GET") {
    const o = await env.RELEASES.get(`workshop/previews/${m[1]}`);
    if (!o) return cors(new Response("Not found", { status: 404 }));
    return cors(new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType || "image/png", "Cache-Control": "public, max-age=86400" } }));
  }

  // ---- download: a fresh Discord link (cached up to 12 hours)
  m = path.match(/^\/api\/download\/([a-z0-9]{16,40})$/);
  if (m && request.method === "GET") {
    const db = await r2json(env, WS_DB, { items: [] });
    const it = (db.items || []).find((x) => x.id === m[1] && !x.removed);
    if (!it) fail(404, "That item isn't available any more.");
    let c = wsUrls.get(it.id);
    if (!c || c.until < Date.now()) {
      let msg;
      try { msg = await discordApi(env, "GET", `/channels/${it.channelId}/messages/${it.messageId}`); }
      catch (e) { if (e.status === 404) fail(404, "That item was removed from Discord."); throw e; }
      const att = (msg.attachments || []).find((a) => a.filename === it.fileName) || (msg.attachments || []).find((a) => !/^preview\./i.test(a.filename));
      if (!att) fail(404, "That item's file is missing on Discord.");
      // Discord's links say when they run out (ex=hex seconds); never keep one past that
      let until = Date.now() + WS_URL_TTL;
      const ex = (att.url.match(/[?&]ex=([0-9a-f]+)/) || [])[1];
      if (ex) until = Math.min(until, parseInt(ex, 16) * 1000 - 300_000);
      c = { url: att.url, until };
      wsUrls.set(it.id, c);
      if (wsUrls.size > 2000) wsUrls.delete(wsUrls.keys().next().value);
    }
    ctx.waitUntil(r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; x.downloads = (x.downloads || 0) + 1; }).catch(() => {}));
    if (url.searchParams.get("redirect") === "1") return cors(Response.redirect(c.url, 302));
    return reply({ url: c.url, fileName: it.fileName, size: it.size, type: it.type, title: it.title });
  }

  // ---- upload from the game
  if (path === "/api/upload" && request.method === "POST") {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) fail(503, "Uploads aren't set up on the server.");
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    // a few uploads a day per player
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `workshop/rate/${who.playerId}.json`;
    const rate = await r2json(env, rateKey, { day, n: 0 });
    if (rate.day !== day) { rate.day = day; rate.n = 0; }
    const isStaff = badgesOf(who.playerId).some((b) => b === "DEV" || b === "MOD");
    if (rate.n >= 15 && !isStaff) fail(429, "You've uploaded a lot today. Try again tomorrow.");

    const max = await wsMaxBytes(env);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > max + 200_000) fail(413, `That's too big: the OCTIVE Discord takes files up to ${Math.floor(max / 1048576)} MB right now.`);
    let form;
    try { form = await request.formData(); } catch { fail(400, "The upload wasn't readable (multipart/form-data expected)."); }
    const file = form.get("file");
    if (!file || typeof file === "string") fail(400, "No file was attached.");
    const fileName = String(file.name || "item").replace(/[^A-Za-z0-9 ._()\[\]'&+,-]/g, "_").slice(0, 100);
    const ext = (fileName.match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase();
    const type = WS_TYPES[ext];
    if (!type) fail(400, "Only .oct (charts), .octskin (skins), .octtheme (themes) and .octstyle (styles) files can be shared.");
    if (file.size > max) fail(413, `That's too big: the OCTIVE Discord takes files up to ${Math.floor(max / 1048576)} MB right now.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { preview } = await wsInspect(type, bytes);

    const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@​$1").trim().slice(0, n);
    const card = (await publicItems(cfg, who.playerId, ["card"]).catch(() => ({}))).card || {};
    const creator = clean(moderation.overrides[who.playerId]?.name || card.name || form.get("creator") || who.username || "Player", 40);
    const title = clean(form.get("title"), 80) || fileName.replace(/\.[^.]+$/, "");
    const description = clean(form.get("description"), 1000);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    let creatorDiscord = null;
    try { const rec = await record(env, who.playerId); creatorDiscord = rec.discord?.id || null; } catch { /* not linked */ }

    const channels = await wsChannelIds(env);
    const channelId = channels[type];
    if (!channelId) fail(503, `The #${WS_CHANNEL[type]} channel wasn't found on the OCTIVE Discord.`);
    const pType = imageType(preview);
    const embed = {
      title: `${WS_LABEL[type]}: ${title}`.slice(0, 256), color: WS_COLOR[type],
      description: description || undefined,
      author: { name: `by ${creator}`, url: `${SITE}#/u/${encodeURIComponent(who.playerId)}` },
      fields: [
        // a linked Discord gets the credit (shown as their name, no ping)
        ...(creatorDiscord ? [{ name: "Made by", value: `<@${creatorDiscord}>`, inline: true }] : []),
        { name: "File", value: `${fileName} · ${(bytes.length / 1048576).toFixed(bytes.length < 1048576 ? 2 : 1)} MB`, inline: true },
        { name: "Get it", value: `Download the file above, or [open it in OCTIVE](${SITE}#/open/workshop/${id})`, inline: true },
      ],
      footer: { text: `Shared from OCTIVE · ${id}` },
      timestamp: new Date().toISOString(),
    };
    if (pType) embed.image = { url: `attachment://preview.${pType}` };
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({
      embeds: [embed], allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: fileName }, ...(pType ? [{ id: 1, filename: `preview.${pType}` }] : [])],
    }));
    fd.append("files[0]", new Blob([bytes], { type: "application/octet-stream" }), fileName);
    if (pType) fd.append("files[1]", new Blob([preview], { type: pType === "png" ? "image/png" : "image/jpeg" }), `preview.${pType}`);
    let posted;
    try { posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, fd, true); }
    catch (e) { if (e.status === 413) fail(413, "Discord refused the file: it's too big for the server right now."); throw e; }

    if (pType) await env.RELEASES.put(`workshop/previews/${id}`, preview, { httpMetadata: { contentType: pType === "png" ? "image/png" : "image/jpeg" } });
    const item = { id, type, title, description, creator, creatorId: who.playerId, fileName, size: bytes.length, channelId, messageId: posted.id, guildId: env.DISCORD_GUILD_ID, at: Date.now(), downloads: 0, preview: !!pType };
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => { d.items = d.items || []; d.items.push(item); });
    rate.n += 1;
    await r2put(env, rateKey, rate);
    return reply({ ok: true, item: wsPublic(item) });
  }

  // ---- a score shared from the results screen: the picture goes to #octive-scores
  if (path === "/api/score-share" && request.method === "POST") {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) fail(503, "Score sharing isn't set up on the server.");
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    // one share every 20 seconds, 40 a day
    const now = Date.now();
    const last = scoreShareAt.get(who.playerId) || 0;
    if (now - last < 20_000) fail(429, "Wait a few seconds before sharing another score.");
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `scores/rate/${who.playerId}.json`;
    const rate = await r2json(env, rateKey, { day, n: 0 });
    if (rate.day !== day) { rate.day = day; rate.n = 0; }
    if (rate.n >= 40) fail(429, "You've shared a lot of scores today. Try again tomorrow.");
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 8_500_000) fail(413, "That picture is too big.");
    let form;
    try { form = await request.formData(); } catch { fail(400, "The share wasn't readable (multipart/form-data expected)."); }
    const file = form.get("image");
    if (!file || typeof file === "string") fail(400, "No picture was attached.");
    if (file.size > 8_000_000) fail(413, "That picture is too big.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = imageType(bytes);
    if (kind !== "png" && kind !== "jpg") fail(400, "The picture must be a PNG or JPG.");
    let info = {};
    try { info = JSON.parse(String(form.get("info") || "{}")) || {}; } catch { /* none */ }
    const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@\u200b$1").replace(/[*_~`|>]/g, "").trim().slice(0, n);
    const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null; };
    const card = (await publicItems(cfg, who.playerId, ["card"]).catch(() => ({}))).card || {};
    const name = clean(moderation.overrides[who.playerId]?.name || card.name || who.username || "Player", 40);
    const title = clean(info.title, 120) || "A song";
    const sub = clean(info.subtitle, 160);
    const grade = clean(info.grade, 4);
    const score = num(info.score, 0, 10_000_000), acc = num(info.accuracy, 0, 100), pr = num(info.pp, 0, 100_000), stars = num(info.stars, 0, 100);
    const combo = num(info.maxCombo, 0, 1_000_000), notes = num(info.notes, 0, 1_000_000);
    const tags = (Array.isArray(info.tags) ? info.tags : []).map((t) => clean(t, 20)).filter(Boolean).slice(0, 4);
    let discordId = null;
    try { const rec = await record(env, who.playerId); discordId = rec.discord?.id || null; } catch { /* not linked */ }

    const channelId = await scoresChannelId(env);
    if (!channelId) fail(503, "The #octive-scores channel wasn't found on the OCTIVE Discord.");
    const avatarHash = moderation.overrides[who.playerId]?.avatar ? "mod-" + Date.parse(moderation.overrides[who.playerId].at) : (card.avatar || "");
    const gradeColor = { X: 0x7FF5FF, SS: 0x7FF5FF, S: 0xF2C14E, A: 0x3DDC84, B: 0x5DA9FF, C: 0xB69BFF, D: 0xFF6F6F }[grade] || C_ACCENT;
    const fields = [
      ...(score !== null ? [{ name: "Score", value: Math.round(score).toLocaleString("en-US"), inline: true }] : []),
      ...(acc !== null ? [{ name: "Accuracy", value: `${acc.toFixed(2)}%${grade ? ` · ${grade}` : ""}`, inline: true }] : []),
      ...(pr !== null ? [{ name: "Performance", value: `${Math.round(pr).toLocaleString("en-US")} PR${stars !== null ? ` · ★${stars.toFixed(2)}` : ""}`, inline: true }] : []),
      ...(combo !== null ? [{ name: "Max combo", value: `${Math.round(combo).toLocaleString("en-US")}x${notes ? ` / ${Math.round(notes).toLocaleString("en-US")}` : ""}`, inline: true }] : []),
      ...(tags.length ? [{ name: "\u200b", value: tags.map((t) => `**${t}**`).join(" · "), inline: true }] : []),
    ];
    const embed = {
      color: gradeColor,
      author: { name, url: `${SITE}#/u/${encodeURIComponent(who.playerId)}`, ...(avatarHash ? { icon_url: `${WORKER_BASE}/avatar/${encodeURIComponent(who.playerId)}?v=${encodeURIComponent(avatarHash)}` } : {}) },
      title: title.slice(0, 256), description: sub || undefined, fields,
      image: { url: `attachment://score.${kind}` },
      footer: { text: "Shared from OCTIVE" }, timestamp: new Date().toISOString(),
    };
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({
      content: discordId ? `<@${discordId}> shared a score` : undefined,
      embeds: [embed], allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: `score.${kind}` }],
    }));
    fd.append("files[0]", new Blob([bytes], { type: kind === "png" ? "image/png" : "image/jpeg" }), `score.${kind}`);
    const posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, fd, true);
    scoreShareAt.set(who.playerId, now);
    if (scoreShareAt.size > 5000) scoreShareAt.delete(scoreShareAt.keys().next().value);
    rate.n += 1;
    await r2put(env, rateKey, rate);
    return reply({ ok: true, url: `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${channelId}/${posted.id}` });
  }

  // ---- update (the creator, or developers and moderators): a new file, title or description. The post in the
  // OCTIVE Discord is edited in place (same link), and downloads get the new file at once.
  m = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/update$/);
  if (m && request.method === "POST") {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) fail(503, "Uploads aren't set up on the server.");
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    const db = await r2json(env, WS_DB, { items: [] });
    const it = (db.items || []).find((x) => x.id === m[1] && !x.removed);
    if (!it) fail(404, "That item isn't available any more.");
    const staff = badgesOf(who.playerId).some((b) => b === "DEV" || b === "MOD") || who.playerId === OWNER;
    if (it.creatorId !== who.playerId && !staff) fail(403, "Only the person who shared it can update it.");
    const max = await wsMaxBytes(env);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > max + 200_000) fail(413, `That's too big: the OCTIVE Discord takes files up to ${Math.floor(max / 1048576)} MB right now.`);
    let form;
    try { form = await request.formData(); } catch { fail(400, "The update wasn't readable (multipart/form-data expected)."); }
    const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@\u200b$1").trim().slice(0, n);
    const title = form.get("title") != null ? clean(form.get("title"), 80) || it.title : it.title;
    const description = form.get("description") != null ? clean(form.get("description"), 1000) : it.description;
    const file = form.get("file");
    let bytes = null, fileName = it.fileName, preview = null;
    if (file && typeof file !== "string") {
      fileName = String(file.name || it.fileName).replace(/[^A-Za-z0-9 ._()\[\]'&+,-]/g, "_").slice(0, 100);
      const ext = (fileName.match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase();
      if (WS_TYPES[ext] !== it.type) fail(400, `An update must be the same kind of file (${WS_LABEL[it.type].toLowerCase()}).`);
      if (file.size > max) fail(413, `That's too big: the OCTIVE Discord takes files up to ${Math.floor(max / 1048576)} MB right now.`);
      bytes = new Uint8Array(await file.arrayBuffer());
      ({ preview } = await wsInspect(it.type, bytes));
    }
    // a few updates a day per player (they count with uploads)
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `workshop/rate/${who.playerId}.json`;
    const rate = await r2json(env, rateKey, { day, n: 0 });
    if (rate.day !== day) { rate.day = day; rate.n = 0; }
    if (rate.n >= 30 && !staff) fail(429, "You've shared and updated a lot today. Try again tomorrow.");

    let creatorDiscord = null;
    try { const rec = await record(env, it.creatorId); creatorDiscord = rec.discord?.id || null; } catch { /* not linked */ }
    const size = bytes ? bytes.length : it.size;
    const version = (it.version || 1) + (bytes ? 1 : 0);
    const pType = preview ? imageType(preview) : null;
    const hasOldPreview = !bytes && it.preview;
    const embed = {
      title: `${WS_LABEL[it.type]}: ${title}`.slice(0, 256), color: WS_COLOR[it.type],
      description: description || undefined,
      author: { name: `by ${it.creator}`, url: `${SITE}#/u/${encodeURIComponent(it.creatorId)}` },
      fields: [
        ...(creatorDiscord ? [{ name: "Made by", value: `<@${creatorDiscord}>`, inline: true }] : []),
        { name: "File", value: `${fileName} · ${(size / 1048576).toFixed(size < 1048576 ? 2 : 1)} MB`, inline: true },
        { name: "Get it", value: `Download the file above, or [open it in OCTIVE](${SITE}#/open/workshop/${it.id})`, inline: true },
        { name: "Updated", value: `<t:${Math.floor(Date.now() / 1000)}:R>${version > 1 ? ` · version ${version}` : ""}`, inline: true },
      ],
      footer: { text: `Shared from OCTIVE · ${it.id}` },
      timestamp: new Date(it.at).toISOString(),
    };
    if (pType) embed.image = { url: `attachment://preview.${pType}` };
    else if (hasOldPreview) embed.image = { url: `${WORKER_BASE}/api/preview/${it.id}?v=${it.version || 1}` };
    let patched;
    if (bytes) {
      const fd = new FormData();
      fd.append("payload_json", JSON.stringify({
        embeds: [embed], allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename: fileName }, ...(pType ? [{ id: 1, filename: `preview.${pType}` }] : [])],
      }));
      fd.append("files[0]", new Blob([bytes], { type: "application/octet-stream" }), fileName);
      if (pType) fd.append("files[1]", new Blob([preview], { type: pType === "png" ? "image/png" : "image/jpeg" }), `preview.${pType}`);
      try { patched = await discordApi(env, "PATCH", `/channels/${it.channelId}/messages/${it.messageId}`, fd, true); }
      catch (e) { if (e.status === 413) fail(413, "Discord refused the file: it's too big for the server right now."); if (e.status === 404) fail(404, "That item's post was removed from Discord."); throw e; }
    } else {
      // only the words changed: keep the attachments as they are
      const old = await discordApi(env, "GET", `/channels/${it.channelId}/messages/${it.messageId}`).catch(() => null);
      const keep = (old?.attachments || []).map((a) => ({ id: a.id }));
      const prevAtt = (old?.attachments || []).find((a) => /^preview\./i.test(a.filename));
      if (prevAtt) embed.image = { url: `attachment://${prevAtt.filename}` };
      patched = await discordApi(env, "PATCH", `/channels/${it.channelId}/messages/${it.messageId}`, { embeds: [embed], allowed_mentions: { parse: [] }, attachments: keep });
    }
    if (pType) await env.RELEASES.put(`workshop/previews/${it.id}`, preview, { httpMetadata: { contentType: pType === "png" ? "image/png" : "image/jpeg" } });
    wsUrls.delete(it.id);
    let out = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === it.id);
      if (!x) return false;
      x.title = title; x.description = description; x.fileName = fileName; x.size = size; x.updatedAt = Date.now(); x.version = version;
      if (pType) x.preview = true;
      out = x;
    });
    rate.n += 1;
    await r2put(env, rateKey, rate);
    return reply({ ok: true, item: wsPublic(out || it), edited: !!patched });
  }

  // ---- remove (the creator, or developers and moderators): the Discord message goes too
  m = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/remove$/);
  if (m && request.method === "POST") {
    const who = await signedIn(request, env);
    await loadModeration(config(env));
    const staff = badgesOf(who.playerId).some((b) => b === "DEV" || b === "MOD") || who.playerId === OWNER;
    let gone = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === m[1] && !y.removed);
      if (!x) return false;
      if (x.creatorId !== who.playerId && !staff) return false;
      x.removed = true; gone = x;
    });
    if (!gone) fail(404, "That item isn't yours, or it's already gone.");
    ctx.waitUntil(discordApi(env, "DELETE", `/channels/${gone.channelId}/messages/${gone.messageId}`).catch(() => {}));
    ctx.waitUntil(env.RELEASES.delete(`workshop/previews/${gone.id}`).catch(() => {}));
    wsUrls.delete(gone.id);
    return reply({ ok: true });
  }
  fail(404, "Not found.");
}

/** A Discord DM from the bot: "X sent you a message" (opted in, linked, at most once per friend every 10 minutes). */
async function discordMessageAlert(env, to, from, fromName, preview) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const rec = await record(env, to);
  if (!rec.discord?.id || !rec.discordPrefs?.dmAlerts) return;
  const key = `discord-alerts/${to}.json`;
  const last = await r2json(env, key, {});
  if (last[from] && Date.now() - last[from] < 10 * 60_000) return;
  last[from] = Date.now();
  for (const k of Object.keys(last)) if (Date.now() - last[k] > 3600_000) delete last[k];
  await r2put(env, key, last);
  const ch = await discordApi(env, "POST", "/users/@me/channels", { recipient_id: rec.discord.id });
  await discordApi(env, "POST", `/channels/${ch.id}/messages`, {
    embeds: [{ color: 0x8b7bff, title: `💬 ${String(fromName).slice(0, 40)} sent you a message on OCTIVE`, description: String(preview || "").slice(0, 300),
      footer: { text: "Reply in the game (F8) or on the website · turn these off in Settings → Profile → Discord" } }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open messages", url: `${SITE}#/messages/${encodeURIComponent(from)}` }] }],
    allowed_mentions: { parse: [] },
  });
}

async function dmRoutes(request, env, url) {
  const path = url.pathname;
  let m;
  const who = await signedIn(request, env);
  if (Date.now() - dmModerationAt > 5 * 60_000) { dmModerationAt = Date.now(); try { await loadModeration(config(env)); } catch { /* keep the old lists */ } }
  if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
  const me = who.playerId;

  // the game keeps the friend and block lists here (and the player's display name)
  if (path === "/dm/friends") {
    const b = await bodyOf(request, 200_000);
    const friends = (Array.isArray(b.friends) ? b.friends : [])
      .filter((f) => f && DM_ID.test(String(f.id))).slice(0, 1000).map((f) => ({ id: String(f.id), name: dmName(f.name) }));
    const blocked = (Array.isArray(b.blocked) ? b.blocked : []).map(String).filter((x) => DM_ID.test(x)).slice(0, 1000);
    const done = new Set((Array.isArray(b.doneUnfriend) ? b.doneUnfriend : []).map(String));
    await r2update(env, dmInboxKey(me), dmEmptyInbox, (box) => {
      box.unfriend = (box.unfriend || []).filter((x) => !done.has(x));
      const pending = new Set(box.unfriend);
      box.friends = friends.filter((f) => !pending.has(f.id)); box.blocked = blocked; box.synced = Date.now();
      if (b.name) box.name = dmName(b.name);
    });
    return reply({ ok: true });
  }

  // a file sent in a conversation (a replay with its song): only friends, at most 40 MB, kept 60 days
  if (path === "/dm/file" && request.method === "POST") {
    const to = String(url.searchParams.get("to") || "");
    if (!DM_ID.test(to) || to === me) fail(400, "You can't send that player files.");
    const theirs = await r2json(env, dmInboxKey(to), dmEmptyInbox());
    const mine = await r2json(env, dmInboxKey(me), dmEmptyInbox());
    if ((theirs.blocked || []).includes(me)) fail(403, "This player isn't taking messages from you.");
    const friendly = isOfficial(me) || isOfficial(to) || (theirs.synced ? (theirs.friends || []).some((f) => f.id === me) : (mine.friends || []).some((f) => f.id === to));
    if (!friendly) fail(403, "You can only send files to your friends.");
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 40 * 1048576) fail(413, "That file is too big to send (40 MB at most).");
    // at most 25 files and 300 MB a day per player
    const day = new Date().toISOString().slice(0, 10);
    const quotaKey = `dm/quota/${me}.json`;
    const quota = await r2json(env, quotaKey, { day, files: 0, bytes: 0 });
    if (quota.day !== day) { quota.day = day; quota.files = 0; quota.bytes = 0; }
    if (quota.files >= 25 || quota.bytes + len > 300 * 1048576) fail(429, "You've sent a lot of files today. Try again tomorrow.");
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) fail(400, "The file is empty.");
    if (body.byteLength > 40 * 1048576) fail(413, "That file is too big to send (40 MB at most).");
    const id = crypto.randomUUID().replace(/-/g, "");
    const name = String(url.searchParams.get("name") || "replay.octreplay").replace(/[^A-Za-z0-9 ._()\[\]-]/g, "_").slice(0, 120);
    await env.RELEASES.put(`dm/files/${id}`, body, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { from: me, to, name, at: String(Date.now()) } });
    quota.files += 1; quota.bytes += body.byteLength;
    await r2put(env, quotaKey, quota);
    return reply({ ok: true, id, size: body.byteLength });
  }
  m = path.match(/^\/dm\/file\/([a-f0-9]{32})$/);
  if (m) {
    const o = await env.RELEASES.get(`dm/files/${m[1]}`);
    if (!o) fail(404, "That file isn't there any more.");
    const meta = o.customMetadata || {};
    if (meta.from !== me && meta.to !== me) fail(403, "That file wasn't sent to you.");
    if (Date.now() - Number(meta.at || 0) > DM_FILE_DAYS * 86_400_000) {
      await env.RELEASES.delete(`dm/files/${m[1]}`);
      fail(404, "That file expired (files that aren't opened within a week are removed).");
    }
    const h = new Headers({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${meta.name || "replay.octreplay"}"`, "Cache-Control": "private, no-store" });
    if (meta.to === me) {
      // the receiver has it now: it's taken off the server
      const bytes = await o.arrayBuffer();
      await env.RELEASES.delete(`dm/files/${m[1]}`);
      return cors(new Response(bytes, { headers: h }));
    }
    return cors(new Response(o.body, { headers: h }));
  }

  // conversations, newest first, with unread counts
  if (path === "/dm/inbox") {
    const box = await r2json(env, dmInboxKey(me), dmEmptyInbox());
    const threads = Object.entries(box.threads || {}).map(([id, t]) => ({ with: id, ...t })).sort((a, b) => (b.last || 0) - (a.last || 0));
    const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);
    return reply({ me, name: box.name || who.username || "", friends: box.friends || [], synced: !!box.synced, threads, unread, unfriend: box.unfriend || [], now: Date.now() });
  }

  // one conversation (messages after "since", in ms)
  m = path.match(/^\/dm\/thread\/([A-Za-z0-9_-]{8,64})$/);
  if (m) {
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const t = await r2json(env, dmThreadKey(me, m[1]), { msgs: [] });
    return reply({ msgs: (t.msgs || []).filter((x) => x.at > since), now: Date.now() });
  }

  if (path === "/dm/send") {
    const b = await bodyOf(request, 8000);
    const to = String(b.to || "");
    if (!DM_ID.test(to) || to === me) fail(400, "You can't message that player.");
    const text = String(b.text || "").replace(/\r/g, "").trim().slice(0, 500);
    if (!text) fail(400, "The message is empty.");
    const id = /^[A-Za-z0-9_-]{8,40}$/.test(String(b.id || "")) ? String(b.id) : crypto.randomUUID().replace(/-/g, "");
    const now = Date.now();
    const times = (dmRate.get(me) || []).filter((t) => now - t < 60_000);
    if (times.length >= 30) fail(429, "You're sending messages too fast. Wait a moment.");
    times.push(now); dmRate.set(me, times);
    if (dmRate.size > 5000) dmRate.delete(dmRate.keys().next().value);
    if (moderation.bans[to]) fail(403, "This player can't receive messages.");
    const [mine, theirs] = await Promise.all([r2json(env, dmInboxKey(me), dmEmptyInbox()), r2json(env, dmInboxKey(to), dmEmptyInbox())]);
    if ((theirs.blocked || []).includes(me)) fail(403, "This player isn't taking messages from you.");
    // the receiver's own friend list decides; before their game uploaded it, the sender's does
    const friendly = isOfficial(me) || isOfficial(to) || (theirs.synced ? (theirs.friends || []).some((f) => f.id === me) : (mine.friends || []).some((f) => f.id === to));
    if (!friendly) fail(403, "You can only message your friends.");
    const kind = b.kind === "replay" ? "replay" : b.kind === "file" ? "file" : "chat";
    const data = kind !== "chat" && /^[a-f0-9]{32}$/.test(String(b.data || "")) ? String(b.data) : undefined;
    if (kind !== "chat" && !data) fail(400, kind === "replay" ? "That replay wasn't uploaded." : "That file wasn't uploaded.");
    const msg = { id, from: me, text, at: now, ...(kind !== "chat" ? { kind, data } : {}) };
    let dup = false;
    await r2update(env, dmThreadKey(me, to), () => ({ msgs: [] }), (t) => {
      t.msgs = t.msgs || [];
      if (t.msgs.some((x) => x.id === id)) { dup = true; return false; }
      t.msgs.push(msg);
      if (t.msgs.length > DM_KEEP) t.msgs.splice(0, t.msgs.length - DM_KEEP);
    });
    if (!dup) {
      const myName = mine.name || dmName(b.name) || who.username || "Player";
      const theirName = theirs.name || (mine.friends || []).find((f) => f.id === to)?.name || "Player";
      const preview = (kind === "replay" ? "🎬 " : kind === "file" ? "🎨 " : "") + text.slice(0, 140);
      await Promise.all([
        r2update(env, dmInboxKey(to), dmEmptyInbox, (box) => {
          box.threads = box.threads || {};
          const t = box.threads[me] || {};
          box.threads[me] = { name: myName, last: now, unread: (t.unread || 0) + 1, preview, fromMe: false };
          dmTrim(box);
        }),
        r2update(env, dmInboxKey(me), dmEmptyInbox, (box) => {
          box.threads = box.threads || {};
          box.threads[to] = { name: theirName, last: now, unread: 0, preview, fromMe: true };
          dmTrim(box);
        }),
      ]);
      try { await discordMessageAlert(env, to, me, myName, preview); } catch (e) { console.log("discord alert", e && e.message); }
    }
    return reply({ ok: true, msg });
  }

  // unfriend on the website: the friend leaves your list here at once, and your game removes the friendship
  // in Unity Friends the next time it starts (it reads "unfriend" from the inbox)
  if (path === "/dm/unfriend") {
    const b = await bodyOf(request, 2000);
    const other = String(b.playerId || "");
    if (!DM_ID.test(other)) fail(400, "That isn't a player.");
    await r2update(env, dmInboxKey(me), dmEmptyInbox, (box) => {
      box.friends = (box.friends || []).filter((f) => f.id !== other);
      box.unfriend = [...new Set([...(box.unfriend || []), other])];
    });
    await r2update(env, dmInboxKey(other), dmEmptyInbox, (box) => {
      if (!(box.friends || []).some((f) => f.id === me)) return false;
      box.friends = box.friends.filter((f) => f.id !== me);
    });
    return reply({ ok: true });
  }

  // read on some device: the unread count goes to 0 everywhere
  if (path === "/dm/read") {
    const b = await bodyOf(request, 2000);
    const other = String(b.with || "");
    if (!DM_ID.test(other)) fail(400, "That isn't a player.");
    await r2update(env, dmInboxKey(me), dmEmptyInbox, (box) => {
      const t = box.threads && box.threads[other];
      if (!t || !t.unread) return false;
      t.unread = 0;
    });
    return reply({ ok: true });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- test builds (testers only)
// Tools/publish_release.py --test N uploads test/OCTIVE-<v>-test<N>-windows.zip / -android.apk and test.json;
// only testers (the TESTER badge) and developers can read them. The browser test build lives under
// web/t-<random id>/, an address only test.json gives out.
let testersCheckedAt = 0;
async function isTester(request, env) {
  if (Date.now() - testersCheckedAt > 5 * 60_000) { testersCheckedAt = Date.now(); try { await loadModeration(config(env)); } catch { /* keep the old lists */ } }
  const who = await signedIn(request, env);
  const badges = badgesOf(who.playerId);
  return badges.includes("TESTER") || badges.includes("DEV") || who.playerId === OWNER;
}

// Signed download links for the website (a link can't carry the sign-in header): valid for 2 hours.
async function linkKey(env) {
  let k = await r2json(env, "keys/test-links.json", null);
  if (!k?.key) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    k = { key: [...b].map((x) => x.toString(16).padStart(2, "0")).join("") };
    await r2put(env, "keys/test-links.json", k);
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(k.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function linkSig(env, file, exp) {
  const sig = await crypto.subtle.sign("HMAC", await linkKey(env), new TextEncoder().encode(file + "|" + exp));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The tester download links (the website's Download page): the newest test build and signed file links. */
async function testLinks(request, env) {
  try {
    if (!(await isTester(request, env))) return reply({ error: "Test builds are for testers." }, 403);
  } catch (e) { return reply({ error: e.expose ? e.message : "Sign in first." }, e.status || 401); }
  const m = await r2json(env, "test.json", null);
  if (!m) return reply({ test: null });
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
  const url = new URL(request.url);
  const link = async (f) => f ? `${url.origin}/releases/test/${encodeURIComponent(f.file)}?exp=${exp}&sig=${await linkSig(env, f.file, exp)}` : null;
  return reply({ test: { version: m.version, test: m.test, notes: m.notes, published: m.published,
    windows: m.windows ? { size: m.windows.size, url: await link(m.windows) } : null,
    android: m.android ? { size: m.android.size, url: await link(m.android) } : null,
    web: !!m.web } });
}

async function testRelease(request, env, key) {
  // a signed link from the website
  const u = new URL(request.url), exp = Number(u.searchParams.get("exp")), sig = u.searchParams.get("sig") || "";
  if (key.startsWith("test/") && exp && sig) {
    if (exp * 1000 < Date.now()) return reply({ error: "This download link ran out. Open the Download page again." }, 403);
    if (sig !== await linkSig(env, key.slice(5), exp)) return reply({ error: "This download link isn't valid." }, 403);
    const res = await release(env, key, request);
    const h = new Headers(res.headers);
    h.set("Cache-Control", "private, no-store");
    return new Response(res.body, { status: res.status, headers: h });
  }
  try {
    if (!(await isTester(request, env))) return reply({ error: "Test builds are for testers." }, 403);
  } catch (e) { return reply({ error: e.expose ? e.message : "Sign in first." }, e.status || 401); }
  const res = await release(env, key, request);
  const h = new Headers(res.headers);
  h.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  // every 6 hours: who still boosts the Discord server (wrangler.toml [triggers] crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([refreshBoosters(env).catch((e) => console.log("boosters", e && e.message)), cleanDmFiles(env).catch((e) => console.log("dm files", e && e.message))]));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/discord" && request.method === "POST") {
      try { return await discordInteraction(request, env, ctx); }
      catch (e) { return new Response("error: " + e.message, { status: 500 }); }
    }
    if (/^\/(support\/|stripe\/webhook$|looks\/|social\/|follow$)/.test(url.pathname)) {
      try { const r = await supportRoutes(request, env, url, ctx); if (r) return r; }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await workshopRoutes(request, env, url, ctx); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/chat/")) {
      try { return await chatRoutes(request, env, url, ctx); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/dm/")) {
      try { return await dmRoutes(request, env, url); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/scores/")) {
      try { return await chartScores(request, env, url); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/account/")) {
      try { return await account(request, env, url.pathname.slice(9)); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (request.method !== "GET") return cors(new Response("Method not allowed", { status: 405 }));
    try {
      if (url.pathname === "/" || url.pathname === "/leaderboard") {
        const board = await leaderboard(env);
        let sup = {}, web = {};
        try { sup = await supporters(env); } catch { /* none */ }
        try { web = await webVisitors(env); } catch { /* none */ }
        const players = board.players.map((p) => withWeb({ ...p, supporter: sup[p.id] || null, ...giftInfo(p.id) }, web));
        const official = await officialProfile(env);
        return json({ ...board, online: players.filter((p) => p.online).length, players, official }, 30);
      }
      if (url.pathname === "/official/status") return json({ ...(await officialStatus(env)), now: Date.now() }, 30);
      const m = url.pathname.match(/^\/avatar\/([A-Za-z0-9_-]{1,64})$/);
      if (m) return await avatar(env, m[1], url.searchParams.get("v"));
      // /web/<version>/[~<build stamp>/]Build/... — the stamp only makes browsers fetch a re-uploaded build
      const w = url.pathname.match(/^\/web\/(\d{1,3}\.\d{1,3}\.\d{1,3}|t-[a-f0-9]{24})\/(?:~[A-Za-z0-9-]{1,40}\/)?((?:Build|StreamingAssets)\/[A-Za-z0-9._\/-]{1,200})$/);
      if (w && !w[2].includes("..")) return await webFile(env, w[1], w[2], request);
      if (url.pathname === "/releases/test.json") return await testRelease(request, env, "test.json");
      if (url.pathname === "/releases/test-links") return await testLinks(request, env);
      const tf = url.pathname.match(/^\/releases\/test\/([A-Za-z0-9._-]{1,120})$/);
      if (tf) return await testRelease(request, env, `test/${tf[1]}`);
      const r = url.pathname.match(/^\/releases\/(latest\.json|history\.json|OCTIVE[A-Za-z0-9._-]{0,120})$/);
      if (r) return await release(env, r[1], request);
      return cors(new Response("Not found", { status: 404 }));
    } catch (e) {
      return json({ error: e.message }, 0, e.status === 429 ? 503 : 502);
    }
  },
};
