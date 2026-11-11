// OCTIVE rankings API: a Cloudflare Worker (free plan) between the GitHub Pages site and Unity Gaming
// Services. It keeps the Unity service-account key secret and serves:
//   GET /leaderboard            the global PP ranking with each player's public card (JSON)
//   GET /avatar/<playerId>?v=…  a player's public avatar (JPG)
//   GET /releases/<file>         game updates from the R2 bucket bound as RELEASES (latest.json + builds)
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
const TOP = 50;                    // players shown
const BOARD_TTL = 60_000;          // ranking refresh
const CARD_TTL = 3 * 60_000;       // public card + online status refresh
const CARD_FETCH_BUDGET = 40;      // cards fetched per request (Cloudflare free plan: 50 subrequests)
const ONLINE_MS = 5 * 60_000;      // "online" when the game wrote its heartbeat this recently
const DEVELOPERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE"]; // same list as the game's PlayerRoles

let board = null, boardAt = 0, boardPromise = null;
const cards = new Map();           // playerId -> { card, seen, at }
const avatars = new Map();         // playerId:hash -> Uint8Array
let moderation = { bans: {}, overrides: {}, roles: {}, badges: {} };
const BADGE_ORDER = ["DEV", "MOD", "CREATOR", "VIP", "TESTER"];
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
      const items = await publicItems(cfg, id, ["card", "seen"]);
      cards.set(id, { card: items.card ?? null, seen: items.seen || "", at: now });
    } catch (e) { if (!cards.has(id)) cards.set(id, { card: null, seen: "", at: 0 }); }
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
      pp: Math.round(e.score * 100) / 100,
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
      devFriend: !!card.devFriend,
      role: DEVELOPERS.includes(e.playerId) ? "DEV" : (badgesOf(e.playerId)[0] || moderation.roles[e.playerId] || null),
      badges: badgesOf(e.playerId),
      socials: badgesOf(e.playerId).includes("CREATOR") ? socialsOf(card) : {},
      online: seen > 0 && now - seen < ONLINE_MS,
      lastSeen: seen > 0 ? new Date(seen).toISOString() : null,
      avatarHash,
    };
  });
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

async function bodyOf(request) {
  if (request.method !== "POST") fail(405, "Use POST.");
  const text = await request.text();
  if (text.length > 400_000) fail(413, "That's too big.");
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname.startsWith("/account/")) {
      try { return await account(request, env, url.pathname.slice(9)); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (request.method !== "GET") return cors(new Response("Method not allowed", { status: 405 }));
    try {
      if (url.pathname === "/" || url.pathname === "/leaderboard") return json(await leaderboard(env), 30);
      const m = url.pathname.match(/^\/avatar\/([A-Za-z0-9_-]{1,64})$/);
      if (m) return await avatar(env, m[1], url.searchParams.get("v"));
      const r = url.pathname.match(/^\/releases\/([A-Za-z0-9._-]{1,120})$/);
      if (r) return await release(env, r[1], request);
      return cors(new Response("Not found", { status: 404 }));
    } catch (e) {
      return json({ error: e.message }, 0, e.status === 429 ? 503 : 502);
    }
  },
};
