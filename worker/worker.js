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
  const entries = (page.results ?? []).filter((e) => !moderation.bans[e.playerId]).slice(0, TOP);
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
      badges: badgesOf(e.playerId),
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
  const mutable = key === "latest.json" || key === "OCTIVE-Installer.exe";
  h.set("Cache-Control", mutable ? "no-cache, max-age=0" : "public, max-age=31536000, immutable");
  if (ext !== "json") h.set("Content-Disposition", `attachment; filename="${key}"`);
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
const SITE = "https://senterraslays.github.io/octive-rankings/";
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
    level: card.level || 1, levelProgress: card.levelProgress || 0, playCount: card.playCount || 0, maxCombo: card.maxCombo || 0,
    fullCombos: card.fullCombos || 0, playTimeMs: card.playTimeMs || 0, totalScore: card.totalScore || 0, bio: card.bio || "", achievements: card.achievements || {},
    badges: badgesOf(playerId), online: seen > 0 && Date.now() - seen < ONLINE_MS, lastSeen: seen ? new Date(seen).toISOString() : null,
    platform: items.platform || "", status: seen > 0 && Date.now() - seen < ONLINE_MS ? platformStatus(items.platform) : null,
    avatarHash: ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : (card.avatar || ""),
  };
}

function profileEmbed(p) {
  const badges = (p.badges || []).map((b) => BADGE_EMOJI[b] || b).join("  ");
  const color = (p.badges || []).includes("DEV") ? 0xB69BFF : (p.badges || []).includes("CREATOR") ? 0xFF2133 : 0x7C6CFF;
  const bio = stripBio(p.bio);
  const e = {
    title: p.name,
    url: `${SITE}#/u/${encodeURIComponent(p.id)}`,
    color,
    description: [badges, bio ? `> ${bio.slice(0, 300).replace(/\n/g, "\n> ")}` : null].filter(Boolean).join("\n") || undefined,
    fields: [
      { name: "Rank", value: p.rank ? `#${fmtN(p.rank)}` : "Unranked", inline: true },
      { name: "Performance", value: `${fmtN(p.pp)}pp`, inline: true },
      { name: "Accuracy", value: `${fmtN(p.accuracy, 2)}%`, inline: true },
      { name: "Level", value: `Lv${p.level} (${Math.round((p.levelProgress || 0) * 100)}%)`, inline: true },
      { name: "Plays", value: fmtN(p.playCount), inline: true },
      { name: "Max combo", value: p.maxCombo ? `${fmtN(p.maxCombo)}x` : "—", inline: true },
      { name: "Full combos", value: fmtN(p.fullCombos), inline: true },
      { name: "Play time", value: playTimeText(p.playTimeMs), inline: true },
      { name: "Status", value: p.online ? "🟢 " + statusText(p) : p.lastSeen ? `Last online ${agoText(p.lastSeen)}` : "Offline", inline: true },
    ],
    footer: { text: "OCTIVE · senterraslays.github.io/octive-rankings" },
  };
  if (p.avatarHash) e.thumbnail = { url: `${WORKER_BASE}/avatar/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.avatarHash)}` };
  return e;
}

async function linkedPlayer(env, discordId) {
  if (!env.RELEASES) return null;
  const o = await env.RELEASES.get(`discord/${discordId}.json`);
  if (!o) return null;
  try { return (await o.json()).playerId || null; } catch { return null; }
}

const opt = (data, name) => (data.options || []).find((o) => o.name === name)?.value;

