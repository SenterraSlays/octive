// Fetches the OCTIVE global PP ranking from Unity Gaming Services and writes the static site's data.
// Runs in a GitHub Action (Node 20+, no dependencies). Needs these environment variables (repository secrets):
//   UGS_KEY_ID, UGS_SECRET_KEY   service account key (Cloud Save Viewer + leaderboard score reading)
//   UGS_PROJECT_ID               the Unity Cloud project id
//   UGS_ENVIRONMENT_ID           the id of the "production" environment
// Writes data/leaderboard.json and avatars/<playerId>.jpg. Usage: node scripts/update.mjs [--sample]

import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data", "leaderboard.json");
const AVATARS = path.join(ROOT, "avatars");
const LEADERBOARD = "global-pp";
const MAX_PLAYERS = 200;          // players fetched per run (keeps well inside Unity's request limits)
const PAGE = 100;

const stripTag = (n) => { if (!n) return "Player"; const i = n.lastIndexOf("#"); return i > 0 ? n.slice(0, i) : n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, auth, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
    if (res.status === 429 && i < tries) { await sleep(1000 * Number(res.headers.get("Retry-After") || 2)); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}\n${await res.text()}`);
    return res.json();
  }
}

/** Reads public Cloud Save items of one player; returns { key: value }. */
async function publicItems(base, playerId, keys, auth) {
  const q = keys.map((k) => "keys=" + encodeURIComponent(k)).join("&");
  const body = await api(`${base}/players/${encodeURIComponent(playerId)}/public/items?${q}`, auth);
  const out = {};
  for (const it of body?.results ?? []) {
    let v = it.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* plain string (the avatar) */ } }
    out[it.key] = v;
  }
  return out;
}

async function previous() {
  try { return JSON.parse(await readFile(DATA, "utf8")); } catch { return { players: [] }; }
}

async function live() {
  const { UGS_KEY_ID, UGS_SECRET_KEY, UGS_PROJECT_ID, UGS_ENVIRONMENT_ID } = process.env;
  for (const [k, v] of Object.entries({ UGS_KEY_ID, UGS_SECRET_KEY, UGS_PROJECT_ID, UGS_ENVIRONMENT_ID }))
    if (!v) throw new Error(`Missing ${k} (add it as a repository secret).`);
  const auth = "Basic " + Buffer.from(`${UGS_KEY_ID}:${UGS_SECRET_KEY}`).toString("base64");
  const env = `projects/${UGS_PROJECT_ID}/environments/${UGS_ENVIRONMENT_ID}`;
  const lbBase = `https://services.api.unity.com/leaderboards/v1/${env}/leaderboards/${LEADERBOARD}/scores`;
  const csBase = `https://services.api.unity.com/cloud-save/v1/data/${env}`;

  const entries = [];
  for (let offset = 0; offset < MAX_PLAYERS; offset += PAGE) {
    const page = await api(`${lbBase}?offset=${offset}&limit=${Math.min(PAGE, MAX_PLAYERS - offset)}`, auth);
    if (!page) throw new Error(`Leaderboard "${LEADERBOARD}" not found: create it in the Unity dashboard.`);
    entries.push(...(page.results ?? []));
    if ((page.results ?? []).length < PAGE || entries.length >= (page.total ?? Infinity)) break;
  }

  const prev = new Map((await previous()).players.map((p) => [p.id, p]));
  await mkdir(AVATARS, { recursive: true });
  const players = [];
  for (const e of entries) {
    const p = { id: e.playerId, rank: e.rank + 1, pp: Math.round(e.score * 100) / 100, name: stripTag(e.playerName), accuracy: 0, level: 1, levelProgress: 0, avatar: null };
    try {
      const { card } = await publicItems(csBase, e.playerId, ["card"], auth);
      if (card) {
        p.name = card.name || p.name;
        p.accuracy = card.accuracy ?? 0;
        p.level = card.level ?? 1;
        p.levelProgress = card.levelProgress ?? 0;
        const hash = card.avatar || "";
        if (hash) {
          const file = path.join(AVATARS, `${e.playerId}.jpg`);
          const old = prev.get(e.playerId);
          if (old?.avatarHash !== hash || !existsSync(file)) {
            const { avatar } = await publicItems(csBase, e.playerId, ["avatar"], auth);
            if (typeof avatar === "string" && avatar.length) await writeFile(file, Buffer.from(avatar, "base64"));
          }
          if (existsSync(file)) { p.avatar = `avatars/${e.playerId}.jpg`; p.avatarHash = hash; }
        }
      }
    } catch (err) { console.warn(`card of ${e.playerId}: ${err.message}`); }
    players.push(p);
  }
  // remove pictures of players who left the ranking
  const keep = new Set(players.filter((p) => p.avatar).map((p) => `${p.id}.jpg`));
  for (const f of await readdir(AVATARS)) if (f.endsWith(".jpg") && !keep.has(f)) await unlink(path.join(AVATARS, f));
  return players;
}

function sample() {
  const names = ["Senterra", "Aurelia", "kiwi_beats", "Nocturne", "mochi", "StreamGod", "LaneRunner", "pixelfox", "Orbit", "tapdancer", "Velvet", "J4CK"];
  return names.map((n, i) => ({
    id: i === 0 ? "PlwcYVKV9y7NBFWfUaC263XpCFbE" : `sample${i}`, rank: i + 1, name: n,
    pp: Math.round((2400 / (1 + i * 0.35)) * 100) / 100, accuracy: Math.round((99.1 - i * 0.6) * 100) / 100,
    level: Math.max(2, 48 - i * 3), levelProgress: (i * 0.137) % 1, avatar: null,
  }));
}

const useSample = process.argv.includes("--sample");
const players = useSample ? sample() : await live();
await mkdir(path.dirname(DATA), { recursive: true });
const out = { updated: new Date().toISOString(), leaderboard: LEADERBOARD, sample: useSample || undefined, players };
const json = JSON.stringify(out, null, 1);
const before = existsSync(DATA) ? await readFile(DATA, "utf8") : "";
// only the timestamp changed: keep the old file so the Action doesn't commit every run
const strip = (s) => s.replace(/"updated":\s*"[^"]*",?/, "");
if (strip(before) === strip(json)) console.log("No changes.");
else { await writeFile(DATA, json); console.log(`Wrote ${players.length} players.`); }
