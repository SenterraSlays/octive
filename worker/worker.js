// OCTIVE rankings API: a Cloudflare Worker (free plan) between the GitHub Pages site and Unity Gaming
// Services. It keeps the Unity service-account key secret and serves:
//   GET /leaderboard            the global PP ranking with each player's public card (JSON)
//   GET /avatar/<playerId>?v=…  a player's public avatar (JPG)
// Secrets (Worker → Settings → Variables and Secrets): UGS_KEY_ID, UGS_SECRET_KEY, UGS_PROJECT_ID,
// UGS_ENVIRONMENT_ID. Results are kept in memory (ranking 60 s, cards 10 min, avatars until they
// change) so the site stays fast and inside Unity's request limits; if Unity can't be reached the
// last ranking is served.

const LEADERBOARD = "global-pp";
const TOP = 50;                    // players shown
const BOARD_TTL = 60_000;          // ranking refresh
const CARD_TTL = 10 * 60_000;      // public card refresh
const CARD_FETCH_BUDGET = 25;      // cards fetched per request (Cloudflare free plan: 50 subrequests)

let board = null, boardAt = 0, boardPromise = null;
const cards = new Map();           // playerId -> { card, at }
const avatars = new Map();         // playerId:hash -> Uint8Array

const stripTag = (n) => { if (!n) return "Player"; const i = n.lastIndexOf("#"); return i > 0 ? n.slice(0, i) : n; };

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
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

/** One public Cloud Save item of a player (value parsed when it is JSON), or undefined. */
async function publicItem(cfg, playerId, key) {
  const body = await api(`${cfg.save}/players/${encodeURIComponent(playerId)}/public/items?keys=${encodeURIComponent(key)}`, cfg.auth);
  const it = (body?.results ?? []).find((r) => r.key === key);
  if (!it) return undefined;
  let v = it.value;
  if (typeof v === "string" && key !== "avatar") { try { v = JSON.parse(v); } catch { /* keep the string */ } }
  return v;
}

async function buildBoard(env) {
  const cfg = config(env);
  const page = await api(`${cfg.scores}?offset=0&limit=${TOP}`, cfg.auth);
  if (!page) throw new Error(`Leaderboard "${LEADERBOARD}" not found: create it in the Unity dashboard.`);
  const entries = page.results ?? [];
  const now = Date.now();
  // refresh the stalest cards first, within this request's budget
  const stale = entries.map((e) => e.playerId)
    .filter((id) => !cards.has(id) || now - cards.get(id).at > CARD_TTL)
    .sort((a, b) => (cards.get(a)?.at ?? 0) - (cards.get(b)?.at ?? 0))
    .slice(0, CARD_FETCH_BUDGET);
  await Promise.all(stale.map(async (id) => {
    try { cards.set(id, { card: (await publicItem(cfg, id, "card")) ?? null, at: now }); }
    catch (e) { if (!cards.has(id)) cards.set(id, { card: null, at: 0 }); }
  }));
  const players = entries.map((e) => {
    const card = cards.get(e.playerId)?.card;
    return {
      id: e.playerId,
      rank: e.rank + 1,
      pp: Math.round(e.score * 100) / 100,
      name: (card && card.name) || stripTag(e.playerName),
      accuracy: card?.accuracy ?? 0,
      level: card?.level ?? 1,
      levelProgress: card?.levelProgress ?? 0,
      avatarHash: card?.avatar || "",
    };
  });
  return { updated: new Date(now).toISOString(), leaderboard: LEADERBOARD, total: page.total ?? players.length, players };
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

async function avatar(env, playerId, hash) {
  const key = `${playerId}:${hash || "latest"}`;
  let bytes = avatars.get(key);
  if (!bytes) {
    const b64 = await publicItem(config(env), playerId, "avatar");
    if (typeof b64 !== "string" || !b64.length) return cors(new Response("No avatar", { status: 404 }));
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (avatars.size > 300) avatars.delete(avatars.keys().next().value);
    avatars.set(key, bytes);
  }
  return cors(new Response(bytes, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": hash ? "public, max-age=31536000, immutable" : "public, max-age=600" },
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return cors(new Response("Method not allowed", { status: 405 }));
    try {
      if (url.pathname === "/" || url.pathname === "/leaderboard") return json(await leaderboard(env), 30);
      const m = url.pathname.match(/^\/avatar\/([A-Za-z0-9_-]{1,64})$/);
      if (m) return await avatar(env, m[1], url.searchParams.get("v"));
      return cors(new Response("Not found", { status: 404 }));
    } catch (e) {
      return json({ error: e.message }, 0, e.status === 429 ? 503 : 502);
    }
  },
};