async function discordCommand(env, it) {
  const data = it.data || {};
  const user = it.member?.user || it.user || {};
  switch (data.name) {
    case "profile": {
      const name = opt(data, "player"), mention = opt(data, "user");
      let id = null;
      if (name) {
        const board = await leaderboard(env);
        const q = String(name).trim().toLowerCase();
        const p = board.players.find((x) => (x.name || "").toLowerCase() === q) || board.players.find((x) => (x.name || "").toLowerCase().includes(q));
        if (!p) return { content: `Nobody called **${String(name).slice(0, 40)}** is on the ranking. Players who aren't ranked can be found when they've linked Discord: \`/profile user:@them\`.`, flags: EPHEMERAL };
        id = p.id;
      } else {
        const who = mention || user.id;
        id = await linkedPlayer(env, who);
        if (!id) return {
          content: who === user.id
            ? `Your Discord isn't linked to an OCTIVE account yet. Sign in at ${SITE}#/account, press **Link Discord**, then use \`/link\` with the code.`
            : `<@${who}> hasn't linked an OCTIVE account.`,
          flags: EPHEMERAL, allowed_mentions: { parse: [] },
        };
      }
      const p = await profileOf(env, id);
      if (!p) return { content: "That profile isn't available (no plays online yet).", flags: EPHEMERAL };
      return { embeds: [profileEmbed(p)], allowed_mentions: { parse: [] } };
    }
    case "leaderboard": {
      const page = Math.max(1, Math.min(5, Number(opt(data, "page") || 1)));
      const board = await leaderboard(env);
      const rows = board.players.slice((page - 1) * 10, page * 10);
      if (!rows.length) return { content: "No ranked players on that page yet.", flags: EPHEMERAL };
      const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `\`#${r}\``);
      return {
        embeds: [{
          title: "OCTIVE Performance Ranking", url: `${SITE}#/rankings`, color: 0x7C6CFF,
          description: rows.map((p) => `${medal(p.rank)} **${p.name.replace(/[*_`~|]/g, "")}** — ${fmtN(p.pp)}pp · ${fmtN(p.accuracy, 2)}% · Lv${p.level}${p.online ? " 🟢" : ""}`).join("\n"),
          footer: { text: `Page ${page} · ${board.total} ranked · ${board.online} online` },
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "online": {
      const board = await leaderboard(env);
      const on = board.players.filter((p) => p.online);
      return {
        embeds: [{
          title: `${on.length} player${on.length === 1 ? "" : "s"} online`, color: 0x3DDC84, url: `${SITE}#/rankings`,
          description: on.length ? on.slice(0, 30).map((p) => `🟢 **${p.name.replace(/[*_`~|]/g, "")}** · #${p.rank} · ${fmtN(p.pp)}pp`).join("\n") : "Nobody on the ranking is online right now.",
        }],
        allowed_mentions: { parse: [] },
      };
    }
    case "download": {
      let m = null;
      try { const o = await env.RELEASES.get("latest.json"); m = o ? await o.json() : null; } catch { /* none */ }
      return {
        embeds: [{
          title: m ? `Download OCTIVE ${m.version}` : "Download OCTIVE", url: `${SITE}#/download`, color: 0x7C6CFF,
          description: [
            `🪟 **Windows:** [installer](${WORKER_BASE}/releases/OCTIVE-Installer.exe) (always installs the newest version)`,
            m?.android ? `🤖 **Android:** [APK](${WORKER_BASE}/releases/${m.android.file})` : null,
            m?.web ? `🌐 **Browser:** [play now](${SITE}play/)` : null,
            `\nThe game updates itself. More at ${SITE}#/download`,
          ].filter(Boolean).join("\n"),
          footer: m?.notes ? { text: ("What's new: " + m.notes).slice(0, 2000) } : undefined,
        }],
      };
    }
    case "link": {
      const code = String(opt(data, "code") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 8) return { content: `That code doesn't look right. Get one at ${SITE}#/account → **Link Discord**.`, flags: EPHEMERAL };
      const o = await env.RELEASES.get(`discord-codes/${code}.json`);
      const c = o ? await o.json() : null;
      if (!c || c.exp < Date.now()) return { content: `That code isn't valid or ran out (codes work for 10 minutes). Make a new one at ${SITE}#/account.`, flags: EPHEMERAL };
      await env.RELEASES.delete(`discord-codes/${code}.json`);
      const old = await linkedPlayer(env, user.id);
      if (old && old !== c.playerId) {
        const orec = await record(env, old); delete orec.discord; await saveRecord(env, old, orec);
      }
      const rec = await record(env, c.playerId);
      if (rec.discord && rec.discord.id !== user.id) await env.RELEASES.delete(`discord/${rec.discord.id}.json`);
      rec.discord = { id: user.id, name: user.global_name || user.username || "", at: new Date().toISOString() };
      if (env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID && it.member) await setBooster(env, c.playerId, user.id, it.member.premium_since || null);
      await saveRecord(env, c.playerId, rec);
      await env.RELEASES.put(`discord/${user.id}.json`, JSON.stringify({ playerId: c.playerId, at: rec.discord.at }), { httpMetadata: { contentType: "application/json" } });
      await syncSupporterRole(env, c.playerId, user.id, env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID ? it.member : undefined);
      let name = "your account";
      try { const p = await profileOf(env, c.playerId); if (p) name = `**${p.name}**`; } catch { /* fine */ }
      return { content: `✅ Linked to ${name}. Try \`/profile\`!`, flags: EPHEMERAL };
    }
    case "update": {
      // re-checks the server boost and gives or takes the OCTIVE Supporter role right now
      const id = await linkedPlayer(env, user.id);
      if (!id) return { content: `Your Discord isn't linked to an OCTIVE account yet. Sign in at ${SITE}#/account?tab=preferences, press **Link Discord**, then use \`/link\` with the code.`, flags: EPHEMERAL };
      const member = env.DISCORD_GUILD_ID && it.guild_id === env.DISCORD_GUILD_ID && it.member ? it.member : await memberOf(env, user.id);
      if (member) await setBooster(env, id, user.id, member.premium_since || null);
      supportIndex = null;
      const st = supportStatus(await r2json(env, `supporters/${id}.json`, null), id, await r2json(env, `boosters/${id}.json`, null));
      if (member) await syncSupporterRole(env, id, user.id, member);
      let name = "your account";
      try { const p = await profileOf(env, id); if (p) name = `**${p.name}**`; } catch { /* fine */ }
      const what = st.lifetime ? "a lifetime supporter"
        : st.booster ? "a supporter while you boost the server" + (st.until ? ` (your paid time is paused and continues until ${new Date(st.until).toLocaleDateString("en-GB", { dateStyle: "medium" })} after)` : "")
        : st.active ? `a supporter until ${new Date(st.until).toLocaleDateString("en-GB", { dateStyle: "medium" })}`
        : "not a supporter right now";
      const role = !env.DISCORD_SUPPORTER_ROLE_ID ? "" : !member ? " Join the OCTIVE Discord server to get the supporter role." : st.active ? " You have the **OCTIVE Supporter** role." : " The supporter role was removed.";
      return { content: `🔄 Updated ${name}: you're ${what}.${role}`, flags: EPHEMERAL };
    }
    case "unlink": {
      const id = await linkedPlayer(env, user.id);
      if (!id) return { content: "Your Discord isn't linked to an OCTIVE account.", flags: EPHEMERAL };
      await syncSupporterRole(env, id, user.id, undefined, true);
      await env.RELEASES.delete(`discord/${user.id}.json`);
      const rec = await record(env, id); delete rec.discord; await saveRecord(env, id, rec);
      return { content: "Unlinked. Your OCTIVE account and Discord aren't connected any more.", flags: EPHEMERAL };
    }
    default:
      return { content: "I don't know that command (yet).", flags: EPHEMERAL };
  }
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
  if (it.type !== 2) return dReply({ content: "Not supported.", flags: EPHEMERAL });
  // answer straight away when the result is ready within ~2.5 s (Discord allows 3 s); otherwise answer
  // "thinking…" and edit the reply when it's done (the ranking can be slow on a cold start)
  const ephemeral = ["link", "unlink"].includes(it.data?.name);
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
      method: "PATCH", headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive-rankings, 1.0)" }, body: JSON.stringify(msg),
    });
    if (!res.ok) {
      console.log("discord edit failed", res.status, (await res.text()).slice(0, 500));
      // last try: plain text, so the command never hangs on "thinking"
      await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${it.token}/messages/@original`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://senterraslays.github.io/octive-rankings, 1.0)" },
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
    const entries = data.entries.filter((e) => !moderation.bans[e.playerId]).slice(0, 50).map((e, i) => ({ ...e, rank: i + 1, supporter: !!sup[e.playerId]?.active }));
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
function platformStatus(tag) { return tag === "desktop" || tag === "mobile" || tag === "web" ? tag : "game"; }
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
function statusText(p) { return p.online ? STATUS_TEXT[p.status] || "Online" : "Offline"; }
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
const MAX_MONTHS = 24;
const GIF_MAX = 8 * 1048576; // supporters' animated pictures
const LIFETIME_SUPPORTERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE"]; // Senterra
const OWNER = "PlwcYVKV9y7NBFWfUaC263XpCFbE"; // everyone follows the developer
const MILESTONES = [[0, "new"], [1, "1 month"], [3, "3 months"], [6, "6 months"], [12, "1 year"], [24, "2 years"], [36, "3 years"], [48, "4 years"], [60, "5 years"], [120, "10 years"]];
const EFFECTS = ["none", "sparkles", "snow", "hearts", "embers", "stars", "aurora", "rain"];

function discountFor(m) { return m >= 24 ? 0.4 : m >= 12 ? 0.3 : m >= 6 ? 0.2 : m >= 3 ? 0.1 : 0; }
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
    totalMonthsBought: (rec?.purchases || []).reduce((n, p) => n + (p.months || 0), 0),
  };
}

let supportIndex = null, supportIndexAt = 0;
/** Every supporter (active or with time on record) and their looks, cached a minute. */
async function supporters(env) {
  if (supportIndex && Date.now() - supportIndexAt < 60_000) return supportIndex;
  const out = {};
  const ids = new Set(LIFETIME_SUPPORTERS);
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
  await Promise.all([...ids].map(async (id) => {
    const rec = await r2json(env, `supporters/${id}.json`, null);
    const boost = boosts[id] ? await r2json(env, `boosters/${id}.json`, null) : null;
    const st = supportStatus(rec, id, boost);
    if (!st.active && st.days <= 0) return;
    const looks = st.active ? await r2json(env, `looks/${id}.json`, {}) : {};
    out[id] = { ...st, nameStyle: looks.nameStyle || "", effect: looks.effect || "none", banner: looks.banner || "", gif: looks.gif || "" };
  }));
  supportIndex = out; supportIndexAt = Date.now();
  return out;
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
  if (path === "/support/all") return reply({ supporters: await supporters(env), owner: OWNER });
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
      const style = String(b.nameStyle || "").slice(0, 200);
      const plain = stripBio(style);
      const card = (await publicItems(config(env), who.playerId, ["card"])).card || {};
      const name = String(card.name || who.username || "");
      if (style && plain !== name) fail(400, `The coloured name has to spell your name exactly ("${name}").`);
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
    return reply({ following, followers, friends, youFollow, owner: OWNER });
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
    const friendly = theirs.synced ? (theirs.friends || []).some((f) => f.id === me) : (mine.friends || []).some((f) => f.id === to);
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
    const friendly = theirs.synced ? (theirs.friends || []).some((f) => f.id === me) : (mine.friends || []).some((f) => f.id === to);
    if (!friendly) fail(403, "You can only message your friends.");
    const kind = b.kind === "replay" ? "replay" : "chat";
    const data = kind === "replay" && /^[a-f0-9]{32}$/.test(String(b.data || "")) ? String(b.data) : undefined;
    if (kind === "replay" && !data) fail(400, "That replay wasn't uploaded.");
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
      const preview = (kind === "replay" ? "🎬 " : "") + text.slice(0, 140);
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
        const players = board.players.map((p) => withWeb({ ...p, supporter: sup[p.id] || null }, web));
        return json({ ...board, online: players.filter((p) => p.online).length, players }, 30);
      }
      const m = url.pathname.match(/^\/avatar\/([A-Za-z0-9_-]{1,64})$/);
      if (m) return await avatar(env, m[1], url.searchParams.get("v"));
      // /web/<version>/[~<build stamp>/]Build/... — the stamp only makes browsers fetch a re-uploaded build
      const w = url.pathname.match(/^\/web\/(\d{1,3}\.\d{1,3}\.\d{1,3})\/(?:~[A-Za-z0-9-]{1,40}\/)?((?:Build|StreamingAssets)\/[A-Za-z0-9._\/-]{1,200})$/);
      if (w && !w[2].includes("..")) return await webFile(env, w[1], w[2], request);
      const r = url.pathname.match(/^\/releases\/([A-Za-z0-9._-]{1,120})$/);
      if (r) return await release(env, r[1], request);
      return cors(new Response("Not found", { status: 404 }));
    } catch (e) {
      return json({ error: e.message }, 0, e.status === 429 ? 503 : 502);
    }
  },
};
