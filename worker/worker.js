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

// the game's judge, so plays are judged again from their replays (board scores, daily charts, dans): deploy judge.js with this file
import { JUDGE_VERSION, JudgeDataError, loadChart, compileChart, packCompiled, unpackCompiled, readReplay, judgeReplay, parseMods, rateOf, signatureMatch, REPLAY_VERSION, chartStats, seededRandom, botPlay, starRating, playPR, gradeOf } from "./judge.js";
/**
 * The oldest replay version whose plays still count (boards, dailies, dans). 3 = 2.0 and newer (no early misses), raised
 * when 2.0 came out (2026-11-17): plays from 1.x get "Update the game and play it again".
 */
const SCORE_REPLAY_MIN = 3;

const LEADERBOARD = "global-pp";
const TOP = 100;                   // players shown
const BOARD_TTL = 60_000;          // ranking refresh
const CARD_TTL = 3 * 60_000;       // public card + online status refresh
const CARD_FETCH_BUDGET = 40;      // cards fetched per request (Cloudflare free plan: 50 subrequests)
const ONLINE_MS = 5 * 60_000;
const PP_VERSION = 3;              // the PP rework (1.3.3): totals from older formulas are listed after, as "before rework"
const PP_LATEST = 4;               // the game's newest PP formula (Performance.Version; 4 = 1.6.0's osu! accuracy)
const DEVELOPERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE"]; // same list as the game's PlayerRoles

let board = null, boardAt = 0, boardBuildingAt = 0;
const cards = new Map();           // playerId -> { card, seen, at }
const avatars = new Map();         // playerId:hash -> Uint8Array
let moderation = { bans: {}, overrides: {}, roles: {}, badges: {} };
const BADGE_ORDER = ["DEV", "MOD", "CREATOR", "CHARTER", "VIP", "TESTER"];
// (2.1.1) no typed Twitch: a Twitch channel is linked with Twitch's own sign-in (Settings → Account → Twitch)
const SOCIAL_KEYS = ["youtube", "tiktok", "x", "instagram", "bluesky", "discord", "website"];

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
function socialsOf(card, playerId) {
  const out = {};
  const s = card && typeof card.socials === "object" && card.socials ? card.socials : {};
  for (const k of SOCIAL_KEYS) {
    // (2.1.1) a Discord server link is the official OCTIVE server's only (players link their own Discord account)
    if (k === "discord" && playerId !== "PlwcYVKV9y7NBFWfUaC263XpCFbE") continue;
    if (typeof s[k] === "string" && s[k].length > 0 && s[k].length <= 200) out[k] = s[k];
  }
  return out;
}

const stripTag = (n) => { if (!n) return "Player"; const i = n.lastIndexOf("#"); return i > 0 ? n.slice(0, i) : n; };

// ---------------------------------------------------------------- server validation
// Nothing a game (or anyone pretending to be one) sends is trusted. Every number is range-checked, the
// PR total, accuracy and level are worked out HERE from the player's plays (POST /account/rank/sync),
// a PR or level jump much bigger than a day of real playing is held for Senterra / Octive to look at, and
// the ranking, profiles and Discord only ever show entries that pass. Entries written straight to the
// leaderboard with impossible values are taken off it.
const V = {
  maxStars: 25,            // the hardest real charts are far below this
  maxTotalPR: 60_000,      // the best players are around 13,000
  maxLevel: 1000,
  maxPlays: 2_000_000,
  maxCombo: 200_000,
  maxPlayTimeMs: 100_000_000_000, // about three years of playing
  maxBig: 9_000_000_000_000_000,
  dayPR: 4_000,            // more PR than this within 24 hours waits for a moderator
  dayLevels: 25,           // the same for levels
  maxCharts: 30_000,
};
const isNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v, lo, hi) => isNum(v, lo, hi) && Number.isInteger(v);
const NAME_RE = /^[A-Za-z0-9_.\-]{3,20}$/;
const validName = (n) => typeof n === "string" && NAME_RE.test(n);
const round2 = (x) => Math.round(x * 100) / 100;

/** The most PR a play can give on a chart of these stars (100% accuracy, longest-chart bonus), as the game works it out. */
function playPRMax(stars, acc = 100) {
  const s = Math.min(V.maxStars, Math.max(0, stars));
  const a = Math.max(0, Math.min(1, acc / 100));
  return 8 * Math.pow(Math.max(s - 0.15, 0.05), 2.2) * Math.max(0, 5 * a - 4) * 1.1 * 1.0005 + 0.02;
}
/** Total PR from the best play per chart: the best counts fully, the next 95%, … plus the plays bonus (Performance.Total). */
function totalPR(best) {
  const sorted = [...best].sort((a, b) => b - a);
  let t = 0, w = 1;
  for (const p of sorted) { t += p * w; w *= 0.95; }
  return round2(t + 416.6667 * (1 - Math.pow(0.995, Math.min(1000, sorted.length))));
}
function weightedAccuracy(plays) {
  let s = 0, ws = 0, w = 1;
  for (const p of [...plays].sort((a, b) => b.pp - a.pp)) { s += p.acc * w; ws += w; w *= 0.95; }
  return ws > 0 ? round2(s / ws) : 0;
}
const LV_FIRST = 150_000, LV_GROWTH = 1.07;
const xpForLevel = (l) => (l <= 1 ? 0 : Math.round(LV_FIRST * (Math.pow(LV_GROWTH, l - 1) - 1) / (LV_GROWTH - 1)));
function levelOf(xp) {
  if (!(xp > 0)) return 1;
  let lv = 1 + Math.floor(Math.log(xp * (LV_GROWTH - 1) / LV_FIRST + 1) / Math.log(LV_GROWTH));
  lv = Math.max(1, Math.min(V.maxLevel, lv));
  while (lv > 1 && xpForLevel(lv) > xp) lv--;
  while (lv < V.maxLevel && xpForLevel(lv + 1) <= xp) lv++;
  return lv;
}
function levelProgress(xp) {
  const lv = levelOf(xp);
  if (lv >= V.maxLevel) return 1;
  const a = xpForLevel(lv), b = xpForLevel(lv + 1);
  return Math.round(Math.max(0, Math.min(1, (xp - a) / (b - a))) * 1000) / 1000;
}
const cleanBio = (b) => (typeof b === "string" ? b.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").split("\n").slice(0, 8).join("\n").slice(0, 400) : "");
function cleanAchievements(a) {
  const out = {};
  if (!a || typeof a !== "object" || Array.isArray(a)) return out;
  for (const [k, v] of Object.entries(a).slice(0, 400))
    if (/^[a-z0-9_.-]{1,48}$/i.test(k) && typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) && Date.parse(v) <= Date.now() + 86_400_000) out[k] = v;
  return out;
}
const cleanInt = (v, lo, hi, d = lo) => (isNum(v, lo - 1e-9, hi) ? Math.round(v) : d);

/**
 * Why a ranking entry can't be real (null when it's fine): what a real game can never send. The name must
 * follow the name rules, the numbers must be possible.
 */
function boardProblem(e, card, meta) {
  if (!isNum(e.score, 0, V.maxTotalPR)) return `PR ${e.score}`;
  if (card.pp !== undefined && !isNum(card.pp, 0, V.maxTotalPR)) return `card PR ${card.pp}`;
  const acc = card.accuracy ?? meta.a ?? 0;
  if (!isNum(acc, 0, 100)) return `accuracy ${acc}`;
  const lv = card.level ?? meta.l ?? 1;
  if (!isInt(lv, 1, V.maxLevel)) return `level ${lv}`;
  const lp = card.levelProgress ?? meta.lp ?? 0;
  if (!isNum(lp, 0, 1)) return `level progress ${lp}`;
  const pc = card.playCount ?? meta.pc ?? 0;
  if (!isInt(pc, 0, V.maxPlays)) return `plays ${pc}`;
  for (const [k, v] of [["totalScore", card.totalScore ?? meta.ts], ["fullCombos", card.fullCombos ?? meta.fc], ["xp", card.xp], ["maxCombo", card.maxCombo], ["playTimeMs", card.playTimeMs]])
    if (v !== undefined && v !== null && !isInt(v, 0, V.maxBig)) return `${k} ${v}`;
  const name = card.name ?? meta.n;
  if (name !== undefined && name !== null && !validName(name)) return "name";
  return null;
}

/** A public card's numbers made safe to show (anything impossible becomes the empty value). */
/** The player's country (2.0): where Cloudflare sees their connection come from, as a 2-letter code ("" unknown). */
function countryOf(request) {
  const c = String((request && request.cf && request.cf.country) || "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : "";
}
function safeCard(card) {
  const c = card && typeof card === "object" && !Array.isArray(card) ? card : {};
  return {
    ...c,
    country: /^[A-Z]{2}$/.test(String(c.country || "")) ? c.country : "",
    name: validName(c.name) ? c.name : undefined,
    pp: isNum(c.pp, 0, V.maxTotalPR) ? c.pp : 0,
    accuracy: isNum(c.accuracy, 0, 100) ? c.accuracy : 0,
    level: isInt(c.level, 1, V.maxLevel) ? c.level : 1,
    levelProgress: isNum(c.levelProgress, 0, 1) ? c.levelProgress : 0,
    playCount: cleanInt(c.playCount, 0, V.maxPlays, 0),
    totalScore: cleanInt(c.totalScore, 0, V.maxBig, 0),
    xp: cleanInt(c.xp, 0, V.maxBig, 0),
    fullCombos: cleanInt(c.fullCombos, 0, V.maxPlays, 0),
    maxCombo: cleanInt(c.maxCombo, 0, V.maxCombo, 0),
    playTimeMs: cleanInt(c.playTimeMs, 0, V.maxPlayTimeMs, 0),
    rank: cleanInt(c.rank, 0, 10_000_000, 0),
    bio: cleanBio(c.bio),
    achievements: cleanAchievements(c.achievements),
    avatar: typeof c.avatar === "string" && /^[A-Za-z0-9_-]{0,80}$/.test(c.avatar) ? c.avatar : "",
    version: typeof c.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(c.version) ? c.version : "",
    ppVersion: isInt(c.ppVersion, 0, 100) ? c.ppVersion : 2,
  };
}

/** Bad ranking entries seen this hour (so each is taken off and written down once). */
const purged = new Map();
async function purgeEntry(env, cfg, playerId, why) {
  const last = purged.get(playerId);
  if (last && Date.now() - last < 3_600_000) return;
  purged.set(playerId, Date.now());
  try { await admin(env, "DELETE", `${cfg.scores}/players/${encodeURIComponent(playerId)}`); } catch (e) { console.log("purge", playerId, e.message); }
  await flagPlayer(env, playerId, "ranking entry removed: " + why);
}
/** Writes down something a player's game sent that couldn't be real (the moderator view shows it). */
async function flagPlayer(env, playerId, what) {
  try {
    await r2update(env, "rank/flags.json", () => ({ flags: [] }), (d) => {
      d.flags = (d.flags || []).filter((f) => Date.now() - Date.parse(f.at) < 90 * 86_400_000);
      d.flags.push({ playerId, what: String(what).slice(0, 200), at: new Date().toISOString() });
      if (d.flags.length > 2000) d.flags = d.flags.slice(-2000);
    });
  } catch (e) { console.log("flag", e.message); }
}
const flagsOf = async (env, playerId) => ((await r2json(env, "rank/flags.json", { flags: [] })).flags || []).filter((f) => f.playerId === playerId).slice(-20);

/** Writes the server's own copy of something (ranking entry, public card): needs the service account's write roles. */
async function serverWrite(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status === 401 || e.status === 403) {
      const err = new HttpError(503, "The server can't write rankings yet (the Unity service account needs the Leaderboards and Cloud Save write roles).");
      err.code = "server-writes-unavailable";
      throw err;
    }
    throw e;
  }
}

/**
 * The ranking from a player's own plays, worked out and checked here. Returns what to publish and why
 * anything was left out.
 */
let devFriends = null, devFriendsAt = 0;
/** On the developer's friends list (their own game keeps it here): never taken from a player's own word. */
async function isDevFriend(env, id) {
  if (!devFriends || Date.now() - devFriendsAt > 300_000) {
    const box = await r2json(env, dmInboxKey(OWNER), null).catch(() => null);
    devFriends = new Set(((box && box.friends) || []).map((f) => String((f && f.id) || f)));
    devFriendsAt = Date.now();
  }
  return devFriends.has(String(id));
}

async function rankFromPlays(env, cfg, playerId) {
  const [priv, resetRec] = await Promise.all([
    privateItems(env, playerId, ["scores"]).catch(() => ({})),
    r2json(env, `rank/reset/${playerId}.json`, null),
  ]);
  const resetAt = resetRec ? Date.parse(resetRec.at) || 0 : 0;
  const data = priv.scores && typeof priv.scores === "object" ? priv.scores : {};
  const charts = data.charts && typeof data.charts === "object" ? Object.entries(data.charts).slice(0, V.maxCharts) : [];
  const plays = [], problems = [];
  let fullCombos = 0, bestCombo = 0, oldAfterReset = false;
  for (const [key, c] of charts) {
    if (!c || typeof c !== "object") continue;
    if (resetAt && !(Date.parse(c.lastPlayed) > resetAt)) { oldAfterReset = true; continue; }
    if (c.fullCombo === true) fullCombos++;
    if (isInt(c.maxCombo, 0, V.maxCombo)) bestCombo = Math.max(bestCombo, c.maxCombo);
  }
  // 2.0: verified charts and OCTIVE's own give their full PR, only from plays the server judged from their replays
  // (their board scores); the numbers the game syncs don't count for them (if they can't be read, this fails: better
  // no update than a ranking of 0)
  const judged = await judgedPlays(env, playerId, charts);
  for (const [k, p] of Object.entries(judged.charts || {})) {
    if (!p || !isNum(p.pp, 0, V.maxTotalPR) || !(p.pp > 0) || !isNum(p.acc, 0, 100)) continue;
    if (!(await boardSong(env, k.split("/")[0]).catch(() => false))) continue; // no longer verified
    if (resetAt && !(Date.parse(p.at) > resetAt)) continue; // from before the player's reset
    plays.push({ pp: round2(p.pp), acc: p.acc });
  }
  // 2.0.1: every other chart (not verified) gives a third of its PR, only from plays the server judged itself from the
  // chart and replay the game sent (see unverifiedPlay): the numbers the game syncs never count. Plays from before 2.0.1
  // that came in during the last day (the game sends earlier bests once) are left out of the day's pace check (pacePP).
  const nowMs = Date.now(), restoring = new Set();
  for (const p of Object.values(judged.unverified || {})) {
    if (!p || !isNum(p.pp, 0, V.maxTotalPR) || !(p.pp > 0) || !isNum(p.acc, 0, 100)) continue;
    if (resetAt && !(Date.parse(p.at) > resetAt)) continue;
    if (p.song && (await boardSong(env, p.song).catch(() => false))) continue; // its song got verified: its board play counts
    const play = { pp: round2(p.pp * UNVERIFIED_SHARE), acc: p.acc };
    plays.push(play);
    if (p.old && nowMs < RESTORE_UNTIL && nowMs - Date.parse(p.at) < 86_400_000) restoring.add(play);
  }
  // totals: after a reset the device must have started over; numbers from before don't count
  const fresh = resetAt && oldAfterReset;
  const xp = fresh ? 0 : cleanInt(data.xp, 0, V.maxBig, 0);
  const playCount = fresh ? plays.length : Math.max(plays.length, cleanInt(data.totalPlays, 0, V.maxPlays, 0));
  return {
    pp: totalPR(plays.map((p) => p.pp)),
    accuracy: weightedAccuracy(plays),
    xp, level: levelOf(xp), levelProgress: levelProgress(xp),
    playCount,
    totalScore: fresh ? 0 : cleanInt(data.totalScore, 0, V.maxBig, 0),
    playTimeMs: fresh ? 0 : cleanInt(data.playTimeMs, 0, V.maxPlayTimeMs, 0),
    fullCombos, maxCombo: bestCombo,
    // the formula the game worked the plays out with (1.6 games show anything older than theirs as out of date)
    ppVersion: isInt(data.ppVersion, 0, 100) && data.ppVersion >= PP_VERSION ? Math.min(data.ppVersion, PP_LATEST) : 2,
    counted: plays.length, problems,
    charts, resetAt,
    // (2.0.1) the total without earlier plays sent again today (the pace check), and the synced numbers (achievements)
    pacePP: restoring.size ? totalPR(plays.filter((p) => !restoring.has(p)).map((p) => p.pp)) : undefined,
    synced: data,
  };
}

// ---------------------------------------------------------------- the server-made ranking (2.0)
// Verified charts and OCTIVE's own count toward PR only through plays the server judged from their replays (board
// scores); other charts a third of the PR of plays the server judged from the chart and replay the game sent.
// Each player's best judged PR per board is kept in rank/judged/<id>.json: added to with every board score, and built
// once from the boards for players who had scores before (the charts their game synced say which boards to look at).
const judgedKey = (id) => `rank/judged/${id}.json`;

/** Grades, worst first. */
const GRADE_ORDER = ["F", "D", "C", "B", "A", "S", "SS"];
const gradeRank = (g) => Math.max(0, GRADE_ORDER.indexOf(String(g || "")));
/** Every note Marvelous or Perfect (judgement counts: Marvelous, Perfect, Great, Good, Bad, Miss). */
const allPerfect = (c) => Array.isArray(c) && c.length >= 6 && c[0] + c[1] > 0 && c[2] + c[3] + c[4] + c[5] === 0;
const hasMod = (codes, m) => String(codes || "").split(" ").includes(m);
/** A compiled chart's length (first to last judged moment), in ms. */
const chartMs = (c) => (c && c.time && c.time.length ? Math.max(0, (c.time[c.time.length - 1] - c.time[0]) / 1000) : 0);

/**
 * What one judged play says for achievements (2.0.1): a clear of a 5★ chart or harder with Hidden, an S or better with
 * Hard Rock, a clear of a 5★ chart or harder at 1.5× or faster (stars at the play's speed), and its combo.
 */
function playFacts(result, replay, stars) {
  const failed = replay?.result?.failed === true, cleared = !failed && gradeRank(result.grade) >= 1, mods = replay?.mods || "";
  return {
    hd5: cleared && stars >= 5 && hasMod(mods, "HD"),
    hrS: !failed && gradeRank(result.grade) >= 5 && hasMod(mods, "HR"),
    rate15: cleared && stars >= 5 && rateOf(mods) >= 1.5,
    combo: result.maxCombo || 0,
  };
}
function noteFacts(d, f) {
  if (!f) return;
  d.facts ||= {};
  const now = new Date().toISOString();
  for (const k of ["hd5", "hrS", "rate15"]) if (f[k] && !d.facts[k]) d.facts[k] = now;
  if (f.combo > (d.facts.combo || 0)) d.facts.combo = f.combo;
}
/** A judged play counted toward the totals the server follows (2.0.1: how far the totals achievements can grow). */
function countPlay(d, result, durationMs) {
  d.count ||= { plays: 0, timeMs: 0, notes: 0, score: 0, since: new Date().toISOString() };
  d.count.plays++;
  d.count.timeMs += Math.max(0, Math.round(Number(durationMs) || 0));
  d.count.notes += Math.max(0, result.hits || 0);
  d.count.score += Math.max(0, Math.round(result.score || 0));
}

/**
 * One chart's judged record: the best-PR play's numbers (pp, acc, at, mods) and, from every play at normal speed or
 * faster, the best for achievements (grade, full combo, all perfect, best accuracy, combo); the chart's stars, keys and
 * difficulty as last known.
 */
function mergeJudged(cur, nw, forAch) {
  const out = cur && typeof cur === "object" ? { ...cur } : { pp: 0, acc: 0, fc: false, combo: 0, at: nw.at };
  if (!cur || (nw.pp || 0) > (cur.pp || 0)) Object.assign(out, { pp: nw.pp || 0, acc: nw.acc, at: nw.at, m: nw.m || undefined });
  for (const k of ["st", "k", "d", "song", "title"]) if (nw[k] !== undefined && nw[k] !== null && nw[k] !== "") out[k] = nw[k];
  if (forAch) {
    if (nw.fc) out.fc = true;
    if (nw.pf) out.pf = true;
    if (gradeRank(nw.g) > gradeRank(out.g)) out.g = nw.g;
    out.best = Math.max(Number(out.best) || 0, Number(nw.acc) || 0);
    out.combo = Math.max(out.combo || 0, nw.combo || 0);
  }
  return out;
}

/**
 * Keeps a judged board play: its PR for the ranking (the best per board), what achievements read from it (see
 * mergeJudged, playFacts), and the play counted toward the totals the server follows.
 */
async function rememberJudged(env, playerId, songId, chartId, entry, extra = {}) {
  if (!entry) return;
  const pp = isNum(entry.pp, 0, V.maxTotalPR) ? entry.pp : 0;
  await r2update(env, judgedKey(playerId), () => ({ v: 1, charts: {} }), (d) => {
    d.charts ||= {};
    const k = `${songId}/${chartId}`;
    d.charts[k] = mergeJudged(d.charts[k], {
      pp, acc: entry.accuracy, fc: !!entry.fullCombo, combo: entry.maxCombo || 0, g: entry.grade, pf: allPerfect(entry.counts),
      at: entry.date || new Date().toISOString(), m: entry.mods || undefined, st: extra.stars, k: extra.keys, d: extra.difficulty,
    }, !(extra.rate < 1));
    noteFacts(d, extra.facts);
    if (extra.result) countPlay(d, extra.result, extra.durationMs);
  });
}

// ---------------------------------------------------------------- achievements (2.0.1)
// A player's game says which achievements it unlocked; their card only shows the ones the server can see were earned:
//  - what the server knows itself: supporter time, Discord, Workshop uploads, friends, follows, chats, Ranked, and the
//    ranking's PR and level (the level from the synced XP, which the day's pace check already holds back);
//  - plays it judged from their replays (verified boards and unverified plays): stars, full combos, grades, combos, keys,
//    Hidden / Hard Rock / speed clears, OCTIVE's own charts;
//  - totals (plays, play time, notes hit, score, charts played): the synced ones as they were the first time it looked
//    (it can't count plays from before that), then only as far as the plays it judged since add up.
// Dates must be real (from OCTIVE's first days, never ahead of now). What it accepts is kept in ach/<id>.json and never
// taken back (a friend removed later doesn't lock "Squad" again; a new computer doesn't lose them). Play achievements a
// card already showed before the server checked them (rec.prior, kept once) stay when the game's synced bests show them,
// as the game decided then (plays from back then can't be judged any more); anything newer needs a judged play. An
// achievement the game adds needs its rule here, or cards leave it out. Cards not checked since (no achV) show only what can be checked on
// the spot (shownAchievements), and the hourly sweep takes the rest off them.
const ACH_EPOCH = Date.parse("2026-10-01T00:00:00Z"); // nothing in OCTIVE is older
const achKey = (id) => `ach/${id}.json`;
const achTried = new Map(); // player -> { at, keys }: the claims last looked at and not accepted (in this Worker instance)
const achDateOk = (v) => { const t = Date.parse(v); return Number.isFinite(t) && t >= ACH_EPOCH && t <= Date.now() + 86_400_000; };
const SUP_DAYS = { "sup-new": 0, "sup-1m": 30, "sup-3m": 91, "sup-6m": 182, "sup-1y": 365, "sup-2y": 730, "sup-3y": 1095 };

/** Each achievement's rule, from what the server knows about the player (x: see achContext). */
const ACH_RULES = (() => {
  const r = {};
  const min = (get, list) => { for (const [id, n] of list) r[id] = (x) => get(x) >= n; };
  // milestones
  min((x) => x.tot.plays, [["first-play", 1], ["plays-10", 10], ["plays-100", 100], ["plays-500", 500], ["plays-1000", 1000], ["plays-5000", 5000]]);
  min((x) => x.tot.timeMs, [["time-1h", 3_600_000], ["time-10h", 36_000_000], ["time-50h", 180_000_000], ["time-100h", 360_000_000]]);
  min((x) => x.level, [["level-10", 10], ["level-25", 25], ["level-50", 50], ["level-100", 100], ["level-250", 250], ["level-500", 500], ["level-1000", 1000]]);
  min((x) => x.pp, [["pp-1000", 1000], ["pp-2500", 2500], ["pp-5000", 5000], ["pp-10000", 10000], ["pp-15000", 15000], ["pp-20000", 20000]]);
  min((x) => x.tot.notes, [["hits-10k", 10_000], ["hits-100k", 100_000], ["hits-500k", 500_000], ["hits-1m", 1_000_000], ["hits-5m", 5_000_000]]);
  min((x) => x.tot.charts, [["charts-50", 50], ["charts-250", 250]]);
  min((x) => x.tot.score, [["score-10m", 10_000_000], ["score-100m", 100_000_000], ["score-1b", 1_000_000_000]]);
  // skill: judged plays
  min((x) => x.v.fc, [["first-fc", 1], ["fc-10", 10], ["fc-50", 50], ["fc-100", 100]]);
  min((x) => x.v.s, [["first-s", 1], ["s-25", 25]]);
  min((x) => x.v.ss, [["first-ss", 1], ["ss-10", 10]]);
  min((x) => x.v.combo, [["combo-500", 500], ["combo-1000", 1000], ["combo-3000", 3000], ["combo-5000", 5000]]);
  min((x) => x.v.clear, [["stars-5", 5], ["stars-6", 6], ["stars-7", 7], ["stars-8", 8], ["stars-9", 9], ["stars-10", 10]]);
  min((x) => x.v.fcStars, [["fc-stars-5", 5], ["fc-stars-7", 7]]);
  min((x) => x.v.keys, [["keys-7", 7], ["keys-10", 10]]);
  Object.assign(r, {
    "pfc": (x) => x.v.pf, "pfc-stars-6": (x) => x.v.pf6, "acc-99": (x) => x.v.acc99,
    "mod-hd": (x) => x.v.hd5, "mod-hr": (x) => x.v.hrS, "rate-15": (x) => x.v.rate15,
  });
  // supporting OCTIVE: the server's own record
  for (const [id, days] of Object.entries(SUP_DAYS)) r[id] = (x) => (days === 0 ? x.sup.active || x.sup.days > 0 : x.sup.days >= days);
  // community
  const chatted = (x) => x.friends >= 1 && x.threads >= 1;
  Object.assign(r, {
    "discord-linked": (x) => x.discord, "discord-updates": (x) => x.discordUpdates,
    "workshop-share": (x) => x.uploads >= 1, "chart-verified": (x) => x.verifiedUploads >= 1,
    "friend-first": (x) => x.friends >= 1, "friends-10": (x) => x.friends >= 10, "friends-25": (x) => x.friends >= 25,
    "chat-first": chatted, "replay-send": chatted, "file-send": chatted,
    "follow-first": (x) => x.following >= 1, "score-share": (x) => x.scoreShared, "official-chat": (x) => x.officialChat,
    // (nothing on the server says these: the date check only)
    "global-chat": () => true, "spectate": () => true, "workshop-get": () => true,
  });
  // Ranked: the server's own records (4K and 7K)
  Object.assign(r, {
    "ranked-placed": (x) => x.rk.placed, "ranked-flawless": (x) => x.rk.placed, "ranked-friendly": (x) => x.rk.any,
    "ranked-first-win": (x) => x.rk.wins >= 1, "ranked-sweep": (x) => x.rk.wins >= 1, "ranked-comeback": (x) => x.rk.wins >= 1,
    "ranked-giant": (x) => x.rk.wins >= 1, "ranked-rankup": (x) => x.rk.wins >= 1,
    "ranked-streak-3": (x) => x.rk.wins >= 3, "ranked-streak-5": (x) => x.rk.wins >= 5,
    "ranked-rockstar": (x) => x.rk.group >= 3, "ranked-superstar": (x) => x.rk.group >= 4, "ranked-elite": (x) => x.rk.group >= 5,
    "ranked-champion": (x) => x.rk.group >= 6, "ranked-legend": (x) => x.rk.group >= 7,
  });
  // OCTIVE's own charts (judged board plays)
  const v = (x) => x.v;
  Object.assign(r, {
    "remix-first": (x) => v(x).remixCleared >= 1, "remix-10": (x) => v(x).remixCleared >= 10, "remix-all-songs": (x) => v(x).allOfficial,
    "brain-power": (x) => v(x).clearOn("brain-power"), "brain-overdrive": (x) => v(x).gradeOn("brain-power", "OVERDRIVE", "S"),
    "idol": (x) => v(x).fcOn("idol"), "fallen": (x) => v(x).clearOn("fallen-symphony"), "fallen-a": (x) => v(x).gradeOn("fallen-symphony", null, "A"),
    "galaxy": (x) => v(x).clearOn("galaxy-collapse"), "ghost-nova": (x) => v(x).clearOn("ghost", "NOVA"),
    "ghost-all": (x) => ["PHANTASM", "SPIRIT", "NOVA"].every((d) => v(x).list.some((e) => e.song.startsWith("octive-") && /ghost/i.test(e.title || e.song) && e.d.toUpperCase().includes(d) && gradeRank(e.g) >= 1)),
    "grimm": (x) => v(x).clearOn("grimm", "Grimmpossible"), "big-black": (x) => v(x).clearOn("the-big-black", "SHD"),
    "big-black-ss": (x) => v(x).gradeOn("the-big-black", "HD ·", "SS"), "q-shrimp": (x) => v(x).clearOn("q", "Shrimp"),
    "xronial": (x) => v(x).clearOn("xronial-xero"), "everything-black": (x) => v(x).clearOn("everything-black", "EXTREME"),
    "kazusa": (x) => v(x).clearOn("kazusa", "Extra"), "dead-end": (x) => v(x).clearOn("dead-end", "Diary"),
    "bumblebee": (x) => v(x).list.some((e) => e.song.startsWith("octive-sweet-little-bumblebee") && e.d.includes("1.2x") && gradeRank(e.g) >= 1),
    "r4v3-6k": (x) => v(x).clearOn("r4v3-b0y", "6K"), "navsegda": (x) => v(x).gradeOn("navsegda", "V2", "S"),
  });
  return r;
})();

/**
 * A card's achievements as shown (2.0.1): a card the server checked (achV) as it is; an older one only with what can be
 * checked on the spot: achievements that exist, real dates, and supporter time (from the supporter list, once loaded).
 */
function shownAchievements(card, id) {
  const a = cleanAchievements(card && card.achievements);
  if (isOfficial(id) || (card && card.achV >= 1)) return a;
  const out = {};
  for (const [k, at] of Object.entries(a)) {
    if (!ACH_RULES[k] || !achDateOk(at)) continue;
    if (SUP_DAYS[k] !== undefined) {
      const st = supportIndex ? supportIndex[id] : null;
      if (!st || !(SUP_DAYS[k] === 0 ? st.active || st.days > 0 : st.days >= SUP_DAYS[k])) continue;
    }
    out[k] = at;
  }
  return out;
}

/** OCTIVE's own and verified charts by board key: stars, keys, difficulty, song title; and OCTIVE's own song ids. */
let chartInfoCache = null, chartInfoAt = 0;
async function boardChartInfo(env) {
  if (chartInfoCache && Date.now() - chartInfoAt < 120_000) return chartInfoCache;
  const charts = new Map(), officialSongs = new Set();
  for (const it of (await judgeDb(env)).items || []) {
    if (it.type !== "charts" || it.removed || !it.meta || !(it.verified || it.builtin)) continue;
    for (const sg of it.meta.songs || []) {
      if (!sg || !sg.songId) continue;
      if (officialSong(sg.songId)) officialSongs.add(sg.songId);
      const set = Math.round(Number(sg.osuSet) || 0), board = set > 0 ? "osu-" + set : sg.songId;
      for (const c of sg.charts || []) {
        const ch = set > 0 && c.osuMd5 ? c.osuMd5 : c.chartId;
        if (!ch || charts.has(`${board}/${ch}`)) continue;
        charts.set(`${board}/${ch}`, { stars: Number(c.stars) || 0, keys: Number(c.keys) || 0, difficulty: String(c.difficulty || ""), title: String(sg.title || "") });
      }
    }
  }
  chartInfoCache = { charts, officialSongs }; chartInfoAt = Date.now();
  return chartInfoCache;
}

/** A player's Ranked over both ladders and every season: placed, matches won, the best rank group reached. */
async function rankedSummary(env, id) {
  const out = { any: false, placed: false, wins: 0, peak: 0, group: 0 };
  for (const mode of [4, 7]) {
    const rec = await r2json(env, rkPlayerKey(id, mode), null).catch(() => null);
    if (!rec || typeof rec !== "object") continue;
    out.any = true;
    const seasons = Array.isArray(rec.seasons) ? rec.seasons.filter((s) => s && typeof s === "object") : [];
    if (rec.placed || seasons.length) out.placed = true;
    out.wins += (Number(rec.wins) || 0) + seasons.reduce((n, s) => n + (Number(s.wins) || 0), 0);
    out.peak = Math.max(out.peak, Number(rec.peak) || 0, Number(rec.tier) || 0, ...seasons.map((s) => Number(s.peak || s.tier) || 0));
  }
  out.group = rkGroupOf(out.peak);
  return out;
}

/** The judged record, with the board scores' grades, all-perfect plays and combos read in once (older records lack them). */
async function achJudged(env, id) {
  const j = (await r2json(env, judgedKey(id), null)) || { v: 1, charts: {} };
  if (j.achBuilt) return j;
  const found = {};
  let reads = 0;
  for (const k of Object.keys(j.charts || {})) {
    if (reads >= 150) break;
    const i = k.indexOf("/"), sid = k.slice(0, i), cid = k.slice(i + 1);
    if (i <= 0 || !chartIdOk(cid)) continue;
    reads++;
    const e = (await readBoard(env, sid, cid).catch(() => ({ entries: [] }))).entries.find((x) => x.playerId === id);
    if (e) found[k] = e;
  }
  return r2update(env, judgedKey(id), () => ({ v: 1, charts: {} }), (d) => {
    d.charts ||= {};
    for (const [k, e] of Object.entries(found))
      if (d.charts[k]) d.charts[k] = mergeJudged(d.charts[k], { pp: 0, acc: e.accuracy, fc: !!e.fullCombo, combo: e.maxCombo || 0, g: e.grade, pf: allPerfect(e.counts), at: e.date }, rateOf(e.mods || "") >= 1);
    d.achBuilt = new Date().toISOString();
  });
}

/** What the judged plays show for achievements: every chart judged, with its stars, keys, difficulty and best results. */
async function judgedView(env, j, resetAt) {
  const info = await boardChartInfo(env);
  const fresh = (at) => !resetAt || Date.parse(at) > resetAt;
  const list = [];
  const add = (e, song, ci) => {
    if (!e || typeof e !== "object" || !fresh(e.at)) return;
    const best = Number(e.best ?? e.acc) || 0;
    list.push({ song: String(song || ""), d: String(e.d || ci?.difficulty || ""), title: String(e.title || ci?.title || ""), st: Number(e.st ?? ci?.stars) || 0,
      k: Number(e.k || ci?.keys) || 0, g: e.g || gradeOf(best), fc: !!e.fc, pf: !!e.pf, best, combo: Number(e.combo) || 0 });
  };
  for (const [k, e] of Object.entries(j.charts || {})) add(e, k.split("/")[0], info.charts.get(k));
  for (const e of Object.values(j.unverified || {})) add(e, e && e.song, null);
  const f = j.facts || {};
  const facts = { combo: Number(f.combo) || 0 };
  for (const k of ["hd5", "hrS", "rate15"]) facts[k] = !!f[k] && fresh(f[k]);
  return achView(list, facts, info.officialSongs);
}

/**
 * The same from the game's synced bests and recent plays: only for play achievements a card already showed before the
 * server checked them (plays from back then can't be judged any more), read the way the game reads them.
 */
function syncedView(data, officialSongs) {
  const list = [], plays = [], facts = { combo: 0, hd5: false, hrS: false, rate15: false };
  const charts = data && typeof data.charts === "object" && data.charts ? Object.entries(data.charts).slice(0, V.maxCharts) : [];
  for (const [key, c] of charts) {
    if (!c || typeof c !== "object") continue;
    list.push({ song: String(key).split("/")[0], d: String(c.difficulty || ""), title: String(c.title || ""), st: isNum(c.stars, 0, V.maxStars) ? c.stars : 0,
      k: isInt(c.keyCount, 0, 20) ? c.keyCount : 0, g: GRADE_ORDER.includes(c.bestGrade) ? c.bestGrade : "F", fc: c.fullCombo === true, pf: c.perfectPlay === true,
      best: isNum(c.bestAccuracy, 0, 100) ? c.bestAccuracy : 0, combo: isInt(c.maxCombo, 0, V.maxCombo) ? c.maxCombo : 0 });
    if (Array.isArray(c.top)) plays.push(...c.top.slice(0, 50));
  }
  if (Array.isArray(data?.recent)) plays.push(...data.recent.slice(0, 1000));
  for (const p of plays) {
    if (!p || typeof p !== "object" || p.failed === true) continue;
    const st = isNum(p.stars, 0, V.maxStars) ? p.stars : 0, mods = typeof p.mods === "string" ? p.mods : "";
    if (st >= 5 && hasMod(mods, "HD")) facts.hd5 = true;
    if (gradeRank(p.grade) >= 5 && hasMod(mods, "HR")) facts.hrS = true;
    if (st >= 5 && rateOf(mods) >= 1.5) facts.rate15 = true;
  }
  return achView(list, facts, officialSongs);
}

/** What play achievements read: counts and bests over a list of charts' results (judged or synced), and special plays. */
function achView(list, facts, officialSongs) {
  const cleared = (e) => gradeRank(e.g) >= 1;
  const v = { list, officialSongs, fc: 0, s: 0, ss: 0, pf: false, pf6: false, combo: facts.combo, clear: 0, fcStars: 0, acc99: false, keys: 0,
    hd5: facts.hd5, hrS: facts.hrS, rate15: facts.rate15, remixCleared: 0, allOfficial: false };
  for (const e of list) {
    if (e.fc) { v.fc++; v.fcStars = Math.max(v.fcStars, e.st); }
    if (gradeRank(e.g) >= 5) v.s++;
    if (e.g === "SS") v.ss++;
    if (e.pf) { v.pf = true; if (e.st >= 6) v.pf6 = true; }
    v.combo = Math.max(v.combo, e.combo);
    if (cleared(e)) {
      v.clear = Math.max(v.clear, e.st); v.keys = Math.max(v.keys, e.k);
      if (e.song.startsWith("octive-") && e.d.includes("OCTIVE Remix")) v.remixCleared++;
    }
    if (e.st >= 5 && e.best >= 99) v.acc99 = true;
  }
  const on = (song, diff) => list.filter((e) => e.song === "octive-" + song && (!diff || e.d.toLowerCase().includes(diff.toLowerCase())));
  v.clearOn = (song, diff) => on(song, diff).some(cleared);
  v.gradeOn = (song, diff, g) => on(song, diff).some((e) => gradeRank(e.g) >= gradeRank(g));
  v.fcOn = (song, diff) => on(song, diff).some((e) => e.fc);
  v.allOfficial = officialSongs.size > 0 && [...officialSongs].every((sg) => list.some((e) => e.song === sg && cleared(e)));
  return v;
}

/** What the server knows about a player for their achievements (read when a claim needs checking). */
async function achContext(env, id, r, pub, base, synced) {
  const [supRec, boost, acct, inbox, follows, shared, j, rk] = await Promise.all([
    r2json(env, `supporters/${id}.json`, null), r2json(env, `boosters/${id}.json`, null), r2json(env, `accounts/${id}.json`, null),
    r2json(env, dmInboxKey(id), null), r2json(env, `follows/${id}.json`, { following: [] }), env.RELEASES.head(`scores/rate/${id}.json`).catch(() => null),
    achJudged(env, id), rankedSummary(env, id),
  ]);
  const sup = supportStatus(supRec, id, boost);
  const mine = ((await judgeDb(env)).items || []).filter((x) => x.creatorId === id);
  const counted = (j && j.count) || {};
  const tot = {};
  for (const k of ["plays", "timeMs", "notes", "score"]) tot[k] = Math.min(Number(synced[k]) || 0, (Number(base[k]) || 0) + (Number(counted[k]) || 0));
  tot.charts = Math.min(Number(synced.charts) || 0, (Number(base.charts) || 0) + Object.keys(j.charts || {}).length + Object.keys(j.unverified || {}).length);
  return {
    sup, supSince: sup.since ? Date.parse(sup.since) || 0 : 0,
    discord: !!acct?.discord?.id, discordUpdates: !!acct?.discordPrefs?.updates,
    uploads: mine.length, verifiedUploads: mine.filter((x) => x.verified).length,
    friends: (inbox?.friends || []).length, threads: Object.keys(inbox?.threads || {}).length, officialChat: !!inbox?.threads?.[OFFICIAL_ID],
    following: (follows?.following || []).length, scoreShared: !!shared, rk,
    pp: Number(pub.pp) || 0, level: Number(pub.level) || 1, tot,
    v: await judgedView(env, j, r.resetAt),
  };
}

/**
 * The achievements a player's card shows (see above): what their game says it unlocked, kept only when the server can
 * see it was earned; dated when the game says (a real date, never before supporter time could have reached it), else now.
 */
async function checkAchievements(env, id, claimed, r, pub) {
  const claims = cleanAchievements(claimed);
  const rec = (await r2json(env, achKey(id), null)) || { v: 1, ok: {} };
  rec.ok = rec.ok && typeof rec.ok === "object" ? rec.ok : {};
  const now = Date.now(), data = r.synced || {};
  const synced = { plays: r.playCount || 0, timeMs: r.playTimeMs || 0, notes: cleanInt(data.totalNotesHit, 0, V.maxBig, 0), score: r.totalScore || 0, charts: (r.charts || []).length };
  let changed = false;
  if (!rec.base) {
    rec.base = { ...synced, at: new Date(now).toISOString() };
    // what the card showed before the server checked achievements: its play achievements stay when the synced bests show them
    const old = (await publicItems(config(env), id, ["card"]).catch(() => ({}))).card;
    rec.prior = old && typeof old === "object" && !Array.isArray(old) ? cleanAchievements(old.achievements) : {};
    changed = true;
  }
  const pending = Object.keys(claims).filter((k) => !rec.ok[k] && ACH_RULES[k]).sort();
  // claims it couldn't accept yet are looked at again after 15 minutes (or at once when the game claims something new)
  const tried = achTried.get(id);
  if (pending.length && !(tried && tried.keys === pending.join(",") && now - tried.at < 900_000)) {
    const x = await achContext(env, id, r, pub, rec.base, synced);
    let xs = null; // the same with the synced bests, for achievements the card showed before (rec.prior)
    for (const k of pending) {
      let ok = false;
      try { ok = ACH_RULES[k](x) === true; } catch { ok = false; }
      const was = rec.prior && rec.prior[k];
      if (!ok && was && achDateOk(was) && Date.parse(was) <= Date.parse(rec.base.at)) {
        xs ||= { ...x, v: syncedView(data, x.v.officialSongs) };
        try { ok = ACH_RULES[k](xs) === true; } catch { ok = false; }
      }
      if (!ok) continue;
      let at = achDateOk(claims[k]) ? Date.parse(claims[k]) : now;
      if (SUP_DAYS[k] && x.supSince) at = Math.max(at, x.supSince + SUP_DAYS[k] * 86_400_000);
      rec.ok[k] = new Date(Math.min(at, now)).toISOString();
      changed = true;
    }
    const left = pending.filter((k) => !rec.ok[k]);
    if (left.length) achTried.set(id, { at: now, keys: left.join(",") }); else achTried.delete(id);
    if (achTried.size > 2000) achTried.delete(achTried.keys().next().value);
  }
  if (changed) { rec.at = new Date(now).toISOString(); await r2put(env, achKey(id), rec); }
  return { ...rec.ok };
}

/**
 * Takes achievements that can't be real off cards the server hasn't checked yet (unknown ones, impossible dates,
 * supporter time nobody had), through the ranking a batch an hour (offset in ach/sweep.json), so games reading a card
 * straight from cloud save don't show them either. A card gets its full check when its player syncs.
 */
async function achSweep(env, max = 80) {
  const state = await r2json(env, "ach/sweep.json", { offset: 0, done: false, fixed: 0 });
  if (state.done) return state;
  const cfg = config(env);
  await supporters(env);
  const page = await api(`${cfg.scores}?offset=${state.offset}&limit=${max}`, cfg.auth);
  const results = (page && page.results) || [];
  for (const e of results) {
    const id = e.playerId;
    if (!id || isOfficial(id)) continue;
    try {
      const card = (await publicItems(cfg, id, ["card"])).card;
      if (!card || typeof card !== "object" || Array.isArray(card) || card.achV >= 1) continue;
      const shown = shownAchievements(card, id);
      if (Object.keys(shown).length === Object.keys(cleanAchievements(card.achievements)).length) continue;
      await serverWrite(() => saveItem(env, id, "card", { ...card, achievements: shown }, true));
      cards.delete(id);
      state.fixed = (state.fixed || 0) + 1;
    } catch (err) { console.log("achievement sweep", id, err && err.message); }
  }
  state.offset += results.length;
  if (results.length < max) { state.done = true; state.finishedAt = new Date().toISOString(); }
  await r2put(env, "ach/sweep.json", state);
  return state;
}

/**
 * Moves the ranking over to judged plays for everyone, not just players who play again: a few ranking entries an hour
 * (offset kept in rank/recompute.json) get their PR and accuracy worked out again and written to the ranking, their
 * card and their pace record. It stops once it has been through the whole ranking; after that, playing keeps it current.
 */
async function recomputeRanking(env, max = 6) {
  const state = await r2json(env, "rank/recompute.json", { offset: 0, done: false, changed: 0 });
  if (state.done) return state;
  const cfg = config(env);
  await loadModeration(cfg);
  const page = await api(`${cfg.scores}?offset=${state.offset}&limit=${max}&includeMetadata=true`, cfg.auth);
  const results = (page && page.results) || [];
  for (const e of results) {
    const id = e.playerId;
    if (!id || isOfficial(id) || moderation.bans[id]) continue;
    try {
      const r = await rankFromPlays(env, cfg, id);
      if (Math.abs((Number(e.score) || 0) - r.pp) < 0.01) continue;
      let meta = null; try { meta = e.metadata ? JSON.parse(e.metadata) : null; } catch { /* none */ }
      if (!meta || !meta.n) {
        const one = await api(`${cfg.scores}/players/${encodeURIComponent(id)}?includeMetadata=true`, cfg.auth).catch(() => null);
        try { meta = one && one.metadata ? JSON.parse(one.metadata) : null; } catch { meta = null; }
      }
      if (!meta || !meta.n) continue; // its details unknown: left for the player's next sync
      await serverWrite(async () => {
        await writeScore(env, id, r.pp, { ...meta, a: r.accuracy });
        const card = (await publicItems(cfg, id, ["card"]).catch(() => ({}))).card;
        if (card && typeof card === "object") { card.pp = r.pp; card.accuracy = r.accuracy; await saveItem(env, id, "card", card, true); }
      });
      const pk = `rank/players/${id}.json`, rec = await r2json(env, pk, null);
      if (rec) { rec.pp = r.pp; rec.hist = []; await r2put(env, pk, rec); }
      cards.delete(id);
      state.changed = (state.changed || 0) + 1;
    } catch (err) { console.log("ranking recompute", id, err && err.message); }
  }
  state.offset += results.length;
  if (results.length < max) { state.done = true; state.finishedAt = new Date().toISOString(); }
  await r2put(env, "rank/recompute.json", state);
  return state;
}

/** A player's judged plays, built from the boards the first time (see above). */
async function judgedPlays(env, playerId, charts) {
  const have = await r2json(env, judgedKey(playerId), null);
  if (have && have.built) return have;
  const found = {}, sets = new Set();
  let reads = 0;
  for (const [key, c] of charts || []) {
    if (reads >= 200) break; // a very long play history: the rest come in as they play
    if (!c || typeof c !== "object") continue;
    const [sid, cid] = String(key).split("/");
    const board = typeof c.board === "string" && /^osu-[0-9]+$/.test(c.board) ? c.board : sid;
    if (!(await boardSong(env, board).catch(() => false))) continue;
    const files = [];
    if (/^osu-[0-9]+$/.test(board)) {
      // an osu! set's boards are by .osu file: every board of the set is looked at once
      if (sets.has(board)) continue;
      sets.add(board);
      const list = await env.RELEASES.list({ prefix: `scores/${board}/`, limit: 60 });
      for (const o of list.objects || []) { const m = /^scores\/[^/]+\/([A-Za-z0-9_-]{1,80})\.json$/.exec(o.key); if (m) files.push(m[1]); }
    } else if (chartIdOk(cid)) files.push(cid);
    for (const ch of files) {
      const k = `${board}/${ch}`;
      if (found[k]) continue;
      reads++;
      const e = (await readBoard(env, board, ch)).entries.find((x) => x.playerId === playerId);
      if (e && isNum(e.pp, 0, V.maxTotalPR) && e.pp > 0) found[k] = { pp: e.pp, acc: e.accuracy, fc: !!e.fullCombo, combo: e.maxCombo || 0, at: e.date };
    }
  }
  return r2update(env, judgedKey(playerId), () => ({ v: 1, charts: {} }), (d) => {
    d.charts ||= {};
    for (const [k, v] of Object.entries(found)) if (!d.charts[k] || d.charts[k].pp < v.pp) d.charts[k] = mergeJudged(d.charts[k], v, true);
    d.built = new Date().toISOString();
  });
}

// ---------------------------------------------------------------- progress over time and the skill radar (2.0)
// Every ranking sync keeps the day's PR, accuracy, global rank and level in rank/history/<id>.json (one point a UTC
// day, the last of the day wins, two years at most). Before that existed, PR and accuracy are rebuilt week by week from
// the judged best plays and their dates. The skill radar reads the same plays against each verified chart's pattern tags.
const historyKey = (id) => `rank/history/${id}.json`;

/** Keeps today's numbers for the progress graphs. */
async function rememberDay(env, id, pp, acc, rank, level) {
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  await r2update(env, historyKey(id), () => ({ v: 1, days: [] }), (d) => {
    d.days ||= [];
    const point = [day, round2(Number(pp) || 0), round2(Number(acc) || 0), Number(rank) || 0, Number(level) || 1];
    const last = d.days[d.days.length - 1];
    if (last && last[0] === day) {
      if (last[1] === point[1] && last[2] === point[2] && last[3] === point[3] && last[4] === point[4]) return false;
      d.days[d.days.length - 1] = point;
    } else d.days.push(point);
    if (d.days.length > 730) d.days = d.days.slice(-730);
  });
}

/** Every verified chart's stars and pattern tags by its board key ("song/chart", osu! sets as "osu-<set>/<md5>"). */
let shapeIndexCache = null, shapeIndexAt = 0;
async function chartShapeIndex(env) {
  if (shapeIndexCache && Date.now() - shapeIndexAt < 60_000) return shapeIndexCache;
  const out = new Map();
  for (const it of (await judgeDb(env)).items || []) {
    if (it.type !== "charts" || it.removed || !it.verified || !it.meta) continue;
    for (const sg of it.meta.songs || []) {
      if (!sg || !sg.songId) continue;
      const set = Math.round(Number(sg.osuSet) || 0), board = set > 0 ? "osu-" + set : sg.songId;
      for (const c of sg.charts || []) {
        const ch = set > 0 && c.osuMd5 ? c.osuMd5 : c.chartId;
        if (!ch || !(Number(c.stars) > 0)) continue;
        out.set(`${board}/${ch}`, { stars: Number(c.stars), keys: Number(c.keys) || 0, tags: [...new Set([...(c.autoTags || []), ...(it.tags || [])].map(String))] });
      }
    }
  }
  shapeIndexCache = out; shapeIndexAt = Date.now();
  return out;
}

/** The radar's axes: a name and the chart tags that count for it. */
// (2.0.2) eight of them, an octagon: tags from the notes, and the uploader's own tags (Tech and SV are often only those)
const SKILL_AXES = [
  ["jumpstream", "Jumpstream", ["jumpstream"]],
  ["handstream", "Handstream", ["handstream"]],
  ["chordjack", "Chordjack", ["chordjack"]],
  ["speedjack", "Speedjack", ["speedjack"]],
  ["ln", "LNs", ["ln", "hybrid"]],
  ["tech", "Tech", ["technical"]],
  ["sv", "SV", ["sv"]],
  ["speed", "Speed", ["speed", "stamina"]],
];

/**
 * A player's skill on each pattern, in stars: each judged play is a level (its stars × an accuracy factor, the same
 * rule as Ranked placement), and an axis is the average of its 3 best levels on charts with those tags.
 */
function skillsFrom(plays, idx) {
  const levels = SKILL_AXES.map(() => []), all = [];
  for (const [k, p] of plays) {
    const sh = idx.get(k);
    if (!sh) continue;
    const lv = rkLevel(sh.stars, Number(p.acc) || 0, false, !!p.fc);
    all.push(lv);
    SKILL_AXES.forEach(([, , tags], i) => { if (sh.tags.some((t) => tags.includes(t))) levels[i].push(lv); });
  }
  const top = (a, n) => { const s = [...a].sort((x, y) => y - x).slice(0, n); return s.length ? round2(s.reduce((x, y) => x + y, 0) / s.length) : 0; };
  return { overall: top(all, 5), plays: all.length, axes: SKILL_AXES.map(([key, name], i) => ({ key, name, level: top(levels[i], 3), plays: levels[i].length })) };
}

/** What a profile's Progress shows: the kept days, the rebuilt weeks before them, and the skill radar. */
async function progressOf(env, id) {
  const [hist, judged, idx, reset] = await Promise.all([
    r2json(env, historyKey(id), null), r2json(env, judgedKey(id), null), chartShapeIndex(env), r2json(env, `rank/reset/${id}.json`, null),
  ]);
  const resetAt = reset ? Date.parse(reset.at) || 0 : 0;
  const plays = Object.entries((judged && judged.charts) || {})
    .filter(([, p]) => p && isNum(p.pp, 0, V.maxTotalPR) && p.pp > 0 && isNum(p.acc, 0, 100) && !(resetAt && !(Date.parse(p.at) > resetAt)));
  const days = ((hist && hist.days) || []).filter((d) => Array.isArray(d) && typeof d[0] === "string");
  const built = [];
  const dated = plays.map(([, p]) => ({ pp: round2(p.pp), acc: p.acc, t: Date.parse(p.at) || 0 })).filter((p) => p.t > 0).sort((a, b) => a.t - b.t);
  if (dated.length) {
    const WEEK = 7 * 86_400_000, now = Date.now();
    const stop = days.length ? Date.parse(days[0][0] + "T00:00:00Z") : now;
    const cur = [];
    let i = 0;
    for (let t = dated[0].t + WEEK; t < stop && built.length < 160; t += WEEK) {
      while (i < dated.length && dated[i].t < t) cur.push(dated[i++]);
      built.push([new Date(t).toISOString().slice(0, 10), totalPR(cur.map((p) => p.pp)), weightedAccuracy(cur)]);
    }
    // nothing kept yet: the rebuilt line ends today, at everything
    if (!days.length) built.push([new Date(now).toISOString().slice(0, 10), totalPR(dated.map((p) => p.pp)), weightedAccuracy(dated)]);
  }
  return { days, built, skills: skillsFrom(plays, idx) };
}

/**
 * Holds a jump much bigger than a day of playing (PR or levels) until a moderator approves it: returns the
 * values to publish and whether the new ones are waiting.
 */
async function paceCheck(env, cfg, playerId, now) {
  const key = `rank/players/${playerId}.json`;
  let rec = await r2json(env, key, null);
  if (!rec) {
    // the first check: start from what the ranking shows now (when that was possible)
    let pp = 0, level = 1;
    try {
      const e = await api(`${cfg.scores}/players/${encodeURIComponent(playerId)}?includeMetadata=true`, cfg.auth);
      let meta = {}; try { meta = e?.metadata ? JSON.parse(e.metadata) : {}; } catch { /* none */ }
      if (e && isNum(e.score, 0, V.maxTotalPR)) pp = e.score;
      if (isInt(meta.l, 1, V.maxLevel)) level = meta.l;
    } catch { /* not ranked yet */ }
    if (level <= 1) {
      try { const c = (await publicItems(cfg, playerId, ["card"])).card; if (c && isInt(c.level, 1, V.maxLevel)) level = c.level; } catch { /* no card */ }
    }
    rec = { pp, level, hist: [] };
  }
  return { key, rec };
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
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

/** The badge and role lists, read again when they're more than a minute old (charters' rights depend on them). */
let moderationAt = 0;
/** Moderator actions: Senterra, the official account, and players with the MOD badge (who can't act on developers,
 *  the official account or other moderators). */
async function modGate(env, who, target) {
  if (who.playerId === OWNER || isOfficial(who.playerId)) return;
  await freshModeration(env);
  if (!badgesOf(who.playerId).includes("MOD")) fail(403, "Only Senterra, the official OCTIVE account and moderators can do that.");
  if (target && (target === OWNER || isOfficial(target) || DEVELOPERS.includes(target) || badgesOf(target).includes("MOD") || badgesOf(target).includes("DEV")))
    fail(403, "Moderators can't moderate developers, the official OCTIVE account or other moderators.");
}

async function freshModeration(env) {
  if (Date.now() - moderationAt < 60_000) return;
  try { await loadModeration(config(env)); moderationAt = Date.now(); } catch { /* keep the last lists */ }
}

async function loadModeration(cfg) {
  const merged = { bans: {}, overrides: {}, roles: {}, badges: {} };
  await Promise.all(DEVELOPERS.map(async (dev) => {
    try {
      const items = await publicItems(cfg, dev, ["moderation", "moderation-mods"]);
      const mm = items["moderation-mods"];
      if (mm && typeof mm === "object") {
        Object.assign(merged.bans, mm.bans || {});
        for (const [id, o] of Object.entries(mm.overrides || {}))
          if (!merged.overrides[id] || new Date(o.at) > new Date(merged.overrides[id].at)) merged.overrides[id] = o;
      }
      const m = items.moderation;
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
  await supporters(env).catch(() => null); // (cards' supporter achievements are checked against it)
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
  // server validation: an entry no real game could have sent is left out and taken off the leaderboard
  const bad = [];
  const checked = entries.filter((e) => {
    const raw = cards.get(e.playerId)?.card;
    let meta = {};
    try { meta = e.metadata ? JSON.parse(e.metadata) : {}; } catch { /* none */ }
    const why = boardProblem(e, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}, meta && typeof meta === "object" ? meta : {});
    if (why) bad.push([e.playerId, why]);
    return !why;
  });
  if (bad.length) await Promise.all(bad.map(([id, why]) => purgeEntry(env, cfg, id, why)));
  const players = checked.map((e, i) => {
    const c = cards.get(e.playerId) || {};
    const card = safeCard(c.card);
    let meta = {};
    try { meta = e.metadata ? JSON.parse(e.metadata) : {}; } catch { /* none */ }
    if (!meta || typeof meta !== "object") meta = {};
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
      country: card.country || (/^[A-Z]{2}$/.test(String(meta.c || "")) ? meta.c : ""),
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
      achievements: shownAchievements(card, e.playerId),
      devFriend: !!card.devFriend,
      role: DEVELOPERS.includes(e.playerId) ? "DEV" : (badgesOf(e.playerId)[0] || moderation.roles[e.playerId] || null),
      badges: badgesOf(e.playerId), check: checkOf(e.playerId),
      socials: badgesOf(e.playerId).includes("CREATOR") ? socialsOf(card, e.playerId) : {},
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
  // another request is rebuilding it: the last board meanwhile. (Its promise can't be shared: Workers drop a
  // promise when the request that made it ends, and every other request waiting on it then fails.)
  if (board && Date.now() - boardBuildingAt < 20_000) return board;
  boardBuildingAt = Date.now();
  try {
    const b = await buildBoard(env);
    board = b; boardAt = Date.now();
    return b;
  } catch (e) {
    if (board) return { ...board, stale: true, error: e.message };
    throw e;
  } finally { boardBuildingAt = 0; }
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
  // a body that says it's too big is refused before it's read
  if (Number(request.headers.get("Content-Length")) > max) fail(413, "That's too big.");
  const text = await request.text();
  if (text.length > max) fail(413, "That's too big.");
  let v;
  try { v = text ? JSON.parse(text) : {}; } catch { fail(400, "The request wasn't valid JSON."); }
  // always an object: a body of null (or a number, a word or a list) read as fields made a server error
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
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

// ---- the official OCTIVE account is everyone's friend: the server makes the friendship (Unity Friends, with the
// service account: no request to accept), once per player, the first time they're online in the game; everyone who
// had an account before gets it from the backfill (/api/admin/official-friends). Removing it later sticks.
// R2: official-friends/<playerId>  (when it was done)
const SOCIAL_API = "https://social.services.api.unity.com/v1";
let socialAuthWay = null; // how Unity Friends took the service account (found on the first call)
let statelessTok = null, statelessUntil = 0;
async function statelessToken(env) {
  if (statelessTok && Date.now() < statelessUntil) return statelessTok;
  const res = await fetch(`https://services.api.unity.com/auth/v1/token-exchange?projectId=${env.UGS_PROJECT_ID}&environmentId=${env.UGS_ENVIRONMENT_ID}`, { method: "POST", headers: { Authorization: config(env).auth } });
  if (!res.ok) throw new Error(`Unity token exchange ${res.status}`);
  const j = await res.json();
  statelessTok = j.accessToken; statelessUntil = Date.now() + 45 * 60_000;
  return statelessTok;
}
/**
 * Unity's Custom ID sign-in (server side, with the service account): with an access token it ties the id to that
 * player; without one it signs in as the player the id is tied to. Gives { idToken, sessionToken, userId }.
 * (Needs the Custom ID provider switched on, and the service account's "Player Authentication Token Issuer" role.)
 */
async function customIdSignIn(env, externalId, accessToken) {
  const res = await fetch(`https://player-auth.services.api.unity.com/v1/projects/${env.UGS_PROJECT_ID}/authentication/server/custom-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", UnityEnvironment: env.UGS_ENVIRONMENT_NAME || "production", Authorization: "Bearer " + (await statelessToken(env)) },
    body: JSON.stringify(accessToken ? { externalId, accessToken } : { externalId }),
  });
  const text = await res.text();
  if (!res.ok) { console.log("custom id", res.status, text.slice(0, 300)); fail(res.status === 409 ? 409 : 502, res.status === 409 ? "That Discord is tied to another OCTIVE account." : "Unity's sign-in didn't work right now. Try again in a moment."); }
  let j = {};
  try { j = JSON.parse(text); } catch { /* none */ }
  return { idToken: j.idToken, sessionToken: j.sessionToken, userId: j.userId || (j.user && j.user.id) || jwtSubject(j.idToken) };
}
/** The player id ("sub") inside a Unity id token. */
function jwtSubject(t) {
  try { const p = String(t || "").split(".")[1]; return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(p.length / 4) * 4, "="))).sub || null; } catch { return null; }
}

/**
 * Playing inside Discord (2.0): the Activity page sends the code Discord gave it; it's exchanged for the player's
 * Discord, and when that Discord is linked to an OCTIVE account (and tied to it for signing in), the server signs
 * them in to that account. Not linked: the page says to link it in the game first.
 */
async function activityToken(request, env) {
  const b = await bodyOf(request, 2_000);
  const code = String(b.code || "");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(code)) fail(400, "That Discord code isn't valid.");
  if (!env.DISCORD_CLIENT_SECRET) fail(503, "Playing inside Discord isn't set up on the server yet.");
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DISCORD_APP_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) fail(401, "Discord didn't accept the sign-in.");
  const me = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + tok.access_token } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!me || !me.id) fail(401, "Discord didn't say who you are.");
  const out = { access_token: tok.access_token, discordName: me.global_name || me.username || "" };
  const playerId = await linkedPlayer(env, me.id);
  if (!playerId) return reply({ ...out, linked: false });
  const rec = await record(env, playerId);
  if (!rec.discord || rec.discord.id !== me.id) return reply({ ...out, linked: false });
  await loadModeration(config(env));
  if (moderation.bans[playerId]) fail(403, "This account is banned.");
  if (!rec.discord.activity) return reply({ ...out, linked: true, ready: false });
  const s = await customIdSignIn(env, "discord-" + me.id);
  if (!s.idToken || (s.userId && s.userId !== playerId)) fail(409, "Your Discord sign-in doesn't match your OCTIVE account: open OCTIVE, unlink and link Discord again.");
  return reply({ ...out, linked: true, ready: true, token: s.idToken, sessionToken: s.sessionToken, playerId });
}

/**
 * The Discord Activity's page: Discord's SDK (through the "/sdk" URL mapping), the sign-in above, every address the game
 * reaches sent through Discord's proxy (the Developer Portal's URL mappings), then the browser build, like the website's
 * play page. Documentation/DISCORD_ACTIVITY.md lists the mappings.
 */
const ACTIVITY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<title>OCTIVE</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #07080e; color: #eef0ff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
  #stage { position: fixed; inset: 0; }
  #game { width: 100%; height: 100%; display: block; background: #000; outline: none; }
  #loading { position: fixed; inset: 0; display: grid; place-items: center; z-index: 10; background: radial-gradient(900px 500px at 50% 30%, #2a1f6644, transparent 60%), #07080e; transition: opacity .5s; }
  #loading.gone { opacity: 0; pointer-events: none; }
  .box { width: min(440px, 88vw); display: flex; flex-direction: column; align-items: center; gap: 16px; text-align: center; }
  .word { font-weight: 800; letter-spacing: .4em; font-size: 24px; margin-right: -.4em; }
  .track { width: 100%; height: 8px; border-radius: 4px; background: #ffffff10; overflow: hidden; }
  .fill { height: 100%; width: 0; border-radius: 4px; background: linear-gradient(90deg, #8b7bff, #4fd6e8); transition: width .2s; }
  .status { color: #9aa0bd; font-size: 14px; min-height: 1.4em; line-height: 1.6; }
  .error { color: #ff9aaa; font-size: 15px; line-height: 1.6; }
</style>
</head>
<body>
<div id="stage"><canvas id="game" tabindex="-1" aria-label="OCTIVE"></canvas></div>
<div id="loading" role="status" aria-live="polite"><div class="box">
  <div class="word">OCTIVE</div>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="status" id="status">Connecting to Discord…</div>
</div></div>
<script type="module">
import { DiscordSDK, patchUrlMappings } from "/.proxy/sdk/npm/@discord/embedded-app-sdk@2.1.0/+esm";
const CLIENT_ID = "1569883934827745330";
const canvas = document.getElementById("game"), fill = document.getElementById("fill"), status = document.getElementById("status"), loading = document.getElementById("loading");
function fail(text) { status.className = "error"; status.textContent = text; fill.parentElement.hidden = true; }
canvas.addEventListener("pointerdown", () => canvas.focus());
// everything the game reaches goes through Discord's proxy (an Activity can't reach other addresses)
patchUrlMappings([
  { prefix: "/w", target: "octive-rankings-api.lunalazum18.workers.dev" },
  { prefix: "/ugs-auth", target: "player-auth.services.api.unity.com" },
  { prefix: "/ugs-save", target: "cloud-save.services.api.unity.com" },
  { prefix: "/ugs-lb", target: "leaderboards.services.api.unity.com" },
  { prefix: "/ugs-social", target: "social.services.api.unity.com" },
  { prefix: "/ugs-lobby", target: "lobby.services.api.unity.com" },
  { prefix: "/ugs-relay", target: "relay-allocations.services.api.unity.com" },
  { prefix: "/ugs-api", target: "services.api.unity.com" },
  { prefix: "/osu", target: "b.ppy.sh" },
]);
(async () => {
  try {
    const sdk = new DiscordSDK(CLIENT_ID);
    await sdk.ready();
    status.textContent = "Signing in with Discord…";
    const a = await sdk.commands.authorize({ client_id: CLIENT_ID, response_type: "code", state: "", prompt: "none", scope: ["identify"] });
    const code = a && (a.code || (a.data && a.data.code));
    const r = await fetch("/activity/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) });
    const auth = await r.json().catch(() => ({}));
    if (!r.ok) { fail(auth.error || "Couldn't sign in."); return; }
    try { await sdk.commands.authenticate({ access_token: auth.access_token }); } catch (e) { /* the game doesn't need it */ }
    if (!auth.linked) { fail("Link your Discord to your OCTIVE account first: in OCTIVE (on your computer, phone or the website) open Settings → Profile → Discord and link it. Then start the activity again."); return; }
    if (!auth.ready) { fail("Almost there: open OCTIVE once, signed in, on your computer or phone (it finishes setting up Discord sign-in). Then start the activity again."); return; }
    // the game signs in with these (WebPlatform.DiscordActivityAuth)
    window.octiveDiscord = { token: auth.token, sessionToken: auth.sessionToken, playerId: auth.playerId, name: auth.discordName, instance: sdk.instanceId || "" };
    status.textContent = "Finding the latest version…";
    const m = await fetch("/releases/latest.json", { cache: "no-cache" }).then((x) => x.json());
    if (!m || !m.web) { fail("The browser version isn't out yet."); return; }
    const w = m.web, base = "/web/" + w.version + "/~" + (w.build || String(m.published || "").replace(/[^0-9]/g, ""));
    status.textContent = "Loading OCTIVE " + w.version + "…";
    const script = document.createElement("script");
    script.src = base + "/Build/" + w.loader;
    script.onerror = () => fail("The game couldn't be loaded. Close the activity and start it again.");
    script.onload = () => {
      createUnityInstance(canvas, {
        dataUrl: base + "/Build/" + w.data, frameworkUrl: base + "/Build/" + w.framework, codeUrl: base + "/Build/" + w.code, streamingAssetsUrl: base + "/StreamingAssets",
        companyName: "Hazelwood", productName: "OCTIVE", productVersion: w.version, matchWebGLToCanvasSize: true, autoSyncPersistentDataPath: true,
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      }, (p) => { fill.style.width = Math.round(p * 100) + "%"; status.textContent = p < 0.9 ? "Downloading… " + Math.round(p * 100) + "%" : "Starting…"; })
        .then(() => { loading.classList.add("gone"); canvas.focus(); })
        .catch((e) => fail("OCTIVE couldn't start: " + String((e && e.message) || e)));
    };
    document.body.appendChild(script);
  } catch (e) { fail("OCTIVE couldn't start inside Discord: " + String((e && e.message) || e)); }
})();
</script>
</body>
</html>`;

async function socialAdmin(env, method, path, body, asPlayer) {
  const ways = socialAuthWay ? [socialAuthWay] : ["bearer", "basic"];
  const tried = [];
  for (const way of ways) {
    const headers = { "Content-Type": "application/json", ProjectId: env.UGS_PROJECT_ID };
    // a service caller acts as one player (Unity: "a service caller must supply a player to impersonate")
    if (asPlayer) headers["impersonated-user-id"] = asPlayer;
    if (way === "bearer") headers.Authorization = "Bearer " + (await statelessToken(env));
    else { headers.Authorization = config(env).auth; headers.UnityEnvironment = env.UGS_ENVIRONMENT_NAME || "production"; }
    const res = await fetch(SOCIAL_API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) { tried.push(`${way} ${res.status}: ${text.slice(0, 160)}`); continue; }
    socialAuthWay = way;
    return { status: res.status, text, way };
  }
  throw new Error("Unity Friends refused the server: " + tried.join(" | "));
}
const officialFriendsDone = new Set();
/**
 * The friend lists profiles show are a copy each game uploads (/dm/friends): the official account's copy only changes
 * when someone plays as it, so the server adds both sides itself (a player who already removed OCTIVE is left out).
 */
async function mirrorOfficialFriend(env, playerId) {
  const name = dmName(await displayName(env, playerId).catch(() => "Player")) || "Player";
  await r2update(env, dmInboxKey(playerId), dmEmptyInbox, (box) => {
    box.friends ||= [];
    const had = (box.unfriend || []).includes(OFFICIAL_ID);
    if (had) box.unfriend = box.unfriend.filter((x) => x !== OFFICIAL_ID);
    if (box.friends.some((f) => f.id === OFFICIAL_ID)) return had ? undefined : false;
    box.friends.push({ id: OFFICIAL_ID, name: "OCTIVE" });
  });
  await r2update(env, dmInboxKey(OFFICIAL_ID), dmEmptyInbox, (box) => {
    box.friends ||= [];
    const x = box.friends.find((f) => f.id === playerId);
    if (x) { if (x.name === name) return false; x.name = name; return; }
    box.friends.push({ id: playerId, name });
  });
}
/** Puts back a friendship with OCTIVE that an older game removed (OCTIVE can't be removed). */
async function refriendOfficial(env, playerId) {
  let r = await socialAdmin(env, "POST", "/relationships?withPresence=false&withProfile=false", { type: "FRIEND", members: [{ id: OFFICIAL_ID }, { id: playerId }] }, playerId);
  if (r.status === 409) r = await socialAdmin(env, "POST", "/relationships?withPresence=false&withProfile=false", { type: "FRIEND", members: [{ id: playerId }, { id: OFFICIAL_ID }] }, OFFICIAL_ID);
  if (!((r.status >= 200 && r.status < 300) || r.status === 409)) throw new Error(`Unity Friends ${r.status}: ${r.text.slice(0, 200)}`);
  await mirrorOfficialFriend(env, playerId);
}

/** Makes the player friends with the official OCTIVE account (once). Returns what happened. */
async function befriendOfficial(env, playerId) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(playerId || "") || isOfficial(playerId)) return "skipped";
  if (officialFriendsDone.has(playerId)) return "already";
  const key = `official-friends/${playerId}`;
  // done before: unless it was a "409" from before OCTIVE could accept waiting requests (v2), which is tried once more
  const mark = await r2json(env, key, null).catch(() => null);
  if (mark && (mark.status !== 409 || mark.v >= 2)) { officialFriendsDone.add(playerId); return "already"; }
  const body = { type: "FRIEND", members: [{ id: OFFICIAL_ID }, { id: playerId }] };
  let r = await socialAdmin(env, "POST", "/relationships?withPresence=false&withProfile=false", body, playerId);
  // 409: a friend request is already waiting between them (the player asked OCTIVE before), or they're friends,
  // or one blocked the other. OCTIVE accepts a waiting request; still 409 means friends already (or blocked).
  if (r.status === 409) r = await socialAdmin(env, "POST", "/relationships?withPresence=false&withProfile=false", { type: "FRIEND", members: [{ id: playerId }, { id: OFFICIAL_ID }] }, OFFICIAL_ID);
  if ((r.status >= 200 && r.status < 300) || r.status === 409) {
    await env.RELEASES.put(key, JSON.stringify({ at: new Date().toISOString(), status: r.status, v: 2 }), { httpMetadata: { contentType: "application/json" } });
    officialFriendsDone.add(playerId);
    await mirrorOfficialFriend(env, playerId).catch((e) => console.log("official friend list", e && e.message));
    return r.status === 409 ? "already friends" : "friended";
  }
  throw new Error(`Unity Friends ${r.status}: ${r.text.slice(0, 200)}`);
}

async function privateItems(env, playerId, keys) {
  const q = keys.map((k) => "keys=" + encodeURIComponent(k)).join("&");
  const body = await admin(env, "GET", `${config(env).save}/players/${encodeURIComponent(playerId)}/items?${q}`);
  const out = {};
  for (const it of body?.results ?? []) {
    let v = it.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* keep */ } }
    out[it.key] = it.key === "scores" ? scoresToPoints(v) : v; // older games scores in 2.1.1 points
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

/**
 * Adds or replaces a player's ranking entry. Unity's admin API has no way to write a score (it answers 404), so this
 * is the Leaderboards player API with the service account's token; the project policy only stops players writing
 * their own.
 */
async function writeScore(env, playerId, score, metadata) {
  const url = `https://leaderboards.services.api.unity.com/v1/projects/${env.UGS_PROJECT_ID}/leaderboards/${LEADERBOARD}/scores/players/${encodeURIComponent(playerId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await statelessToken(env)), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ score, metadata }),
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`Unity returned ${res.status} for the ranking: ${text.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
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
  youtube: "https://www.youtube.com/@{0}", tiktok: "https://www.tiktok.com/@{0}",
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
    socials: socialsOf(card, who.playerId),
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
          if (k === "twitch") continue; // linked, not typed (older pages and games still send it)
          if (k === "discord" && who.playerId !== OWNER) continue; // the official server's link only
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
      // the public card: written by the server (players can't write public items once Access Control is on)
      try {
        await serverWrite(async () => { await saveItem(env, who.playerId, "card", safeCard(card), true); if (small) await saveItem(env, who.playerId, "avatar", small, true); });
      } catch (e) {
        if (e.code !== "server-writes-unavailable") throw e;
        await saveAsPlayer(env, token, who.playerId, "card", card, true);
        if (small) await saveAsPlayer(env, token, who.playerId, "avatar", small, true);
      }
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
    // ---- the developer's and the official account's moderator view of a player (the game's player pop-up)
    // ---- a moderator's ban, unban, name or picture (kept in their own list next to Senterra's; never badges or roles)
    case "mod/act": {
      const b = await bodyOf(request, 4_000);
      const who = await signedIn(request, env);
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      await modGate(env, who, id);
      const action = String(b.action || ""), text = cleanText(b.text, 200);
      const cfg = config(env);
      const byName = await displayName(env, who.playerId);
      const cur = (await publicItems(cfg, OWNER, ["moderation-mods"]).catch(() => ({})))["moderation-mods"] || {};
      const list = { bans: cur.bans || {}, overrides: cur.overrides || {}, updated: new Date().toISOString() };
      const now = new Date().toISOString();
      if (action === "ban") list.bans[id] = { name: await displayName(env, id), reason: text || null, by: byName, byId: who.playerId, at: now };
      else if (action === "unban") {
        if (!list.bans[id]) { await loadModeration(cfg); fail(400, moderation.bans[id] ? "Senterra banned them: only Senterra can unban them." : "They aren't banned."); }
        delete list.bans[id];
      } else if (action === "name") {
        if (!/^[A-Za-z0-9_.\-]{3,20}$/.test(text)) fail(400, "Names are 3–20 letters, numbers and _ . -");
        list.overrides[id] = { ...(list.overrides[id] || {}), name: text, at: now, by: byName };
      } else if (action === "picture") list.overrides[id] = { ...(list.overrides[id] || {}), avatar: "default", at: now, by: byName };
      else if (action === "clear") delete list.overrides[id];
      else fail(400, "Unknown action.");
      await serverWrite(() => saveItem(env, OWNER, "moderation-mods", JSON.stringify(list), true));
      await loadModeration(cfg); moderationAt = Date.now();
      cards.delete(id);
      return reply({ ok: true });
    }
    case "mod/inspect": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const cfg = config(env);
      await loadModeration(cfg);
      const [pub, rec, sup, boost, followers, following, inbox, db, web, alerts, rate] = await Promise.all([
        publicItems(cfg, id, ["card", "seen", "platform"]).catch(() => ({})),
        record(env, id),
        r2json(env, `supporters/${id}.json`, null),
        r2json(env, `boosters/${id}.json`, null),
        followerCount(env, id).catch(() => 0),
        followingOf(env, id).catch(() => []),
        r2json(env, dmInboxKey(id), dmEmptyInbox()).catch(() => ({})),
        r2json(env, WS_DB, { items: [] }),
        env.RELEASES.head(`webseen/${id}`).catch(() => null),
        r2json(env, `scores/rate/${id}.json`, null),
        r2json(env, `workshop/rate/${id}.json`, null),
      ]);
      const card = pub.card || {};
      const st = supportStatus(sup, id, boost);
      const uploads = (db.items || []).filter((x) => x.creatorId === id && !x.removed).map(wsPublic);
      // how they sign in: their OCTIVE username, and any other ways linked to the account (Unity's admin API)
      let signInName = null, signInWith = [];
      try {
        const u = await admin(env, "GET", `${identity(env)}/users/${encodeURIComponent(id)}`);
        signInName = u?.usernamePasswordLoginMetadata?.username || u?.username || null;
        signInWith = (u?.externalIds || []).map((x) => x.providerId).filter((x) => x && x !== "username");
      } catch (e) { console.log("inspect sign-in", e && e.message); }
      return reply({
        playerId: id, name: card.name || null, hasCard: !!pub.card, signInName, signInWith,
        version: card.version || null, ppVersion: card.ppVersion || null, platform: pub.platform || null,
        lastSeenGame: pub.seen || null, lastSeenWebsite: web ? web.uploaded.toISOString() : null,
        badges: badgesOf(id), check: checkOf(id), banned: moderation.bans[id] || null, overrides: moderation.overrides[id] || null,
        discord: rec.discord?.id ? { id: rec.discord.id, username: rec.discord.username || null, name: rec.discord.name || null, linkedAt: rec.discord.at || null, prefs: rec.discordPrefs || {} } : null,
        emailLinked: !!rec.email, emailVerified: !!rec.verified,
        supporter: st, supporterPurchases: (sup?.purchases || []).length,
        followers, following: following.length, friends: (inbox.friends || []).length, blocked: (inbox.blocked || []).length,
        conversations: Object.keys(inbox.threads || {}).length,
        uploads, scoresSharedToday: rate && rate.day === new Date().toISOString().slice(0, 10) ? rate.n : 0,
        achievements: Object.keys(card.achievements || {}).length,
        stats: { pp: card.pp || 0, accuracy: card.accuracy || 0, level: card.level || 0, playCount: card.playCount || 0, playTimeMs: card.playTimeMs || 0, rank: card.rank || 0 },
        flags: await flagsOf(env, id).catch(() => []),
        held: (await r2json(env, `rank/players/${id}.json`, null).catch(() => null))?.held || null,
        statsResetAt: (await r2json(env, `rank/reset/${id}.json`, null).catch(() => null))?.at || null,
      });
    }
    // ---- the ranking, worked out and written by the server (the game only says "I played")
    case "rank/sync": {
      const b = await bodyOf(request, 150_000);
      const who = await signedIn(request, env);
      const id = who.playerId, now = Date.now(), official = isOfficial(id);
      const cfg = config(env);
      await loadModeration(cfg);
      if (moderation.bans[id]) fail(403, "This account is banned.");
      const r = await rankFromPlays(env, cfg, id);
      // (dan clears aren't taken from synced plays any more: only from /play/dan/clear, judged from the replay)
      // a jump bigger than a day of real playing waits for a moderator
      const { key, rec } = await paceCheck(env, cfg, id, now);
      rec.hist = (rec.hist || []).filter((h) => now - h.t < 86_400_000);
      const basePR = Math.min(rec.pp, ...rec.hist.map((h) => h.pp));
      const baseLv = Math.min(rec.level, ...rec.hist.map((h) => h.level));
      // a record started at level 1 didn't know the player's level (their old ranking entry didn't say): level isn't
      // held against it, or a long-time player would stay stuck at "Lv1" with a full bar
      const lvKnown = rec.level > 1 || rec.levelKnown === true;
      const approved = rec.approvedUntil && Date.parse(rec.approvedUntil) > now;
      let pub = r, held = null;
      if (!official && !approved && ((r.pacePP ?? r.pp) - basePR > V.dayPR || (lvKnown && r.level - baseLv > V.dayLevels))) {
        held = { pp: r.pp, level: r.level, at: new Date(now).toISOString() };
        pub = lvKnown ? { ...r, pp: Math.min(r.pp, rec.pp), level: Math.min(r.level, rec.level), levelProgress: r.level > rec.level ? 1 : r.levelProgress } : { ...r, pp: Math.min(r.pp, rec.pp) };
        if (!lvKnown) { rec.level = r.level; rec.levelKnown = true; }
        if (!rec.held || now - Date.parse(rec.held.at) > 86_400_000) await flagPlayer(env, id, `held: ${rec.pp} → ${r.pp} PR, level ${rec.level} → ${r.level} within a day`);
        rec.held = rec.held && now - Date.parse(rec.held.at) <= 86_400_000 ? { ...held, at: rec.held.at } : held;
      } else {
        delete rec.held;
        rec.pp = r.pp; rec.level = r.level; rec.levelKnown = true;
        rec.hist.push({ t: now, pp: r.pp, level: r.level });
        if (rec.hist.length > 300) rec.hist = rec.hist.slice(-300);
      }
      // the level is known from now on: the day's history shouldn't hold it against the old level-1 start either
      if (!lvKnown) rec.hist = rec.hist.map((h) => ({ ...h, level: Math.max(h.level || 1, rec.level) }));
      if (official) pub = { ...pub, level: 1000, levelProgress: 1 };
      // the public card: numbers from above, the rest checked
      const avatarHash = typeof b.avatarHash === "string" && /^[A-Za-z0-9_-]{0,80}$/.test(b.avatarHash) ? b.avatarHash : "";
      let avatarB64 = null;
      if (typeof b.avatar === "string") {
        if (b.avatar === "") avatarB64 = "";
        else {
          let bytes = null;
          try { bytes = b64Bytes(b.avatar); } catch { /* not base64 */ }
          if (!bytes || bytes.length > 80_000 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) fail(400, "That profile picture can't be used.");
          avatarB64 = b.avatar;
        }
      }
      const name = validName(b.name) ? b.name : validName(who.username) ? who.username : "Player";
      // their country (2.0): from where the connection comes from, every sync
      const country = countryOf(request);
      const card = {
        name, pp: pub.pp, accuracy: pub.accuracy, level: pub.level, levelProgress: pub.levelProgress, avatar: avatarHash, country,
        totalScore: pub.totalScore, xp: pub.xp, playCount: pub.playCount, fullCombos: pub.fullCombos, maxCombo: pub.maxCombo,
        playTimeMs: pub.playTimeMs, bio: cleanBio(b.bio), devFriend: await isDevFriend(env, id).catch(() => false), rank: 0,
        socials: badgesOf(id).includes("CREATOR") ? socialsOf({ socials: b.socials }, id) : {},
        version: typeof b.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(b.version) ? b.version : "",
        ppVersion: pub.ppVersion,
        // (2.0.1) only the achievements the server can see were earned (see checkAchievements); achV marks a checked card
        achievements: official ? cleanAchievements(b.achievements)
          : await checkAchievements(env, id, b.achievements, r, pub).catch((e) => { console.log("achievements", id, e && e.message); return {}; }),
        achV: 1,
      };
      // friends see new achievements (only a few at once: a first sync, or many unlocked together, isn't news)
      const achNow = Object.keys(card.achievements || {});
      if (Array.isArray(rec.ach) && !official) {
        const fresh = achNow.filter((a) => !rec.ach.includes(a));
        if (fresh.length > 0 && fresh.length <= 8) await addFeed(env, id, { kind: "achievements", ids: fresh.slice(0, 6), n: fresh.length }).catch(() => {});
      }
      if (achNow.length) rec.ach = achNow;
      const platform = typeof b.platform === "string" && /^[a-z0-9-]{1,24}$/.test(b.platform) ? b.platform : "";
      let rank = 0;
      await serverWrite(async () => {
        if (!official) {
          const meta = { n: name, l: pub.level, lp: pub.levelProgress, a: pub.accuracy, av: avatarHash, ts: pub.totalScore, pc: pub.playCount, fc: pub.fullCombos, pv: pub.ppVersion, c: country || undefined };
          const e = await writeScore(env, id, pub.pp, meta);
          rank = isInt(e?.rank, 0, 1e9) ? e.rank + 1 : 0;
        }
        card.rank = rank;
        await saveItem(env, id, "card", card, true);
        if (avatarB64 !== null) await saveItem(env, id, "avatar", avatarB64, true);
        await saveItem(env, id, "seen", b.hidden === true ? "" : new Date(now).toISOString(), true);
        await saveItem(env, id, "platform", platform, true);
      });
      rec.at = new Date(now).toISOString();
      await env.RELEASES.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
      cards.delete(id);
      // the profile's progress graphs (what the ranking shows today), and their crew's score
      if (!official) await rememberDay(env, id, pub.pp, pub.accuracy, rank, pub.level).catch((e) => console.log("progress day", e && e.message));
      if (!official) await crewTouch(env, id, pub.pp).catch((e) => console.log("crew", e && e.message));
      return reply({ ok: true, pp: pub.pp, level: pub.level, rank, held, leftOut: r.problems.length, counted: r.counted, country });
    }
    case "rank/seen": {
      // the online heartbeat (written by the server: nobody can make anyone else look online)
      const b = await bodyOf(request, 2_000);
      const who = await signedIn(request, env);
      const platform = typeof b.platform === "string" && /^[a-z0-9-]{1,24}$/.test(b.platform) ? b.platform : "";
      await serverWrite(async () => {
        await saveItem(env, who.playerId, "seen", b.hidden === true ? "" : new Date().toISOString(), true);
        await saveItem(env, who.playerId, "platform", platform, true);
      });
      if (env.OFFICIAL_FRIENDS !== "off") await befriendOfficial(env, who.playerId).catch((e) => console.log("official friend", e && e.message));
      return reply({ ok: true });
    }
    case "mod/moderation": {
      // the developer's moderation list (bans, name and picture overrides, roles, badges)
      const b = await bodyOf(request, 300_000);
      const who = await signedIn(request, env);
      if (!DEVELOPERS.includes(who.playerId)) fail(403, "Only the developer can change the moderation list.");
      const d = b.data;
      const idOk = (k) => /^[A-Za-z0-9_-]{8,64}$/.test(k);
      if (!d || typeof d !== "object" || Array.isArray(d)) fail(400, "That moderation list isn't valid.");
      for (const part of ["bans", "overrides", "roles", "badges"]) {
        const m = d[part];
        if (m === undefined || m === null) continue;
        if (typeof m !== "object" || Array.isArray(m) || Object.keys(m).some((k) => !idOk(k))) fail(400, `The moderation list's ${part} aren't valid.`);
      }
      await serverWrite(() => saveItem(env, who.playerId, "moderation", JSON.stringify(d), true));
      return reply({ ok: true });
    }
    case "mod/reset-stats": {
      // a player's stats back to a new account's: ranking, plays, levels, achievements, chart leaderboards
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const cfg = config(env);
      const at = new Date().toISOString();
      await serverWrite(async () => {
        await admin(env, "DELETE", `${cfg.scores}/players/${encodeURIComponent(id)}`);
        const pub = await publicItems(cfg, id, ["card"]).catch(() => ({}));
        const old = safeCard(pub.card);
        await saveItem(env, id, "card", { ...old, pp: 0, accuracy: 0, level: 1, levelProgress: 0, totalScore: 0, xp: 0, playCount: 0, fullCombos: 0, maxCombo: 0, playTimeMs: 0, rank: 0, achievements: {} }, true);
        await saveItem(env, id, "scores", JSON.stringify({ version: 1, charts: {}, recent: [], totalPlays: 0, totalNotesHit: 0, totalScore: 0, xp: 0, playTimeMs: 0, ppVersion: PP_LATEST }), false);
        // the game sees this, and starts that account over on every device
        await saveItem(env, id, "statsReset", at, false);
      });
      await env.RELEASES.put(`rank/reset/${id}.json`, JSON.stringify({ at, by: who.playerId }), { httpMetadata: { contentType: "application/json" } });
      await env.RELEASES.delete(achKey(id)).catch(() => {}); // (2.0.1) the achievements the server accepted
      await env.RELEASES.delete(`rank/players/${id}.json`);
      // off every chart leaderboard too
      let cursor, boardsTouched = 0;
      do {
        const list = await env.RELEASES.list({ prefix: "scores/", cursor });
        for (const o of list.objects) {
          if (o.key.startsWith("scores/rate/") || !o.key.endsWith(".json")) continue;
          let had = false;
          await r2update(env, o.key, () => ({ entries: [] }), (d) => { const n = (d.entries || []).length; d.entries = (d.entries || []).filter((e) => e.playerId !== id); had = d.entries.length !== n; if (!had) return false; });
          if (had) { boardsTouched++; boards.delete(o.key); }
        }
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      await flagPlayer(env, id, `stats reset by ${who.playerId === OWNER ? "Senterra" : "Octive"}`);
      board = null; cards.delete(id);
      return reply({ ok: true, at, boardsTouched });
    }
    case "mod/reset-link": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const token = [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, "0")).join("");
      await env.RELEASES.put(`reset-links/${token}.json`, JSON.stringify({ playerId: id, exp: Date.now() + 86_400_000, by: who.playerId }), { httpMetadata: { contentType: "application/json" } });
      return reply({ ok: true, url: `${SITE}#/reset?link=${token}` });
    }
    case "reset/link": {
      const b = await bodyOf(request);
      const token = String(b.token || "");
      if (!/^[a-f0-9]{40}$/.test(token)) fail(400, "That reset link isn't valid.");
      const link = await r2json(env, `reset-links/${token}.json`, null);
      if (!link || link.exp < Date.now()) fail(400, "That reset link ran out or was used. Ask for a new one.");
      const problem = passwordProblem(b.newPassword);
      if (problem) fail(400, problem);
      try { await admin(env, "POST", `${identity(env)}/users/${encodeURIComponent(link.playerId)}/change-password`, { newPassword: b.newPassword }); }
      catch (e) {
        if (e.status === 401 || e.status === 403) fail(503, "Password resets aren't switched on yet (the server's Unity service account needs the Player Authentication admin role).");
        if (e.status === 400) fail(400, "Unity didn't accept that password: " + e.message.replace(/^.*?: /, "").slice(0, 160));
        throw e;
      }
      await env.RELEASES.delete(`reset-links/${token}.json`);
      return reply({ ok: true, message: "Your password is changed. Sign in with the new one." });
    }
    case "mod/rank-approve": {
      // lets a held PR / level jump through (for a day)
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      const key = `rank/players/${id}.json`;
      const rec = await r2json(env, key, null);
      if (!rec) fail(404, "Nothing is held for that player.");
      rec.approvedUntil = new Date(Date.now() + 86_400_000).toISOString();
      delete rec.held;
      await env.RELEASES.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
      return reply({ ok: true, approvedUntil: rec.approvedUntil });
    }
    case "mod/anticheat": {
      // Senterra / Octive: the anti-cheat's state (bans on or watching only, the trusted players); { bans } switches it
      const b = await bodyOf(request, 2_000);
      const who = await signedIn(request, env);
      if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account can do that.");
      let cfg = await r2json(env, AC_CONFIG, { bans: false });
      if (typeof b.bans === "boolean" && b.bans !== (cfg.bans === true)) {
        const by = await displayName(env, who.playerId);
        cfg = { bans: b.bans, by, at: new Date().toISOString() };
        await r2put(env, AC_CONFIG, cfg);
        await modPost(env, { title: b.bans ? "Anti-cheat: bans are ON" : "Anti-cheat: watching only (bans off)", color: b.bans ? 0xFF4D6D : 0x5DA9FF,
          description: b.bans ? `${modText(by, 40)} switched bans on: a sign now holds a play back, and proof bans the account (trusted players excepted).` : `${modText(by, 40)} switched bans off: the anti-cheat only posts what it would do.`,
          timestamp: cfg.at });
      }
      const trusted = (await r2json(env, AC_TRUSTED, { players: {} })).players || {};
      return reply({ ok: true, bans: cfg.bans === true, since: cfg.at || null, trusted: Object.entries(trusted).map(([id, t]) => ({ id, name: t.name, by: t.by, at: t.at })) });
    }
    case "mod/trust": {
      // Senterra / Octive: a player the anti-cheat never holds back or bans (top players close to its limits)
      const b = await bodyOf(request, 2_000);
      const who = await signedIn(request, env);
      if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account can mark players as trusted.");
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const on = b.trusted !== false;
      const [by, name] = await Promise.all([displayName(env, who.playerId), displayName(env, id)]);
      await r2update(env, AC_TRUSTED, () => ({ players: {} }), (d) => {
        d.players ||= {};
        if (on) d.players[id] = { name, by, at: new Date().toISOString() };
        else if (d.players[id]) delete d.players[id];
        else return false;
      });
      await modPost(env, { title: on ? "Anti-cheat: trusted player added" : "Anti-cheat: trusted mark removed", color: 0x5DA9FF,
        description: `${modText(by, 40)} ${on ? "marked" : "took the mark off"} ${modText(name, 60)} (${id})${on ? ": the anti-cheat won't hold back their plays or ban them (alerts still post)." : "."}`,
        timestamp: new Date().toISOString() });
      return reply({ ok: true, trusted: on });
    }
    case "report": {
      // a player reports another (cheating, an offensive name or picture, chat): it goes to #moderator-only
      const b = await bodyOf(request, 4_000);
      const who = await signedIn(request, env);
      await fileReport(env, who, String(b.playerId || ""), b.reason, b.details, b.where);
      return reply({ ok: true });
    }
    case "mod/chart-shapes": {
      // Senterra / Octive: fill in older uploads' chart shapes now (the 6-hourly job does it a batch at a time)
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account can do that.");
      return reply({ ok: true, ...(await fillChartShapes(env, Math.max(1, Math.min(12, Number(b.uploads) || 6)))) });
    }
    case "mod/verify": {
      // verify (or un-verify) a song: its charts get a global leaderboard
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      if (who.playerId !== OWNER && !isOfficial(who.playerId)) await freshModeration(env);
      if (who.playerId !== OWNER && !isOfficial(who.playerId) && !badgesOf(who.playerId).includes("CHARTER")) fail(403, "Only Senterra, the official OCTIVE account and charters can verify songs.");
      const id = String(b.songId || "");
      if (!songIdOk(id) || officialSong(id)) fail(400, "That song can't be verified.");
      const clean = (v, n) => String(v || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, n);
      let out = null;
      await r2update(env, "verified.json", () => ({ songs: {} }), (d) => {
        d.songs ||= {};
        if (b.verified === false) delete d.songs[id];
        else d.songs[id] = { title: clean(b.title, 120), artist: clean(b.artist, 120), osuSet: Number(b.osuSet) > 0 ? Math.round(Number(b.osuSet)) : undefined, workshopId: /^[a-z0-9]{16,40}$/.test(String(b.workshopId || "")) ? String(b.workshopId) : undefined, by: who.playerId, at: new Date().toISOString() };
        out = d;
      });
      verifiedCache = out; verifiedAt = Date.now();
      // its Workshop uploads follow (the badge, daily charts, the request closed): by song id, or an osu! map's set
      const on = b.verified !== false;
      const set = /^osu-(\d+)$/.exec(id);
      await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
        let changed = false;
        for (const x of d.items || []) {
          if (x.removed || x.type !== "charts") continue;
          const songs = (x.meta && x.meta.songs) || [];
          const match = (x.songIds || []).includes(id) || (set && songs.some((sg) => String(sg.osuSet || "") === set[1]));
          if (!match) continue;
          if (on) { if (!x.verified || x.verifyRequest) { x.verified = true; delete x.verifyRequest; changed = true; } }
          else if (x.verified && !x.builtin) { x.verified = false; changed = true; }
        }
        if (!changed) return false;
      }).catch(() => {});
      verIdx = null; danIdx = null; // the verified-copy check, dans and dailies read the uploads' verified flag
      return reply({ ok: true, verified: on, count: Object.keys(out?.songs || {}).length });
    }
    case "mod/unlink-twitch": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const rec = await record(env, id);
      if (!rec.twitch?.id) fail(400, "They haven't linked a Twitch.");
      await env.RELEASES.delete(`twitch/${rec.twitch.id}.json`);
      delete rec.twitch; delete rec.twitchPrefs;
      await saveRecord(env, id, rec);
      return reply({ ok: true });
    }
    case "mod/unlink-discord": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
      const rec = await record(env, id);
      if (!rec.discord?.id) fail(400, "They haven't linked a Discord.");
      await env.RELEASES.delete(`discord/${rec.discord.id}.json`);
      delete rec.discord; delete rec.discordPrefs;
      await saveRecord(env, id, rec);
      return reply({ ok: true });
    }
    case "mod/remove-uploads": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      await modGate(env, who, String(b.playerId || ""));
      const id = String(b.playerId || "");
      const db = await r2json(env, WS_DB, { items: [] });
      const mine = (db.items || []).filter((x) => x.creatorId === id && !x.removed);
      for (const it of mine) {
        if (it.messageId) { try { await discordApi(env, "DELETE", `/channels/${it.channelId}/messages/${it.messageId}`); } catch { /* already gone */ } }
        await wsDeleteFiles(env, it);
        wsUrls.delete(it.id);
      }
      await r2update(env, WS_DB, () => ({ items: [] }), (d) => { for (const x of d.items || []) if (x.creatorId === id) x.removed = true; });
      return reply({ ok: true, removed: mine.length });
    }
    case "discord/status": {
      // the game's Discord settings: who's linked and the Discord options
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      const p = rec.discordPrefs || {};
      return reply({ linked: rec.discord?.id ? { name: rec.discord.name || "", at: rec.discord.at } : null, prefs: { dmAlerts: !!p.dmAlerts, updates: !!p.updates, show: !!p.show, streak: p.streak !== false },
        activity: !!rec.discord?.activity });
    }
    case "discord/activity-link": {
      // playing inside Discord (2.0): the linked Discord becomes a way to sign in to this account (Unity's Custom ID
      // sign-in, tied to the account with the player's own access token, this request's), so the Discord Activity can
      // sign them in. The game asks for it once, signed in, after Discord is linked.
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      if (!rec.discord?.id) fail(400, "Link your Discord first.");
      if (rec.discord.activity) return reply({ ok: true, already: true });
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const s = await customIdSignIn(env, "discord-" + rec.discord.id, token);
      if (s.userId && s.userId !== who.playerId) fail(409, "That Discord is tied to another OCTIVE account.");
      rec.discord.activity = true;
      await saveRecord(env, who.playerId, rec);
      return reply({ ok: true });
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
      if ("streak" in b) p.streak = !!b.streak;
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
      return reply({ ok: true, prefs: { dmAlerts: !!p.dmAlerts, updates: !!p.updates, show: !!p.show, streak: p.streak !== false }, note });
    }
    // ---- (2.1.1) Twitch: linked with Twitch's own sign-in (not typed in), so the channel is really the player's
    case "twitch/start": {
      const who = await signedIn(request, env);
      if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) fail(503, "Twitch linking isn't set up on the server yet.");
      const state = [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const b0 = await bodyOf(request).catch(() => ({}));
      await r2put(env, `twitch/state/${state}.json`, { playerId: who.playerId, exp: Date.now() + 15 * 60_000, site: b0 && b0.from === "site" });
      const q = new URLSearchParams({ response_type: "code", client_id: env.TWITCH_CLIENT_ID, redirect_uri: twitchRedirect(request), scope: "", state, force_verify: "true" });
      return reply({ url: "https://id.twitch.tv/oauth2/authorize?" + q.toString() });
    }
    case "twitch/status": {
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      return reply({ linked: rec.twitch?.id ? { login: rec.twitch.login, name: rec.twitch.name || rec.twitch.login, at: rec.twitch.at } : null, show: rec.twitchPrefs?.show !== false, ready: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) });
    }
    case "twitch/prefs": {
      const b = await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      if (!rec.twitch?.id) fail(400, "Link your Twitch first.");
      rec.twitchPrefs = { ...(rec.twitchPrefs || {}), show: b.show !== false };
      await saveRecord(env, who.playerId, rec);
      return reply({ ok: true, show: rec.twitchPrefs.show });
    }
    case "twitch/unlink": {
      await bodyOf(request);
      const who = await signedIn(request, env);
      const rec = await record(env, who.playerId);
      if (rec.twitch?.id) await env.RELEASES.delete(`twitch/${rec.twitch.id}.json`);
      delete rec.twitch; delete rec.twitchPrefs;
      await saveRecord(env, who.playerId, rec);
      return reply({ ok: true });
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
    case "reset/options": {
      // which ways this account can get a reset code (email, Discord): the website shows only those
      const b = await bodyOf(request);
      const username = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._@-]{3,20}$/.test(username)) return reply({ email: true, discord: false });
      const id = await findPlayer(env, username);
      const rec = id ? await record(env, id) : {};
      return reply({ email: true, discord: !!(rec.discord && rec.discord.id) });
    }
    case "reset/start": {
      const b = await bodyOf(request);
      const username = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9._@-]{3,20}$/.test(username)) fail(400, "Type your OCTIVE username.");
      if (b.via === "discord") {
        // the code as a DM from the OCTIVE bot on the linked Discord
        const sent = { ok: true, message: "If that account has a linked Discord, OCTIVE sent you a code in your Discord DMs." };
        const did = await findPlayer(env, username);
        if (!did) return reply(sent);
        const drec = await record(env, did);
        if (!drec.discord || !drec.discord.id || !env.DISCORD_BOT_TOKEN) return reply(sent);
        allowSend(drec);
        const dcode = newCode();
        drec.reset = { hash: await codeHash(env, did, "reset", dcode), exp: Date.now() + CODE_TTL, tries: 0 };
        try {
          const ch = await discordApi(env, "POST", "/users/@me/channels", { recipient_id: drec.discord.id });
          await discordApi(env, "POST", `/channels/${ch.id}/messages`, { embeds: [{ color: 0x8b7bff, title: "🔑 OCTIVE password reset", description: `Your code for the account **${username}**: \`${dcode}\`\nIt works for 15 minutes. If you didn't ask for it, ignore this: your password stays the same.` }], allowed_mentions: { parse: [] } });
        } catch (e) { fail(502, "Discord didn't take the message (are your DMs open to the OCTIVE server?)."); }
        await saveRecord(env, did, drec);
        return reply(sent);
      }
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
  if (!items.card || moderation.bans[playerId]) return null;
  try { await supporters(env); } catch { /* its supporter achievements are left out */ }
  const card = safeCard(items.card);
  const seen = items.seen ? Date.parse(items.seen) : 0;
  const ov = moderation.overrides[playerId] || {};
  return {
    id: playerId, rank: card.rank || 0, pp: card.pp || 0, name: ov.name || card.name || "Player", accuracy: card.accuracy || 0,
    level: isOfficial(playerId) ? 1000 : card.level || 1, levelProgress: isOfficial(playerId) ? 1 : card.levelProgress || 0, playCount: card.playCount || 0, maxCombo: card.maxCombo || 0,
    fullCombos: card.fullCombos || 0, playTimeMs: card.playTimeMs || 0, totalScore: card.totalScore || 0, bio: card.bio || "", achievements: shownAchievements(card, playerId),
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
        if (list.length) fields.push({ name: `${label} — ${list.length}`, value: list.slice(0, 20).map((p) => `**${clean(p.name)}** · #${p.rank}${/-dev$/.test(p.status || "") ? " · 🧪" : ""}`).join("\n").slice(0, 1024), inline: true });
      }
      const rest = all.filter((p) => !groups.some(([, t]) => t(p.status || "")));
      if (rest.length) fields.push({ name: `🎮 In game — ${rest.length}`, value: rest.slice(0, 20).map((p) => `**${clean(p.name)}** · #${p.rank}`).join("\n").slice(0, 1024), inline: true });
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
      let items = (db.items || []).filter((it) => !it.removed && (!type || it.type === type));
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
      // (not named "supporters": that would hide the supporters() function above and the count would always be 0)
      const supCount = Object.values(sup).filter((s) => s.active).length;
      const gifted = Object.values(giftedIndex).reduce((n, x) => n + x, 0);
      return {
        embeds: [{
          title: "📊 OCTIVE in numbers", url: SITE, color: C_ACCENT,
          fields: [
            { name: "Ranked players", value: fmtN(board.total), inline: true },
            { name: "Online now", value: fmtN(board.online), inline: true },
            { name: "Supporters", value: fmtN(supCount), inline: true },
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
    case "tournament": {
      // staff only (Senterra and the official account, by their linked Discord): the same as the game's /tournament
      const id = await linkedPlayer(env, user.id);
      if (!id || (id !== OWNER && !isOfficial(id))) return { content: "Only Senterra and the official OCTIVE account run tournaments.", flags: EPHEMERAL };
      const sub = (data.options || [])[0] || {}, so = { options: sub.options || [] };
      const body = { action: sub.name || "status" };
      if (sub.name === "create") {
        const range = String(opt(so, "stars") || "").split("-").map((x) => Number(x));
        Object.assign(body, { name: opt(so, "name"), size: opt(so, "size"), minutes: opt(so, "minutes"), lo: range[0], hi: range[1], prize: opt(so, "prize"), channel: opt(so, "channel") });
      }
      if (sub.name === "win") body.player = opt(so, "player");
      try {
        const r = await tourAdmin(env, { playerId: id }, body);
        return { content: r.text, flags: EPHEMERAL };
      } catch (e) { return { content: "Couldn't: " + (e.message || "error"), flags: EPHEMERAL }; }
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
const SCORE_MAX = 2_000_000_000; // 2.1.1: points per judgement, no cap (350 a note at most)
// ---- 2.1.1 scores: points per judgement. Saves from older games (no scoreVersion) are worked out again on read.
const SCORE_POINTS_W = [350, 300, 250, 200, 100, 0];
/** (2.1.2) Showcase plays saved before the 2.1.1 score change hold the old 0-1,000,000 score: shown in the new points,
 *  worked out from their hit counts (pv marks ones already in points). */
function showcasePoints(list) {
  if (!Array.isArray(list)) return list;
  return list.map((x) => {
    if (!x || x.kind !== "song" || Number(x.pv) >= 1) return x;
    const pts = pointsOf(x.counts);
    return pts == null ? x : { ...x, score: pts, pv: 1 };
  });
}
function pointsOf(counts) {
  if (!Array.isArray(counts)) return null;
  let s = 0, n = 0;
  for (let i = 0; i < 6; i++) { const c = Math.max(0, Math.round(Number(counts[i]) || 0)); s += SCORE_POINTS_W[i] * c; n += c; }
  return n > 0 ? s : null;
}
function pointsFromOld(old, targets) { return Math.round(Math.max(0, Number(old) || 0) / 1_000_000 * 350 * Math.max(0, Number(targets) || 0)); }
/** A player's synced scores (Cloud Save "scores") from a game before 2.1.1, in the new points. */
function scoresToPoints(d) {
  if (!d || typeof d !== "object" || Number(d.scoreVersion) >= 1) return d;
  let oldSum = 0, newSum = 0;
  const seen = new Set();
  const conv = (p, targets) => {
    if (!p || typeof p !== "object" || seen.has(p)) return;
    seen.add(p);
    const old = Number(p.score) || 0;
    const pts = pointsOf(p.counts);
    p.score = pts ?? pointsFromOld(old, Number(p.notes) || targets);
    if (!p.failed && old > 0) { oldSum += old; newSum += p.score; }
  };
  const charts = d.charts && typeof d.charts === "object" ? d.charts : {};
  for (const c of Object.values(charts)) {
    if (!c || typeof c !== "object") continue;
    const bestPts = pointsOf(c.bestCounts);
    let targets = Array.isArray(c.bestCounts) ? c.bestCounts.reduce((a, x) => a + (Number(x) || 0), 0) : 0;
    if (!targets && Array.isArray(c.top)) for (const t of c.top) targets = Math.max(targets, Array.isArray(t?.counts) ? t.counts.reduce((a, x) => a + (Number(x) || 0), 0) : Number(t?.notes) || 0);
    if (Array.isArray(c.top)) { for (const t of c.top) conv(t, targets); c.top.sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0)); }
    let best = bestPts ?? pointsFromOld(c.bestScore, targets);
    if (Array.isArray(c.top) && c.top.length) best = Math.max(best, Number(c.top[0]?.score) || 0);
    c.bestScore = best;
  }
  if (Array.isArray(d.recent)) for (const p of d.recent) conv(p, 0);
  d.totalScore = oldSum > 0 ? Math.round((Number(d.totalScore) || 0) * newSum / oldSum) : 0;
  d.scoreVersion = 1;
  return d;
}
const boards = new Map(); // key -> { data, at }

const officialSong = (id) => /^octive-[a-z0-9-]{1,80}$/.test(id || "");
const songIdOk = (id) => /^[a-z0-9][a-z0-9_-]{0,89}$/.test(id || "");

// ---- verified songs: Senterra and the official account verify any song (by its song id), which gives its
// charts a global leaderboard like OCTIVE's own. Kept in R2 at verified.json.
let verifiedCache = null, verifiedAt = 0;
async function verifiedSongs(env) {
  if (verifiedCache && Date.now() - verifiedAt < 60_000) return verifiedCache;
  verifiedCache = await r2json(env, "verified.json", { songs: {} });
  verifiedCache.songs ||= {};
  verifiedAt = Date.now();
  return verifiedCache;
}

/** A Workshop upload of a song that's verified: one of its song ids, or an osu! map's set ("osu-<set>"), is in the list. */
function wsOfVerifiedSong(it, songs) {
  if (!it || it.type !== "charts" || !songs) return false;
  if ((it.songIds || []).some((id) => songs[id])) return true;
  return ((it.meta && it.meta.songs) || []).some((sg) => (sg.songId && songs[sg.songId]) || (Number(sg.osuSet) > 0 && songs["osu-" + sg.osuSet]));
}
// ---- notices: things to tell one player that happened while they weren't looking (their game's notifications)
// R2: notices/<playerId>.json  { items: [{ id, kind, at, ... }] }  newest first, the last NOTICES_MAX
//   kind "beaten":     someone took your #1 on a global board   { songId, chartId, title, difficulty, byId, byName, score }
//   kind "daily-pick": your Workshop upload is one of today's daily charts   { date, tier, tierName, itemId, songId, title, difficulty }
const NOTICES_MAX = 100;
async function addNotice(env, playerId, n) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(playerId || "")) return;
  const item = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), at: new Date().toISOString(), ...n };
  await r2update(env, `notices/${playerId}.json`, () => ({ items: [] }), (d) => { d.items = [item, ...(d.items || [])].slice(0, NOTICES_MAX); });
}
const cleanText = (v, max) => String(v || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A song with global leaderboards: OCTIVE's own, or one Senterra or Octive verified. */
async function boardSong(env, id) {
  if (officialSong(id)) return true;
  if (!songIdOk(id)) return false;
  return !!(await verifiedSongs(env)).songs[id];
}
const chartIdOk = (id) => /^[A-Za-z0-9_-]{1,80}$/.test(id || "");

/**
 * (2.0.2) A board score's mods as shown: its mod letters and, played faster or slower, its rate ("MR OT 1.3x"). Before,
 * only the letters were kept, so the board never said a score was played at another rate.
 */
function boardMods(codes) {
  const letters = String(codes || "").replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  const rate = rateOf(String(codes || ""));
  return (letters + (rate !== 1 ? ` ${rate}x` : "")).trim().slice(0, 40);
}

/**
 * (2.0.2) Board scores kept before the rate was: their rate read back from their replays, once (each gets rc: 1).
 * Only the first 50 (what the board shows) are looked at.
 */
async function boardRatesBackfill(env, songId, chartId, data) {
  const todo = (data.entries || []).slice(0, 50).filter((e) => !e.rc && e.playerId);
  if (!todo.length) return;
  const found = new Map();
  for (const e of todo) {
    let mods = null;
    try {
      const o = await env.RELEASES.get(boardReplayKey(songId, chartId, e.playerId));
      if (o) mods = (await readReplay(new Uint8Array(await o.arrayBuffer()))).mods;
    } catch { /* no readable replay: as it was */ }
    found.set(e.playerId, mods == null ? null : boardMods(mods));
  }
  const key = `scores/${songId}/${chartId}.json`;
  const out = await r2update(env, key, () => ({ entries: [] }), (d) => {
    let changed = false;
    for (const e of d.entries || []) {
      if (e.rc || !found.has(e.playerId)) continue;
      const m = found.get(e.playerId);
      // only when the replay is of this score (the letters it has match), so a newer score's replay never relabels an older one
      if (m != null && m.replace(/ ?[0-9.]+x$/, "") === String(e.mods || "").trim()) e.mods = m;
      e.rc = 1; changed = true;
    }
    if (!changed) return false;
  });
  boards.set(key, { data: out, at: Date.now() });
}

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

// R2: board-replays/<songId>/<chartId>/<playerId>.octreplay  the replay of a board score (its timing and Watch replay)
const BOARD_REPLAY_MAX = 1_500_000;
const boardReplayKey = (songId, chartId, playerId) => `board-replays/${songId}/${chartId}/${playerId}.octreplay`;
/** A replay sent with a score: gzip bytes from base64 (null when missing or not a replay). */
function replayBytes(b64) {
  if (typeof b64 !== "string" || b64.length < 8 || b64.length > BOARD_REPLAY_MAX * 1.4) return null;
  try {
    const bin = atob(b64);
    if (bin.length > BOARD_REPLAY_MAX || bin.charCodeAt(0) !== 0x1f || bin.charCodeAt(1) !== 0x8b) return null;
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  } catch { return null; }
}

async function chartScores(request, env, url) {
  // a board score's replay
  const rp = url.pathname.match(/^\/scores\/replay\/([a-z0-9-]{1,90})\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{8,64})$/);
  if (rp && request.method === "GET") {
    const o = await env.RELEASES.get(boardReplayKey(rp[1], rp[2], rp[3]));
    if (!o) fail(404, "That score has no replay.");
    return cors(new Response(o.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=300" } }));
  }
  const m = url.pathname.match(/^\/scores\/([a-z0-9-]{1,90})\/([A-Za-z0-9_-]{1,80})$/);
  if (m && request.method === "GET") {
    if (!(await boardSong(env, m[1]))) return reply({ entries: [], official: false });
    let data = await readBoard(env, m[1], m[2]);
    // (2.0.2) older scores' rates, from their replays (once per score)
    if ((data.entries || []).slice(0, 50).some((e) => !e.rc)) { try { await boardRatesBackfill(env, m[1], m[2], data); data = await readBoard(env, m[1], m[2]); } catch (e) { console.log("board rates", e && e.message); } }
    if (Date.now() - boardAt > BOARD_TTL) { try { await loadModeration(config(env)); } catch { /* keep */ } }
    let sup = {};
    try { sup = await supporters(env); } catch { /* none */ }
    const entries = data.entries.filter((e) => !moderation.bans[e.playerId] && !isOfficial(e.playerId)).slice(0, 50).map((e, i) => ({ ...e, rank: i + 1, supporter: !!sup[e.playerId]?.active }));
    return reply({ official: true, entries, total: data.entries.length });
  }
  if (url.pathname === "/scores/submit") {
    const b = await bodyOf(request, 2_600_000); // the play's replay comes with it
    const who = await signedIn(request, env);
    const songId = String(b.songId || ""), chartId = String(b.chartId || "");
    if (!(await boardSong(env, songId)) || !chartIdOk(chartId)) fail(400, "Only OCTIVE Official and verified charts have online leaderboards.");
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    // the play is judged again from its replay, against the chart's Workshop upload: that's what goes on the board (the
    // numbers the game sent are only compared with it, for the moderators)
    const rep = replayBytes(b.replay);
    if (!rep) fail(400, "A board score only counts with its replay. Update OCTIVE and play it again.");
    const where = await boardChartOf(env, songId, chartId, cleanText(b.difficulty, 60));
    const osuBoard = /^osu-[0-9]+$/.test(songId); // an osu! map's board: players' own imports have song ids of their own
    const { replay, result } = await judgePlay(who, rep, where, { what: "A board score", ...(osuBoard ? {} : { songId, chartId }) });
    await refuseCopies(env, `board|${songId}|${chartId}`, who, result);
    await judgeFlags(env, who.playerId, `board ${songId}/${chartId}`, result, { score: b.score, accuracy: b.accuracy });
    const score = result.score, acc = result.accuracy;
    const card = (await publicItems(cfg, who.playerId, ["card"])).card || {};
    const ov = moderation.overrides[who.playerId] || {};
    const entry = {
      playerId: who.playerId,
      name: String(ov.name || card.name || who.username || "Player").slice(0, 40),
      avatarHash: ov.avatar === "default" ? "" : ov.avatar ? "mod-" + Date.parse(ov.at) : String(card.avatar || ""),
      score, accuracy: Math.round(acc * 100) / 100,
      grade: result.grade,
      maxCombo: result.maxCombo,
      fullCombo: result.fullCombo,
      pp: Math.min(playPRMax(V.maxStars), Math.max(0, Math.round((Number(b.pp) || 0) * 100) / 100)),
      counts: result.counts,
      badges: badgesOf(who.playerId),
      date: new Date().toISOString(),
      version: String(replay.octiveVersion || b.version || "").slice(0, 12),
      mods: boardMods(replay.mods),
      rc: 1,
      judged: JUDGE_VERSION,
      pts: 1, // 2.1.1 points
    };
    // a verified chart's stars are known here: the PR on its board is never more than they give at that accuracy
    try {
      const kn = findVerified(await verifiedIndex(env), where.songId, where.difficulty, null);
      const ks = kn ? Number(kn.chart.stars) : 0;
      if (ks > 0) entry.pp = Math.min(entry.pp, round2(playPRMax(ks + 0.15, entry.accuracy) * 1.03 + 0.5));
    } catch { /* as sent, within the limits above */ }
    // the server-made ranking: this judged play's PR counts (its best per board), whether or not it beats their board score
    // (2.0.1) with what achievements read from it: the chart's stars and keys, its difficulty, Hidden / Hard Rock / speed plays
    {
      const info = (await boardChartInfo(env).catch(() => null))?.charts.get(`${songId}/${chartId}`) || null;
      const st1 = Number(info?.stars) || 0, rate = rateOf(replay.mods);
      await rememberJudged(env, who.playerId, songId, chartId, entry, {
        stars: st1 || undefined, keys: where.compiled.keyCount, difficulty: where.difficulty || info?.difficulty || undefined, rate,
        facts: playFacts(result, replay, rate >= 1 ? st1 : 0), result: versionBefore(replay.octiveVersion, "2.0.1") ? null : result, durationMs: chartMs(where.compiled) / rate,
      }).catch((e) => console.log("judged play", e && e.message));
    }
    const key = `scores/${songId}/${chartId}.json`;
    boards.delete(key);
    const data = await readBoard(env, songId, chartId);
    // who held #1 before this score (told if it takes their place)
    const prevTop = data.entries[0] ? data.entries[0].playerId : null;
    // the song's name for notices (games from 1.6.1 send it)
    const title = cleanText(b.title, 120), difficulty = cleanText(b.difficulty, 60);
    const i = data.entries.findIndex((e) => e.playerId === who.playerId);
    let improved = true;
    if (i >= 0) {
      if (data.entries[i].score >= score) improved = false;
      else data.entries.splice(i, 1);
    }
    // the play that's on the board (its replay is public): its timing is kept, so a copy of it is refused
    if (improved || (rep && data.entries[i] && data.entries[i].score === score)) await rememberReplay(env, `board|${songId}|${chartId}`, who.playerId, result.signature);
    // the same score sent again with its replay (scores from before replays were kept): it's attached, as judged
    if (!improved && rep && data.entries[i] && data.entries[i].score === score && !data.entries[i].replay) {
      await env.RELEASES.put(boardReplayKey(songId, chartId, who.playerId), rep, { httpMetadata: { contentType: "application/octet-stream" } });
      Object.assign(data.entries[i], { accuracy: entry.accuracy, grade: entry.grade, maxCombo: entry.maxCombo, fullCombo: entry.fullCombo, counts: entry.counts, judged: JUDGE_VERSION });
      data.entries[i].replay = true;
      await env.RELEASES.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
      boards.set(key, { data, at: Date.now() });
    }
    if (improved) {
      // the new best's replay (or none: the older one no longer matches)
      if (rep) { await env.RELEASES.put(boardReplayKey(songId, chartId, who.playerId), rep, { httpMetadata: { contentType: "application/octet-stream" } }); entry.replay = true; }
      else await env.RELEASES.delete(boardReplayKey(songId, chartId, who.playerId)).catch(() => {});
      data.entries.push(entry);
      data.entries.sort((a, c) => c.score - a.score || c.accuracy - a.accuracy || Date.parse(a.date) - Date.parse(c.date));
      data.entries = data.entries.slice(0, BOARD_SIZE);
      if (title) { data.title = title; if (difficulty) data.difficulty = difficulty; }
      await env.RELEASES.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
      boards.set(key, { data, at: Date.now() });
      // a new #1: the player who held it is told
      if (prevTop && prevTop !== who.playerId && data.entries[0] && data.entries[0].playerId === who.playerId) {
        const name = data.title || (officialSong(songId) ? "" : ((await verifiedSongs(env)).songs[songId] || {}).title) || "";
        await addNotice(env, prevTop, { kind: "beaten", songId, chartId, title: name || undefined, difficulty: data.difficulty || undefined, byId: who.playerId, byName: entry.name, score })
          .catch((e) => console.log("notice", e && e.message));
      }
    }
    const rank = data.entries.findIndex((e) => e.playerId === who.playerId) + 1;
    // friends see a new best on a verified chart
    if (improved) await addFeed(env, who.playerId, { kind: "pb", songId, chartId, title: title || data.title || undefined, difficulty: difficulty || data.difficulty || undefined,
      score, acc: entry.accuracy, fc: !!result.fullCombo, place: rank || undefined }).catch((e) => console.log("feed", e && e.message));
    // crew wars: a better play on one of the week's charts can raise your crew's score
    if (improved || i < 0) await warPlay(env, who.playerId, songId, chartId, entry.pp).catch((e) => console.log("war", e && e.message));
    // weekly (and event) missions: this judged play counts
    const missions = await missionEvent(env, who.playerId, { kind: "board", chart: `${songId}/${chartId}`, acc: entry.accuracy, fc: !!result.fullCombo, fresh: i < 0 })
      .catch((e) => { console.log("missions", e && e.message); return []; });
    // what the server's judging gave (the game shows it if it differs from its own)
    return reply({ ok: true, improved, rank: rank || null, total: data.entries.length, missions: missions.length ? missions : undefined,
      judged: { score, accuracy: Math.round(acc * 100) / 100, maxCombo: result.maxCombo, counts: result.counts, fullCombo: result.fullCombo, grade: result.grade } });
  }
  // (2.0.1) a play of a chart that isn't verified, judged from the chart and replay it brings
  if (url.pathname === "/scores/unverified") return unverifiedPlay(request, env);
  fail(404, "Not found");
}

// ---------------------------------------------------------------- unverified plays (2.0.1)
// A chart that isn't verified has no board and no copy on the server, so its play brings its chart along. The server
// reads the chart, works out its stars at the play's speed (the game's own star rating, judge.js), judges the replay
// against it (the same judging and anti-cheat as board scores) and works out the PR itself: the numbers the game shows
// are never used. A third of that PR counts toward the ranking (rankFromPlays). Against made-up plays and charts:
//  - a chart counts once per player, by its notes (a renamed song or chart is the same chart; its best play counts);
//  - a replay counts once: another player's copy is refused, and so is your own sent again for an edited copy;
//  - stars never go past the hardest verified chart's (or 10), so a made-up chart can't give more than a real one, and a
//    third of that is less than a bot could try for on a verified chart, where the same anti-cheat watches;
//  - a few hundred plays a day at most.
const UNVERIFIED_SHARE = 1 / 3;
const UNVERIFIED_GZ_MAX = 4_000_000;      // the chart's gzip bytes (a big FNF modchart is a few hundred kB)
const UNVERIFIED_TEXT_MAX = 24 * 1048576; // and unpacked
const UNVERIFIED_PER_DAY = 800;           // plays sent a day (the game sends earlier bests once, best first)
const UNVERIFIED_KEEP = 3000;             // charts kept per player (the best)
const UNVERIFIED_STAR_FLOOR = 10;         // the star cap is the hardest verified chart's, never below this
// plays made before 2.0.1 (the game sends each chart's best once) count at once, without the day's pace check holding
// the jump for a moderator, until this date
const RESTORE_UNTIL = Date.parse("2027-02-01T00:00:00Z");

/** The game version is older than a.b.c. */
function versionBefore(v, want) {
  const p = (x) => String(x || "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = p(v), b = p(want);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

/** A chart sent with a play (gzip JSON in base64), as text. */
async function sentChartText(b64) {
  if (typeof b64 !== "string" || b64.length < 8) fail(400, "This play came without its chart. Update OCTIVE.");
  if (b64.length > UNVERIFIED_GZ_MAX * 1.4) fail(413, "That chart is too big for the server to check.");
  let u;
  try { u = b64Bytes(b64); } catch { fail(400, "The chart couldn't be read."); }
  if (u.length < 18 || u[0] !== 0x1f || u[1] !== 0x8b) fail(400, "The chart couldn't be read.");
  const parts = [];
  let n = 0, big = false;
  try {
    const reader = new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > UNVERIFIED_TEXT_MAX) { big = true; try { await reader.cancel(); } catch { /* stopped */ } break; }
      parts.push(value);
    }
  } catch { fail(400, "The chart couldn't be read."); }
  if (big) fail(413, "That chart is too big for the server to check.");
  const all = new Uint8Array(n);
  let o = 0;
  for (const part of parts) { all.set(part, o); o += part.length; }
  return new TextDecoder().decode(all);
}

/** A chart by its notes, what's judged (the same for a renamed song or chart, different for any changed note). */
async function chartNotesHash(c) {
  return (await sha256Hex([c.keyCount, Array.from(c.time).join(","), Array.from(c.lane).join(","), Array.from(c.kind).join(",")].join("|"))).slice(0, 32);
}

let hardestStars = 0, hardestAt = 0;
/** The most stars an unverified chart counts for: the hardest verified chart's (cached 10 minutes), never below 10. */
async function unverifiedStarCap(env) {
  if (!hardestAt || Date.now() - hardestAt > 600_000) {
    let max = 0;
    try { for (const c of (await boardChartInfo(env)).charts.values()) if (c.stars > max && c.stars <= V.maxStars) max = c.stars; } catch { /* the floor */ }
    hardestStars = max; hardestAt = Date.now();
  }
  return Math.max(UNVERIFIED_STAR_FLOOR, hardestStars);
}

/** POST /scores/unverified: a play of a chart that isn't verified, with the chart and the replay (see above). */
async function unverifiedPlay(request, env) {
  const b = await bodyOf(request, 8_000_000);
  const who = await signedIn(request, env);
  const cfg = config(env);
  await loadModeration(cfg);
  if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
  const songId = String(b.songId || "").slice(0, 120), chartId = String(b.chartId || "").slice(0, 120);
  if (!songId || !chartId) fail(400, "Which chart was played?");
  // verified charts (and OCTIVE's own) count on their boards, in full
  for (const s of new Set([songId, String(b.board || "")])) if (s && (await boardSong(env, s).catch(() => false))) fail(409, "This song has a leaderboard: its plays count from there.");
  // a day's plays
  const day = new Date().toISOString().slice(0, 10), rateKey = `rank/unverified-rate/${who.playerId}.json`;
  const sent = await r2json(env, rateKey, { day, n: 0 });
  if (sent.day !== day) { sent.day = day; sent.n = 0; }
  if (sent.n >= UNVERIFIED_PER_DAY) fail(429, "That's a lot of plays for one day. The rest are sent tomorrow.");
  sent.n++;
  await r2put(env, rateKey, sent);
  // the chart, read and compiled here
  let text = await sentChartText(b.chart), compiled;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { compiled = compileChart(loadChart(text)); }
  catch (e) { if (e instanceof JudgeDataError) fail(400, "The server can't read this chart: " + e.message); throw e; }
  if (!compiled.time.length) fail(400, "That chart has nothing to hit.");
  // the play, judged again from its replay (since 1.5.2 a replay names its player; older plays by the rules they had)
  const { replay, result } = await judgePlay(who, replayBytes(b.replay), { compiled }, { what: "A play", songId, chartId, minVersion: 2 });
  const hash = await chartNotesHash(compiled);
  const sig = result.signature ? (await sha256Hex(result.signature)).slice(0, 16) : "";
  const have = ((await r2json(env, judgedKey(who.playerId), null)) || {}).unverified?.[hash];
  if (have && sig && have.sig === sig) return reply({ ok: true, same: true, pp: have.pp || 0, counted: round2((have.pp || 0) * UNVERIFIED_SHARE) });
  // a replay counts once: not another player's passed on, and not yours again on an edited copy of the chart
  await refuseCopies(env, `unverified|${hash}`, who, result);
  await refuseCopies(env, `unverified-mine|${who.playerId}`, who, result, false);
  const title = cleanText(b.title || replay.title, 120), difficulty = cleanText(b.difficulty || replay.difficulty, 60);
  // the same anti-cheat as board scores (without comparing numbers: an edited chart judges differently from the game)
  await judgeFlags(env, who.playerId, `unverified ${title || songId}${difficulty ? ` [${difficulty}]` : ""}`, result, null);
  // stars and PR, worked out here: the chart's own stars (achievements) and at the play's speed (PR), never past the cap
  const rate = rateOf(replay.mods), cap = await unverifiedStarCap(env);
  let stars1, stars;
  try { stars1 = Math.min(starRating(text, 1), cap); stars = rate === 1 ? stars1 : Math.min(starRating(text, rate), cap); }
  catch (e) { if (e instanceof JudgeDataError) fail(400, "The server can't rate this chart: " + e.message); throw e; }
  const failed = replay.result.failed === true;
  const pp = playPR(stars, result.counts, compiled.time.length, failed, replay.mods);
  const entry = {
    pp, acc: round2(result.accuracy), fc: !!result.fullCombo, combo: result.maxCombo || 0, g: result.grade, pf: allPerfect(result.counts),
    at: new Date().toISOString(), m: String(replay.mods || "").slice(0, 40) || undefined, st: round2(stars1), k: compiled.keyCount,
    song: songId, title: title || undefined, d: difficulty || undefined,
  };
  const old = versionBefore(replay.octiveVersion, "2.0.1");
  let improved = false;
  await r2update(env, judgedKey(who.playerId), () => ({ v: 1, charts: {} }), (d) => {
    d.unverified ||= {};
    const cur = d.unverified[hash];
    improved = !cur || pp > (cur.pp || 0);
    const next = mergeJudged(cur, entry, !failed && rate >= 1);
    if (improved) { next.sig = sig; if (old) next.old = true; else delete next.old; }
    d.unverified[hash] = next;
    noteFacts(d, playFacts(result, replay, stars));
    if (!old) countPlay(d, result, chartMs(compiled) / rate); // (earlier plays are in the totals the server started from)
    const keys = Object.keys(d.unverified);
    if (keys.length > UNVERIFIED_KEEP)
      for (const k of keys.sort((a, c) => (d.unverified[a].pp || 0) - (d.unverified[c].pp || 0)).slice(0, keys.length - UNVERIFIED_KEEP)) delete d.unverified[k];
  });
  await rememberReplay(env, `unverified|${hash}`, who.playerId, result.signature);
  await rememberReplay(env, `unverified-mine|${who.playerId}`, who.playerId, result.signature, 500);
  return reply({ ok: true, improved, pp, counted: round2(pp * UNVERIFIED_SHARE), stars: round2(stars), capped: stars >= cap || undefined,
    judged: { score: result.score, accuracy: round2(result.accuracy), maxCombo: result.maxCombo, counts: result.counts, fullCombo: result.fullCombo, grade: result.grade } });
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
const LIFETIME_SUPPORTERS = ["PlwcYVKV9y7NBFWfUaC263XpCFbE", "o2quUJmLzZujIpPomajHJ7oW07aI"]; // Senterra, and the official OCTIVE account
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
// ---- recent supporter purchases and gifts (the in-game supporter screen's feed), newest first
// R2 support/recent.json { items: [{ at, months, cents (paid), full (months x $2.50), free, gift, buyer, to, buyerName, toName, ref }] }
const RECENT_KEY = "support/recent.json", RECENT_MAX = 60;
let recentCache = null, recentAt = 0;

async function supportName(env, id) {
  if (!id) return "";
  const ov = moderation.overrides[id] || {};
  if (ov.name) return ov.name;
  try { return (await displayName(env, id)) || ""; } catch { return ""; }
}

/** The feed; the first time, built from the purchases and gifts already on record. */
async function recentSupport(env) {
  if (recentCache && Date.now() - recentAt < 30_000) return recentCache;
  let d = await r2json(env, RECENT_KEY, null);
  if (!d) { d = { items: await backfillRecent(env) }; await r2put(env, RECENT_KEY, d); }
  recentCache = d.items || []; recentAt = Date.now();
  return recentCache;
}

async function backfillRecent(env) {
  const out = [];
  for (const prefix of ["supporters/", "gifts/"]) {
    let cursor;
    do {
      const list = await env.RELEASES.list({ prefix, cursor });
      for (const o of list.objects) {
        const id = o.key.slice(prefix.length).replace(/\.json$/, "");
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) continue;
        const rec = await r2json(env, o.key, null);
        if (prefix === "supporters/") {
          for (const p of rec?.purchases || []) {
            const gift = p.gift !== undefined;
            const free = String(p.session || "").startsWith("free-") || (gift && !p.amount);
            out.push({ at: p.at, months: p.months || 0, cents: free ? 0 : p.amount || 0, full: (p.months || 0) * PRICE_CENTS, free, gift, buyer: gift ? p.gift || "" : id, to: id, ref: p.session || null });
          }
        } else {
          for (const g of rec?.pending || [])
            out.push({ at: g.at, months: g.months || 0, cents: g.free ? 0 : g.amount || 0, full: (g.months || 0) * PRICE_CENTS, free: !!g.free, gift: true, buyer: g.from || "", to: id, ref: g.id || null });
        }
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const items = out.slice(0, RECENT_MAX);
  const names = {};
  for (const id of new Set(items.flatMap((x) => [x.buyer, x.to]).filter(Boolean))) names[id] = await supportName(env, id);
  for (const x of items) { x.buyerName = names[x.buyer] || ""; x.toName = names[x.to] || ""; }
  return items;
}

/** One new purchase or gift for the feed (once per checkout or gift). */
async function recordSupport(env, e) {
  try {
    await recentSupport(env); // the history is there first
    const item = { at: new Date().toISOString(), months: e.months, cents: e.free ? 0 : e.cents || 0, full: e.months * PRICE_CENTS, free: !!e.free, gift: !!e.gift,
      buyer: e.buyer || "", to: e.to || "", buyerName: await supportName(env, e.buyer), toName: await supportName(env, e.to), ref: e.ref || null };
    await r2update(env, RECENT_KEY, () => ({ items: [] }), (d) => {
      d.items ||= [];
      if (item.ref && d.items.some((x) => x.ref === item.ref)) return false;
      d.items = [item, ...d.items].slice(0, RECENT_MAX);
    });
    recentCache = null;
  } catch (err) { console.log("recent support", err && err.message); }
}

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
  if (path === "/support/recent") return reply({ items: await recentSupport(env), monthly: PRICE_CENTS });
  if (path === "/support/all") { const all = await supporters(env); return reply({ supporters: all, owner: OWNER, gifted: giftedIndex, numbers: numberIndex }); }
  if (path === "/stripe/webhook" && request.method === "POST") {
    const body = await request.text();
    if (!(await stripeSignatureOk(env, request.headers.get("Stripe-Signature"), body))) return new Response("bad signature", { status: 400 });
    const ev = JSON.parse(body);
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
      const s = ev.data.object;
      const id = s.metadata?.playerId, months = Number(s.metadata?.months);
      if (s.payment_status === "paid" && id && months >= 1 && months <= MAX_MONTHS) {
        if (s.metadata?.gift === "1") {
          await addGift(env, id, { id: s.id, from: s.metadata?.buyer || "", months, amount: s.amount_total, currency: s.currency, free: false });
          await recordSupport(env, { months, cents: s.amount_total, gift: true, buyer: s.metadata?.buyer || "", to: id, ref: s.id });
        } else {
          await grantMonths(env, id, months, s); supportIndex = null; await syncSupporterRole(env, id);
          await recordSupport(env, { months, cents: s.amount_total, gift: false, buyer: id, to: id, ref: s.id });
        }
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
    // from the game: the payment window ends on a small page that says to go back (and closes itself)
    const fromGame = b.from === "game";
    const s = await stripe(env, "checkout/sessions", {
      mode: "payment",
      success_url: fromGame ? `${url.origin}/support/done?paid=1` : `${SITE}#/supporter?thanks=1`,
      cancel_url: fromGame ? `${url.origin}/support/done?cancel=1` : `${SITE}#/supporter`,
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
    return reply({ url: s.url, session: s.id });
  }
  if (path === "/support/session") {
    // the game asks whether its checkout was paid (gifts too: they only show for the buyer this way)
    const who = await signedIn(request, env);
    const id = String(url.searchParams.get("id") || "");
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) fail(400, "That checkout can't be found.");
    const s = await stripe(env, "checkout/sessions/" + encodeURIComponent(id));
    if (s.metadata?.buyer !== who.playerId) fail(404, "That checkout can't be found.");
    return reply({ paid: s.payment_status === "paid", status: s.status, months: Number(s.metadata?.months) || 0, gift: s.metadata?.gift === "1", to: s.metadata?.playerId || null });
  }
  if (path === "/support/done") {
    // where the game's payment window lands: thanks (or nothing charged), then it closes itself
    const paid = url.searchParams.get("paid") === "1";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCTIVE</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b14;color:#fff;font-family:"Segoe UI",system-ui,sans-serif;text-align:center}
.c{padding:40px 32px;max-width:420px}.h{width:88px;height:88px;margin:0 auto 20px;border-radius:28px;display:flex;align-items:center;justify-content:center;font-size:46px;background:rgba(255,107,181,.16);border:1px solid rgba(255,107,181,.5);color:#ff6bb5}
h1{margin:0 0 10px;font-size:30px}p{margin:0;color:#aab0c4;line-height:1.55}.s{margin-top:16px;font-size:13px;color:#7a8099}</style></head><body><div class="c">
<div class="h">${paid ? "&#9829;" : "&#10005;"}</div><h1>${paid ? "Thank you!" : "Payment cancelled"}</h1>
<p>${paid ? "Your payment went through. Go back to OCTIVE: it's updating there now." : "Nothing was charged. Go back to OCTIVE to choose again."}</p>
<p class="s">You can close this window.</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},${paid ? 2600 : 1400})</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (path === "/support/grant") {
    // the developer (Senterra) gives supporter time for free
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only the OCTIVE developer can gift supporter for free.");
    const months = Math.round(Number(b.months));
    if (!(months >= 1 && months <= 120)) fail(400, "Choose 1 to 120 months.");
    const target = String(b.playerId || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(target)) fail(400, "That player can't be found.");
    const card = (await publicItems(config(env), target, ["card"])).card;
    if (!card || moderation.bans[target]) fail(400, "That player can't be found (they need to have played online once).");
    const giftId = "free-" + crypto.randomUUID();
    await addGift(env, target, { id: giftId, from: who.playerId, months, amount: 0, currency: "usd", free: true });
    await recordSupport(env, { months, free: true, gift: true, buyer: who.playerId, to: target, ref: giftId });
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
  // (2.1.1) Twitch's sign-in comes back here: the code is swapped for the player's Twitch account, which is linked
  if (path === "/twitch/callback") {
    const page = (title, text, ok) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCTIVE · Twitch</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c14;color:#fff;font:16px/1.5 system-ui,sans-serif}
.c{max-width:460px;padding:32px;border-radius:20px;background:#151726;border:1px solid ${ok ? "#9146ff" : "#ff4d6d"};text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:#b9bdd6;margin:0}</style></head><body><div class="c"><h1>${title}</h1><p>${text}</p></div></body></html>`,
      { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const state = String(url.searchParams.get("state") || "");
    if (url.searchParams.get("error")) return page("Not linked", "Twitch sign-in was cancelled. You can close this tab and try again from OCTIVE.", false);
    if (!/^[0-9a-f]{40}$/.test(state)) return page("Not linked", "That link isn't valid. Start again from OCTIVE (Settings → Account → Twitch).", false);
    const st = await r2json(env, `twitch/state/${state}.json`, null);
    await env.RELEASES.delete(`twitch/state/${state}.json`).catch(() => {});
    if (!st || st.exp < Date.now()) return page("Link expired", "That link ran out. Start again from OCTIVE (Settings → Account → Twitch).", false);
    const code = String(url.searchParams.get("code") || "");
    if (!code || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return page("Not linked", "Twitch didn't send a sign-in code. Try again from OCTIVE.", false);
    let user = null;
    try {
      const tok = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: twitchRedirect(request) }),
      }).then((r) => r.json());
      if (!tok || !tok.access_token) throw new Error("no token");
      const u = await fetch("https://api.twitch.tv/helix/users", { headers: { Authorization: "Bearer " + tok.access_token, "Client-Id": env.TWITCH_CLIENT_ID } }).then((r) => r.json());
      user = u && Array.isArray(u.data) ? u.data[0] : null;
      // the token is only needed to know who they are: given back to Twitch at once
      fetch("https://id.twitch.tv/oauth2/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, token: tok.access_token }) }).catch(() => {});
    } catch (e) { console.log("twitch link", e && e.message); }
    if (!user || !user.id || !user.login) return page("Not linked", "Twitch didn't confirm your account. Try again from OCTIVE.", false);
    const owner = await r2json(env, `twitch/${user.id}.json`, null);
    if (owner && owner.playerId && owner.playerId !== st.playerId) return page("Already linked", `The Twitch channel ${esc(user.display_name || user.login)} is linked to another OCTIVE account. Unlink it there first.`, false);
    const rec = await record(env, st.playerId);
    if (rec.twitch?.id && rec.twitch.id !== user.id) await env.RELEASES.delete(`twitch/${rec.twitch.id}.json`).catch(() => {});
    rec.twitch = { id: user.id, login: String(user.login).toLowerCase(), name: String(user.display_name || user.login).slice(0, 40), at: new Date().toISOString() };
    rec.twitchPrefs ||= { show: true };
    await saveRecord(env, st.playerId, rec);
    await r2put(env, `twitch/${user.id}.json`, { playerId: st.playerId, at: rec.twitch.at });
    if (st.site) return Response.redirect(SITE + "?twitch=linked#/account", 302);
    return page("Twitch linked!", `${esc(rec.twitch.name)} is now linked to your OCTIVE account. You can close this tab and go back to the game.`, true);
  }
  // following
  // (2.1.2) everyone streaming on Twitch right now, for the live marks on online dots in the game and on the site
  if (path === "/social/live") return reply({ live: await twitchLiveAll(env) }, 200);
  m = path.match(/^\/social\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    const id = m[1];
    const [following, followers] = await Promise.all([followingOf(env, id), followerCount(env, id)]);
    let youFollow = null;
    const h = request.headers.get("Authorization") || "";
    if (h.startsWith("Bearer ")) { try { const who = await signedIn(request, env); youFollow = (await followingOf(env, who.playerId)).includes(id); } catch { /* signed out */ } }
    let friends = null;
    try { friends = ((await r2json(env, dmInboxKey(id), dmEmptyInbox())).friends || []).length; } catch { /* none */ }
    let discord = null, discordUser = null, twitch = null;
    try {
      const rec = await record(env, id);
      if (rec.twitch?.id && rec.twitchPrefs?.show !== false) twitch = { login: rec.twitch.login, name: rec.twitch.name || rec.twitch.login, live: await twitchLiveOf(env, rec.twitch.id) };
      if (rec.discord?.id && rec.discordPrefs?.show) {
        discord = rec.discord.name || null;
        // the username (what people type to add them); links made before 1.5 get it from Discord once
        if (!rec.discord.username && env.DISCORD_BOT_TOKEN) {
          try { const u = await discordApi(env, "GET", `/users/${rec.discord.id}`); if (u && u.username) { rec.discord.username = u.username; await saveRecord(env, id, rec); } } catch { /* later */ }
        }
        discordUser = rec.discord.username || null;
      }
    } catch { /* none */ }
    return reply({ following, followers, friends, youFollow, owner: OWNER, discord, discordUser, twitch });
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
// the room when someone reads it (at most every CHAT_PULL_MS) with the bot, together with what changed on the
// recent ones there: edits and deletions. Pictures are kept in R2 (chat/img/<message>-<n>) while their message is in
// the room: sent from the game (POST /chat/image), or copied from Discord the first time someone looks. (Reactions were
// tried in 1.6.6 and taken out: Discord only shows one bot reaction for every game player.)
// Replies and @names reach the player they're for as a pop-up (chat/pings/<playerId>.json, read by /dm/inbox).
// Set up by Tools/discord_chat_setup.py (secrets DISCORD_CHAT_CHANNEL_ID and DISCORD_CHAT_WEBHOOK); without
// them the chat is game-only.
const CHAT_KEY = "chat/global.json";
const CHAT_KEEP = 200;
const CHAT_MAX = 300;
const CHAT_PULL_MS = 4000;
const CHAT_IMG_MAX = 8 * 1024 * 1024;
const CHAT_IMG_SIDE_MAX = 4096; // the game sends pictures at most 2048 across; older games anything up to this
const CHAT_IMG_PIXELS_MAX = 4096 * 4096; // bigger pictures aren't sent to the game: opening one froze it for half a second
const CHAT_IMG_TYPES = ["png", "jpeg", "gif", "webp"];
let chatPulledAt = 0, chatPulling = null;
const chatEmpty = () => ({ seq: 0, rev: 0, msgs: [], removed: [], lastDiscord: null });
const discordBot = (env) => ({ Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (https://senterraslays.github.io/octive, 1.0)" });

/** The Discord message a room message is (or was copied to), or null. */
const chatDiscordId = (m) => m.discordId || ((m.src === "discord" || m.src === "command") && /^d\d+$/.test(String(m.id)) ? m.id.slice(1) : null);
/** A message changed (an edit on Discord): readers who already have it fetch it again. */
const chatBump = (b, m) => { b.rev = (b.rev || 0) + 1; m.rev = b.rev; };
/** Messages taken out of the room (removed, or deleted on Discord): readers drop them too. */
function chatGone(b, list) {
  b.removed = b.removed || [];
  for (const m of list) { b.rev = (b.rev || 0) + 1; b.removed.push({ id: m.id, rev: b.rev }); }
  if (b.removed.length > 100) b.removed = b.removed.slice(-100);
}
/** The room keeps the newest CHAT_KEEP; returns the ones that fell out (their pictures are deleted). */
function chatTrim(b) {
  if (b.msgs.length <= CHAT_KEEP) return [];
  const cut = b.msgs.length - CHAT_KEEP;
  const out = b.msgs.slice(0, cut);
  b.msgs = b.msgs.slice(cut);
  return out;
}
async function chatDropImages(env, list) {
  for (const m of list) for (let i = 0; i < (m.images || []).length; i++)
    for (const k of ["", "-720", "-2048", "-w720", "-w2048"]) await env.RELEASES.delete(`chat/img/${m.id}-${i}${k}`).catch(() => {});
}

/** A Discord attachment's picture type (png, jpeg, gif or webp), or null when it isn't a picture. */
function chatImageKind(a) {
  const ct = String(a.content_type || "").toLowerCase().split(";")[0];
  const ext = String(a.filename || "").toLowerCase().split(".").pop();
  const t = ct.startsWith("image/") ? ct.slice(6) : ext === "jpg" ? "jpeg" : ext;
  return CHAT_IMG_TYPES.includes(t) ? t : null;
}

/** The pictures of a Discord message: its attachments, and pictures and GIFs linked in it (4 at most). */
function chatImagesOf(m) {
  const out = [];
  for (const a of m.attachments || []) {
    const type = chatImageKind(a);
    if (!type || out.length >= 4) continue;
    out.push({ w: a.width || 0, h: a.height || 0, type, name: String(a.filename || "picture").slice(0, 80), att: a.id });
  }
  for (const e of m.embeds || []) {
    if (out.length >= 4 || (e.type !== "image" && e.type !== "gifv")) continue;
    const t = e.thumbnail || e.image;
    if (!t || !t.url) continue;
    out.push({ w: t.width || 0, h: t.height || 0, type: e.type === "gifv" ? "gifv" : "link", name: "", src: t.proxy_url || t.url, link: e.url || t.url });
  }
  return out;
}

/** The type and size of a PNG, JPEG or GIF picture from its first bytes (null for anything else). */
function chatImageInfo(b) {
  if (!b || b.length < 26) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { type: "png", w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { type: "gif", w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const k = b[i + 1];
      if (k === 0xff) { i++; continue; }
      if (k === 0xd8 || k === 0x01 || (k >= 0xd0 && k <= 0xd7)) { i += 2; continue; }
      if (k >= 0xc0 && k <= 0xcf && k !== 0xc4 && k !== 0xc8 && k !== 0xcc) return { type: "jpeg", h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return { type: "jpeg", w: 0, h: 0 };
  }
  return null;
}

/** Discord text as plain text for the game: mentions, channels, roles and custom emoji become readable. */
function discordToText(m) {
  let t = String(m.content || "");
  for (const u of m.mentions || []) t = t.split(`<@${u.id}>`).join("@" + (u.global_name || u.username)).split(`<@!${u.id}>`).join("@" + (u.global_name || u.username));
  t = t.replace(/<@!?\d+>/g, "@someone").replace(/<@&\d+>/g, "@role").replace(/<#\d+>/g, "#channel")
    .replace(/<a?:(\w+):\d+>/g, ":$1:").replace(/<t:(\d+)(:\w)?>/g, (_, s) => new Date(Number(s) * 1000).toUTCString());
  // files that aren't pictures (pictures are shown)
  const files = (m.attachments || []).filter((a) => !chatImageKind(a));
  if (!t.trim() && files.length) t = "[sent " + (files.length === 1 ? "a file" : files.length + " files") + "]";
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
    lines = chatPlain(e.description || "").split("\n").map((x) => x.trim()).filter((x) => x && x !== "　");
    for (const f of e.fields || []) if (lines.length < 6) lines.push(`${chatPlain(f.name)}: ${chatPlain(f.value).split("\n")[0]}`);
  } else lines = chatPlain(m.content || "").split("\n").filter(Boolean);
  lines = lines.slice(0, 6).map((x) => x.slice(0, 120));
  return { name: String(name).split(" ")[0].slice(0, 32), title: title.slice(0, 100), lines, url: e?.url || null };
}

/** Who a new message is for: the writer of the message it answers, and players it @names. Map playerId -> "reply" | "mention". */
function chatTargets(box, msg, mentioned = []) {
  const out = new Map();
  const mine = msg.from?.id;
  const isPlayer = (id) => id && !String(id).startsWith("discord:") && id !== mine;
  if (isPlayer(msg.reply?.fromId)) out.set(msg.reply.fromId, "reply");
  for (const id of mentioned) if (isPlayer(id) && !out.has(id)) out.set(id, "mention");
  // @Name of a player who chatted lately
  const names = new Map();
  for (const x of (box.msgs || []).slice(-CHAT_KEEP)) if (isPlayer(x.from?.id) && x.from?.name) names.set(String(x.from.name).toLowerCase(), x.from.id);
  for (const [, nm] of String(msg.text || "").matchAll(/@([^\s@]{2,40})/g)) {
    const id = names.get(nm.toLowerCase().replace(/[.,!?:;]+$/, ""));
    if (id && !out.has(id)) out.set(id, "mention");
  }
  return out;
}

/** Notes a reply or @name for the players it's for (a pop-up in the game, see /dm/inbox). */
async function chatPing(env, msg, targets) {
  if (!targets || !targets.size) return;
  const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, 140) || ((msg.images || []).length ? "[a picture]" : "");
  for (const [pid, kind] of targets) {
    if (!DM_ID.test(pid)) continue;
    try {
      await r2update(env, `chat/pings/${pid}.json`, () => ({ items: [] }), (p) => {
        p.items = (p.items || []).filter((x) => x.id !== msg.id)
          .concat([{ id: msg.id, at: Date.now(), kind, by: msg.from?.name || "Someone", byId: msg.from?.id || null, text, src: msg.src }]).slice(-20);
      });
    } catch (e) { console.log("chat ping", e && e.message); }
  }
}

/** New messages from the Discord channel into the room, and what changed there on the recent ones. */
async function chatPull(env) {
  if (!env.DISCORD_CHAT_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) return;
  if (Date.now() - chatPulledAt < CHAT_PULL_MS) return; // pulled moments ago (by this or another request: its promise can't be shared)
  chatPulledAt = Date.now();
  chatPulling = (async () => {
    const base = `https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages`;
    const get = async (q) => {
      const res = await fetch(base + q, { headers: discordBot(env) });
      if (!res.ok) { console.log("chat pull", res.status); return null; }
      const v = await res.json();
      return Array.isArray(v) ? v.filter((m) => m && m.id) : null;
    };
    // the newest 50: the new ones, and edits and deletions on the rest
    const latest = await get("?limit=50");
    if (!latest) return;
    const big = (id) => BigInt(id);
    const oldest = latest.length ? latest.reduce((a, m) => (big(m.id) < a ? big(m.id) : a), big(latest[0].id)) : 0n;
    const newest = latest.reduce((a, m) => (big(m.id) > a ? big(m.id) : a), 0n);
    const box0 = await r2json(env, CHAT_KEY, chatEmpty());
    let list = latest.slice();
    if (box0.lastDiscord && latest.length >= 50 && big(box0.lastDiscord) < oldest) {
      // more than 50 since the last pull: the ones in between too
      const gap = await get(`?limit=50&after=${box0.lastDiscord}`);
      for (const m of gap || []) if (!list.some((x) => x.id === m.id)) list.push(m);
    }
    list.sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
    let fresh = list.filter((m) => !box0.lastDiscord || big(m.id) > big(box0.lastDiscord));
    // a command still "thinking": wait for its answer (but never longer than a minute)
    const thinking = fresh.findIndex((m) => m.type === 20 && (Number(m.flags || 0) & 128) && Date.now() - Date.parse(m.timestamp) < 60_000);
    if (thinking >= 0) fresh = fresh.slice(0, thinking);
    const ours = webhookId(env);
    const isCommand = (m) => m.type === 20 && (m.application_id === DISCORD_APP_ID || m.author?.id === DISCORD_APP_ID);
    // Discord people who linked their OCTIVE account appear as their OCTIVE player (writers and people @named)
    const who = new Map();
    const cfg = config(env);
    if (fresh.length) {
      try { await loadModeration(cfg); } catch { /* badges may be missing */ }
      const users = [];
      for (const m of fresh) {
        const u = isCommand(m) ? (m.interaction_metadata?.user || m.interaction?.user) : m.author;
        if (u?.id && !(u.bot && !isCommand(m))) users.push(u);
        for (const x of m.mentions || []) if (x?.id && !x.bot) users.push(x);
      }
      for (const u of users) {
        if (who.has(u.id)) continue;
        who.set(u.id, null);
        const pid = await linkedPlayer(env, u.id).catch(() => null);
        if (pid) who.set(u.id, await chatIdentity(cfg, pid, u.global_name || u.username));
      }
    }
    const discordFrom = (u, member) => {
      const shown = String(member?.nick || u?.global_name || u?.username || "Discord user").slice(0, 40);
      const linked = u?.id ? who.get(u.id) : null;
      if (linked) return { ...linked, discord: shown, discordId: u.id };
      return { id: "discord:" + (u?.id || "0"), name: shown, discordId: u?.id || null, avatar: u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null };
    };
    const byId = new Map(latest.map((d) => [d.id, d]));
    let dropped = [], pings = [], unreact = [];
    await r2update(env, CHAT_KEY, chatEmpty, (b) => {
      dropped = []; pings = []; unreact = [];
      let changed = false;
      // reactions were taken out (1.6.6): kept ones are dropped, and the bot's reactions that stood for game players
      // come off Discord (once)
      if (!b.reactionsGone) {
        for (const m of b.msgs) {
          if (!m.reactions) continue;
          const did = chatDiscordId(m);
          if (did) for (const [k, v] of Object.entries(m.reactions)) if ((v.by || []).length) unreact.push([did, k]);
          delete m.reactions;
        }
        b.reactionsGone = true;
        changed = true;
      }
      for (const m of fresh) {
        if (b.lastDiscord && big(m.id) <= big(b.lastDiscord)) continue;
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
        const images = chatImagesOf(m);
        let text = discordToText(m);
        // only a link to a picture or GIF: the picture is enough
        if (images.some((x) => x.link && text.trim() === x.link)) text = "";
        if (!text.trim() && !images.length) continue;
        const from = discordFrom(m.author || {}, m.member);
        // a Discord reply: to a Discord message ("d<id>"), or to a game message's Discord copy
        let reply;
        const ref = m.referenced_message;
        if (ref && ref.id) {
          const target = b.msgs.find((x) => x.id === "d" + ref.id || x.discordId === ref.id);
          reply = target ? { id: target.id, name: target.from?.name || "", text: String(target.text || "").slice(0, 120) || ((target.images || []).length ? "[a picture]" : ""), fromId: target.from?.id || null }
            : { id: "d" + ref.id, name: String(ref.member?.nick || ref.author?.global_name || ref.author?.username || "").slice(0, 40), text: String(ref.content || "").slice(0, 120), fromId: null };
        }
        const msg = { seq: ++b.seq, id: "d" + m.id, at: m.timestamp || new Date().toISOString(), src: "discord", text, from, linked: !from.id.startsWith("discord:"), reply };
        if (images.length) msg.images = images;
        if (m.edited_timestamp) msg.edited = m.edited_timestamp;
        b.msgs.push(msg);
        const mentioned = (m.mentions || []).map((x) => who.get(x.id)?.id).filter(Boolean);
        const targets = chatTargets(b, msg, mentioned);
        if (targets.size) pings.push([msg, targets]);
      }
      // the recent ones: edits and deletions on Discord
      if (latest.length) {
        const low = Math.max(0, b.msgs.length - 80);
        for (let i = b.msgs.length - 1; i >= low; i--) {
          const m = b.msgs[i];
          const did = chatDiscordId(m);
          if (!did) continue;
          const id = big(did);
          if (id < oldest || id > newest) continue;
          const d = byId.get(did);
          if (!d) { b.msgs.splice(i, 1); chatGone(b, [m]); dropped.push(m); changed = true; continue; }
          let c = false;
          if (m.src === "discord" && d.edited_timestamp && d.edited_timestamp !== m.edited) {
            m.edited = d.edited_timestamp;
            const im = chatImagesOf(d);
            m.text = discordToText(d);
            if (im.some((x) => x.link && m.text.trim() === x.link)) m.text = "";
            if (im.length) m.images = im; else delete m.images;
            c = true;
          }
          if (c) { chatBump(b, m); changed = true; }
        }
      }
      if (!changed) return false;
      dropped.push(...chatTrim(b));
    });
    if (dropped.length) await chatDropImages(env, dropped);
    for (const [did, e] of unreact)
      await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages/${did}/reactions/${encodeURIComponent(e)}/@me`, { method: "DELETE", headers: discordBot(env) }).catch(() => {});
    for (const [msg, targets] of pings) await chatPing(env, msg, targets);
  })().catch((e) => console.log("chat pull failed", e && e.message)).finally(() => { chatPulling = null; });
  return chatPulling;
}

/** Messages from before someone linked their Discord: shown as their OCTIVE player now (so they're clickable). */
async function chatAsPlayers(env, lists) {
  const all = lists.flat();
  const unlinked = [...new Set(all.filter((m) => String(m.from?.id || "").startsWith("discord:")).map((m) => m.from.id.slice(8)))].slice(0, 30);
  if (!unlinked.length) return lists;
  const cfg = config(env);
  const ids = new Map();
  for (const d of unlinked) { const pid = await linkedPlayer(env, d).catch(() => null); if (pid) ids.set(d, await chatIdentity(cfg, pid, null)); }
  if (!ids.size) return lists;
  const fix = (m) => { const d = String(m.from?.id || "").startsWith("discord:") ? m.from.id.slice(8) : null; const p = d && ids.get(d); return p ? { ...m, from: { ...p, discord: m.from.name, discordId: d }, linked: true } : m; };
  return lists.map((l) => l.map(fix));
}

/** A message's text from the game: no control characters, at most one empty line in a row. */
const chatClean = (t) => String(t || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** A little slow-down: 1 message every 1.5 s and 12 a minute per player, and 6 pictures in 10 minutes. */
async function chatRate(env, playerId, picture) {
  const key = `chat/rate/${playerId}.json`;
  const rl = await r2json(env, key, { at: [], img: [] });
  const now = Date.now();
  rl.at = (rl.at || []).filter((t) => now - t < 60_000);
  rl.img = (rl.img || []).filter((t) => now - t < 600_000);
  if (rl.at.length && now - rl.at[rl.at.length - 1] < 1500) fail(429, "Slow down a little.");
  if (rl.at.length >= 12) fail(429, "You're sending a lot of messages. Wait a minute.");
  if (picture && rl.img.length >= 6) fail(429, "That's a lot of pictures. Wait a few minutes.");
  rl.at.push(now);
  if (picture) rl.img.push(now);
  await r2put(env, key, rl);
}

/** Adds a game message to the room (answering another when replyTo names one that's still there). */
async function chatAdd(env, msg, replyTo) {
  let target = null, dropped = [];
  const box = await r2update(env, CHAT_KEY, chatEmpty, (bx) => {
    target = null; dropped = [];
    msg.seq = ++bx.seq;
    const rid = String(replyTo || "");
    const t = rid ? bx.msgs.find((x) => x.id === rid) : null;
    if (t) {
      msg.reply = { id: t.id, name: t.from?.name || "", text: String(t.text || "").slice(0, 120) || ((t.images || []).length ? "[a picture]" : ""), fromId: t.from?.id || null };
      target = t;
    } else delete msg.reply;
    bx.msgs.push(msg);
    dropped = chatTrim(bx);
  });
  return { box, target, dropped };
}

/** A game message into the Discord channel as the player (pinging only the @named and the reply's writer). */
async function chatToDiscord(env, box, msg, target, file) {
  if (!env.DISCORD_CHAT_WEBHOOK) return;
  const badge = (msg.from.badges || []).includes("DEV") ? " 🛠️" : (msg.from.badges || []).includes("MOD") ? " 🛡️" : "";
  const byName = new Map();
  for (const x of (box.msgs || []).slice(-CHAT_KEEP)) if (x.from?.discordId && x.from?.name) byName.set(String(x.from.name).toLowerCase(), x.from.discordId);
  const pings = new Set();
  let content = String(msg.text || "").replace(/@([^\s@]{2,40})/g, (all, nm) => { const d = byName.get(String(nm).toLowerCase()); if (!d) return all; pings.add(d); return `<@${d}>`; });
  if (target) {
    const quote = String(target.text || "").replace(/\n/g, " ").slice(0, 80) || ((target.images || []).length ? "[picture]" : "");
    const rd = target.from?.discordId;
    if (rd) pings.add(rd);
    content = `> ↪ ${rd ? `<@${rd}>` : `**${target.from?.name || "someone"}**`}: ${quote}\n${content}`;
  }
  const ua = "DiscordBot (https://senterraslays.github.io/octive, 1.0)";
  const payload = { content: content.slice(0, 2000), username: `${msg.from.name}${badge} · OCTIVE`.slice(0, 80), avatar_url: msg.from.avatar || `${SITE}logo-512.png`, allowed_mentions: { parse: [], users: [...pings].slice(0, 10) } };
  let init;
  if (file) {
    payload.attachments = [{ id: 0, filename: file.name }];
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify(payload));
    fd.append("files[0]", new Blob([file.bytes], { type: file.type }), file.name);
    init = { method: "POST", body: fd, headers: { "User-Agent": ua } };
  } else init = { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua }, body: JSON.stringify(payload) };
  const r = await fetch(env.DISCORD_CHAT_WEBHOOK + "?wait=true", init);
  if (!r.ok) { console.log("chat webhook", r.status, (await r.text()).slice(0, 200)); return; }
  const posted = await r.json();
  await r2update(env, CHAT_KEY, chatEmpty, (bx) => {
    const m = bx.msgs.find((x) => x.id === msg.id);
    if (!m) return false;
    m.discordId = posted.id;
  });
}

async function chatRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (path === "/chat/global" && request.method === "GET") {
    await chatPull(env);
    const after = Number(url.searchParams.get("after") || 0);
    const since = url.searchParams.has("rev") ? Number(url.searchParams.get("rev") || 0) : null;
    const box = await r2json(env, CHAT_KEY, chatEmpty());
    const shown = (m) => !moderation.bans[m.from?.id];
    let msgs = (box.msgs || []).filter((m) => m.seq > after && shown(m));
    if (!after) msgs = msgs.slice(-80);
    // what changed on messages the reader already has, and which were taken out
    let upd = after && since !== null ? (box.msgs || []).filter((m) => m.seq <= after && (m.rev || 0) > since && shown(m)) : [];
    const gone = after && since !== null ? (box.removed || []).filter((x) => x.rev > since).map((x) => x.id) : [];
    [msgs, upd] = await chatAsPlayers(env, [msgs, upd]);
    return reply({ seq: box.seq || 0, rev: box.rev || 0, msgs, upd, gone, discord: !!env.DISCORD_CHAT_CHANNEL_ID, channel: env.DISCORD_CHAT_CHANNEL_ID || null, guild: env.DISCORD_GUILD_ID || null });
  }
  if (path === "/chat/send" && request.method === "POST") {
    const b = await bodyOf(request);
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    const text = chatClean(b.text);
    if (!text) fail(400, "Type a message first.");
    if (text.length > CHAT_MAX) fail(400, `Messages can be ${CHAT_MAX} characters at most.`);
    await chatRate(env, who.playerId, false);
    const from = await chatIdentity(cfg, who.playerId, who.username);
    const msg = { id: "g" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), at: new Date().toISOString(), src: "game", text, from };
    const { box, target, dropped } = await chatAdd(env, msg, b.replyTo);
    ctx.waitUntil((async () => {
      if (dropped.length) await chatDropImages(env, dropped);
      await chatPing(env, msg, chatTargets(box, msg));
      await chatToDiscord(env, box, msg, target, null);
    })().catch((e) => console.log("chat send", e && e.message)));
    return reply({ ok: true, msg, seq: box.seq });
  }
  if (path === "/chat/image" && request.method === "POST") {
    // a picture from the game (PNG, JPEG or GIF), with words if there are some
    const who = await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    let form = null;
    try { form = await request.formData(); } catch { fail(400, "That picture couldn't be read."); }
    const file = form.get("file");
    if (!file || typeof file === "string") fail(400, "Choose a picture first.");
    if (file.size > CHAT_IMG_MAX) fail(413, "Pictures can be 8 MB at most.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = chatImageInfo(bytes);
    if (!info) fail(400, "Send a PNG, JPG or GIF picture.");
    if (info.w > CHAT_IMG_SIDE_MAX || info.h > CHAT_IMG_SIDE_MAX) fail(400, `Pictures can be ${CHAT_IMG_SIDE_MAX} pixels across at most.`);
    const text = chatClean(form.get("text"));
    if (text.length > CHAT_MAX) fail(400, `Messages can be ${CHAT_MAX} characters at most.`);
    await chatRate(env, who.playerId, true);
    // checked before it's kept or sent anywhere: nudity, sexual content, gore and the like never reach the chat or Discord
    const safe = await chatPictureSafe(env, bytes);
    if (safe === false) {
      await flagPlayer(env, who.playerId, "chat picture refused (not safe for the chat)").catch(() => {});
      fail(400, "That picture can't be posted in the chat.");
    }
    if (safe !== true) fail(503, "The picture couldn't be checked right now, so it wasn't sent. Try again in a moment.");
    const from = await chatIdentity(cfg, who.playerId, who.username);
    const id = "g" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const ext = info.type === "jpeg" ? "jpg" : info.type;
    const name = `${String(file.name || "picture").replace(/\.[^.]*$/, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "picture"}.${ext}`;
    const type = "image/" + info.type;
    await env.RELEASES.put(`chat/img/${id}-0`, bytes, { httpMetadata: { contentType: type } });
    const msg = { id, at: new Date().toISOString(), src: "game", text, from, images: [{ w: info.w, h: info.h, type: info.type, name }] };
    const { box, target, dropped } = await chatAdd(env, msg, form.get("replyTo"));
    ctx.waitUntil((async () => {
      if (dropped.length) await chatDropImages(env, dropped);
      await chatPing(env, msg, chatTargets(box, msg));
      await chatToDiscord(env, box, msg, target, { bytes, name, type });
    })().catch((e) => console.log("chat picture", e && e.message)));
    return reply({ ok: true, msg, seq: box.seq });
  }
  let mi = path.match(/^\/chat\/img\/([A-Za-z0-9_-]{2,40})\/([0-3])$/);
  if (mi && request.method === "GET") {
    // a picture in the room: from R2, or copied from Discord the first time (its file links expire). One bigger than
    // 16 megapixels isn't sent to the game (opening it froze the game for half a second); it's still there on Discord.
    const key = `chat/img/${mi[1]}-${mi[2]}`;
    const headers = (type) => ({ "Content-Type": type, "Cache-Control": "public, max-age=604800" });
    const have = await env.RELEASES.get(key);
    if (have && have.size <= 1_000_000) return cors(new Response(have.body, { headers: headers(have.httpMetadata?.contentType || "image/png") }));
    const box = await r2json(env, CHAT_KEY, chatEmpty());
    const m = (box.msgs || []).find((x) => x.id === mi[1]);
    const im = m && (m.images || [])[Number(mi[2])];
    if (im && (im.w || 0) * (im.h || 0) > CHAT_IMG_PIXELS_MAX) return cors(new Response("That picture is too big to show in the game.", { status: 413 }));
    if (have) return cors(new Response(have.body, { headers: headers(have.httpMetadata?.contentType || "image/png") }));
    if (!im) return cors(new Response("Not found", { status: 404 }));
    let src = im.src || null;
    if (!src) {
      const did = chatDiscordId(m);
      if (!did || !env.DISCORD_BOT_TOKEN || !env.DISCORD_CHAT_CHANNEL_ID) return cors(new Response("Not found", { status: 404 }));
      const r = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages/${did}`, { headers: discordBot(env) });
      if (!r.ok) return cors(new Response("Not found", { status: 404 }));
      const d = await r.json();
      const a = (d.attachments || []).find((x) => x.id === im.att);
      if (!a) return cors(new Response("Not found", { status: 404 }));
      // WebP isn't something the game can show: Discord's media server sends it as PNG
      src = im.type === "webp" ? (a.proxy_url || a.url) + ((a.proxy_url || a.url).includes("?") ? "&" : "?") + "format=png" : a.url;
    } else if (/\.webp(\?|$)/i.test(src)) src += (src.includes("?") ? "&" : "?") + "format=png";
    const res = await fetch(src);
    if (!res.ok) return cors(new Response("Not found", { status: 404 }));
    const buf = new Uint8Array(await res.arrayBuffer());
    const info = chatImageInfo(buf);
    if (info && (info.w || 0) * (info.h || 0) > CHAT_IMG_PIXELS_MAX) return cors(new Response("That picture is too big to show in the game.", { status: 413 }));
    const ct = info ? "image/" + info.type : res.headers.get("Content-Type") || "application/octet-stream";
    if (buf.length <= CHAT_IMG_MAX * 2) ctx.waitUntil(env.RELEASES.put(key, buf, { httpMetadata: { contentType: ct } }).catch(() => {}));
    return cors(new Response(buf, { headers: headers(ct) }));
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
      removed = null;
      const i = bx.msgs.findIndex((x) => x.id === String(b.id || ""));
      if (i < 0) return false;
      removed = bx.msgs.splice(i, 1)[0];
      chatGone(bx, [removed]);
    });
    if (!removed) fail(404, "That message is already gone.");
    ctx.waitUntil(chatDropImages(env, [removed]));
    if (removed.discordId && env.DISCORD_CHAT_WEBHOOK) ctx.waitUntil(fetch(`${env.DISCORD_CHAT_WEBHOOK}/messages/${removed.discordId}`, { method: "DELETE" }).catch(() => {}));
    else if ((removed.src === "discord" || removed.src === "command") && env.DISCORD_BOT_TOKEN && env.DISCORD_CHAT_CHANNEL_ID)
      ctx.waitUntil(fetch(`https://discord.com/api/v10/channels/${env.DISCORD_CHAT_CHANNEL_ID}/messages/${removed.id.slice(1)}`, { method: "DELETE", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } }).catch(() => {}));
    return reply({ ok: true });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- shared score pictures, read back
// A shared score's picture is drawn by the game, so the server reads it back (Workers AI, a vision model: the AI
// binding in wrangler.toml) before it goes on Discord: it has to be a results screen, with something on it that matches
// the play saved to the account. The post's numbers always come from the saved play, so a misread number doesn't
// matter; the check keeps other pictures off the Discord. (It used to need the exact score as well, and the model
// misreads long numbers often enough that most shares lost their picture.)
const SHARE_VISION = "@cf/meta/llama-3.2-11b-vision-instruct";
let shareVisionAgreed = false;
/**
 * { check, read, why }: check is "ok" (a results screen showing something of this play), "fake" (not a results screen
 * at all), "different" (nothing on it matches the play) or "unread" (the model gave no usable answer).
 */
async function sharePictureCheck(env, bytes, want) {
  if (!env.AI) return { check: "unread", why: "no AI binding" };
  const prompt = 'This image should be the results screen of the rhythm game OCTIVE. Reply with JSON only, no other words: {"results": true or false (is it a rhythm game results screen?), "player": "the player name written at the top", "score": "the big score number", "accuracy": "the accuracy percentage", "title": "the song title"}';
  const image = Array.from(bytes);
  let why = null;
  // two tries: now and then the model fails, or answers with something that can't be read
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try { out = await env.AI.run(SHARE_VISION, { prompt, image, max_tokens: 160, temperature: attempt ? 0.2 : 0 }); }
    catch (e) {
      why = String((e && e.message) || e).slice(0, 160);
      // the model's license is accepted once for the account
      if (!shareVisionAgreed && /agree|licen[cs]e/i.test(why)) {
        try { await env.AI.run(SHARE_VISION, { prompt: "agree" }); shareVisionAgreed = true; } catch (e2) { why = String((e2 && e2.message) || e2).slice(0, 160); }
      }
      continue;
    }
    const text = String(out?.response ?? out?.description ?? "");
    const r = readShareReply(text);
    if (r) return matchSharePicture(r, want);
    why = "reply: " + text.slice(0, 120);
  }
  console.log("share vision", why);
  return { check: "unread", why };
}

/** The model's reading of a score picture: its JSON, or the fields picked out one by one when the JSON is broken. */
function readShareReply(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { const r = JSON.parse(m[0]); if (r && typeof r === "object" && !Array.isArray(r)) return r; } catch { /* field by field */ } }
  const field = (k) => {
    const x = text.match(new RegExp(`"?${k}"?\\s*[:=]\\s*(?:"([^"\\n]*)"|([^,}\\n]+))`, "i"));
    return x ? (x[1] ?? x[2]).trim() : null;
  };
  const r = { results: field("results"), player: field("player"), score: field("score"), accuracy: field("accuracy"), title: field("title") };
  return Object.values(r).some((v) => v != null && v !== "") ? r : null;
}

/** Compares the model's reading with the play: any one of the score, accuracy, name or song title is enough. */
function matchSharePicture(r, want) {
  if (r.results === false || /^\s*false\s*$/i.test(String(r.results ?? ""))) return { check: "fake", read: r };
  const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
  const got = digits(r.score);
  const scoreOk = got.length >= 3 && digitEdits(got, String(Math.round(want.score))) <= 1;
  const a = parseFloat(String(r.accuracy ?? "").replace(",", ".").replace(/[^0-9.]/g, ""));
  const accOk = Number.isFinite(a) && Math.abs(a - want.acc) <= 0.1;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const near = (x, y, min) => { x = norm(x); y = norm(y); return x.length >= min && y.length >= min && (x.includes(y) || y.includes(x)); };
  const nameOk = near(r.player, want.name, 2), titleOk = near(r.title, want.title, 3);
  if (scoreOk || accOk || nameOk || titleOk) return { check: "ok", read: r };
  return { check: got !== "" || norm(r.player) !== "" ? "different" : "unread", read: r };
}

/** How many digits differ between two numbers as read (Levenshtein; short strings only). */
function digitEdits(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A picture for the public chat, checked before anyone sees it (here or on Discord): true when it's fine, false when
 * it shows nudity, sexual content, gore and the like, null when it couldn't be checked (then it isn't posted either).
 */
async function chatPictureSafe(env, bytes) {
  if (!env.AI) return null;
  // (2.0.2) a plain one-word question: the long list of what isn't allowed made the model refuse to answer at all (then
  // every picture was "couldn't be checked"). Two tries; an answer that isn't SAFE or UNSAFE is logged and not posted.
  const prompt = "You check pictures before they are posted in the chat of a rhythm game played by teenagers. " +
    "Is this picture fine to show there? Pictures with nudity, sexual content, gore or hate symbols are not. Screenshots, photos, memes and drawings usually are. " +
    "Answer with one word: SAFE or UNSAFE.";
  const ask = async () => {
    try { return await env.AI.run(SHARE_VISION, { prompt, image: Array.from(bytes), max_tokens: 12, temperature: 0 }); }
    catch (e) {
      if (shareVisionAgreed || !/agree|licen[cs]e/i.test(String(e && e.message))) throw e;
      await env.AI.run(SHARE_VISION, { prompt: "agree" }); shareVisionAgreed = true;
      return env.AI.run(SHARE_VISION, { prompt, image: Array.from(bytes), max_tokens: 12, temperature: 0 });
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try { const out = await ask(); text = String(out?.response ?? out?.description ?? ""); }
    catch (e) { console.log("chat picture check error", e && e.message); continue; }
    const t = text.toLowerCase();
    if (/\bunsafe\b|not (fine|safe|appropriate|suitable)|\bno\b/.test(t)) return false;
    if (/\bsafe\b|\byes\b|"safe"\s*:\s*true/.test(t)) return true;
    console.log("chat picture check answer", JSON.stringify(text.slice(0, 200)));
  }
  return null;
}

// ---------------------------------------------------------------- workshop: charts, skins, themes and styles shared from the game
// The game uploads a file (POST /api/upload, multipart); the bot posts it to the matching read-only channel
// (#octive-charts / -skins / -themes / -styles) with the file attached and an embed with the details and a
// preview. Only the channel and message ids are kept (Discord's file links expire): a download asks Discord for
// the message again and caches the fresh link for up to 12 hours. Previews are kept in R2 for the item lists.
const WS_TYPES = { ".oct": "charts", ".octskin": "skins", ".octtheme": "themes", ".octstyle": "styles" };
/** Song tags people can pick when they share (filters in the Workshop). */
const WS_TAGS = ["stream", "jumpstream", "handstream", "chordjack", "jacks", "speedjack", "technical", "ln", "hybrid", "sv", "stamina", "speed", "dump", "trills", "vibro", "gimmick", "modchart", "fnf", "osu", "pack", "easy", "marathon"];
const wsTags = (v) => [...new Set(String(v || "").toLowerCase().split(",").map((t) => t.trim()).filter((t) => WS_TAGS.includes(t)))].slice(0, 8);
/** The most PR a song's hardest difficulty can give (100%, verified), for cards and sorting. */
function wsTopPR(it) {
  let best = 0;
  for (const sg of (it.meta && it.meta.songs) || [])
    for (const c of sg.charts || []) {
      const st = Number(c.stars) || 0;
      if (st <= 0) continue;
      const pr = 8 * Math.pow(Math.max(st - 0.15, 0.05), 2.2) * (1 + 0.1 * Math.min(1, (Number(c.notes) || 0) / 1500));
      if (pr > best) best = pr;
    }
  return Math.round(best);
}
/** Uploads a player can make a day: Senterra and Octive any number, supporters 10, everyone else 3. */
// players with no daily Workshop upload limit besides staff and charters (lego1027)
const UNLIMITED_UPLOADS = ["u0bAhHr7LjswtFU4NB03XZcuUCOG"];
async function wsDailyLimit(env, playerId) {
  if (playerId === OWNER || isOfficial(playerId) || UNLIMITED_UPLOADS.includes(playerId)) return Infinity;
  // staff and charters: no daily limit (badges read fresh)
  await freshModeration(env);
  if (badgesOf(playerId).some((b) => b === "DEV" || b === "MOD" || b === "CHARTER")) return Infinity;
  try { const sup = await supporters(env); if (sup[playerId]?.active) return 10; } catch { /* not known */ }
  return 3;
}
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

// ---- Backblaze B2: where Workshop files live (Discord only shows a post about each upload).
// The S3-compatible API, signed here (AWS Signature V4). Secrets: B2_KEY_ID, B2_APP_KEY (an application key for the
// bucket); vars: B2_BUCKET, B2_ENDPOINT (the bucket's S3 endpoint, like s3.us-west-004.backblazeb2.com).
// Files: workshop/<itemId>/v<version>-<n><ext>. Downloads go through /api/file (B2 to Cloudflare costs nothing).
const b2Ready = (env) => !!(env.B2_KEY_ID && env.B2_APP_KEY && env.B2_BUCKET && env.B2_ENDPOINT);
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmacRaw(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}
/** The Authorization header of an S3 request (headers: lower-case names, host included). */
async function s3Sign({ method, path, query = "", headers, payloadHash, keyId, secret, region, amzDate }) {
  const names = Object.keys(headers).sort();
  const canonical = [method, path, query, names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
  let k = await hmacRaw("AWS4" + secret, amzDate.slice(0, 8));
  k = await hmacRaw(k, region); k = await hmacRaw(k, "s3"); k = await hmacRaw(k, "aws4_request");
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hexOf(await hmacRaw(k, toSign))}`;
}
async function b2Fetch(env, method, key, body = null, contentType = null) {
  const host = String(env.B2_ENDPOINT).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const region = (host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/) || [])[1] || "us-east-1";
  const path = `/${env.B2_BUCKET}/` + key.split("/").map((x) => encodeURIComponent(x)).join("/");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = await sha256Hex(body || "");
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["content-type"] = contentType;
  const auth = await s3Sign({ method, path, headers, payloadHash, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, region, amzDate });
  const send = { ...headers, authorization: auth }; delete send.host;
  return fetch(`https://${host}${path}`, { method, headers: send, body: body || undefined });
}
async function b2Put(env, key, bytes) {
  const r = await b2Fetch(env, "PUT", key, bytes, "application/octet-stream");
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Backblaze ${r.status}: ${t.slice(0, 200)}`); }
}
const b2Get = (env, key) => b2Fetch(env, "GET", key);
async function b2Delete(env, key) { const r = await b2Fetch(env, "DELETE", key); if (!r.ok && r.status !== 404) throw new Error(`Backblaze ${r.status}`); }
const wsB2Key = (id, version, n, fileName) => `workshop/${id}/v${version || 1}-${n}${((fileName || "").match(/\.[A-Za-z]+$/) || [".bin"])[0].toLowerCase()}`;
/** Stores an upload's files (its parts) in B2; nothing is left behind when one fails. */
async function wsStoreFiles(env, id, version, parts) {
  const out = [], put = [];
  try {
    for (const [k, x] of parts.entries()) {
      // (2.0.2) a file sent in parts: it's in B2 already
      if (x.staged) { out.push({ key: x.staged.key, name: x.fileName, size: x.staged.size }); continue; }
      const key = wsB2Key(id, version, k, x.fileName); await b2Put(env, key, x.bytes); out.push({ key, name: x.fileName, size: x.bytes.length }); put.push(key);
    }
  } catch (e) {
    for (const key of put) await b2Delete(env, key).catch(() => {});
    console.log("workshop store", e && e.message);
    fail(502, "The file couldn't be stored right now. Try again in a moment.");
  }
  return out;
}
async function wsDeleteFiles(env, it) {
  for (const f of it.b2Files || []) {
    await b2Delete(env, f.key).catch(() => {});
    // its cached copy goes too (this Cloudflare location; elsewhere nothing links to it any more)
    if (typeof caches !== "undefined") await caches.default.delete(new Request(`${WORKER_BASE}/api/file-cache/${encodeURIComponent(f.key)}`)).catch(() => {});
  }
}
/** An older upload's files, copied from its Discord post to B2 (and its preview to R2 if it wasn't there). */
async function wsMoveFiles(env, it) {
  let msg;
  try { msg = await discordApi(env, "GET", `/channels/${it.channelId}/messages/${it.messageId}`); }
  catch (e) { if (e.status === 404) { const x = new Error("Its Discord post is gone, so its file can't be copied."); x.lost = true; throw x; } throw e; }
  const names = it.fileNames && it.fileNames.length ? it.fileNames : [it.fileName];
  const atts = msg.attachments || [];
  let found = names.map((n) => atts.find((a) => a.filename === n)).filter(Boolean);
  if (!found.length) found = atts.filter((a) => !/^preview\./i.test(a.filename)).slice(0, 1);
  if (!found.length) { const x = new Error("Its Discord post has no file."); x.lost = true; throw x; }
  const parts = [];
  for (const a of found) {
    const r = await fetch(a.url);
    if (!r.ok) { const x = new Error(r.status === 404 ? "Its file is gone from Discord." : `Discord file ${r.status}`); x.lost = r.status === 404; throw x; }
    parts.push({ fileName: a.filename, bytes: new Uint8Array(await r.arrayBuffer()) });
  }
  const pv = it.preview ? null : atts.find((a) => /^preview\.(png|jpe?g)$/i.test(a.filename));
  if (pv && !(await env.RELEASES.head(`workshop/previews/${it.id}`).catch(() => null))) {
    const r = await fetch(pv.url);
    if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); const t = imageType(b); if (t) { await env.RELEASES.put(`workshop/previews/${it.id}`, b, { httpMetadata: { contentType: t === "png" ? "image/png" : "image/jpeg" } }); it.preview = true; } }
  }
  return wsStoreFiles(env, it.id, it.version || 1, parts);
}

// ---- the Workshop's Discord posts: a card with the details and buttons (the file itself is on B2)
const WS_EMOJI = { charts: "🎵", skins: "🎨", themes: "🖼️", styles: "✨" };
const wsMd = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@\u200b$1").replace(/([*_`~|\\>])/g, "\\$1").trim().slice(0, n);
async function wsCreatorDiscord(env, playerId) { try { return (await record(env, playerId)).discord?.id || null; } catch { return null; } }
function wsPostBody(it, creatorDiscord) {
  const songs = (it.type === "charts" && it.meta && it.meta.songs) || [];
  const lines = [];
  if (it.description) lines.push(wsMd(it.description, 700));
  if (songs.length) {
    if (lines.length) lines.push("");
    for (const sg of songs.slice(0, 20)) {
      lines.push(`**${wsMd(sg.title || "Song", 80)}**${sg.artist ? ` · ${wsMd(sg.artist, 60)}` : ""}`);
      const cs = (sg.charts || []).slice().sort((a, b) => (a.stars || 0) - (b.stars || 0)).slice(0, 10);
      if (cs.length) lines.push(cs.map((c) => "`" + `${c.keys ? c.keys + "K " : ""}${String(c.difficulty || "?").replace(/`/g, "'").slice(0, 24)}${c.stars ? " " + Number(c.stars).toFixed(1) + "★" : ""}` + "`").join(" "));
    }
  }
  const mb = (it.size || 0) / 1048576;
  const fields = [
    { name: "Creator", value: creatorDiscord ? `<@${creatorDiscord}>` : wsMd(it.creator, 40) || "Player", inline: true },
    { name: "Size", value: `${mb.toFixed(mb < 1 ? 2 : 1)} MB${songs.length > 1 ? ` · ${songs.length} songs` : ""}`, inline: true },
  ];
  if (it.type === "charts") {
    const keys = [...new Set(songs.flatMap((sg) => (sg.charts || []).map((c) => c.keys)).filter(Boolean))].sort((a, b) => a - b);
    if (keys.length) fields.push({ name: "Keys", value: keys.map((k) => k + "K").join(" · "), inline: true });
    fields.push({ name: "Leaderboard", value: it.verified ? "✅ Verified: global board" : "Community upload", inline: true });
  }
  const embed = {
    title: `${WS_EMOJI[it.type] || ""} ${String(it.title || "Untitled")}`.trim().slice(0, 256), url: `${SITE}#/open/workshop/${it.id}`, color: WS_COLOR[it.type],
    author: { name: `${WS_LABEL[it.type]} by ${it.creator || "Player"}`.slice(0, 256), url: `${SITE}#/u/${encodeURIComponent(it.creatorId || "")}` },
    description: lines.join("\n").slice(0, 4000) || undefined,
    fields,
    image: it.preview ? { url: `${WORKER_BASE}/api/preview/${it.id}?v=${it.version || 1}` } : undefined,
    footer: { text: `OCTIVE Workshop${(it.version || 1) > 1 ? ` · version ${it.version}` : ""} · ${it.id}` },
    timestamp: new Date(it.updatedAt || it.at || Date.now()).toISOString(),
  };
  return {
    embeds: [embed], allowed_mentions: { parse: [] }, attachments: [],
    components: [row(linkButton("Open in OCTIVE", `${SITE}#/open/workshop/${it.id}`, "🎮"), linkButton("Download", `${WORKER_BASE}/api/download/${it.id}?redirect=1`, "⬇️"), linkButton("Creator", `${SITE}#/u/${encodeURIComponent(it.creatorId || "")}`, "👤"))],
  };
}
/** Posts an upload's card in its channel (the old post, if any, is deleted after). */
async function wsRepost(env, it) {
  const channels = await wsChannelIds(env);
  const channelId = channels[it.type];
  if (!channelId) throw new Error(`The #${WS_CHANNEL[it.type]} channel wasn't found.`);
  const posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, wsPostBody(it, await wsCreatorDiscord(env, it.creatorId)));
  if (it.channelId && it.messageId && it.messageId !== posted.id) await discordApi(env, "DELETE", `/channels/${it.channelId}/messages/${it.messageId}`).catch(() => {});
  return { channelId, messageId: posted.id, guildId: env.DISCORD_GUILD_ID };
}

// ---- (2.0.2) big Workshop files, sent in parts
// A request can't carry a 150 MB file (the Worker has 128 MB of memory), so the game sends a big file in 16 MB parts
// (POST /api/upload/stage, then PUT /api/upload/stage/<id>/<n>): each goes straight on to B2 as a part of one multipart
// upload, and the file's SHA-256 is worked out part by part as they come (its state kept between parts). The upload
// itself (/api/upload, /api/items/<id>/update) then names the staged files ("staged" fields) instead of carrying
// them; they're checked from B2 (wsSlimZip: everything but the sound and video, read in byte ranges). Staged files
// nothing used are removed after 12 hours (wsStageSweep, hourly).
const WS_SINGLE_MAX = 50 * 1048576 - 1_000_000; // what one request can carry
const WS_PART = 16 * 1048576; // the parts' size (the last one smaller); a multiple of 64 (SHA-256 blocks)
const WS_STAGE_TTL = 12 * 3600_000;
const wsStageKey = (playerId, id) => `workshop/stage/${playerId}/${id}.json`;

/** An S3 request to B2 with a query string (multipart uploads). */
async function b2S3(env, method, key, query, body = null, contentType = null) {
  const host = String(env.B2_ENDPOINT).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const region = (host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/) || [])[1] || "us-east-1";
  const path = `/${env.B2_BUCKET}/` + key.split("/").map((x) => encodeURIComponent(x)).join("/");
  const q = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`).join("&");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = await sha256Hex(body || "");
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["content-type"] = contentType;
  const auth = await s3Sign({ method, path, query: q, headers, payloadHash, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, region, amzDate });
  const send = { ...headers, authorization: auth }; delete send.host;
  return fetch(`https://${host}${path}${q ? "?" + q : ""}`, { method, headers: send, body: body || undefined });
}

// SHA-256 a part at a time (Web Crypto can't carry on from where it stopped): the state is 8 numbers
const SHA_K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const sha256Start = () => [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
/** Runs whole 64-byte blocks of u8 (its length a multiple of 64) through the state h (changed in place). */
function sha256Blocks(h, u8) {
  const w = new Uint32Array(64);
  let h0 = h[0] | 0, h1 = h[1] | 0, h2 = h[2] | 0, h3 = h[3] | 0, h4 = h[4] | 0, h5 = h[5] | 0, h6 = h[6] | 0, h7 = h[7] | 0;
  for (let o = 0; o + 64 <= u8.length; o += 64) {
    for (let i = 0; i < 16; i++) { const j = o + i * 4; w[i] = (u8[j] << 24) | (u8[j + 1] << 16) | (u8[j + 2] << 8) | u8[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
  }
  h[0] = h0 >>> 0; h[1] = h1 >>> 0; h[2] = h2 >>> 0; h[3] = h3 >>> 0; h[4] = h4 >>> 0; h[5] = h5 >>> 0; h[6] = h6 >>> 0; h[7] = h7 >>> 0;
}
/** The last part (any length) and the whole file's length: the hash, hex like bytesHash. */
function sha256Finish(h, u8, totalLen) {
  const whole = u8.length - (u8.length % 64);
  sha256Blocks(h, u8.subarray(0, whole));
  const rest = u8.length - whole;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(u8.subarray(whole)); tail[rest] = 0x80;
  const bits = totalLen * 8, dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(bits / 4294967296)); dv.setUint32(tail.length - 4, bits >>> 0);
  sha256Blocks(h, tail);
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** An upload's files: the ones it carries, and (2.0.2) the ones sent before in parts ("staged"), each read when needed. */
async function wsInputs(env, form, playerId) {
  const out = form.getAll("file").filter((f) => f && typeof f !== "string")
    .map((f) => ({ name: f.name, size: f.size, hash: null, staged: null, read: async () => new Uint8Array(await f.arrayBuffer()) }));
  for (const sid of [...new Set(form.getAll("staged").map(String))].slice(0, 20)) {
    if (!/^[a-z0-9]{20}$/.test(sid)) fail(400, "That upload isn't valid.");
    const rec = await r2json(env, wsStageKey(playerId, sid), null);
    if (!rec || !rec.done) fail(410, "A file of this upload didn't finish sending, or it was too long ago. Try again.");
    out.push({ name: rec.fileName, size: rec.size, hash: rec.hash, staged: rec, read: () => wsStagedBytes(env, rec) });
  }
  return out;
}
/** A staged file, to check and read: songs and skins as a slim zip, themes and styles whole (they're small). */
async function wsStagedBytes(env, rec) {
  const t = WS_TYPES[((rec.fileName || "").match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase()];
  if (t === "charts" || t === "skins") return wsSlimZip(env, rec.key, rec.size);
  if (rec.size > WS_SINGLE_MAX) fail(413, `Themes and styles can be up to ${Math.floor(WS_SINGLE_MAX / 1048576)} MB.`);
  const r = await b2Get(env, rec.key);
  if (!r.ok) fail(502, "The file couldn't be read right now. Try again in a moment.");
  return new Uint8Array(await r.arrayBuffer());
}
/** Staged files an upload used: theirs now (their records go, so the sweep leaves the files). */
async function wsStagesUsed(env, playerId, parts) {
  for (const x of parts) if (x.staged) await env.RELEASES.delete(wsStageKey(playerId, x.staged.id)).catch(() => {});
}

/**
 * A big package in B2 as a small zip to check and read (wsInspect, wsMeta): every file but the sound and video, read in
 * byte ranges. Its file list is the whole package's (so the checks see every name); the files left out are empty in it.
 */
async function wsSlimZip(env, key, size) {
  const bad = (m) => fail(400, m || "That file isn't a valid OCTIVE package (not a zip archive).");
  if (size < 22) bad();
  const tailStart = Math.max(0, size - 66_000);
  const tail = await b2Range(env, key, tailStart, size - 1);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) bad();
  const count = tv.getUint16(eocd + 10, true), cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true);
  if (count > 20000) bad("That package has too many files.");
  if (count === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > size) bad("That package can't be read (zip64 isn't supported).");
  const cd = cdOff >= tailStart ? tail.slice(cdOff - tailStart, cdOff - tailStart + cdSize) : await b2Range(env, key, cdOff, cdOff + cdSize - 1);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const recs = [];
  let budget = 40 * 1048576;
  for (let n = 0, p = 0; n < count; n++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) bad("That package is damaged (its file list is broken).");
    const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    const comp = cv.getUint32(p + 20, true), local = cv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
    const media = /\.(ogg|mp3|wav|flac|opus|m4a|aac|mp4|webm|mkv|avi|mov|m4v|wmv)$/i.test(name);
    const keep = !media && comp <= 16 * 1048576 && local < cdOff && comp + 2048 <= budget;
    if (keep) budget -= comp + 2048;
    recs.push({ p, len: 46 + nl + xl + cl, local, comp, keep });
    p += 46 + nl + xl + cl;
  }
  // the kept files' local records, read in runs of neighbours
  const kept = recs.filter((r) => r.keep).sort((a, b) => a.local - b.local);
  const data = new Map(); // local offset -> its local record (header, name, extra, data)
  for (let i = 0; i < kept.length;) {
    let j = i, end = Math.min(cdOff, kept[i].local + 30 + 1024 + kept[i].comp);
    while (j + 1 < kept.length && kept[j + 1].local - end < 512 * 1024 && Math.min(cdOff, kept[j + 1].local + 30 + 1024 + kept[j + 1].comp) - kept[i].local < 24 * 1048576) { j++; end = Math.max(end, Math.min(cdOff, kept[j].local + 30 + 1024 + kept[j].comp)); }
    const start = kept[i].local;
    const run = await b2Range(env, key, start, end - 1);
    for (let k = i; k <= j; k++) {
      const r = kept[k], at = r.local - start;
      let piece = run.subarray(at);
      if (piece.length < 30) piece = await b2Range(env, key, r.local, Math.min(cdOff, r.local + 30 + 1024 + r.comp) - 1);
      let dv = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
      if (dv.getUint32(0, true) !== 0x04034b50) bad("That package is damaged.");
      const len = 30 + dv.getUint16(26, true) + dv.getUint16(28, true) + r.comp;
      if (len > piece.length) { piece = await b2Range(env, key, r.local, r.local + len - 1); }
      data.set(r.local, piece.slice(0, len));
    }
    i = j + 1;
  }
  // the slim zip: an empty record for the files left out, the kept ones, the whole file list, the end
  const stub = new Uint8Array(30); new DataView(stub.buffer).setUint32(0, 0x04034b50, true);
  const chunks = [stub];
  let off = 30;
  const newLocal = new Map();
  for (const r of kept) { newLocal.set(r.local, off); const d = data.get(r.local); chunks.push(d); off += d.length; }
  const cdStart = off;
  for (const r of recs) {
    const c = cd.slice(r.p, r.p + r.len), dv = new DataView(c.buffer);
    if (r.keep) dv.setUint32(42, newLocal.get(r.local), true);
    else { dv.setUint16(10, 0, true); dv.setUint32(20, 0, true); dv.setUint32(24, 0, true); dv.setUint32(42, 0, true); }
    chunks.push(c); off += c.length;
  }
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, count, true); ev.setUint16(10, count, true); ev.setUint32(12, off - cdStart, true); ev.setUint32(16, cdStart, true);
  chunks.push(end); off += 22;
  const out = new Uint8Array(off);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Staged files nothing used: gone after WS_STAGE_TTL (the multipart upload stopped, or the file deleted). */
async function wsStageSweep(env, max = 200) {
  let cursor, n = 0;
  do {
    const page = await env.RELEASES.list({ prefix: "workshop/stage/", cursor, limit: 500 });
    for (const o of page.objects) {
      if (Date.now() - new Date(o.uploaded).getTime() < WS_STAGE_TTL) continue;
      if (++n > max) return;
      const rec = await r2json(env, o.key, null);
      try {
        if (rec && rec.key && /^workshop\/staged\//.test(rec.key)) {
          if (rec.done) await b2Delete(env, rec.key);
          else if (rec.uploadId) await b2S3(env, "DELETE", rec.key, { uploadId: rec.uploadId });
        }
        await env.RELEASES.delete(o.key);
      } catch (e) { console.log("stage sweep", e && e.message); }
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
}

/** The biggest file the server takes now (it follows the boost level, checked every 10 minutes), less a safety margin. */
async function wsMaxBytes(env) {
  // on B2 the limit is the server's own, not Discord's: (2.0.2) 150 MB, files over what one request can carry
  // (WS_SINGLE_MAX) sent in parts (/api/upload/stage)
  if (b2Ready(env)) return 150 * 1048576 - 1_000_000;
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

// ---------------------------------------------------------------- plays judged again from their replays
// Board scores, daily charts and dans only count with the play's replay: its inputs are judged again here against the
// chart (judge.js: the game's judge, ported line for line and checked against it by Tools/judge_parity.mjs), and only
// what that gives is kept. The counts, score, accuracy and combo a game sends are never used. The chart comes from its
// Workshop upload in B2: just the zip's directory, its manifest and the one chart file are read (byte ranges), compiled
// once and kept in R2 under judge/<judge version>/<file key>/ (manifest.json, chart-<n>.json).
const BACKSLASH = String.fromCharCode(92);
/** 503 with code "retry": the game sends the play again a little later (it isn't the play's fault). */
const failRetry = (message) => { const e = new HttpError(503, message); e.code = "retry"; throw e; };
const JUDGE_MEMO = new Map(); // in this Worker instance: R2 key -> manifest details or compiled chart
const judgeMemo = (k, v) => { JUDGE_MEMO.set(k, v); if (JUDGE_MEMO.size > 60) JUDGE_MEMO.delete(JUDGE_MEMO.keys().next().value); return v; };

/** A byte range of a file in B2 (signed like b2Fetch; the Range header isn't part of the signature). */
async function b2Range(env, key, start, end) {
  const host = String(env.B2_ENDPOINT).replace("https://", "").replace("http://", "").replace(/[/]+$/, "");
  const region = (host.match(/^s3[.]([a-z0-9-]+)[.]backblazeb2[.]com$/) || [])[1] || "us-east-1";
  const path = `/${env.B2_BUCKET}/` + key.split("/").map((x) => encodeURIComponent(x)).join("/");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/[.][0-9]{3}/, "");
  const payloadHash = await sha256Hex("");
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const auth = await s3Sign({ method: "GET", path, headers, payloadHash, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, region, amzDate });
  const send = { ...headers, authorization: auth, range: `bytes=${start}-${end}` };
  delete send.host;
  const r = await fetch(`https://${host}${path}`, { headers: send });
  if (r.status !== 206 && r.status !== 200) throw new Error(`Backblaze answered ${r.status}`);
  const u8 = new Uint8Array(await r.arrayBuffer());
  return r.status === 200 ? u8.subarray(start, end + 1) : u8; // a whole file sent anyway: the part asked for
}

/** The directory of a zip in B2 (name -> where its data is), read from the end of the file. */
async function judgeZipDir(env, f) {
  const size = Number(f.size) || 0;
  if (size < 22) throw new Error("the package is empty");
  const tailStart = Math.max(0, size - 66_000);
  const tail = await b2Range(env, f.key, tailStart, size - 1);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("the package isn't a zip archive");
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error("the package is too large to read here");
  const cd = cdOff >= tailStart && cdOff + cdSize <= size ? tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize) : await b2Range(env, f.key, cdOff, cdOff + cdSize - 1);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const out = new Map();
  for (let n = 0, p = 0; n < count && p + 46 <= cd.length; n++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl)).split(BACKSLASH).join("/");
    out.set(name, { method: cv.getUint16(p + 10, true), comp: cv.getUint32(p + 20, true), size: cv.getUint32(p + 24, true), local: cv.getUint32(p + 42, true) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** One file out of a zip in B2: its local header, then its bytes (deflate undone). */
async function judgeZipFile(env, f, e, max = 32 * 1048576) {
  if (e.size > max || e.comp > max) throw new Error("a file in the package is too large");
  let part = await b2Range(env, f.key, e.local, e.local + 30 + 1024 + e.comp - 1);
  let dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
  if (part.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error("the package is damaged");
  const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  if (start + e.comp > part.length) part = await b2Range(env, f.key, e.local, e.local + start + e.comp - 1);
  const raw = part.subarray(start, start + e.comp);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error("the package uses a compression this server can't read");
  const buf = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
  if (buf.length > max) throw new Error("a file in the package is too large");
  return buf;
}

/** A package's manifest, as judging needs it: the song id and each chart (file, id, difficulty, osu! file MD5) and where it is. */
async function judgeManifest(env, f) {
  const rk = `judge/${JUDGE_VERSION}/${f.key}/manifest.json`;
  if (JUDGE_MEMO.has(rk)) return JUDGE_MEMO.get(rk);
  let m = await r2json(env, rk, null);
  if (!m) {
    const dir = await judgeZipDir(env, f);
    const me = [...dir.entries()].find(([n]) => n.toLowerCase() === "manifest.json");
    if (!me) throw new Error("the package has no manifest");
    const man = JSON.parse(new TextDecoder().decode(await judgeZipFile(env, f, me[1], 4 * 1048576)));
    const str = (v) => (typeof v === "string" ? v : null);
    m = {
      songId: str(man.songId),
      charts: (Array.isArray(man.charts) ? man.charts : []).filter((c) => c && typeof c === "object").map((c) => {
        const file = String(c.file || "").split(BACKSLASH).join("/");
        return { file, chartId: str(c.chartId), difficulty: str(c.difficulty), osuMd5: str(c.osuMd5) ? c.osuMd5.toLowerCase() : null, entry: dir.get(file) || null };
      }),
    };
    await r2put(env, rk, m);
  }
  return judgeMemo(rk, m);
}

/** One of a package's charts, compiled for judging: read from B2 the first time, then kept in R2. */
async function judgeCompiled(env, f, m, i) {
  const rk = `judge/${JUDGE_VERSION}/${f.key}/chart-${i}.json`;
  if (JUDGE_MEMO.has(rk)) return JUDGE_MEMO.get(rk);
  let packed = await r2json(env, rk, null);
  if (!packed) {
    const mc = m.charts[i];
    if (!mc.entry) throw new Error("the package is missing a chart file");
    let chart;
    try { chart = loadChart(new TextDecoder().decode(await judgeZipFile(env, f, mc.entry))); }
    catch (e) { if (e instanceof JudgeDataError) fail(409, `This chart can't be checked by the server (${e.message}), so plays of it don't count.`); throw e; }
    packed = packCompiled(compileChart(chart));
    await r2put(env, rk, packed);
  }
  const c = unpackCompiled(packed);
  if (!c) throw new Error("a kept chart is out of date");
  return judgeMemo(rk, c);
}

/**
 * A chart of a Workshop upload, ready to judge: found in its song's package by chart id, else the osu! file's MD5, else
 * the difficulty's name (only where the package doesn't name another osu! file). Null when the upload hasn't got it.
 */
async function judgeChartOf(env, it, songId, want) {
  const files = (it && it.b2Files) || [];
  if (!files.length || !b2Ready(env)) failRetry("The server can't read this chart right now, so the play can't be checked. Try again later.");
  const songs = (it.meta && it.meta.songs) || [];
  const order = files.map((_, i) => i);
  const si = songs.findIndex((s) => s.songId === songId);
  if (si >= 0 && songs.length === files.length) order.unshift(...order.splice(si, 1)); // its file first (the details were read in file order)
  try {
    for (const n of order) {
      const f = files[n];
      if (!f || !f.key || Number(f.size) > 200 * 1048576) continue;
      const m = await judgeManifest(env, f);
      if (songId && m.songId !== songId) continue;
      let i = -1;
      if (want.chartId) i = m.charts.findIndex((c) => c.chartId === want.chartId);
      if (i < 0 && want.osuMd5) i = m.charts.findIndex((c) => c.osuMd5 === want.osuMd5);
      if (i < 0 && want.difficulty) i = m.charts.findIndex((c) => c.difficulty === want.difficulty && !(want.osuMd5 && c.osuMd5));
      if (i < 0) return null;
      return { compiled: await judgeCompiled(env, f, m, i), itemId: it.id, songId: m.songId, chartId: m.charts[i].chartId, difficulty: m.charts[i].difficulty };
    }
  } catch (e) {
    if (e.status) throw e;
    console.log("judge chart", it && it.id, e && e.message);
    failRetry("The server couldn't read this chart right now, so the play can't be checked. Try again in a moment.");
  }
  return null;
}

/**
 * A modchart (2.0.1): the chart moves its lanes or notes (lane animations, note-path effects, an FNF stage, input swaps
 * or note behaviours). Its uploads get the "modchart" tag by themselves.
 */
/** (2.0.2) A chart with scroll speed changes that matter: 4 or more SV points 10% off normal speed (or stops / reverses). */
function hasSv(text) {
  let j;
  try { j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return false; }
  const sv = j && Array.isArray(j.sv) ? j.sv : [];
  let n = 0;
  for (const e of sv) { const v = Number(e && e.value); if (Number.isFinite(v) && (v <= 0 || Math.abs(v - 1) >= 0.1) && e.enabled !== false) n++; }
  return n >= 4;
}

function hasModchart(text) {
  let j;
  try { j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return false; }
  if (!j || typeof j !== "object") return false;
  const some = (a) => Array.isArray(a) && a.length > 0;
  return !!(j.fnf || some(j.lanes) || some(j.mods) || some(j.inputMaps) || (Array.isArray(j.notes) && j.notes.some((n) => n && some(n.behaviors))));
}

/** Puts a chart's shape on its Workshop details: len (seconds), ln (long-note share), nps (notes a second), autoTags. */
function setChartShape(ch, st) {
  if (!ch || !st) return;
  const tags = [...(st.tags || [])];
  if (st.mc !== undefined) ch.mc = st.mc;
  if (ch.mc === 1 && !tags.includes("modchart")) tags.push("modchart"); // (a shape worked out again keeps it)
  if (st.sv !== undefined) { ch.sv = st.sv ? 1 : 0; if (st.sv && !tags.includes("sv")) tags.push("sv"); }
  ch.len = st.len; ch.ln = st.ln; ch.nps = st.nps; ch.autoTags = tags; ch.autoTagsAll = tags;
}

/**
 * An upload's auto-tags without the ones its uploader took off (2.0.1): each chart's autoTags is autoTagsAll (what the
 * server worked out from its notes) less the upload's removedTags. Everything that reads tags reads autoTags; Ranked
 * reads autoTagsAll (a modchart stays out of it whatever its tags say).
 */
function applyRemovedTags(it) {
  if (!it || !it.meta) return;
  const off = new Set(Array.isArray(it.removedTags) ? it.removedTags : []);
  for (const sg of it.meta.songs || [])
    for (const c of (sg && sg.charts) || []) {
      if (!Array.isArray(c.autoTagsAll)) { if (!Array.isArray(c.autoTags)) continue; c.autoTagsAll = c.autoTags; }
      c.autoTags = c.autoTagsAll.filter((t) => !off.has(t));
    }
}
/** A chart that moves its lanes or notes (the server's own check, see hasModchart): never in Ranked. */
const chartIsModchart = (c) => c.mc === 1 || (Array.isArray(c.autoTagsAll) ? c.autoTagsAll : c.autoTags || []).includes("modchart");

/**
 * Fills in the shape of charts uploaded before shapes were worked out, a few uploads at a time, verified ones first.
 * Each chart is read through the judge's cache (from B2 the first time). A chart that can't be read as a chart gets
 * len 0 (not tried again); an upload whose files couldn't be fetched is tried again, three times at most. Run by the
 * 6-hourly job and the owner's account/mod/chart-shapes.
 */
async function fillChartShapes(env, maxItems = 6) {
  const db = await r2json(env, WS_DB, { items: [] });
  const missing = (it) => it.type === "charts" && !it.removed && it.meta && (it.b2Files || []).length && (it.meta.shapeTries || 0) < 3 &&
    (it.meta.songs || []).some((sg) => (sg.charts || []).some((c) => c.len === undefined || c.sv === undefined));
  const all = (db.items || []).filter(missing);
  const todo = all.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0)).slice(0, maxItems);
  const found = [], tried = [];
  for (const it of todo) {
    const songs = it.meta.songs || [], files = it.b2Files || [];
    let any = false;
    for (let fi = 0; fi < files.length && fi < 20; fi++) {
      const f = files[fi];
      if (!f || !f.key || Number(f.size) > 200 * 1048576) continue;
      let m;
      try { m = await judgeManifest(env, f); } catch (e) { console.log("chart shapes", it.id, e && e.message); continue; }
      // its song in the details: by song id, else the same place in the list
      let si = m.songId ? songs.findIndex((s) => s.songId === m.songId) : -1;
      if (si < 0 && songs.length === files.length) si = fi;
      if (si < 0) continue;
      const charts = songs[si].charts || [];
      for (let j = 0; j < charts.length && j < m.charts.length; j++) {
        if (charts[j].len !== undefined && charts[j].sv !== undefined) continue;
        let st;
        try { st = chartStats(await judgeCompiled(env, f, m, j)); } catch { st = { len: 0, ln: 0, nps: 0, tags: [] }; }
        // (2.0.2) its SV, from the chart file itself
        try { st.sv = m.charts[j].entry ? hasSv(new TextDecoder().decode(await judgeZipFile(env, f, m.charts[j].entry))) : false; } catch { st.sv = false; }
        found.push([it.id, si, j, st]);
        any = true;
      }
    }
    if (!any) tried.push(it.id);
  }
  if (found.length || tried.length) {
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const byId = new Map((d.items || []).map((x) => [x.id, x]));
      for (const [id, si, j, st] of found) {
        const sg = byId.get(id)?.meta?.songs?.[si];
        const ch = sg?.charts?.[j];
        if (!ch || (ch.len !== undefined && ch.sv !== undefined)) continue;
        setChartShape(ch, st);
        applyRemovedTags(byId.get(id));
        if (!(sg.durationUs > 0) && st.len > 0) sg.durationUs = Math.round(st.len * 1e6);
      }
      for (const id of tried) { const it = byId.get(id); if (it && it.meta) it.meta.shapeTries = (it.meta.shapeTries || 0) + 1; }
    });
    judgeDbCache = null;
  }
  return { uploads: todo.length, charts: found.length, left: Math.max(0, all.length - todo.length) };
}

/**
 * Finds out which charts of older uploads are modcharts (2.0.1: before, only new uploads were looked at), a few uploads
 * at a time, verified ones first (Ranked leaves modcharts out): each chart file read once from B2. A modchart gets the
 * "modchart" auto-tag; every chart looked at gets mc 0 or 1. Run with the chart shapes.
 */
async function fillModchartFlags(env, maxItems = 6) {
  const db = await r2json(env, WS_DB, { items: [] });
  const missing = (it) => it.type === "charts" && !it.removed && it.meta && (it.b2Files || []).length && (it.meta.mcTries || 0) < 3 &&
    (it.meta.songs || []).some((sg) => (sg.charts || []).some((c) => c.mc === undefined));
  const all = (db.items || []).filter(missing);
  const todo = all.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0)).slice(0, maxItems);
  const found = [], tried = [];
  for (const it of todo) {
    const songs = it.meta.songs || [], files = it.b2Files || [];
    let any = false;
    for (let fi = 0; fi < files.length && fi < 20; fi++) {
      const f = files[fi];
      if (!f || !f.key || Number(f.size) > 200 * 1048576) continue;
      let m;
      try { m = await judgeManifest(env, f); } catch (e) { console.log("modchart flags", it.id, e && e.message); continue; }
      let si = m.songId ? songs.findIndex((x) => x.songId === m.songId) : -1;
      if (si < 0 && songs.length === files.length) si = fi;
      if (si < 0) continue;
      const charts = songs[si].charts || [];
      for (let j = 0; j < charts.length && j < m.charts.length; j++) {
        if (charts[j].mc !== undefined || !m.charts[j].entry) continue;
        try { found.push([it.id, si, j, hasModchart(new TextDecoder().decode(await judgeZipFile(env, f, m.charts[j].entry))) ? 1 : 0]); any = true; }
        catch (e) { console.log("modchart flags", it.id, e && e.message); }
      }
    }
    if (!any) tried.push(it.id);
  }
  if (found.length || tried.length) {
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const byId = new Map((d.items || []).map((x) => [x.id, x]));
      const touched = new Set();
      for (const [id, si, j, mc] of found) {
        const ch = byId.get(id)?.meta?.songs?.[si]?.charts?.[j];
        if (!ch || ch.mc !== undefined) continue;
        ch.mc = mc;
        if (mc) ch.autoTagsAll = [...new Set([...(Array.isArray(ch.autoTagsAll) ? ch.autoTagsAll : ch.autoTags || []), "modchart"])];
        touched.add(id);
      }
      for (const id of touched) applyRemovedTags(byId.get(id));
      for (const id of tried) { const it = byId.get(id); if (it && it.meta) it.meta.mcTries = (it.meta.mcTries || 0) + 1; }
    });
    judgeDbCache = null; rkPoolCache[4] = rkPoolCache[7] = null;
  }
  return { uploads: todo.length, charts: found.length, modcharts: found.filter((x) => x[3]).length, left: Math.max(0, all.length - todo.length) };
}

let judgeDbCache = null, judgeDbAt = 0;
async function judgeDb(env) {
  if (judgeDbCache && Date.now() - judgeDbAt < 60_000) return judgeDbCache;
  judgeDbCache = await r2json(env, WS_DB, { items: [] });
  judgeDbAt = Date.now();
  return judgeDbCache;
}

/** The chart a board's play is judged with: OCTIVE's own or a verified song's upload, or a verified upload of an osu! set. */
async function boardChartOf(env, songId, chartId, difficulty) {
  const items = ((await judgeDb(env)).items || []).filter((x) => x.type === "charts" && !x.removed && x.meta && (x.b2Files || []).length);
  const rank = (x) => (x.verified ? 0 : x.builtin ? 1 : 2);
  const set = /^osu-([0-9]+)$/.exec(songId);
  if (set) {
    const md5 = /^[0-9a-f]{32}$/.test(chartId) ? chartId : null;
    const ofSet = (s) => Number(s.osuSet) === Number(set[1]);
    for (const it of items.filter((x) => (x.meta.songs || []).some(ofSet)).sort((a, b) => rank(a) - rank(b)).slice(0, 4))
      for (const sg of it.meta.songs.filter(ofSet)) {
        const r = await judgeChartOf(env, it, sg.songId, { chartId: md5 ? null : chartId, osuMd5: md5, difficulty: difficulty || null });
        if (r) return r;
      }
    return null;
  }
  const it = items.filter((x) => (x.songIds || []).includes(songId) || (x.meta.songs || []).some((s) => s.songId === songId)).sort((a, b) => rank(a) - rank(b))[0];
  return it ? judgeChartOf(env, it, songId, { chartId }) : null;
}

/**
 * A play judged again from its replay (the gzip bytes the game sent, see replayBytes). It has to be the signed-in
 * player's own recorded play (not autoplay), from a game that judges like this one, of a chart with that many keys.
 * Gives { replay, result }: result has the game's numbers (counts, score, accuracy, maxCombo, fullCombo, grade), judged here.
 */
async function judgePlay(who, bytes, where, opts = {}) {
  if (!bytes) fail(400, `${opts.what || "A play"} only counts with its replay. Update OCTIVE and play it again.`);
  let replay;
  try { replay = await readReplay(bytes); }
  catch (e) { if (e instanceof JudgeDataError) fail(400, "The play's replay couldn't be read: " + e.message); throw e; }
  // (REPLAY_VERSION is the newest the judge reads; older plays are judged by the rules they were played with)
  if (replay.version < (opts.minVersion || SCORE_REPLAY_MIN)) fail(400, "That replay comes from an older OCTIVE. Update the game and play it again.");
  if (replay.autoplay) fail(400, "Autoplay doesn't count.");
  if (!replay.playerId || replay.playerId !== who.playerId) fail(403, "That replay isn't your own play.");
  if (opts.noMods && (parseMods(replay.mods) !== 0 || rateOf(replay.mods) !== 1)) fail(400, opts.noModsText || "This is played without mods.");
  if (!where) fail(409, "The server can't find this chart to check the play, so it doesn't count.");
  if (opts.songId && (replay.songId !== opts.songId || replay.chartId !== opts.chartId)) fail(409, "That replay is of another chart.");
  const c = where.compiled;
  if (replay.keyCount && replay.keyCount !== c.keyCount) fail(409, `That replay was played with ${replay.keyCount} keys, but this chart has ${c.keyCount}.`);
  const result = judgeReplay(c, replay);
  if (!result.hits) fail(400, "Nothing was hit in that play.");
  return { replay, result };
}

/** Accuracy from judgement counts (what a game says its play got), or null. */
function claimedAccuracy(counts) {
  if (!Array.isArray(counts) || counts.length !== 6) return null;
  const c = counts.map((n) => Number(n));
  const total = c.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  return total > 0 ? c.reduce((a, n, i) => a + (Number.isFinite(n) && n > 0 ? n : 0) * ACC_WEIGHTS[i], 0) / total : null;
}

// ---------------------------------------------------------------- anti-cheat (2.0)
// Every play the server judges from its replay (board scores, daily charts, dans; Ranked when it comes) is read for signs
// of a bot or edited numbers. It starts watching only: it posts in #moderator-only what it would do and changes nothing.
// Once Senterra or Octive switch bans on (account/mod/anticheat), one sign holds the play back (it doesn't count) and
// clear proof bans the account: two strong signs in one play, or the same strong sign on 3 plays. Players they mark as
// trusted are never held back or banned by it (their alerts still post, marked trusted). Only plays sent after it was
// added are checked. A ban goes in the moderators' list, so Unban in the player pop-up undoes it.
const AC_CONFIG = "anticheat/config.json", AC_TRUSTED = "anticheat/trusted.json";
const acPlayerKey = (id) => `anticheat/players/${id}.json`;

/** The signs in one judged play. A strong sign is a ban when it comes with another, or on a third play. */
function cheatSigns(result, claimed) {
  const signs = [];
  if (claimed) {
    const s = Number(claimed.score), a = Number(claimed.accuracy);
    // games before 2.1.1 send the old score out of 1,000,000: it's checked against that one
    if ((Number.isFinite(s) && s > Math.max(result.score, result.oldScore || 0) + 5000) || (Number.isFinite(a) && a > result.accuracy + 0.5))
      signs.push({ id: "numbers", strong: true, text: `the game sent ${Number.isFinite(s) ? Math.round(s) + " / " : ""}${Number.isFinite(a) ? a.toFixed(2) + "%" : "?"}, its replay gives ${result.score} / ${result.accuracy.toFixed(2)}%` });
  }
  if (result.hits >= 100 && result.stdMs < 3)
    signs.push({ id: "tight", strong: true, text: `hit timing spread ${result.stdMs.toFixed(2)} ms over ${result.hits} hits (people drift by several ms)` });
  if (result.hits >= 100 && result.exactShare >= 0.4)
    signs.push({ id: "dead-on", strong: true, text: `${Math.round(result.exactShare * 100)}% of hits within 1 ms of the note (about 8% for a person)` });
  if (result.presses >= 100 && result.sameHold >= 0.9)
    signs.push({ id: "same-hold", strong: true, text: `${Math.round(result.sameHold * 100)}% of ${result.presses} taps held for exactly ${result.holdMs} ms` });
  if (result.chords >= 50 && result.sameChord >= 0.95)
    signs.push({ id: "same-chord", strong: false, text: `${Math.round(result.sameChord * 100)}% of ${result.chords} chords pressed at the very same instant (cheap keyboards batch keys, so only a supporting sign)` });
  return signs;
}

/**
 * Checks a judged play (see cheatSigns) and acts on it. Watching (the start): posts what it would do in
 * #moderator-only, the play counts. Bans on: one sign holds the play back, proof bans the account (this fails the
 * request, so the play isn't kept). The signs also go in the moderators' flags, as before.
 */
async function judgeFlags(env, playerId, what, result, claimed) {
  const signs = cheatSigns(result, claimed);
  if (!signs.length) return;
  const [cfg, trustedDoc] = await Promise.all([r2json(env, AC_CONFIG, { bans: false }), r2json(env, AC_TRUSTED, { players: {} })]);
  const trusted = !!(trustedDoc.players || {})[playerId];
  // strong signs are counted per player: the same one on a third play is proof
  const strong = signs.filter((s) => s.strong);
  let counts = {}, repeat = false, quiet = false;
  try {
    const now = Date.now(), sigIds = signs.map((s) => s.id).join(",");
    const rec = await r2update(env, acPlayerKey(playerId), () => ({ counts: {}, plays: [] }), (d) => {
      d.counts ||= {}; d.plays ||= [];
      // (2.1.1) the same play sent again (a retry, or a board and a sync at once): counted and posted once, not each time
      repeat = d.plays.some((x) => x.what === what && x.signs?.join(",") === sigIds && now - Date.parse(x.at) < 30 * 60_000);
      if (repeat) return false;
      for (const s of strong) d.counts[s.id] = (d.counts[s.id] || 0) + 1;
      // and at most 6 posts a player an hour: the rest are kept in the record without filling #moderator-only
      quiet = d.plays.filter((x) => now - Date.parse(x.at) < 3_600_000 && x.posted).length >= 6;
      d.plays.push({ at: new Date(now).toISOString(), what, signs: signs.map((s) => s.id), posted: !quiet || undefined });
      if (d.plays.length > 30) d.plays = d.plays.slice(-30);
    });
    counts = rec.counts || {};
  } catch (e) { console.log("anti-cheat record", e && e.message); }
  if (repeat) return;
  for (const s of signs) await flagPlayer(env, playerId, `${what}: ${s.text}`);
  const repeated = strong.find((s) => (counts[s.id] || 0) >= 3);
  const proof = strong.length >= 2 || !!repeated;
  const live = cfg.bans === true && !trusted;
  const name = await displayName(env, playerId).catch(() => playerId);
  const verdict = proof ? (live ? "Banned" : "Would ban") : (live ? "Play held back" : "Would hold the play back");
  if (!quiet || live) await modPost(env, {
    title: `Anti-cheat: ${verdict}${trusted ? " (trusted player: nothing done)" : ""}`,
    color: proof ? 0xFF4D6D : 0xF2C14E,
    description: cfg.bans === true ? "Bans are on." : "Watching only: nothing was done to the player or the play.",
    fields: [
      { name: "Player", value: `${modText(name, 60)} · \`${playerId}\`\n${SITE}#/u/${encodeURIComponent(playerId)}`, inline: false },
      { name: "Play", value: modText(what, 200) || "?", inline: false },
      { name: "Signs", value: signs.map((s) => `${s.strong ? "•" : "◦"} ${s.text}${repeated && s.id === repeated.id ? ` (on ${counts[s.id]} plays now)` : ""}`).join("\n").slice(0, 1000), inline: false },
    ],
    footer: { text: proof ? (repeated && strong.length < 2 ? "Proof: the same sign on 3 plays" : "Proof: two strong signs in one play") : "One sign" },
    timestamp: new Date().toISOString(),
  });
  if (!live) return;
  if (proof) await anticheatBan(env, playerId, name, signs.map((s) => s.text).join("; "));
  fail(409, proof
    ? "This account was banned by OCTIVE's anti-cheat. If you think that's a mistake, ask the moderators on the OCTIVE Discord."
    : "This play was held back for a check by the moderators, so it doesn't count.");
}

/** Bans a player in the moderators' list (so Unban in the player pop-up undoes it), from the anti-cheat. */
async function anticheatBan(env, playerId, name, reason) {
  const cfg = config(env);
  const cur = (await publicItems(cfg, OWNER, ["moderation-mods"]).catch(() => ({})))["moderation-mods"] || {};
  const list = { bans: cur.bans || {}, overrides: cur.overrides || {}, updated: new Date().toISOString() };
  list.bans[playerId] = { name, reason: ("Anti-cheat: " + reason).slice(0, 200), by: "OCTIVE anti-cheat", byId: "anti-cheat", at: new Date().toISOString() };
  await serverWrite(() => saveItem(env, OWNER, "moderation-mods", JSON.stringify(list), true));
  await loadModeration(cfg); moderationAt = Date.now();
  cards.delete(playerId);
}

/** Where Twitch sends players back after signing in (must match the Twitch app's OAuth Redirect URL exactly). */
const twitchRedirect = (request) => new URL(request.url).origin + "/twitch/callback";

// (2.1.1) is a linked channel streaming right now? Twitch's app token (client credentials) and each channel's answer
// are kept a while, so profiles stay quick and Twitch isn't asked on every view.
let twitchApp = null;
const twitchLiveCache = new Map(); // twitch user id -> { at, stream }
async function twitchAppToken(env) {
  if (twitchApp && twitchApp.exp > Date.now() + 60_000) return twitchApp.token;
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }),
  }).then((x) => x.json());
  if (!r || !r.access_token) throw new Error("no Twitch app token");
  twitchApp = { token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
  return twitchApp.token;
}
/** The channel's live stream ({ title, game, viewers, startedAt }) or null; never throws. */
async function twitchLiveOf(env, twitchId) {
  if (!twitchId || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const c = twitchLiveCache.get(twitchId);
  if (c && Date.now() - c.at < 60_000) return c.stream;
  let stream = null;
  try {
    let token = await twitchAppToken(env);
    let res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(twitchId)}`, { headers: { Authorization: "Bearer " + token, "Client-Id": env.TWITCH_CLIENT_ID } });
    if (res.status === 401) { twitchApp = null; token = await twitchAppToken(env); res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(twitchId)}`, { headers: { Authorization: "Bearer " + token, "Client-Id": env.TWITCH_CLIENT_ID } }); }
    const d = await res.json();
    const st = d && Array.isArray(d.data) ? d.data.find((x) => x.type === "live") : null;
    if (st) stream = { title: String(st.title || "").slice(0, 140), game: String(st.game_name || "").slice(0, 60), viewers: Number(st.viewer_count) || 0, startedAt: st.started_at || null };
  } catch (e) { console.log("twitch live", e && e.message); return c ? c.stream : null; }
  twitchLiveCache.set(twitchId, { at: Date.now(), stream });
  if (twitchLiveCache.size > 2000) twitchLiveCache.delete(twitchLiveCache.keys().next().value);
  return stream;
}

/** (2.1.2) Every linked player who is live on Twitch: { playerId: { login, name, title, game, viewers, startedAt } }.
 *  One Twitch call per 100 linked channels, cached a minute; never throws. */
let twitchLiveAllCache = null;
async function twitchLiveAll(env) {
  if (twitchLiveAllCache && Date.now() - twitchLiveAllCache.at < 60_000) return twitchLiveAllCache.map;
  const map = {};
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return map;
  try {
    const ids = []; let cursor;
    do {
      const l = await env.RELEASES.list({ prefix: "twitch/", cursor });
      for (const o of l.objects) { const mm = o.key.match(/^twitch\/(\d+)\.json$/); if (mm) ids.push(mm[1]); }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    let token = await twitchAppToken(env);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const url = "https://api.twitch.tv/helix/streams?first=100&" + chunk.map((x) => "user_id=" + encodeURIComponent(x)).join("&");
      let res = await fetch(url, { headers: { Authorization: "Bearer " + token, "Client-Id": env.TWITCH_CLIENT_ID } });
      if (res.status === 401) { twitchApp = null; token = await twitchAppToken(env); res = await fetch(url, { headers: { Authorization: "Bearer " + token, "Client-Id": env.TWITCH_CLIENT_ID } }); }
      const d = await res.json();
      const live = new Map();
      for (const st of (d && Array.isArray(d.data) ? d.data : [])) if (st.type === "live")
        live.set(String(st.user_id), { title: String(st.title || "").slice(0, 140), game: String(st.game_name || "").slice(0, 60), viewers: Number(st.viewer_count) || 0, startedAt: st.started_at || null });
      for (const tid of chunk) {
        const stream = live.get(tid) || null;
        twitchLiveCache.set(tid, { at: Date.now(), stream }); // the profile's /social reply uses the same answer
        if (!stream) continue;
        const link = await r2json(env, `twitch/${tid}.json`, null).catch(() => null);
        if (!link || !link.playerId) continue;
        const rec = await record(env, link.playerId).catch(() => null);
        if (!rec || !rec.twitch || rec.twitch.id !== tid || (rec.twitchPrefs && rec.twitchPrefs.show === false)) continue;
        map[link.playerId] = { login: rec.twitch.login, name: rec.twitch.name || rec.twitch.login, ...stream };
      }
    }
  } catch (e) { console.log("twitch live all", e && e.message); if (twitchLiveAllCache) return twitchLiveAllCache.map; }
  twitchLiveAllCache = { at: Date.now(), map };
  await twitchAnnounce(env, map).catch((e) => console.log("twitch announce", e && e.message));
  return map;
}

/**
 * (2.1.2) Someone just went live on Twitch: their friends and followers get a notice and it goes in their friends feed,
 * once per stream (keyed by when it started, kept in R2 so every Worker copy agrees).
 */
async function twitchAnnounce(env, map) {
  const fresh = [];
  await r2update(env, "twitch/announced.json", () => ({ live: {} }), (d) => {
    fresh.length = 0;
    const was = d.live || {}, next = {};
    for (const [id, st] of Object.entries(map)) {
      const key = String(st.startedAt || "?");
      next[id] = key;
      if (was[id] === key) continue;
      // found long after it started (the server was down, or this just shipped): no alert for an old stream
      if (st.startedAt && Date.now() - Date.parse(st.startedAt) > 2 * 3_600_000) continue;
      fresh.push(id);
    }
    if (JSON.stringify(was) === JSON.stringify(next)) return false;
    d.live = next;
  });
  for (const id of fresh) {
    const st = map[id];
    if (!st || isOfficial(id) || moderation.bans[id]) continue;
    const name = await rkName(env, id).catch(() => "Player");
    const info = { login: st.login, title: String(st.title || "").slice(0, 140), game: String(st.game || "").slice(0, 60) };
    await addFeed(env, id, { kind: "live", ...info }).catch(() => {});
    // friends (the message server's list) and followers, each once
    const to = new Set();
    try { for (const f of ((await r2json(env, dmInboxKey(id), null)) || {}).friends || []) if (f && okPlayerId(f.id)) to.add(f.id); } catch { /* none */ }
    try { for (const f of (await r2json(env, `followers/${id}.json`, { followers: [] })).followers || []) if (okPlayerId(f)) to.add(f); } catch { /* none */ }
    to.delete(id);
    for (const f of [...to].slice(0, 500)) await addNotice(env, f, { kind: "live", from: id, fromName: name, ...info }).catch(() => {});
  }
}

let modChannel = null, modChannelAt = 0;
/** #moderator-only, the staff's private channel on the OCTIVE Discord: found by name (cached 10 minutes). */
async function modChannelId(env) {
  if (modChannel && Date.now() - modChannelAt < 600_000) return modChannel;
  const list = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  const c = (list || []).find((x) => x.name === "moderator-only" && (x.type === 0 || x.type === 5));
  modChannel = c ? c.id : null; modChannelAt = Date.now();
  return modChannel;
}

/** Posts an embed in #moderator-only (anti-cheat, player reports, trusted marks). Never fails what it's part of. */
async function modPost(env, embed) {
  try {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return false;
    const ch = await modChannelId(env);
    if (!ch) { console.log("moderator post: #moderator-only not found (or the bot can't see it)"); return false; }
    await discordApi(env, "POST", `/channels/${ch}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } });
    return true;
  } catch (e) { console.log("moderator post", e && e.message); return false; }
}

/** Plain words for an embed: no mentions, links or markdown from players' text. */
function modText(v, max) {
  return String(v ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, " ")
    .replace(/<[@#:][^>]*>/g, "").replace(/@(everyone|here)/gi, "$1").replace(/[\[\]<>*_~`|\\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// The same play sent by someone else (a replay passed on or downloaded from a board, its player id changed): the hit
// timing of the plays that count is kept per chart (board scores, daily and dan plays), and a play whose timing
// matches another player's is refused.
const judgeSigKey = async (scope) => `judge/sigs/${(await sha256Hex(scope)).slice(0, 40)}.json`;
/** Another player's play with the same timing on this chart (or, with sameOk false, any earlier one, yours too). */
async function replayCopyOf(env, scope, playerId, sig, sameOk = true) {
  if (!sig) return null;
  const d = await r2json(env, await judgeSigKey(scope), { list: [] });
  return (d.list || []).find((x) => (!sameOk || x.p !== playerId) && signatureMatch(x.s, sig) >= 0.9) || null;
}
/** Keeps a play's timing for a chart: each player's newest few (on a board: their score and the ones it replaced). */
async function rememberReplay(env, scope, playerId, sig, perPlayer = 3) {
  if (!sig) return;
  await r2update(env, await judgeSigKey(scope), () => ({ list: [] }), (d) => {
    d.list = d.list || [];
    if (d.list.some((x) => x.p === playerId && x.s === sig)) return false;
    const theirs = d.list.filter((x) => x.p === playerId);
    if (theirs.length >= perPlayer) { const old = new Set(theirs.slice(0, theirs.length - perPlayer + 1)); d.list = d.list.filter((x) => !old.has(x)); }
    d.list.push({ p: playerId, s: sig, at: new Date().toISOString() });
    if (d.list.length > 600) d.list = d.list.slice(-600);
  }).catch((e) => console.log("replay timing", e && e.message));
}
async function refuseCopies(env, scope, who, result, sameOk = true) {
  const copy = await replayCopyOf(env, scope, who.playerId, result.signature, sameOk);
  if (!copy) return;
  if (copy.p !== who.playerId) await flagPlayer(env, who.playerId, `sent a replay with the same timing as ${copy.p}'s (${scope})`);
  fail(409, copy.p === who.playerId ? "That replay was already used." : "That replay is a copy of another player's play, so it doesn't count.");
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

/**
 * What a file holds, for the Workshop's details: a song's title, artist, bpm, length, osu! set and every
 * difficulty (name, keys, stars, notes, charter); a skin's or style's lock (customizable or not).
 */
async function wsMeta(kind, u8) {
  try {
    if (kind === "charts") {
      const entries = zipEntries(u8);
      const man = entries.find((e) => e.name.toLowerCase() === "manifest.json");
      if (!man) return null;
      const m = JSON.parse(new TextDecoder().decode(await zipRead(u8, man, 4 * 1048576)));
      const tags = Array.isArray(m.song?.tags) ? m.song.tags : [];
      const set = tags.map((t) => /^osu-set:(\d+)$/i.exec(String(t))).find(Boolean);
      const src = (Array.isArray(m.charts) ? m.charts : []).slice(0, 60);
      const out = {
        songId: String(m.songId || "").slice(0, 100) || null, title: String(m.song?.title || "").slice(0, 160), artist: String(m.song?.artist || "").slice(0, 160),
        bpm: Number(m.song?.bpm) || 0, durationUs: Number(m.song?.durationUs) || 0, osuSet: set ? Number(set[1]) : 0,
        charts: src.map((c) => ({
          difficulty: String(c.difficulty || "").slice(0, 100), keys: Number(c.keyCount) || 0, stars: Math.round((Number(c.rating) || 0) * 100) / 100,
          notes: Number(c.noteCount) || 0, creator: String(c.creator || "").slice(0, 60),
          // the chart's own id, and (charts from osu!) its .osu file's MD5: what the verified-copy check compares
          chartId: typeof c.chartId === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(c.chartId) ? c.chartId : undefined,
          osuMd5: typeof c.osuMd5 === "string" && /^[0-9a-f]{32}$/i.test(c.osuMd5) ? c.osuMd5.toLowerCase() : undefined,
          od: Number.isFinite(Number(c.od)) && c.od !== null && Number(c.od) >= 0 && Number(c.od) <= 10 ? Number(c.od) : undefined,
        })),
      };
      // each chart's shape (its length, long notes, density and pattern tags), worked out from its notes
      const byName = new Map(entries.map((e) => [e.name.split(BACKSLASH).join("/").toLowerCase(), e]));
      for (let i = 0; i < src.length; i++) {
        try {
          const e = byName.get(String(src[i]?.file || "").split(BACKSLASH).join("/").toLowerCase());
          const bytes = e ? await zipRead(u8, e, 16 * 1048576) : null;
          if (!bytes) continue;
          const text = new TextDecoder().decode(bytes);
          const st = chartStats(compileChart(loadChart(text)));
          st.mc = hasModchart(text) ? 1 : 0; // (2.0.1)
          st.sv = hasSv(text); // (2.0.2)
          if (st.mc) st.tags = [...st.tags, "modchart"];
          if (st.sv) st.tags = [...st.tags, "sv"];
          setChartShape(out.charts[i], st);
        } catch { /* left without: filled in later by fillChartShapes */ }
      }
      if (!(out.durationUs > 0)) out.durationUs = Math.round(Math.max(0, ...out.charts.map((c) => c.len || 0)) * 1e6);
      return out;
    }
    if (kind === "skins") {
      const entries = zipEntries(u8);
      const sk = entries.find((e) => e.name.toLowerCase() === "skin.json");
      if (!sk) return null;
      const m = JSON.parse(new TextDecoder().decode(await zipRead(u8, sk, 4 * 1048576)));
      return { name: String(m.name || "").slice(0, 100), author: String(m.author || "").slice(0, 60), locked: !!m.locked };
    }
    if (kind === "styles") {
      const o = JSON.parse(new TextDecoder().decode(u8));
      let locked = false;
      if (typeof o.skin === "string" && o.skin.length < 60_000_000) {
        try {
          const bin = Uint8Array.from(atob(o.skin), (c) => c.charCodeAt(0));
          const sk = zipEntries(bin).find((e) => e.name.toLowerCase() === "skin.json");
          if (sk) locked = !!JSON.parse(new TextDecoder().decode(await zipRead(bin, sk, 4 * 1048576))).locked;
        } catch { /* not readable */ }
      }
      return { name: String(o.name || "").slice(0, 100), locked };
    }
  } catch { /* nothing readable */ }
  return null;
}

const bytesHash = async (u8) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", u8))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** An upload that's already in the Workshop (the same file, or the same song): it, or null. */
function wsDuplicate(items, hashes, songIds, exceptId) {
  for (const x of items) {
    if (x.removed || x.id === exceptId) continue;
    if ((x.hashes || []).some((h) => hashes.includes(h))) return x;
    if (songIds.length && (x.songIds || []).some((sid) => songIds.includes(sid))) return x;
  }
  return null;
}

/**
 * What makes two charts the same map: the same chart file (its id), the same osu! difficulty file (MD5), or the
 * same song (title and artist), difficulty name, note count and keys.
 */
const wsNorm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function wsChartKeys(song, c) {
  const keys = [];
  if (c.chartId) keys.push("id:" + c.chartId);
  if (c.osuMd5) keys.push("md5:" + String(c.osuMd5).toLowerCase());
  const t = wsNorm(song.title), d = wsNorm(c.difficulty);
  if (t && d && Number(c.notes) > 0) keys.push(`n:${t}|${wsNorm(song.artist)}|${d}|${Number(c.notes)}|${Number(c.keys) || 0}`);
  return keys;
}

/**
 * An upload that already has every chart of one of these songs: a re-upload of a map that's in the Workshop (a fresh
 * osu! import of it gets a new song id and file, so the file check doesn't catch it), or null. A song with any new
 * difficulty isn't a re-upload.
 */
function wsSameCharts(items, songs, keep) {
  const index = new Map();
  for (const x of items) {
    if (x.removed || x.type !== "charts" || (keep && !keep(x))) continue;
    for (const sg of (x.meta && x.meta.songs) || []) for (const c of sg.charts || []) for (const k of wsChartKeys(sg, c)) if (!index.has(k)) index.set(k, x);
  }
  if (!index.size) return null;
  for (const sg of songs || []) {
    const charts = (sg && sg.charts) || [];
    if (!charts.length) continue;
    let hit = null, all = true;
    for (const c of charts) {
      const found = wsChartKeys(sg, c).map((k) => index.get(k)).find(Boolean);
      if (!found) { all = false; break; }
      hit = hit || found;
    }
    if (all && hit) return hit;
  }
  return null;
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


// ================================================================ the daily chart, points, the points shop, dans
// R2: daily/<YYYY-MM-DD>.json   the day's chart (picked once, from verified Workshop songs) and its scores
//     points/<playerId>.json   { balance, earned, streak, bestStreak, lastDay, freezes, owned, equipped, showcase, dans, attempts, history }
//     cosmetics/index.json     { players: { <id>: { title, frame, icon, showcase, dan, dans } } }  (what others see)
// Everything is decided here: the chart, the one attempt, the accuracy (from the judgement counts) and the points.
const ACC_WEIGHTS = [100, 98, 70, 40, 10, 0];
const DAILY_REPLAY_GAME = "1.6.6"; // the first game that sends its daily and dan plays' replays (they're judged here)
const DAN_CLEAR_ACC = 96; // a dan counts as cleared at this accuracy or more, with no mods (90 until 1.6.6: those clears stay)
// players who can mark dans besides Senterra, Octive and charters (lego1027)
const DAN_MARKERS = ["u0bAhHr7LjswtFU4NB03XZcuUCOG"];
const DAN_LEVELS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
const COSMETICS_KEY = "cosmetics/index.json";
const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const okPlayerId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

// The shop: cosmetics only (nothing changes scores, PR or rankings). "from"/"to" make seasonal items.
const ICON_COLORS = [["gold", "Gold", "#FFC94D"], ["pink", "Pink", "#FF6FB5"], ["hotpink", "Hot pink", "#FF4FA3"], ["red", "Red", "#FF4D6D"],
  ["orange", "Orange", "#FF6A3D"], ["amber", "Amber", "#FFB84F"], ["lime", "Lime", "#A6FF3D"], ["mint", "Mint", "#39FFB0"], ["teal", "Teal", "#3FE0C5"],
  ["cyan", "Cyan", "#3FD8FF"], ["sky", "Sky", "#3FA9FF"], ["purple", "Purple", "#A77BFF"], ["silver", "Silver", "#CFD8E3"]];
/** Icons from before colours were separate: what each became (its shape and its colour). */
const ICONS_V2 = { "icon-purple-star": ["icon-star", "iconcolor-purple"], "icon-red-heart": ["icon-heart", "iconcolor-red"], "icon-mint-note": ["icon-note", "iconcolor-mint"],
  "icon-gold-shield": ["icon-shield", "iconcolor-gold"], "icon-cyan-star": ["icon-star", "iconcolor-cyan"], "icon-ember-star": ["icon-star", "iconcolor-orange"] };
/** The colour each kept icon used to have (its owners get it free, so their icon looks the same). */
const ICON_GIVEN_COLOR = { "icon-star": "iconcolor-gold", "icon-heart": "iconcolor-pink", "icon-note": "iconcolor-cyan", "icon-shield": "iconcolor-silver",
  "icon-tapnote": "iconcolor-hotpink", "icon-holdnote": "iconcolor-sky", "icon-keyboard": "iconcolor-silver", "icon-mic": "iconcolor-amber", "icon-palette": "iconcolor-purple", "icon-globe": "iconcolor-teal" };
/** A cosmetics entry from before the change, read as the new kind (players who haven't been back yet). */
function iconsV2Entry(e) {
  if (!e || !e.icon) return e;
  if (ICONS_V2[e.icon]) return { ...e, icon: ICONS_V2[e.icon][0], iconColor: e.iconColor || ICONS_V2[e.icon][1] };
  if (!e.iconColor && !e.iconsV2 && ICON_GIVEN_COLOR[e.icon]) return { ...e, iconColor: ICON_GIVEN_COLOR[e.icon] };
  return e;
}

const SHOP = [
  ...[["daily-grinder", "Daily Grinder"], ["jack-enjoyer", "Jack Enjoyer"], ["stream-machine", "Stream Machine"], ["ln-lover", "LN Lover"],
     ["chordjack-menace", "Chordjack Menace"], ["sv-survivor", "SV Survivor"], ["night-owl", "Night Owl"], ["speed-demon", "Speed Demon"],
     ["perfectionist", "Perfectionist"], ["rhythm-addict", "Rhythm Addict"], ["tech-wizard", "Tech Wizard"], ["stamina-beast", "Stamina Beast"],
     ["full-combo-hunter", "Full Combo Hunter"], ["marvelous-maniac", "Marvelous Maniac"], ["key-smasher", "Key Smasher"], ["hold-the-line", "Hold the Line"],
     ["jumpstream-junkie", "Jumpstream Junkie"], ["handstream-hero", "Handstream Hero"], ["trill-master", "Trill Master"], ["vibro-victim", "Vibro Victim"],
     ["rate-abuser", "Rate Abuser"], ["sight-reader", "Sight Reader"], ["chart-crafter", "Chart Crafter"], ["workshop-regular", "Workshop Regular"],
     ["daily-devotee", "Daily Devotee"], ["streak-keeper", "Streak Keeper"], ["early-bird", "Early Bird"], ["one-more-try", "One More Try"],
     ["accuracy-addict", "Accuracy Addict"], ["miss-magnet", "Miss Magnet"], ["note-chaser", "Note Chaser"], ["beat-breaker", "Beat Breaker"],
     ["vsrg-veteran", "VSRG Veteran"], ["4k-specialist", "4K Specialist"], ["7k-enjoyer", "7K Enjoyer"], ["osu-refugee", "osu! Refugee"],
     ["dan-addict", "Dan Addict"]]
    .map(([id, name]) => ({ id: "title-" + id, kind: "title", name, price: 300 })),
  ...[["legend", "Legend"], ["unstoppable", "Unstoppable"], ["rhythm-royalty", "Rhythm Royalty"], ["the-one", "The One"], ["beyond-human", "Beyond Human"], ["octive-elite", "OCTIVE Elite"]]
    .map(([id, name]) => ({ id: "title-" + id, kind: "title", name, price: 1500 })),
  ...[["gold", "Gold", "#FFC94D", 500], ["silver", "Silver", "#CFD8E3", 500], ["neon", "Neon", "#39FFB0", 800], ["sakura", "Sakura", "#FF9EC7", 800],
     ["ocean", "Ocean", "#3FA9FF", 800], ["ember", "Ember", "#FF6A3D", 1000], ["void", "Void", "#8A5CFF", 1000], ["diamond", "Diamond", "#B9F2FF", 1500],
     ["bronze", "Bronze", "#CD7F32", 500], ["rose", "Rose", "#FF5C8A", 600], ["lemon", "Lemon", "#FFF06B", 600], ["lavender", "Lavender", "#C3A6FF", 600],
     ["peach", "Peach", "#FFB38A", 600], ["lime", "Lime", "#A6FF3D", 700], ["crimson", "Crimson", "#E0193A", 800], ["cobalt", "Cobalt", "#2F5BFF", 800],
     ["emerald", "Emerald", "#1FCB76", 800], ["obsidian", "Obsidian", "#2A2A33", 900], ["ivory", "Ivory", "#FFF8E7", 900]]
    .map(([id, name, color, price]) => ({ id: "frame-" + id, kind: "frame", name: name + " frame", color, price })),
  ...[["rainbow", "Rainbow", "rainbow", "#FF4FA3"], ["pulse", "Pulse", "pulse", "#FF4FA3"], ["aurora", "Aurora", "aurora", "#3FE0C5"],
     ["pulse-gold", "Golden pulse", "pulse", "#FFC94D"], ["pulse-ice", "Ice pulse", "pulse", "#8FE8FF"], ["pulse-toxic", "Toxic pulse", "pulse", "#7CFF3D"], ["pulse-blood", "Blood pulse", "pulse", "#E0193A"]]
    .map(([id, name, anim, color]) => ({ id: "frame-" + id, kind: "frame", name: name + " frame (animated)", color, anim, price: 3000 })),
  // two colours that flow into each other (OCTIVE 1.6.2; older versions pulse the first colour)
  ...[["sunset", "Sunset", "#FF6A3D", "#FF4FA3"], ["ocean-deep", "Deep ocean", "#2E7BFF", "#3FE0C5"], ["galaxy", "Galaxy", "#8A5CFF", "#FF4FA3"],
     ["fire", "Fire", "#FF2E00", "#FFC94D"], ["frost", "Frost", "#8FE8FF", "#FFFFFF"], ["forest", "Forest", "#1FCB76", "#A6FF3D"],
     ["candy", "Candy", "#FF8AD8", "#8FD3FF"], ["midnight", "Midnight", "#1B1F5E", "#8A5CFF"], ["neon-nights", "Neon nights", "#39FFB0", "#FF4FA3"]]
    .map(([id, name, color, color2]) => ({ id: "frame-" + id, kind: "frame", name: name + " frame (animated)", color, color2, anim: "duo", price: 4000, minVersion: "1.6.2" })),
  // leaderboard icons: shapes, all the same price, white unless an icon colour is on
  ...[["star", "Star", "star"], ["heart", "Heart", "heart"], ["note", "Music note", "note"], ["shield", "Shield", "shield"]]
    .map(([id, name, shape]) => ({ id: "icon-" + id, kind: "icon", name, shape, color: "#FFFFFF", price: 800 })),
  // newer shapes (OCTIVE 1.6.2 draws them; older versions show a star)
  ...[["tapnote", "Tap note", "tapnote"], ["holdnote", "Hold note", "holdnote"], ["keyboard", "Keyboard", "keyboard"],
     ["mic", "Microphone", "mic"], ["palette", "Palette", "palette"], ["globe", "Globe", "globe"]]
    .map(([id, name, shape]) => ({ id: "icon-" + id, kind: "icon", name, shape, color: "#FFFFFF", price: 800, minVersion: "1.6.2" })),
  // icon colours: one at a time, on whichever icon you have on
  ...ICON_COLORS.map(([id, name, color]) => ({ id: "iconcolor-" + id, kind: "iconcolor", name: name + " icon colour", color, price: 200, minVersion: "1.6.2" })),
  { id: "iconcolor-rainbow", kind: "iconcolor", name: "Rainbow icon colour", color: "#FF4FA3", anim: "rainbow", price: 600, note: "Your icon cycles through every colour", minVersion: "1.6.2" },
  { id: "title-color", kind: "titlecolor", name: "Title colour customizer", price: 600, note: "Pick any colour for your profile title (from Your items on your profile)", minVersion: "1.6.2" },
  { id: "title-rainbow", kind: "titlerainbow", name: "Rainbow title", price: 2500, note: "Your profile title cycles through every colour", minVersion: "1.6.2" },
  { id: "streak-freeze", kind: "freeze", name: "Streak freeze", price: 400, note: "Covers one missed daily chart (hold up to 2)" },
  { id: "showcase", kind: "showcase", name: "Profile showcase", price: 1000, note: "Pin up to 3 of your best plays or achievements to your profile" },
  { id: "spotlight", kind: "spotlight", name: "Workshop spotlight", price: 2000, note: "One of your uploads at the top of the Workshop for 24 hours", noGift: true },
  { id: "supporter-month", kind: "supporter", name: "1 month of OCTIVE Supporter", price: 15000 },
];
// ---- supporters: 3x the points from the daily charts, and 10% off in the shop (gifts too)
const SUPPORTER_DAILY_MULT = 3, SUPPORTER_DISCOUNT = 10;
async function isSupporterNow(env, id) {
  if (LIFETIME_SUPPORTERS.includes(id)) return true;
  try {
    const [rec, boost] = await Promise.all([r2json(env, `supporters/${id}.json`, null), r2json(env, `boosters/${id}.json`, null)]);
    return !!supportStatus(rec, id, boost).active;
  } catch { return false; }
}
/** What an item costs this player (supporters: 10% off, rounded). */
const shopPriceFor = (item, supporter) => supporter ? Math.round(item.price * (100 - SUPPORTER_DISCOUNT) / 100) : item.price;

/** Items taken out of the shop, with what they cost: owners get the points back (retireItems). */
const RETIRED = { "frame-amethyst": 800, "frame-sapphire": 1200, "frame-ruby": 1200, "frame-topaz": 1200, "frame-onyx": 1200, "frame-pearl": 1500,
  "frame-platinum": 2000, "frame-sky": 600, "frame-mint": 600, "frame-lava": 4000 };
const OWNABLE = ["title", "frame", "icon", "iconcolor", "showcase", "titlecolor", "titlerainbow"];
async function retireItems(env, id) {
  let cur = await walletOf(env, id);
  // Senterra and the official account: everything in the shop is theirs
  if (infinitePoints(id)) {
    const all = SHOP.filter((x) => OWNABLE.includes(x.kind) && shopActive(x) && !x.reward).map((x) => x.id); // (Ranked's season rewards are earned)
    if (all.some((x) => !(cur.owned || []).includes(x))) {
      cur = (await walletUpdate(env, id, (w) => { for (const x of all) if (!w.owned.includes(x)) w.owned.push(x); })) || cur;
      await writeCosmetics(env, id, cur);
    }
  }
  // icons became shapes + colours: what you had looks the same (the shape, its colour for free, still on)
  if (!cur.iconsV2 && (cur.owned || []).some((x) => x.startsWith("icon-"))) {
    cur = (await walletUpdate(env, id, (w) => {
      if (w.iconsV2) return false;
      const add = new Set();
      w.owned = w.owned.filter((x) => { const m = ICONS_V2[x]; if (m) { add.add(m[0]); add.add(m[1]); return false; } if (ICON_GIVEN_COLOR[x]) add.add(ICON_GIVEN_COLOR[x]); return true; });
      for (const x of add) if (!w.owned.includes(x)) w.owned.push(x);
      const on = w.equipped.icon;
      if (on && ICONS_V2[on]) { w.equipped.icon = ICONS_V2[on][0]; w.equipped.iconColor = ICONS_V2[on][1]; }
      else if (on && ICON_GIVEN_COLOR[on] && !w.equipped.iconColor) w.equipped.iconColor = ICON_GIVEN_COLOR[on];
      w.iconsV2 = true;
    })) || cur;
    await writeCosmetics(env, id, cur);
  }
  if (!(cur.owned || []).some((x) => x in RETIRED)) return cur;
  const free = infinitePoints(id);
  const w = await walletUpdate(env, id, (w) => {
    const gone = w.owned.filter((x) => x in RETIRED);
    if (!gone.length) return false;
    w.owned = w.owned.filter((x) => !(x in RETIRED));
    for (const slot of Object.keys(w.equipped || {})) if (w.equipped[slot] in RETIRED) delete w.equipped[slot];
    for (const x of gone) { if (!free) w.balance = (w.balance || 0) + RETIRED[x]; remember(w, { kind: "refund", item: x, price: RETIRED[x] }); }
  });
  if (w) await writeCosmetics(env, id, w);
  return w || cur;
}
const shopActive = (x, now = Date.now()) => (!x.from || Date.parse(x.from) <= now) && (!x.to || Date.parse(x.to) > now);
const shopItem = (id) => SHOP.find((x) => x.id === id && shopActive(x));
/** "1.6.10" > "1.6.2" (missing parts are 0; anything unreadable is 0.0.0). */
function versionAtLeast(have, want) {
  const a = String(have || "").split(/[.-]/).map((x) => parseInt(x, 10) || 0), b = String(want || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}
/** Items a game of that version can show and use (?v= from 1.6.2; older games send none). The website sees everything (all=1). */
/** Titles A to Z (everything else stays where it is in the list). */
function titlesAtoZ(list) {
  const titles = list.filter((x) => x.kind === "title").sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  let i = 0;
  return list.map((x) => (x.kind === "title" ? titles[i++] : x));
}
const shopFor = (url) => {
  rkEnsureRewardItems(); ensureSeasonCollections();
  if (url.searchParams.get("all") === "1") return titlesAtoZ(SHOP.filter((x) => shopActive(x) && !x.reward));
  const v = url.searchParams.get("v"), now = Date.now();
  // past seasons' collections stay in the game's list (their owners can still see and use them), not for sale
  return titlesAtoZ(SHOP.filter((x) => (!x.minVersion || versionAtLeast(v, x.minVersion)) && (shopActive(x, now) || (x.collection != null && Date.parse(x.from) <= now)))
    .map((x) => (x.collection != null && !shopActive(x, now) ? { ...x, reward: true, note: `Season ${x.collection} collection (no longer in the shop)` } : x)));
};

const newWallet = () => ({ balance: 0, earned: 0, streak: 0, bestStreak: 0, lastDay: null, freezes: 0, owned: [], equipped: {}, showcase: [], dans: {}, attempts: {}, history: [] });
async function walletOf(env, id) { return { ...newWallet(), ...(await r2json(env, `points/${id}.json`, null) || {}) }; }
/** Changes a wallet safely (another change at the same time is retried); change returns false to cancel. */
async function walletUpdate(env, id, change) {
  let out = null;
  await r2update(env, `points/${id}.json`, newWallet, (w) => { Object.assign(w, { ...newWallet(), ...w }); const r = change(w); if (r === false) return false; out = w; });
  return out;
}
const remember = (w, entry) => { w.history = [{ ...entry, at: new Date().toISOString() }, ...(w.history || [])].slice(0, 60); };
const infinitePoints = (id) => id === OWNER || isOfficial(id);
function walletPublic(w, id) {
  return { infinite: id ? infinitePoints(id) || undefined : undefined, balance: w.balance, earned: w.earned, streak: w.streak, bestStreak: w.bestStreak, lastDay: w.lastDay, freezes: w.freezes, owned: w.owned, equipped: w.equipped, showcase: showcasePoints(w.showcase), dans: w.dans, history: (w.history || []).slice(0, 30) };
}

let cosmeticsCache = null, cosmeticsAt = 0;
/** A player's highest dan, and the clear of it with the best accuracy: the song it was played on (null: none cleared). */
function highestDanClear(w) {
  let best = null, bi = -1;
  for (const d of Object.values(w.dans || {})) {
    const i = DAN_LEVELS.indexOf(d && d.level);
    if (i < 0) continue;
    if (i > bi || (i === bi && (Number(d.acc) || 0) > (Number(best.acc) || 0))) { best = d; bi = i; }
  }
  return best ? { level: DAN_LEVELS[bi], d: best } : null;
}
/** What others see of that clear: the song (its title and difficulty) and the accuracy. */
function danClearPublic(d) {
  const title = String((d && d.title) || "").slice(0, 80), difficulty = String((d && d.difficulty) || "").slice(0, 60);
  if (!title && !difficulty) return undefined;
  const acc = Number(d.acc);
  return { title: title || undefined, difficulty: difficulty || undefined, acc: Number.isFinite(acc) ? Math.round(acc * 100) / 100 : undefined };
}
async function writeCosmetics(env, id, w) {
  const hd = highestDanClear(w);
  const best = hd ? DAN_LEVELS.indexOf(hd.level) : -1;
  const e = { title: w.equipped.title || undefined, frame: w.equipped.frame || undefined, icon: w.equipped.icon || undefined, titleColor: w.equipped.titleColor || undefined, iconColor: w.equipped.iconColor || undefined, iconsV2: w.iconsV2 || undefined, hasShowcase: (w.owned || []).includes("showcase") || undefined,
    showcase: (w.showcase || []).length ? showcasePoints(w.showcase) : undefined, dan: best >= 0 ? DAN_LEVELS[best] : undefined, danClear: hd ? danClearPublic(hd.d) : undefined, dans: Object.keys(w.dans || {}).length || undefined,
    crew: w.crew && w.crew.id ? { id: w.crew.id, tag: w.crew.tag, color: w.crew.color } : undefined };
  const empty = Object.values(e).every((v) => v === undefined);
  await r2update(env, COSMETICS_KEY, () => ({ players: {} }), (d) => { d.players ||= {}; if (empty) delete d.players[id]; else d.players[id] = e; });
  cosmeticsCache = null;
}
/** Once: the song each player's highest dan was cleared on, for everyone who cleared it before that was kept. */
async function backfillDanClears(env, doc) {
  const ids = Object.entries(doc.players || {}).filter(([, e]) => e && e.dan && !e.danClear).map(([id]) => id);
  const found = {};
  for (let i = 0; i < ids.length; i += 10)
    await Promise.all(ids.slice(i, i + 10).map(async (id) => {
      const hd = highestDanClear(await walletOf(env, id));
      const pub = hd && danClearPublic(hd.d);
      if (pub) found[id] = { level: hd.level, pub };
    }));
  return r2update(env, COSMETICS_KEY, () => ({ players: {} }), (d) => {
    d.players ||= {};
    for (const [id, f] of Object.entries(found)) { const e = d.players[id]; if (e && e.dan === f.level && !e.danClear) e.danClear = f.pub; }
    d.danClears = 1;
  });
}

/** The daily charts: Easy, Normal, Hard and Extreme (4K only, by stars), with what each is worth (× the accuracy). */
const DAILY_TIERS = [
  { tier: "easy", name: "Easy", min: 2, max: 3.9, factor: 0.5 },
  { tier: "normal", name: "Normal", min: 3.91, max: 5.5, factor: 1 },
  { tier: "hard", name: "Hard", min: 5.51, max: 7.5, factor: 2 },
  { tier: "extreme", name: "Extreme", min: 7.51, max: 10, factor: 3 }, // triple Normal (1.6.6)
];
const dailyTier = (t) => DAILY_TIERS.find((x) => x.tier === t);
/** The wallet key of an attempt at one of a day's charts (a re-picked day has its own). */
const attemptKey = (d, date, tier) => {
  const r = (d && d.charts && d.charts[tier] && d.charts[tier].rev) || (d && d.rev);
  return r ? `${date}:${tier}:${r}` : `${date}:${tier}`;
};
/** Points for a daily play: the accuracy rounded down (99.7% = 99), halved for Easy, doubled for Hard, tripled for Extreme. */
const dailyPoints = (acc, tier) => Math.max(0, Math.floor(Math.floor(acc + 1e-9) * tier.factor));

/** Every 4K chart of a verified community song (not dans, never OCTIVE's own), in a fixed order: what dailies are picked from. */
function dailyPool(db) {
  const all = [];
  for (const it of (db.items || []).filter((x) => x.type === "charts" && x.verified && !x.builtin && !x.removed && !x.dan && x.meta).sort((x, y) => String(x.id).localeCompare(String(y.id))))
    for (const sg of it.meta.songs || []) for (const c of sg.charts || [])
      if (c.keys === 4 && c.notes > 0 && sg.songId && !officialSong(sg.songId) && !(it.dans || []).some((d) => d.songId === sg.songId && d.difficulty === c.difficulty)) all.push({ it, sg, c });
  return all;
}

/** A tier's chart for a day (the same for everyone: picked by the date), or null when no chart fits its stars. */
function dailyPickFor(all, date, t) {
  const pool = all.filter((x) => x.c.stars >= t.min && x.c.stars <= t.max);
  if (!pool.length) return null;
  let h = 2166136261; for (const ch of `octive-daily-${date}-${t.tier}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const { it, sg, c } = pool[h % pool.length];
  return { tier: t.tier, name: t.name, maxPoints: Math.floor(100 * t.factor), itemId: it.id, songId: sg.songId, osuSet: sg.osuSet || undefined, title: sg.title || it.title, artist: sg.artist || "",
    difficulty: c.difficulty, keys: c.keys, stars: c.stars, notes: c.notes, durationUs: sg.durationUs || 0, creator: it.creator, scores: [] };
}

/** The day's charts: picked once from the verified Workshop songs (the same for everyone), then kept. */
async function dailyOf(env, date) {
  const key = `daily/${date}.json`;
  const have = await r2json(env, key, null);
  // a day picked before OCTIVE's own songs were left out is picked again (its old picks are kept in it)
  const stale = (d) => d && d.charts && Object.values(d.charts).some((c) => officialSong(c.songId));
  if (have && have.charts && !stale(have)) {
    // a tier added after the day was picked (Extreme, 1.6.6): picked once, the day's other charts stay as they are
    const missing = DAILY_TIERS.filter((t) => !have.charts[t.tier] && !(have.added || []).includes(t.tier));
    // a chart picked with older star ranges that doesn't fit its tier any more: that tier is picked again (once), with
    // its own attempts and board; the tiers that still fit keep theirs
    const fits = (c, t) => c && Number(c.stars) >= t.min && Number(c.stars) <= t.max;
    const misfit = DAILY_TIERS.filter((t) => have.charts[t.tier] && !fits(have.charts[t.tier], t) && !(have.refit || []).includes(t.tier));
    if (!missing.length && !misfit.length) return have;
    const db = await r2json(env, WS_DB, { items: [] });
    const all = dailyPool(db);
    let repicked = [];
    await r2update(env, key, () => ({}), (d) => {
      repicked = [];
      if (!d || !d.charts) return false;
      d.added = d.added || [];
      for (const t of missing) {
        if (d.charts[t.tier] || d.added.includes(t.tier)) continue;
        const c = dailyPickFor(all, date, t);
        if (c) d.charts[t.tier] = c;
        d.added.push(t.tier); // tried once (a tier with no chart that fits isn't looked for again today)
      }
      d.refit = d.refit || [];
      for (const t of misfit) {
        if (d.refit.includes(t.tier) || fits(d.charts[t.tier], t)) continue;
        d.refit.push(t.tier);
        const c = dailyPickFor(all, date, t);
        if (!c) continue; // nothing fits: the old pick stays for today
        c.rev = Date.now();
        d.replacedTiers = d.replacedTiers || {};
        d.replacedTiers[t.tier] = { ...d.charts[t.tier], scores: undefined };
        d.charts[t.tier] = c;
        repicked.push([t, c]);
      }
    }).catch((e) => console.log("daily tier", e && e.message));
    // the uploaders of the new picks are told
    for (const [t, c] of repicked) {
      const it = (db.items || []).find((x) => x.id === c.itemId);
      if (it && it.creatorId) await addNotice(env, it.creatorId, { kind: "daily-pick", date, tier: t.tier, tierName: t.name, itemId: c.itemId, songId: c.songId, title: c.title, difficulty: c.difficulty }).catch(() => {});
    }
    const saved = await r2json(env, key, null);
    return saved && saved.charts ? saved : have;
  }
  const db = await r2json(env, WS_DB, { items: [] });
  const all = dailyPool(db);
  const charts = {};
  for (const t of DAILY_TIERS) {
    const c = dailyPickFor(all, date, t);
    if (c) charts[t.tier] = c;
  }
  // rev: this pick's own id, so attempts at an older pick of the same day don't count against it
  const pick = { date, charts, rev: Date.now() };
  if (stale(have)) pick.replaced = have.charts;
  // kept on the first look of the day (an older one-chart day is replaced)
  let wrote = false;
  const kept = await r2update(env, key, () => ({}), (d) => { wrote = false; if (d && d.charts && !stale(d)) return false; for (const k of Object.keys(d)) delete d[k]; Object.assign(d, pick); wrote = true; })
    .then(() => wrote, () => false);
  // this look picked the day: the uploaders of its charts are told
  if (kept)
    for (const t of DAILY_TIERS) {
      const c = charts[t.tier];
      const it = c && (db.items || []).find((x) => x.id === c.itemId);
      if (!it || !it.creatorId) continue;
      await addNotice(env, it.creatorId, { kind: "daily-pick", date, tier: t.tier, tierName: t.name, itemId: c.itemId, songId: c.songId, title: c.title, difficulty: c.difficulty })
        .catch((e) => console.log("notice", e && e.message));
    }
  const saved = await r2json(env, key, null);
  return saved && saved.charts ? saved : pick;
}

// ---- dans from any copy. A dan is marked on one upload's song, but players may have the same chart from another upload
// or from their own osu! import. A song's id is its artist and title plus a random end ("...-staminamap-pack-5279c3"),
// and an osu! import's board id names its beatmap set ("osu-611978"): so a dan is found by its exact song, by its song
// id without that end, or by its osu! set, each with the difficulty's name. Clears are kept under the marked song.
let danIdx = null, danIdxAt = 0;
const songSlug = (id) => String(id || "").replace(/-[0-9a-f]{6}$/, "");
async function danIndex(env) {
  if (danIdx && Date.now() - danIdxAt < 60_000) return danIdx;
  const db = await r2json(env, WS_DB, { items: [] });
  const idx = new Map();
  for (const it of (db.items || []).filter((x) => !x.removed && Array.isArray(x.dans))) {
    const songs = (it.meta && it.meta.songs) || [];
    for (const d of it.dans) {
      const song = songs.find((x) => x.songId === d.songId);
      const chart = song && (song.charts || []).find((c) => c.difficulty === d.difficulty);
      if (!chart) continue;
      const e = { it, dan: d, song, chart };
      for (const k of [`id|${d.songId}|${d.difficulty}`, `slug|${songSlug(d.songId)}|${d.difficulty}`, song.osuSet ? `osu|${song.osuSet}|${d.difficulty}` : null])
        if (k && !idx.has(k)) idx.set(k, e);
    }
  }
  danIdx = idx; danIdxAt = Date.now();
  return idx;
}
function findDan(idx, songId, difficulty, board) {
  const set = /^osu-(\d+)$/.exec(String(board || ""))?.[1];
  const exact = idx.get(`id|${songId}|${difficulty}`);
  if (exact) return { ...exact, via: "id" };
  const other = idx.get(`slug|${songSlug(songId)}|${difficulty}`) || (set ? idx.get(`osu|${set}|${difficulty}`) : null);
  return other ? { ...other, via: "copy" } : null;
}
// ---- a copy of a verified chart that's been changed (its notes, keys or stars) doesn't count for dans or dailies and
// can't be picked in multiplayer: the player is told to redownload the verified map. Notes and keys must be the same;
// stars within 0.1, and only for uploads rated with the game's current star rating (v3, from 1.3.3), since an older
// upload's stored stars differ for unchanged charts too.
const STAR_VERSION = 3, STARS_V3_FROM = Date.parse("2026-11-12T00:00:00Z");
function chartProblems(it, chart, local, songId, via) {
  if (!local || typeof local !== "object" || !chart) return [];
  const out = [];
  // the chart itself. The verified upload's own song must be that very chart (its chart id); a copy from elsewhere (an
  // osu! import, another upload) has an id of its own, so the osu! difficulty file it came from (MD5) is compared: an
  // edited or updated osu! map has another. Each only when both sides know it.
  const md5 = typeof local.osuMd5 === "string" && /^[0-9a-f]{32}$/i.test(local.osuMd5) ? local.osuMd5.toLowerCase() : null;
  if (via === "id" && chart.chartId && typeof local.chartId === "string" && local.chartId && local.chartId !== chart.chartId) out.push("a different chart");
  else if (chart.osuMd5 && md5 && md5 !== chart.osuMd5) out.push("a different version of the osu! map");
  const n = Number(local.notes), k = Number(local.keys), s = Number(local.stars);
  if (chart.notes > 0 && Number.isInteger(n) && n > 0 && n !== chart.notes) out.push(`${n} notes instead of ${chart.notes}`);
  if (chart.keys > 0 && Number.isInteger(k) && k > 0 && k !== chart.keys) out.push(`${k}K instead of ${chart.keys}K`);
  const when = it && (it.updatedAt || it.at); // milliseconds (or an ISO date)
  const rated = typeof when === "number" ? when : Date.parse(when || "") || 0;
  // OCTIVE's own songs carry hand-set difficulty numbers, not worked-out stars: their notes and keys are checked
  const ownSong = (it && it.builtin) || officialSong(songId);
  if (!ownSong && Number(local.sv) === STAR_VERSION && rated >= STARS_V3_FROM && chart.stars > 0 && Number.isFinite(s) && s > 0 && Math.abs(s - chart.stars) > 0.1)
    out.push(`${s.toFixed(2)}★ instead of ${Number(chart.stars).toFixed(2)}★`);
  return out;
}
function failModified(problems, itemId, what = "it") {
  const e = new HttpError(409, `Your copy of this chart isn't the verified one (${problems.join(", ")}), so ${what} won't count. Redownload the verified map from the Workshop.`);
  e.code = "modified"; e.itemId = itemId || undefined;
  throw e;
}
/** Verified uploads' charts (and every dan's), by exact song and by osu! beatmap set: what a copy is checked against. */
let verIdx = null, verIdxAt = 0;
async function verifiedIndex(env) {
  if (verIdx && Date.now() - verIdxAt < 60_000) return verIdx;
  const db = await r2json(env, WS_DB, { items: [] });
  const idx = new Map();
  for (const it of (db.items || []).filter((x) => !x.removed && (x.verified || (Array.isArray(x.dans) && x.dans.length))))
    for (const song of (it.meta && it.meta.songs) || [])
      for (const chart of song.charts || [])
        for (const k of [`id|${song.songId}|${chart.difficulty}`, song.osuSet ? `osu|${song.osuSet}|${chart.difficulty}` : null])
          if (k && !idx.has(k)) idx.set(k, { it, song, chart });
  verIdx = idx; verIdxAt = Date.now();
  return idx;
}
function findVerified(idx, songId, difficulty, board) {
  const set = /^osu-(\d+)$/.exec(String(board || ""))?.[1];
  const exact = idx.get(`id|${songId}|${difficulty}`);
  if (exact) return { ...exact, via: "id" };
  const osu = set ? idx.get(`osu|${set}|${difficulty}`) : null;
  return osu ? { ...osu, via: "osu" } : null;
}

/** Writes dan clears ({ e, acc, at }) to a wallet when they beat what's there; the wallet when anything changed. */
async function recordDanClears(env, playerId, found) {
  if (!found.length) return null;
  let firsts = [];
  const w = await walletUpdate(env, playerId, (w) => {
    w.dans ||= {};
    let changed = false;
    firsts = [];
    for (const { e, acc, at } of found) {
      const key = `${e.dan.songId}|${e.dan.difficulty}`;
      const a = Math.round(acc * 100) / 100;
      if (w.dans[key] && w.dans[key].acc >= a) continue;
      if (!w.dans[key]) firsts.push({ level: e.dan.level, title: String(e.song.title || e.it.title || "").slice(0, 80), acc: a });
      const when = Date.parse(at);
      w.dans[key] = { level: e.dan.level, acc: a, at: Number.isFinite(when) ? new Date(when).toISOString() : new Date().toISOString(),
        title: String(e.song.title || e.it.title || "").slice(0, 80), difficulty: String(e.dan.difficulty).slice(0, 60) };
      remember(w, { kind: "dan", level: e.dan.level, acc: a });
      changed = true;
    }
    if (!changed) return false;
  });
  // friends see a dan cleared for the first time
  for (const f of firsts) await addFeed(env, playerId, { kind: "dan", level: f.level, title: f.title, acc: f.acc }).catch(() => {});
  return w;
}

// ---- the friends feed (2.0): what each player did lately (a rank-up, a new best on a verified chart, an upload, new
// achievements, a dan cleared), kept by the server in feed/<id>.json (the last 40), and read for a player's friends.
const FEED_KEEP = 40;
async function addFeed(env, id, item) {
  if (!okPlayerId(id) || isOfficial(id)) return;
  const entry = { at: new Date(Date.now()).toISOString(), ...item };
  await r2update(env, `feed/${id}.json`, () => ({ items: [] }), (d) => { d.items = [entry, ...(d.items || [])].slice(0, FEED_KEEP); });
}
const feedCache = new Map();
/** A player's friends' feed: the last three weeks, newest first (friends from the message server's copy of their list). */
async function feedFor(env, me) {
  const c = feedCache.get(me);
  if (c && Date.now() - c.at < 60_000) return c.data;
  const box = await r2json(env, dmInboxKey(me), null);
  const friends = ((box && box.friends) || []).filter((f) => f && okPlayerId(f.id) && !isOfficial(f.id) && !moderation.bans[f.id]).slice(0, 80);
  const since = Date.now() - 21 * 86_400_000, out = [];
  for (let i = 0; i < friends.length; i += 10) {
    await Promise.all(friends.slice(i, i + 10).map(async (f) => {
      const d = await r2json(env, `feed/${f.id}.json`, null);
      for (const it of (d && d.items) || []) if (Date.parse(it.at) > since) out.push({ ...it, who: f.id, name: f.name || "Friend" });
    }));
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const data = { items: out.slice(0, 100), friends: friends.length };
  feedCache.set(me, { at: Date.now(), data });
  if (feedCache.size > 2000) feedCache.delete(feedCache.keys().next().value);
  return data;
}
// Dan clears only come from /play/dan/clear, judged from the play's replay. (Until 1.6.6 the ranking sync also credited
// clears from a player's synced plays, which carry only the game's own numbers: that's gone.)

async function displayName(env, id) {
  try { const ov = moderation.overrides[id] || {}; return String(ov.name || (await publicItems(config(env), id, ["card"])).card?.name || "Player").slice(0, 40); } catch { return "Player"; }
}

/**
 * A player's report about another (the player pop-up's Report, a Ranked match's): checked, rate-limited (5 an hour, the
 * same player once a day), posted to #moderator-only with the anti-cheat's record, and kept in R2 reports/log.json.
 */
async function fileReport(env, who, id, reasonKey, detailsRaw, whereRaw) {
  const cfg = config(env);
  await loadModeration(cfg);
  if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail(400, "That player can't be found.");
  if (id === who.playerId) fail(400, "You can't report yourself.");
  const REASONS = { cheating: "Cheating", name: "Offensive name or picture", chat: "Harassment or spam in chat", other: "Something else" };
  const reason = REASONS[String(reasonKey || "")] ? String(reasonKey) : null;
  if (!reason) fail(400, "Pick a reason.");
  const details = modText(detailsRaw, 300), where = modText(whereRaw, 60) || "Player pop-up";
  // a few reports an hour, and the same player once a day
  const now = Date.now(), rateKey = `reports/rate/${who.playerId}.json`;
  const rate = await r2json(env, rateKey, { times: [], targets: {} });
  rate.times = (rate.times || []).filter((t) => now - t < 3_600_000);
  rate.targets = Object.fromEntries(Object.entries(rate.targets || {}).filter(([, t]) => now - t < 86_400_000));
  if (rate.times.length >= 5) fail(429, "You've sent a lot of reports this hour. Try again later.");
  if (rate.targets[id]) fail(429, "You've already reported this player today. The moderators have it.");
  rate.times.push(now); rate.targets[id] = now;
  await r2put(env, rateKey, rate);
  const [byName, name, ac] = await Promise.all([displayName(env, who.playerId), displayName(env, id), r2json(env, acPlayerKey(id), null)]);
  const acLine = ac && ac.counts && Object.keys(ac.counts).length ? Object.entries(ac.counts).map(([k, n]) => `${k} x${n}`).join(", ") : "none";
  const posted = await modPost(env, {
    title: `Player report: ${REASONS[reason]}`, color: 0xFF8A3D,
    fields: [
      { name: "Reported", value: `${modText(name, 60)} (${id}) ${SITE}#/u/${encodeURIComponent(id)}`, inline: false },
      { name: "By", value: `${modText(byName, 60)} (${who.playerId})`, inline: true },
      { name: "Where", value: where, inline: true },
      ...(details ? [{ name: "What they said", value: details, inline: false }] : []),
      { name: "Anti-cheat signs on record", value: acLine, inline: false },
    ],
    timestamp: new Date(now).toISOString(),
  });
  await r2update(env, "reports/log.json", () => ({ reports: [] }), (d) => {
    d.reports ||= [];
    d.reports.push({ at: new Date(now).toISOString(), by: who.playerId, player: id, reason, details, where, posted });
    if (d.reports.length > 300) d.reports = d.reports.slice(-300);
  }).catch(() => {});
}

// ================================================================ Ranked (2.0)
// 1v1, best of 3, 4K only, on verified Workshop charts chosen by star rating. The server runs every match: it picks the
// charts, takes the bans, judges each play from its replay, plays the AI opponents (botPlay: a real input stream judged
// like anyone's, which the game shows as a live score), decides the rounds and moves the ranks.
//   Ranks: Rookie (until placed), Contender, Challenger, Rockstar, Superstar, Elite (I-III each), Champion and Legend
//   (Legends are numbered by a hidden rating). A 0-100% bar per division and no demotion within a season.
//   Seasons: a month each, from midnight UTC on the 1st (Season 0 runs from 2.0's launch to the next month); a new season
//   moves everyone 4 steps down.
//   Placement: three solo songs (2-3.5, 4-4.5 and 5-6 stars) shown one at a time; the best one places you (Contender I
//   to Superstar II). Quitting one fails all three.
//   Leaving mid-song (or quitting during bans, closing the game, a crash, not coming back) fails every song of the
//   match: a 2-0 loss. Ranked opens after 10 played songs.
// Kept in R2: ranked/players/<id>.json (a player's rank), ranked/matches/<id>.json, ranked/queue.json, ranked/board.json.
// 7K Ranked (2.0): a second ladder on 7K charts with its own queue, board, ranks and seasons (ranked/7k/...; a match
// says which ladder it's on in m.mode). It opens once the Workshop has RK_MIN_SONGS verified 7K songs (staff can try it
// before; opened at 2.0's launch with 10); its seasons give their own titles ("Season N 7K Rockstar") and points.
const RK_NAMES = ["Rookie", "Contender I", "Contender II", "Contender III", "Challenger I", "Challenger II", "Challenger III",
  "Rockstar I", "Rockstar II", "Rockstar III", "Superstar I", "Superstar II", "Superstar III", "Elite I", "Elite II", "Elite III", "Champion", "Legend"];
// each rank: [first tier, last tier, lowest stars, highest stars] (a chart right on a boundary belongs to the higher rank)
const RK_GROUPS = [[1, 3, 2, 3], [4, 6, 3, 4], [7, 9, 4, 5], [10, 12, 5, 5.5], [13, 15, 5.5, 6], [16, 16, 6, 6.5], [17, 17, 6.5, 8]];
const RK_LEGEND = 17, RK_PLACEMENT_CAP = 11, RK_BOT_MAX_TIER = 15, RK_UNLOCK_PLAYS = 10;
const RK_BOT_MIN = 7_000, RK_BOT_MAX = 11_000, RK_ACCEPT = 10_000, RK_BAN = 10_000, RK_ROUND_GAP = 15_000, RK_QUEUE_STALE = 8_000, RK_RESERVE = 20_000;
const RK_SEASON0_MONTH = 2026 * 12 + 10; // Season 0's month (November 2026): set to 2.0's launch month
const RK_PLACE_BANDS = [[2, 3.5], [4, 4.5], [5, 6]];
const rkMode = (m) => (Number(m) === 7 ? 7 : 4);
const rkPrefix = (mode) => (rkMode(mode) === 7 ? "ranked/7k/" : "ranked/");
const rkQueueKey = (mode) => rkPrefix(mode) + "queue.json", rkBoardKey = (mode) => rkPrefix(mode) + "board.json";
const RK_QUEUE = rkQueueKey(4), RK_BOARD = rkBoardKey(4);
const RK_MIN_SONGS = 5; // (a ladder opens with this many verified songs of its keys: a round shows 5; with fewer than 15 a match's later rounds may repeat a song)
const rkPlayerKey = (id, mode) => `${rkPrefix(mode)}players/${id}.json`, rkMatchKey = (id) => `ranked/matches/${id}.json`;
// each round's plays (the gzip replay files, for the match's history) and the friendly-match invites a player has
const rkReplayKey = (mid, n, i) => `ranked/replays/${mid}/${n}-${i}.octreplay`, rkInviteKey = (id) => `ranked/invites/${id}.json`;
const RK_INVITE_TTL = 120_000;
const rkSeasonKey = (n, mode) => `${rkPrefix(mode)}seasons/${n}.json`;
// live matches (anyone can watch): the list, and each round's play as it's sent (every second or two)
const RK_LIVE = "ranked/live/index.json", rkLiveKey = (mid, n, i) => `ranked/live/${mid}/${n}-${i}.json`;
const RK_DISCORD = "ranked/discord.json";
const rkStars = (t) => { for (const [a, b, lo, hi] of RK_GROUPS) if (t >= a && t <= b) return [lo, hi]; return [2, 3]; };
const rkBotRating = (t) => 900 + t * 60;
const rkNewId = () => [...crypto.getRandomValues(new Uint8Array(10))].map((x) => x.toString(16).padStart(2, "0")).join("");
const rkSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const rkScope = (c) => `ranked|${c.itemId}|${c.songId}|${c.chartId || c.difficulty}`;

function rkSeason(now = Date.now()) {
  const d = new Date(now), m = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return { n: Math.max(0, m - RK_SEASON0_MONTH), ends: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

// ---- season rewards, by the highest rank reached in a season (granted once, the first time a player is in Ranked after it
// ends): shop points; a "Season N <rank>" title; from Superstar the rank's emblem as a leaderboard icon; from Elite a rank
// frame; for Legend a gold icon colour; and the season's top 10 Legends a numbered title. They're shop items nobody can buy.
const RK_GROUP_KEYS = [null, "contender", "challenger", "rockstar", "superstar", "elite", "champion", "legend"];
const RK_GROUP_NAMES = [null, "Contender", "Challenger", "Rockstar", "Superstar", "Elite", "Champion", "Legend"];
const RK_REWARD_POINTS = [0, 300, 600, 1000, 1500, 2500, 4000, 6000];
const rkGroupOf = (t) => (t <= 0 ? 0 : t <= 15 ? Math.floor((t - 1) / 3) + 1 : t === 16 ? 6 : 7);
function rkRewardItems(upTo) {
  const r = { price: 0, reward: true, minVersion: "2.0.0" }, out = [];
  for (const [g, name] of [["superstar", "Superstar"], ["elite", "Elite"], ["champion", "Champion"], ["legend", "Legend"]])
    out.push({ ...r, id: `icon-rank-${g}`, kind: "icon", name: `${name} emblem`, shape: `rank-${g}`, color: "#FFFFFF", note: `Reach ${name} in a Ranked season` });
  out.push({ ...r, id: "frame-rank-elite", kind: "frame", name: "Elite frame", color: "#B880FF", note: "Reach Elite in a Ranked season" });
  out.push({ ...r, id: "frame-rank-champion", kind: "frame", name: "Champion frame (animated)", color: "#FF6180", anim: "pulse", note: "Reach Champion in a Ranked season" });
  out.push({ ...r, id: "frame-rank-legend", kind: "frame", name: "Legend frame (animated)", color: "#FFE894", color2: "#FFFFFF", anim: "duo", note: "Reach Legend in a Ranked season" });
  out.push({ ...r, id: "iconcolor-legend", kind: "iconcolor", name: "Legend gold icon colour", color: "#FFD95A", note: "Reach Legend in a Ranked season" });
  for (let n = 0; n <= upTo; n++) {
    for (let g = 1; g <= 7; g++) out.push({ ...r, id: `title-s${n}-${RK_GROUP_KEYS[g]}`, kind: "title", name: `Season ${n} ${RK_GROUP_NAMES[g]}`, note: `Reach ${RK_GROUP_NAMES[g]} in Ranked season ${n}` });
    for (let k = 1; k <= 10; k++) out.push({ ...r, id: `title-s${n}-legend-${k}`, kind: "title", name: `Season ${n} Legend #${k}`, note: `Finish Ranked season ${n} as Legend #${k}` });
    for (let g = 1; g <= 7; g++) out.push({ ...r, id: `title-s${n}-7k-${RK_GROUP_KEYS[g]}`, kind: "title", name: `Season ${n} 7K ${RK_GROUP_NAMES[g]}`, note: `Reach ${RK_GROUP_NAMES[g]} in 7K Ranked season ${n}` });
    for (let k = 1; k <= 10; k++) out.push({ ...r, id: `title-s${n}-7k-legend-${k}`, kind: "title", name: `Season ${n} 7K Legend #${k}`, note: `Finish 7K Ranked season ${n} as Legend #${k}` });
  }
  return out;
}
let rkRewardsUpTo = -1;
const RK_REWARDS_AHEAD = 20; // (2.0.1) every season's rewards are made ahead, up to Season 20 (4K and 7K)
/** The reward items in the shop's list: up to Season 20, then up to next season's as the months go by. */
function rkEnsureRewardItems() {
  const want = Math.max(RK_REWARDS_AHEAD, rkSeason().n + 1);
  if (rkRewardsUpTo >= want) return;
  const have = new Set(SHOP.map((x) => x.id));
  for (const x of rkRewardItems(want)) if (!have.has(x.id)) SHOP.push(x);
  rkRewardsUpTo = want;
}

/** Where a player finished among a season's Legends (by rating), from its final standings; null when they weren't one. */
async function rkLegendNumber(env, id, n, mode) {
  const [board, past] = await Promise.all([r2json(env, rkBoardKey(mode), { players: {} }), r2json(env, rkSeasonKey(n, mode), { players: {} })]);
  const all = { ...(past.players || {}) };
  for (const [pid, p] of Object.entries(board.players || {})) if (p && p.season === n) all[pid] = p;
  const legends = Object.entries(all).filter(([pid, p]) => p && p.tier >= RK_LEGEND && !isOfficial(pid) && !moderation.bans[pid]).sort((a, b) => (b[1].rating || 0) - (a[1].rating || 0));
  const i = legends.findIndex(([pid]) => pid === id);
  return i >= 0 ? i + 1 : null;
}

/** Grants the rewards of the seasons a player has finished and not been rewarded for; gives their record (with the summary to show). */
async function rkSeasonRewards(env, id, rec, mode) {
  const due = (rec.seasons || []).filter((x) => !x.rewarded);
  if (!due.length) return rec;
  rkEnsureRewardItems();
  const k7 = rkMode(mode) === 7, tag = k7 ? "7k-" : "";
  const grants = [];
  for (const sn of due) {
    const tier = sn.peak || sn.tier || 0, g = rkGroupOf(tier);
    if (g <= 0) continue;
    const items = [`title-s${sn.n}-${tag}${RK_GROUP_KEYS[g]}`];
    if (g >= 4) items.push(`icon-rank-${RK_GROUP_KEYS[g]}`);
    if (g >= 5) items.push(`frame-rank-${RK_GROUP_KEYS[g]}`);
    if (g >= 7) items.push("iconcolor-legend");
    let legend = null;
    if ((sn.tier || 0) >= RK_LEGEND) { legend = await rkLegendNumber(env, id, sn.n, mode); if (legend && legend <= 10) items.push(`title-s${sn.n}-${tag}legend-${legend}`); }
    grants.push({ n: sn.n, tier, group: g, points: RK_REWARD_POINTS[g], items, legend, stats: sn.stats || {}, wins: sn.wins || 0, losses: sn.losses || 0 });
  }
  const free = infinitePoints(id);
  let applied = [];
  if (grants.length) {
    const listKey = k7 ? "seasonRewards7k" : "seasonRewards"; // (each ladder's seasons are rewarded on their own)
    await walletUpdate(env, id, (w) => {
      applied = [];
      w[listKey] ||= [];
      for (const gr of grants) {
        if (w[listKey].includes(gr.n)) continue; // (once a season, whatever happens)
        applied.push(gr);
        w[listKey].push(gr.n);
        if (!free) { w.balance = (w.balance || 0) + gr.points; w.earned = (w.earned || 0) + gr.points; }
        for (const it of gr.items) if (!w.owned.includes(it)) w.owned.push(it);
        remember(w, { kind: "season", season: gr.n, rank: (k7 ? "7K " : "") + (RK_NAMES[gr.tier] || ""), points: gr.points });
      }
      if (!applied.length) return false;
    });
  }
  const summary = applied.length ? {
    at: Date.now(), seen: false, mode: k7 ? 7 : 4,
    seasons: applied.map((gr) => ({ n: gr.n, tier: gr.tier, rank: RK_NAMES[gr.tier] || "", points: gr.points, legend: gr.legend, stats: gr.stats, wins: gr.wins, losses: gr.losses,
      items: gr.items.map((x) => { const it = SHOP.find((y) => y.id === x); return { id: x, kind: it ? it.kind : null, name: it ? it.name : x, shape: it ? it.shape : undefined, color: it ? it.color : undefined }; }) })),
  } : null;
  return rkChange(env, id, (d) => {
    for (const x of d.seasons) if (due.some((y) => y.n === x.n)) x.rewarded = true;
    if (summary) d.reward = summary;
  }, mode);
}

const rkFresh = (n) => ({ v: 1, season: n, tier: 0, progress: 0, rating: 1000, placed: false, wins: 0, losses: 0, streak: 0, peak: 0, recent: [], seasons: [], settled: [], active: null });

/** A record moved into this season when a new one has started: 4 steps down for each new season, the bar back to 0. */
function rkRoll(rec, n) {
  rec.settled ||= []; rec.recent ||= []; rec.seasons ||= [];
  if (!(rec.season < n)) return rec;
  if (rec.placed) {
    if (!rec.seasons.some((x) => x.n === rec.season))
      rec.seasons = [...rec.seasons, { n: rec.season, tier: rec.tier, peak: rec.peak || rec.tier, wins: rec.wins || 0, losses: rec.losses || 0, rating: Math.round(rec.rating || 0), stats: rec.stats || {} }].slice(-24);
    rec.tier = Math.max(1, rec.tier - 4 * (n - rec.season));
    rec.peak = rec.tier;
  } else rec.placement = null;
  rec.progress = 0; rec.streak = 0; rec.wins = 0; rec.losses = 0; rec.recent = []; rec.active = null; rec.season = n; rec.stats = {};
  return rec;
}

async function rkLoad(env, id, mode) {
  const n = rkSeason().n;
  return rkRoll((await r2json(env, rkPlayerKey(id, mode), null)) || rkFresh(n), n);
}

/** Changes a player's rank record safely: the change runs again when another request wrote it at the same moment. */
const rkChange = (env, id, change, mode) => { const n = rkSeason().n; return r2update(env, rkPlayerKey(id, mode), () => rkFresh(n), (d) => change(rkRoll(d, n))); };
// the same with the ladder first (rankedRoutes and rkSettle: rkChange(env, … becomes rkChangeM(mode, env, …)
const rkLoadM = (mode, env, id) => rkLoad(env, id, mode);
const rkChangeM = (mode, env, id, change) => rkChange(env, id, change, mode);
const rkBoardSetM = (mode, env, id, rec, name) => rkBoardSet(env, id, rec, name, mode);
const rkPoolM = (mode, env) => rkPool(env, mode);
const rkUnlockedM = (mode, env, id, rec) => rkUnlocked(env, id, rec, mode);
const rkLegendNoM = (mode, env, id, rec) => rkLegendNo(env, id, rec, mode);
const rkBoardListM = (mode, env, n) => rkBoardList(env, n, mode);
const rkSeasonRewardsM = (mode, env, id, rec) => rkSeasonRewards(env, id, rec, mode);
const rkNewMatchM = (mode, ...args) => { const m = rkNewMatch(...args); if (rkMode(mode) === 7) m.mode = 7; return m; };

/** The ranked board (the Ranked tab): every placed player's rank this season. */
async function rkBoardSet(env, id, rec, name, mode) {
  if (!rec || !rec.placed) return;
  let finished = null;
  await r2update(env, rkBoardKey(mode), () => ({ players: {} }), (d) => {
    d.players ||= {};
    const old = d.players[id] || {};
    finished = typeof old.season === "number" && old.season < rec.season ? old : null;
    d.players[id] = { name: name || old.name || "Player", tier: rec.tier, progress: Math.round(rec.progress), rating: Math.round(rec.rating),
      season: rec.season, wins: rec.wins || 0, losses: rec.losses || 0, platform: rec.platform || old.platform || "" };
  }).catch((e) => console.log("ranked board", e && e.message));
  // (the season it came from keeps it: its final standings number the Legends)
  if (finished) await r2update(env, rkSeasonKey(finished.season, mode), () => ({ players: {} }), (d) => { d.players ||= {}; if (d.players[id]) return false; d.players[id] = finished; })
    .catch((e) => console.log("ranked season archive", e && e.message));
}

const rkNames = new Map();
async function rkName(env, id) {
  const c = rkNames.get(id);
  if (c && Date.now() - c.at < 600_000) return c.name;
  const name = await displayName(env, id);
  rkNames.set(id, { name, at: Date.now() });
  return name;
}

function rkPublic(rec, legendNo = null) {
  const t = rec.tier || 0;
  return { tier: t, name: RK_NAMES[t] || "Rookie", progress: Math.round(rec.progress || 0), placed: !!rec.placed, wins: rec.wins || 0, losses: rec.losses || 0,
    streak: rec.streak || 0, peak: rec.peak || 0, peakName: RK_NAMES[rec.peak || 0] || "Rookie", legend: legendNo, stars: rkStars(Math.max(1, t)), seasons: (rec.seasons || []).slice(-6),
    statsNow: rec.stats || {}, season: rec.season };
}

/** Every verified chart of a ladder's keys (4 or 7) Ranked can pick, with what the ban screen shows (cached a minute, like the judge's list). */
const rkPoolCache = { 4: null, 7: null }, rkPoolAt = { 4: 0, 7: 0 };
async function rkPool(env, mode) {
  const keys = rkMode(mode);
  if (rkPoolCache[keys] && Date.now() - rkPoolAt[keys] < 60_000) return rkPoolCache[keys];
  const out = [];
  for (const it of (await judgeDb(env)).items || []) {
    if (it.type !== "charts" || it.removed || !it.verified || !it.meta || !(it.b2Files || []).length) continue;
    // (2.0.1) dans are courses of their own, not Ranked charts
    const dans = new Set((Array.isArray(it.dans) ? it.dans : []).map((d) => `${d && d.songId}|${d && d.difficulty}`));
    for (const sg of it.meta.songs || []) {
      if (!sg || !sg.songId) continue;
      for (const c of sg.charts || []) {
        const stars = Number(c.stars);
        if (Number(c.keys) !== keys || !(stars > 0) || c.len === 0) continue; // (len 0: a chart the server couldn't read)
        if (chartIsModchart(c)) continue; // (2.0.1) modcharts aren't played in Ranked
        if (dans.has(`${sg.songId}|${c.difficulty || ""}`)) continue;
        out.push({
          itemId: it.id, version: it.version || 1, songId: sg.songId, chartId: c.chartId || null, osuMd5: c.osuMd5 || null, difficulty: c.difficulty || "",
          stars, title: sg.title || it.title || "", artist: sg.artist || "", creator: c.creator || it.creator || "", bpm: Math.round(Number(sg.bpm) || 0),
          notes: Number(c.notes) || 0, len: Math.round(Number(c.len) || (Number(sg.durationUs) || 0) / 1e6), ln: Math.round((Number(c.ln) || 0) * 100) / 100,
          tags: [...new Set([...(c.autoTags || []), ...(Array.isArray(it.tags) ? it.tags : [])].map(String))].slice(0, 5),
          preview: it.preview ? `${WORKER_BASE}/api/preview/${it.id}` : null, osuSet: Number(sg.osuSet) || 0, keys,
        });
      }
    }
  }
  rkPoolCache[keys] = out; rkPoolAt[keys] = Date.now();
  return out;
}

/** How many different songs a ladder can pick from (it opens at RK_MIN_SONGS). */
const rkPoolSongs = async (env, mode) => new Set((await rkPool(env, mode)).map((c) => c.songId)).size;

/** n charts in a star range, one per song and none from songs already used; widens the range when there aren't enough. */
function rkPick(pool, lo, hi, n, used, rnd) {
  let cand = [];
  for (let widen = 0; widen <= 2; widen += 0.25) {
    cand = pool.filter((c) => c.stars >= lo - widen && c.stars < hi + widen && !used.has(c.songId));
    if (new Set(cand.map((c) => c.songId)).size >= n) break;
  }
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const outside = (c) => Math.ceil(Math.max(0, lo - c.stars, c.stars - hi + 1e-9) / 0.25); // the ones in range first
  cand.sort((a, b) => outside(a) - outside(b));
  const out = [], songs = new Set();
  for (const c of cand) { if (songs.has(c.songId)) continue; songs.add(c.songId); out.push({ ...c }); if (out.length >= n) break; }
  return out.sort((a, b) => a.stars - b.stars);
}

async function rkUnlocked(env, id, rec, mode) {
  if (id === OWNER || isOfficial(id) || rec.unlocked) return { ok: true, plays: null };
  let plays = 0;
  try { const s = (await privateItems(env, id, ["scores"])).scores; if (s && typeof s === "object") plays = Math.max(0, Math.floor(Number(s.totalPlays) || 0)); }
  catch (e) { console.log("ranked plays", e && e.message); }
  if (plays >= RK_UNLOCK_PLAYS) await rkChange(env, id, (d) => { d.unlocked = true; }, mode);
  return { ok: plays >= RK_UNLOCK_PLAYS, plays };
}

// the AI opponents: made-up players (a name nobody on the ranked board has, a picture drawn from a number)
const RK_BOT_A = ["neo", "kai", "luna", "rin", "hex", "zen", "vex", "aki", "sora", "miko", "juno", "nyx", "echo", "pix", "drift", "nova", "haze", "rio",
  "kuro", "yuki", "mika", "remi", "taro", "ivy", "jinx", "koda", "lumi", "milo", "nami", "orbit", "sable", "tempo", "kiri", "ash", "rue", "piko"];
const RK_BOT_B = ["", "", "", "x", "beats", "tap", "fm", "flux", "line", "keys", "rush", "jack", "wave", "mania", "chord", "sync", "dash", "byte", "z"];
function rkBotName(rnd, taken) {
  for (let i = 0; i < 30; i++) {
    let n = RK_BOT_A[Math.floor(rnd() * RK_BOT_A.length)] + RK_BOT_B[Math.floor(rnd() * RK_BOT_B.length)];
    if (rnd() < 0.5) n += String(Math.floor(rnd() * 100));
    if (rnd() < 0.3) n = n[0].toUpperCase() + n.slice(1);
    if (rnd() < 0.15) n += "_";
    if (n.length >= 3 && !taken.has(n.toLowerCase())) return n;
  }
  return "player" + Math.floor(rnd() * 100000);
}

function rkNewMatch(id, a, b, now, taken) {
  const seed = rkSeed(), rnd = seededRandom(seed);
  const m = { v: 1, id, season: rkSeason(now).n, created: now, seed, kind: b ? "human" : "bot", players: [a, b], state: "accept", acceptBy: now + RK_ACCEPT,
    accepted: [false, false], score: [0, 0], rounds: [], used: [], winner: null, leaver: null, results: [null, null], settled: false };
  if (!b) {
    m.players[1] = { bot: true, name: rkBotName(rnd, taken), tier: a.tier, rating: rkBotRating(a.tier), avatar: Math.floor(rnd() * 1e9), platform: rnd() < 0.7 ? "Windows" : "Android" };
    m.accepted[1] = true; m.botAcceptAt = now + 900 + Math.floor(rnd() * 2200);
  }
  return m;
}

async function rkNewRound(env, m, opens) {
  const mode = rkMode(m.mode);
  const ranges = m.players.map((p) => rkStars(Math.max(1, p.tier)));
  // players of different ranks get the range between theirs (a tournament match: the tournament's)
  const lo = m.stars ? m.stars[0] : (ranges[0][0] + ranges[1][0]) / 2, hi = m.stars ? m.stars[1] : (ranges[0][1] + ranges[1][1]) / 2;
  const rnd = seededRandom((m.seed + (m.rounds.length + 1) * 7919) >>> 0);
  const pool = await rkPool(env, mode);
  let charts = rkPick(pool, lo, hi, 5, new Set(m.used), rnd);
  if (charts.length < 2) charts = rkPick(pool, lo, hi, 5, new Set(), rnd); // (a small pool: a song may come up again)
  if (charts.length < 2) { m.state = "cancelled"; m.why = "There aren't enough verified charts for Ranked yet."; return; }
  for (const c of charts) m.used.push(c.songId);
  const r = { n: m.rounds.length + 1, charts, bans: [null, null], opens, banBy: opens + RK_BAN, pick: null, playFrom: null, playBy: null, results: [null, null], winner: null };
  if (m.players[1].bot) {
    // the AI bans too (most often the hardest chart), a few seconds in; it plays at 90-96%
    let hardest = 0;
    charts.forEach((c, i) => { if (c.stars > charts[hardest].stars) hardest = i; });
    r.bans[1] = rnd() < 0.55 ? hardest : Math.floor(rnd() * charts.length);
    r.botBanAt = opens + 1800 + Math.floor(rnd() * 5600);
    r.botAcc = 90 + rnd() * 6;
  }
  m.rounds.push(r);
  m.state = "bans";
}

/** Bans are in: a random chart from the ones left (one the judge can read), and the AI's play of it. */
async function rkResolvePick(env, m, r, now) {
  const banned = new Set(r.bans.filter((x) => x !== null));
  let left = r.charts.map((_, i) => i).filter((i) => !banned.has(i));
  if (!left.length) left = r.charts.map((_, i) => i);
  const rnd = seededRandom((m.seed ^ Math.imul(r.n, 104729)) >>> 0);
  for (let i = left.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [left[i], left[j]] = [left[j], left[i]]; }
  const db = (await judgeDb(env)).items || [];
  for (const k of left) {
    const c = r.charts[k];
    const it = db.find((x) => x.id === c.itemId);
    let where = null;
    try { where = it ? await judgeChartOf(env, it, c.songId, { chartId: c.chartId, osuMd5: c.osuMd5, difficulty: c.difficulty }) : null; }
    catch (e) { console.log("ranked chart", c.itemId, e && e.message); }
    if (!where) continue;
    r.pick = k;
    c.chartId = where.chartId || c.chartId; c.difficulty = where.difficulty || c.difficulty;
    r.playFrom = now; r.playBy = now + Math.max(60, c.len || 240) * 1500 + 180_000;
    if (m.players[1].bot) {
      const bp = botPlay(where.compiled, r.botAcc, (m.seed ^ Math.imul(r.n, 2654435761)) >>> 0);
      r.live = bp.inputs;
      r.results[1] = { acc: round2(bp.result.accuracy), score: bp.result.score, maxCombo: bp.result.maxCombo, fullCombo: !!bp.result.fullCombo, failed: false, at: now + Math.round((c.len || 120) * 1000) };
    }
    m.state = "play";
    return;
  }
  m.state = "cancelled"; m.why = "The server couldn't read these charts. Try again in a moment.";
}

function rkDecideRound(m, r) {
  const [a, b] = r.results;
  let w;
  if (a.failed !== b.failed) w = a.failed ? 1 : 0;
  else if (a.acc !== b.acc) w = a.acc > b.acc ? 0 : 1;
  else if (a.score !== b.score) w = a.score > b.score ? 0 : 1;
  else w = a.at <= b.at ? 0 : 1;
  r.winner = w;
  m.score[w]++;
}

function rkEnd(m, winner, now, leaver = null) {
  m.state = "done"; m.winner = winner; m.leaver = leaver; m.ended = now;
  if (leaver === 0 || leaver === 1) { m.score[leaver] = 0; m.score[1 - leaver] = 2; } // leaving fails every song of the match
}

/** Moves a match on as time passes and plays come in: accept, bans, the pick, rounds, the end. */
async function rkAdvance(env, m, now) {
  for (let guard = 0; guard < 8; guard++) {
    if (m.state === "accept") {
      const botIn = !m.players[1].bot || now >= (m.botAcceptAt || 0);
      if (m.accepted[0] && m.accepted[1] && botIn) { await rkNewRound(env, m, now + 2000); continue; }
      if (now > m.acceptBy) { m.state = "cancelled"; m.why = "The match wasn't accepted in time."; m.declined = m.accepted.map((x) => !x); }
      return;
    }
    if (m.state === "bans") {
      const r = m.rounds[m.rounds.length - 1];
      if (now < r.opens) return;
      const both = r.bans[0] !== null && r.bans[1] !== null && (!m.players[1].bot || now >= r.botBanAt);
      // (timed at the ban deadline when nobody was looking then: closing the game during bans doesn't stop the clock)
      if (both || now >= r.banBy) { await rkResolvePick(env, m, r, Math.min(now, r.banBy)); continue; }
      return;
    }
    if (m.state === "play") {
      const r = m.rounds[m.rounds.length - 1];
      if (r.results[0] && r.results[1]) {
        rkDecideRound(m, r);
        if (m.score[0] >= 2 || m.score[1] >= 2) { rkEnd(m, m.score[0] >= 2 ? 0 : 1, now); return; }
        await rkNewRound(env, m, now + RK_ROUND_GAP);
        continue;
      }
      // a play that never came back counts as leaving
      if (now > r.playBy) {
        if (!r.results[0] && !r.results[1]) rkEnd(m, null, now, "both");
        else { const gone = r.results[0] ? 1 : 0; rkEnd(m, 1 - gone, now, gone); }
      }
      return;
    }
    return;
  }
}

/**
 * How far a match moves the progress bar: about +25% for a win and -20% for a loss, then the adjustments below. Gives the
 * change and its parts ([what, %] in order, adding up to it), which the end of a match shows as tags.
 */
function rkDelta(rec, opp, won, acc, stars, mine, theirs, left) {
  const parts = [];
  let d = 0;
  const add = (what, v) => { v = Math.round(v); if (v) { parts.push([what, v]); d += v; } };
  const gap = Math.max(-4, Math.min(4, (opp.tier || rec.tier) - rec.tier));
  add(won ? "Win" : left ? "Left the match" : "Loss", won ? 25 : -20);
  // 5% for each division between the players
  if (gap) add(won ? (gap > 0 ? "Beat a higher rank" : "Lower-ranked opponent") : (gap > 0 ? "Higher-ranked opponent" : "Lost to a lower rank"), 5 * gap);
  const [lo, hi] = rkStars(Math.max(1, rec.tier));
  const st = Math.max(-4, Math.min(8, (stars - (lo + hi) / 2) * 8)); // harder charts count for more
  add(st >= 0 ? "Harder charts" : "Easier charts", st);
  if (won && acc > 95) add("Accuracy over 95%", Math.min(8, (acc - 95) * 2));
  if (!won && !left && acc >= 96 && d < 0) add("96%+ accuracy", -d * 0.4); // a loss at 96% or better costs less
  if (won && theirs === 0) add("2-0 sweep", 5);
  if (!won && !left && mine === 1 && d < 0) add("Close 1-2", -d * 0.25); // a close loss costs less
  if (won && (rec.streak || 0) >= 2) add("Win streak", 5); // the third win in a row, and on
  const slow = [1, 1, 1, 1, 0.95, 0.95, 0.95, 0.9, 0.9, 0.9, 0.85, 0.85, 0.85, 0.8, 0.8, 0.8, 0.75, 0.7][rec.tier] ?? 1;
  if (won && slow < 1) add("Higher ranks climb slower", d * (slow - 1));
  let total = won ? Math.max(5, Math.min(70, d)) : Math.min(-3, Math.max(-45, d));
  if (left) total = Math.min(total, -20); // leaving is always a full loss
  if (total !== d) parts.push([won ? "Minimum gain" : d > total ? "Minimum loss" : "Maximum loss", total - d]);
  return { delta: total, parts };
}

/** A finished match moves each player's rank once (each record keeps the matches it has counted). */
async function rkSettle(env, m) {
  const mode = rkMode(m.mode);
  if (m.state !== "done" || m.settled) return false;
  m.results = m.results || [null, null];
  const rounds = m.rounds.filter((r) => r.winner !== null && r.pick !== null);
  for (let i = 0; i < 2; i++) {
    const p = m.players[i];
    if (!p || p.bot) continue;
    const opp = m.players[1 - i], won = m.winner === i, left = m.leaver === i || m.leaver === "both";
    const accs = rounds.map((r) => r.results[i] && r.results[i].acc).filter((x) => typeof x === "number");
    const acc = accs.length ? accs.reduce((s, x) => s + x, 0) / accs.length : 0;
    const stars = rounds.length ? rounds.reduce((s, r) => s + r.charts[r.pick].stars, 0) / rounds.length : null;
    let result = null, applied = false;
    const rec = await rkChangeM(mode, env, p.id, (d) => {
      applied = false;
      if (d.settled.includes(m.id)) { result = (d.recent.find((x) => x.match === m.id) || {}).result || null; return false; }
      applied = true;
      d.settled = [m.id, ...d.settled].slice(0, 40);
      if (d.active === m.id) d.active = null;
      if (m.kind === "friendly" || m.kind === "tournament") { // a friendly or tournament match: in the recent list, the rank doesn't move
        d.recent = [{ at: new Date(m.ended || Date.now()).toISOString(), match: m.id, won, left, friendly: true, tournament: m.kind === "tournament" ? m.tournamentName || true : undefined, score: [m.score[i], m.score[1 - i]], opp: opp.name, oppTier: opp.tier }, ...d.recent].slice(0, 20);
        return;
      }
      if (d.season !== m.season || !d.placed) return; // a match from last season doesn't move this season's rank
      const before = { tier: d.tier, progress: Math.round(d.progress) };
      const { delta, parts } = rkDelta(d, opp, won, acc, stars ?? rkStars(Math.max(1, d.tier))[0], m.score[i], m.score[1 - i], left);
      const exp = 1 / (1 + Math.pow(10, ((opp.rating || 1000) - d.rating) / 400));
      d.rating = Math.round((d.rating + 32 * ((won ? 1 : 0) - exp)) * 10) / 10; // the hidden rating: orders the Legends
      if (won) { d.wins = (d.wins || 0) + 1; d.streak = (d.streak || 0) + 1; } else { d.losses = (d.losses || 0) + 1; d.streak = 0; }
      d.progress = (d.progress || 0) + delta;
      let ups = 0;
      while (d.progress >= 100 && d.tier < RK_LEGEND) { d.progress -= 100; d.tier++; ups++; }
      d.progress = Math.max(0, Math.min(100, d.progress)); // no demotion within a season
      d.peak = Math.max(d.peak || 0, d.tier);
      // the season's numbers (its recap)
      const st = d.stats ||= {};
      st.matches = (st.matches || 0) + 1;
      st.rounds = (st.rounds || 0) + rounds.length;
      st.roundsWon = (st.roundsWon || 0) + rounds.filter((r) => r.winner === i).length;
      for (const r of rounds) {
        const a = r.results[i] && r.results[i].acc;
        if (typeof a === "number") { st.accSum = Math.round(((st.accSum || 0) + a) * 100) / 100; st.accN = (st.accN || 0) + 1; st.bestAcc = Math.max(st.bestAcc || 0, a); }
        const t = String(r.charts[r.pick].title || "").slice(0, 80);
        if (t) { st.songs ||= {}; st.songs[t] = (st.songs[t] || 0) + 1; }
      }
      if (st.songs && Object.keys(st.songs).length > 12) st.songs = Object.fromEntries(Object.entries(st.songs).sort((a, b) => b[1] - a[1]).slice(0, 12));
      if (won && m.score[1 - i] === 0) st.sweeps = (st.sweeps || 0) + 1;
      if (won && rounds.length >= 3 && rounds[0].winner !== i) st.comebacks = (st.comebacks || 0) + 1;
      st.bestStreak = Math.max(st.bestStreak || 0, d.streak || 0);
      if (ups) st.rankUps = (st.rankUps || 0) + ups;
      result = { before, after: { tier: d.tier, progress: Math.round(d.progress) }, delta, parts, rankUp: ups > 0, won, left };
      d.recent = [{ at: new Date(m.ended || Date.now()).toISOString(), match: m.id, won, left, score: [m.score[i], m.score[1 - i]], opp: opp.name, oppTier: opp.tier, result }, ...d.recent].slice(0, 20);
    });
    m.results[i] = result;
    await rkBoardSetM(mode, env, p.id, rec, p.name);
    // the week's "win Ranked rounds" mission (Ranked matches only, counted once: the record's settled list says so)
    if (m.kind !== "friendly" && m.kind !== "tournament" && applied && result) await missionEvent(env, p.id, { kind: "ranked", roundsWon: rounds.filter((r) => r.winner === i).length }).catch((e) => console.log("missions", e && e.message));
    // friends see a rank-up
    if (m.kind !== "friendly" && m.kind !== "tournament" && applied && result && result.rankUp) await addFeed(env, p.id, { kind: "rankup", tier: result.after.tier, rank: (mode === 7 ? "7K " : "") + (RK_NAMES[result.after.tier] || "") }).catch(() => {});
  }
  m.settled = true;
  // a tournament match: its winner goes through
  if (m.kind === "tournament") await tourMatchDone(env, m).catch((e) => console.log("tournament", e && e.message));
  return true;
}

/** Reads, changes and writes a match safely when both players act at once (the change runs again after a clash). */
async function rkUpdateMatch(env, id, change) {
  for (let i = 0; i < 6; i++) {
    const o = await env.RELEASES.get(rkMatchKey(id));
    if (!o) fail(404, "That match can't be found.");
    const m = await o.json();
    const was = JSON.stringify(m);
    await change(m);
    let ok = JSON.stringify(m) === was;
    if (!ok) ok = !!(await env.RELEASES.put(rkMatchKey(id), JSON.stringify(m), { httpMetadata: { contentType: "application/json" }, onlyIf: { etagMatches: o.etag } }));
    if (ok) { if (await rkSettle(env, m)) await r2put(env, rkMatchKey(id), m); return m; }
  }
  fail(503, "The match is busy. Try again in a moment.");
}

/** A match as one player sees it: both players, the round's charts and bans, results (the opponent's after the round). */
function rkView(m, me, now, wantLive = false) {
  const opp = m.players[1 - me], you = m.players[me], r = m.rounds[m.rounds.length - 1] || null;
  const pub = (p) => ({ name: p.name, tier: p.tier, rank: RK_NAMES[p.tier] || "Rookie", id: p.bot ? null : p.id, picture: p.bot ? p.avatar : null, platform: p.platform || "" });
  const done = m.state === "done";
  const v = {
    id: m.id, mode: rkMode(m.mode), kind: m.kind === "friendly" || m.kind === "tournament" ? "friendly" : "ranked", tournament: m.kind === "tournament" ? m.tournamentName || "Tournament" : undefined, created: m.created, season: m.season, state: m.state, why: m.why || null, now, score: [m.score[me], m.score[1 - me]], acceptBy: m.acceptBy, accepted: !!m.accepted[me],
    oppAccepted: !!m.accepted[1 - me] && (!opp.bot || now >= (m.botAcceptAt || 0)), you: pub(you), opp: pub(opp),
    rounds: m.rounds.filter((x) => x.winner !== null).map((x) => ({ n: x.n, chart: x.charts[x.pick], mine: x.results[me], theirs: x.results[1 - me], won: x.winner === me })),
    winner: done ? m.winner === me : null, left: done ? m.leaver === me || m.leaver === "both" : null, oppLeft: done && (m.leaver === 1 - me || m.leaver === "both"),
    result: m.results ? m.results[me] : null,
  };
  if (r) {
    const botIn = !opp.bot || now >= (r.botBanAt || 0);
    const shown = (r.bans[0] !== null && r.bans[1] !== null && botIn) || now >= r.banBy || r.pick !== null;
    v.round = {
      n: r.n, opens: r.opens, banBy: r.banBy, charts: r.charts, myBan: r.bans[me], oppBanned: r.bans[1 - me] !== null && botIn,
      oppBan: shown ? r.bans[1 - me] : null, pick: r.pick, playFrom: r.playFrom, playBy: r.playBy, mine: r.results[me], decided: r.winner !== null,
      won: r.winner === null ? null : r.winner === me, theirs: r.winner !== null ? r.results[1 - me] : null,
      live: wantLive && r.pick !== null && r.live ? r.live : null,
    };
  }
  return v;
}

/** A match for its players' history: every round's five charts, both bans, the pick and both plays, the rank change. */
function rkSummary(m, me) {
  const opp = m.players[1 - me], you = m.players[me];
  const pub = (p) => ({ name: p.name, tier: p.tier, rank: RK_NAMES[p.tier] || "Rookie", id: p.bot ? null : p.id, picture: p.bot ? p.avatar : null, platform: p.platform || "" });
  const done = m.state === "done";
  const chart = (c) => ({ itemId: c.itemId, songId: c.songId, chartId: c.chartId, difficulty: c.difficulty, stars: c.stars, title: c.title, artist: c.artist,
    creator: c.creator, bpm: c.bpm, notes: c.notes, len: c.len, ln: c.ln, tags: c.tags, preview: c.preview, osuSet: c.osuSet || 0 });
  return {
    id: m.id, mode: rkMode(m.mode), kind: m.kind === "friendly" || m.kind === "tournament" ? "friendly" : "ranked", tournament: m.kind === "tournament" ? m.tournamentName || "Tournament" : undefined, state: m.state, season: m.season, created: m.created, ended: m.ended || null,
    score: [m.score[me], m.score[1 - me]], winner: done ? m.winner === me : null, left: done ? m.leaver === me || m.leaver === "both" : null,
    oppLeft: done && (m.leaver === 1 - me || m.leaver === "both"), you: pub(you), opp: pub(opp), result: m.results ? m.results[me] : null,
    rounds: m.rounds.filter((r) => r.pick !== null).map((r) => ({
      n: r.n, charts: r.charts.map(chart), bans: [r.bans[me], r.bans[1 - me]], pick: r.pick,
      mine: r.results[me], theirs: r.winner !== null ? r.results[1 - me] : null, won: r.winner === null ? null : r.winner === me,
      replays: { mine: !!(r.replays && r.replays[me]), theirs: r.winner !== null && (opp.bot ? !!r.live : !!(r.replays && r.replays[1 - me])) },
    })),
  };
}

/** An AI opponent's play as a replay file (the same gzip JSON the game saves), from its inputs. */
async function rkBotReplay(m, r, p) {
  const c = r.charts[r.pick];
  const rep = { format: "octive.replay", version: 3, octiveVersion: "2.0.0", player: p.name, songId: c.songId, chartId: c.chartId, title: c.title,
    difficulty: c.difficulty, keyCount: rkMode(m.mode), playedAt: new Date(r.playFrom || m.created).toISOString(), autoplay: false, inputs: r.live };
  const gz = new Response(new Blob([JSON.stringify(rep)]).stream().pipeThrough(new CompressionStream("gzip")));
  return new Uint8Array(await gz.arrayBuffer());
}

function rkB64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Judges a ranked or placement play from its replay (no mods; a replay counts once; the anti-cheat reads it too). */
async function rkJudge(env, who, b, c, what) {
  const rep = replayBytes(b.replay);
  if (!rep) fail(400, "A ranked play only counts with its replay. Update OCTIVE.");
  const it = ((await judgeDb(env)).items || []).find((x) => x.id === c.itemId);
  const where = it ? await judgeChartOf(env, it, c.songId, { chartId: c.chartId, osuMd5: c.osuMd5, difficulty: c.difficulty }) : null;
  let result;
  try { ({ result } = await judgePlay(who, rep, where, { what: "A ranked play", noMods: true, noModsText: "Ranked is played without mods." })); }
  catch (e) { if (e.status === 400 && /^Nothing was hit/.test(e.message || "")) return { accuracy: 0, score: 0, maxCombo: 0, fullCombo: false, signature: null }; throw e; }
  await refuseCopies(env, rkScope(c), who, result, false);
  const claimed = b.claimed && typeof b.claimed === "object" && b.failed !== true ? { accuracy: Number(b.claimed.accuracy) } : null;
  await judgeFlags(env, who.playerId, what, result, claimed);
  return result;
}

/** A placement song's level: its stars by how well it went (95%+ counts fully), a little more for a full combo. */
function rkLevel(stars, acc, failed, fc) {
  let f;
  if (failed || acc < 50) f = 0.3;
  else if (acc >= 95) f = 1;
  else if (acc >= 90) f = 0.85 + (acc - 90) / 5 * 0.15;
  else if (acc >= 80) f = 0.6 + (acc - 80) / 10 * 0.25;
  else f = 0.3 + (acc - 50) / 30 * 0.3;
  return stars * f + (fc && !failed ? 0.1 : 0);
}
/** The division a placement level gives: the rank whose stars it's in, thirds of the range for I/II/III. */
function rkTierOfLevel(level) {
  for (const [a, b, lo, hi] of RK_GROUPS) {
    if (level >= hi && a !== RK_LEGEND) continue;
    if (level < lo) return Math.max(1, a);
    return Math.min(RK_PLACEMENT_CAP, a + Math.min(b - a, Math.floor((level - lo) / (hi - lo) * (b - a + 1))));
  }
  return RK_PLACEMENT_CAP;
}

async function rkLegendNo(env, id, rec, mode) {
  if (rec.tier < RK_LEGEND) return null;
  const all = (await r2json(env, rkBoardKey(mode), { players: {} })).players || {};
  const legends = Object.entries(all).filter(([, p]) => p.tier >= RK_LEGEND && p.season === rec.season).sort((a, b) => b[1].rating - a[1].rating);
  const i = legends.findIndex(([pid]) => pid === id);
  return i >= 0 ? i + 1 : legends.length + 1;
}

/** Keeps a match's line in the live list (anyone can watch Ranked): added while it's on, gone when it ends. */
async function rkLiveIndex(env, m) {
  const on = m.state === "accept" || m.state === "bans" || m.state === "play";
  const r = m.rounds[m.rounds.length - 1] || null;
  const pub = (p) => ({ name: p.name, tier: p.tier, id: p.bot ? null : p.id, picture: p.bot ? p.avatar : null });
  const c = r && r.pick !== null ? r.charts[r.pick] : null;
  const entry = on ? { id: m.id, mode: rkMode(m.mode), kind: m.kind === "friendly" || m.kind === "tournament" ? "friendly" : "ranked", tournament: m.kind === "tournament" ? m.tournamentName || "Tournament" : undefined, state: m.state, players: m.players.map(pub), score: m.score, round: r ? r.n : 0,
    chart: c ? { title: c.title, artist: c.artist, difficulty: c.difficulty, stars: c.stars, preview: c.preview } : null, playFrom: c ? r.playFrom : null, created: m.created } : null;
  await r2update(env, RK_LIVE, () => ({ matches: {} }), (d) => {
    d.matches ||= {};
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(d.matches)) if (now - (v.at || 0) > 20 * 60_000) { delete d.matches[k]; changed = true; }
    const old = d.matches[m.id];
    if (!entry) { if (old) { delete d.matches[m.id]; changed = true; } return changed ? undefined : false; }
    if (old && now - (old.at || 0) < 60_000) { const { at, ...rest } = old; if (JSON.stringify(rest) === JSON.stringify(entry)) return changed ? undefined : false; }
    d.matches[m.id] = { ...entry, at: now };
  }).catch((e) => console.log("ranked live", e && e.message));
}

/** This season's ranked board, best first (Legends by rating), without banned players and the official account. */
async function rkBoardList(env, n, mode) {
  const all = (await r2json(env, rkBoardKey(mode), { players: {} })).players || {};
  return Object.entries(all).filter(([pid, p]) => p && p.season === n && !moderation.bans[pid] && !isOfficial(pid))
    .sort((x, y) => y[1].tier - x[1].tier || (x[1].tier >= RK_LEGEND ? y[1].rating - x[1].rating : y[1].progress - x[1].progress) || y[1].wins - x[1].wins)
    .map(([pid, p], i) => ({ id: pid, name: p.name, tier: p.tier, rank: RK_NAMES[p.tier] || "Rookie", progress: p.progress, wins: p.wins || 0, losses: p.losses || 0,
      platform: p.platform || "", place: i + 1, legend: p.tier >= RK_LEGEND ? i + 1 : null }));
}

// ---- the weekly top 10 (Mondays from 18:00 UTC) and a season's final standings, posted by the bot. Off until Senterra or
// Octive switch it on (/ranked discord on); the channel is found by name (#octive-scores unless they pick another).
const RK_HEX = ["#9AA3B8", "#E08F54", "#CCDBF2", "#FFCC4D", "#54DEF5", "#B880FF", "#FF6180", "#FFE894"];
function rkTopEmbed(list, title, description) {
  const lines = list.slice(0, 10).map((p, i) => `**#${i + 1}** ${modText(p.name, 30)} · ${p.rank}${p.legend ? ` #${p.legend}` : ""}${p.tier < RK_LEGEND ? ` (${p.progress}%)` : ""} · ${p.wins}W ${p.losses}L`);
  return { title, description: (description ? description + "\n\n" : "") + (lines.length ? lines.join("\n") : "Nobody is placed yet."),
    color: parseInt(RK_HEX[rkGroupOf(list[0] ? list[0].tier : 0)].slice(1), 16), footer: { text: "OCTIVE Ranked" }, timestamp: new Date().toISOString() };
}
async function rkChannelByName(env, name) {
  const list = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  const c = (list || []).find((x) => x.name === name && (x.type === 0 || x.type === 5));
  return c ? c.id : null;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}
/** The hourly job: this week's top 10 (once a week) and a season that has ended (once), when switched on. */
async function rkDiscordTick(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return;
  const cfg = await r2json(env, RK_DISCORD, { on: false });
  if (!cfg.on) return;
  await loadModeration(config(env));
  const now = new Date(Date.now()), season = rkSeason(now.getTime());
  const channel = await rkChannelByName(env, cfg.channel || "octive-scores");
  if (!channel) { console.log("ranked discord: channel not found", cfg.channel); return; }
  const posted = { ...cfg };
  // a season that has ended: its final standings (after its first hour, so the last matches are in)
  const prev = season.n - 1;
  if (prev >= 0 && !(cfg.seasons || []).includes(prev) && now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) > 3_600_000) {
    const [board, past] = await Promise.all([r2json(env, RK_BOARD, { players: {} }), r2json(env, rkSeasonKey(prev), { players: {} })]);
    const all = { ...(past.players || {}) };
    for (const [pid, p] of Object.entries(board.players || {})) if (p && p.season === prev) all[pid] = p;
    const list = Object.entries(all).filter(([pid]) => !moderation.bans[pid] && !isOfficial(pid))
      .sort((x, y) => y[1].tier - x[1].tier || (x[1].tier >= RK_LEGEND ? y[1].rating - x[1].rating : y[1].progress - x[1].progress))
      .map(([, p], i) => ({ name: p.name, tier: p.tier, rank: RK_NAMES[p.tier], progress: p.progress, wins: p.wins || 0, losses: p.losses || 0, legend: p.tier >= RK_LEGEND ? i + 1 : null }));
    await discordApi(env, "POST", `/channels/${channel}/messages`, { embeds: [rkTopEmbed(list, `Ranked Season ${prev} is over`, `The final standings. Season ${season.n} has started: everyone moved down 4 divisions.`)], allowed_mentions: { parse: [] } });
    posted.seasons = [...(cfg.seasons || []), prev].slice(-24);
  }
  // the week's top 10
  const week = isoWeek(now);
  if (now.getUTCDay() === 1 && now.getUTCHours() >= 18 && cfg.week !== week) {
    const list = await rkBoardList(env, season.n);
    await discordApi(env, "POST", `/channels/${channel}/messages`, { embeds: [rkTopEmbed(list, `Ranked top 10 · Season ${season.n}, ${week.replace("-W", " week ")}`, null)], allowed_mentions: { parse: [] } });
    posted.week = week;
  }
  if (JSON.stringify(posted) !== JSON.stringify(cfg)) await r2put(env, RK_DISCORD, posted);
}

/** The ranked board for everyone (the website's Ranked page): GET, no sign-in. */
async function rankedPublicBoard(env, mode) {
  await freshModeration(env);
  const season = rkSeason();
  const all = await rkBoardList(env, season.n, mode);
  return reply({ season: season.n, ends: season.ends, total: all.length, players: all.slice(0, 100), mode: rkMode(mode) });
}

/** The model's reading of a rank card picture (a rank-up or a season recap): it has to be one, with this player or rank on it. */
async function rankedPictureCheck(env, bytes, want) {
  if (!env.AI) return { check: "unread" };
  const prompt = 'This image should be a rank card from the rhythm game OCTIVE (a rank emblem, a player name and a rank such as "Superstar II"). Reply with JSON only, no other words: {"card": true or false (is it a rank card from a game?), "player": "the player name on it", "rank": "the rank name on it"}';
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try { out = await env.AI.run(SHARE_VISION, { prompt, image: Array.from(bytes), max_tokens: 120, temperature: attempt ? 0.2 : 0 }); }
    catch (e) { continue; }
    const text = String(out?.response ?? out?.description ?? "");
    const m = text.match(/\{[\s\S]*\}/);
    let r = null;
    try { r = m ? JSON.parse(m[0]) : null; } catch { r = null; }
    if (!r) continue;
    if (r.card === false || /^\s*false\s*$/i.test(String(r.card ?? ""))) return { check: "fake", read: r };
    const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const ok = (norm(r.player) && norm(want.name) && (norm(r.player).includes(norm(want.name)) || norm(want.name).includes(norm(r.player))))
      || (norm(r.rank) && norm(want.rank) && (norm(r.rank).includes(norm(want.rank)) || norm(want.rank).includes(norm(r.rank))));
    return { check: ok ? "ok" : "other", read: r };
  }
  return { check: "unread" };
}

/**
 * Sharing a rank card to #octive-scores (POST /play/ranked/share, multipart: image + info {kind: "rankup", match} or
 * {kind: "season", season}): what it says comes from the server's own records; the picture goes with it only when the
 * model reads it as a rank card of this player or rank (the same check as score pictures).
 */
async function rankedShare(request, env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) fail(503, "Sharing isn't set up on the server.");
  const who = await signedIn(request, env);
  const cfg = config(env);
  await loadModeration(cfg);
  if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
  const now = Date.now();
  const last = scoreShareAt.get("ranked:" + who.playerId) || 0;
  if (now - last < 20_000) fail(429, "Wait a few seconds before sharing again.");
  if (Number(request.headers.get("Content-Length") || 0) > 8_500_000) fail(413, "That picture is too big.");
  let form;
  try { form = await request.formData(); } catch { fail(400, "The share wasn't readable (multipart/form-data expected)."); }
  let info = {};
  try { info = JSON.parse(String(form.get("info") || "{}")) || {}; } catch { /* none */ }
  const id = who.playerId;
  const card = (await publicItems(cfg, id, ["card"]).catch(() => ({}))).card || {};
  const name = modText(moderation.overrides[id]?.name || card.name || who.username || "Player", 40) || "Player";
  const shareMode = rkMode(info.mode); // (a season card: which ladder; a rank-up: its match says)
  let k7 = shareMode === 7;
  const rec = await rkLoad(env, id, shareMode);
  let title, fields = [], tier, rankText;
  if (info.kind === "rankup") {
    const mid = String(info.match || "");
    if (!/^[a-f0-9]{20}$/.test(mid)) fail(400, "That match can't be found.");
    const m = await r2json(env, rkMatchKey(mid), null);
    const me = m && m.players[0] && m.players[0].id === id ? 0 : m && m.players[1] && m.players[1].id === id ? 1 : -1;
    const res = me >= 0 && m.results ? m.results[me] : null;
    if (!res || !res.rankUp) fail(400, "That match didn't rank you up.");
    k7 = rkMode(m.mode) === 7;
    tier = res.after.tier; rankText = RK_NAMES[tier];
    title = `${name} ranked up to ${rankText}${k7 ? " in 7K" : ""}!`;
    fields = [{ name: "Match", value: `${m.score[me]}-${m.score[1 - me]} against ${modText(m.players[1 - me].name, 30)}`, inline: true },
      { name: "Change", value: `${res.delta >= 0 ? "+" : ""}${res.delta}%`, inline: true }, { name: "Season", value: String(m.season), inline: true }];
  } else if (info.kind === "season") {
    const n = Math.floor(Number(info.season));
    const sn = n === rec.season ? { n, tier: rec.tier, peak: rec.peak, wins: rec.wins, losses: rec.losses, stats: rec.stats || {}, now: true } : (rec.seasons || []).find((x) => x.n === n);
    if (!sn || !rec.placed && sn.now) fail(400, "There's no season to share.");
    tier = sn.peak || sn.tier || 0; rankText = RK_NAMES[tier];
    const st = sn.stats || {}, games = (sn.wins || 0) + (sn.losses || 0);
    title = sn.now ? `${name}'s ${k7 ? "7K " : ""}Ranked season ${n} so far` : `${name}'s ${k7 ? "7K " : ""}Ranked season ${n}`;
    fields = [{ name: "Highest rank", value: rankText, inline: true }, { name: "Matches", value: `${sn.wins || 0}W ${sn.losses || 0}L${games ? ` (${Math.round(100 * (sn.wins || 0) / games)}%)` : ""}`, inline: true },
      ...(st.bestStreak ? [{ name: "Best streak", value: `${st.bestStreak} wins`, inline: true }] : []),
      ...(st.bestAcc ? [{ name: "Best round", value: `${Number(st.bestAcc).toFixed(2)}%`, inline: true }] : []),
      ...(st.sweeps ? [{ name: "2-0 wins", value: String(st.sweeps), inline: true }] : [])];
  } else fail(400, "Update OCTIVE to share this.");
  // the picture
  let bytes = null, kind = null;
  const file = form.get("image");
  if (file && typeof file !== "string" && file.size <= 8_000_000) {
    const b = new Uint8Array(await file.arrayBuffer());
    const im = chatImageInfo(b);
    if (!im || (im.type !== "jpeg" && im.type !== "png") || im.w !== 1920 || im.h !== 1080) fail(400, "That picture isn't one OCTIVE drew, so it wasn't shared.");
    const pc = await rankedPictureCheck(env, b, { name, rank: rankText });
    if (pc.check === "fake") { await flagPlayer(env, id, "ranked share refused (the picture isn't a rank card)").catch(() => {}); fail(400, "That picture isn't a rank card from OCTIVE, so it wasn't shared."); }
    if (pc.check === "ok") { bytes = b; kind = im.type === "png" ? "png" : "jpg"; }
  }
  let discordId = null;
  try { const r = await record(env, id); discordId = r.discord?.id || null; } catch { /* not linked */ }
  const channelId = await scoresChannelId(env);
  if (!channelId) fail(503, "The #octive-scores channel wasn't found on the OCTIVE Discord.");
  const avatarHash = moderation.overrides[id]?.avatar ? "mod-" + Date.parse(moderation.overrides[id].at) : (card.avatar || "");
  const embed = {
    color: parseInt(RK_HEX[rkGroupOf(tier)].slice(1), 16),
    author: { name, url: `${SITE}#/u/${encodeURIComponent(id)}`, ...(avatarHash ? { icon_url: `${WORKER_BASE}/avatar/${encodeURIComponent(id)}?v=${encodeURIComponent(avatarHash)}` } : {}) },
    title: title.slice(0, 256), fields, ...(bytes ? { image: { url: `attachment://rank.${kind}` } } : {}),
    footer: { text: `Shared from OCTIVE · Ranked${k7 ? " 7K" : ""}` }, timestamp: new Date().toISOString(),
  };
  const payload = { content: discordId ? `<@${discordId}> shared a Ranked card` : undefined, embeds: [embed], allowed_mentions: { parse: [], users: discordId ? [discordId] : [] } };
  let posted;
  if (bytes) {
    const fd = new FormData();
    payload.attachments = [{ id: 0, filename: `rank.${kind}` }];
    fd.append("payload_json", JSON.stringify(payload));
    fd.append("files[0]", new Blob([bytes], { type: kind === "png" ? "image/png" : "image/jpeg" }), `rank.${kind}`);
    posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, fd, true);
  } else posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, payload);
  scoreShareAt.set("ranked:" + id, now);
  return reply({ ok: true, url: `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${channelId}/${posted.id}`, picture: !!bytes });
}

rkEnsureRewardItems();

async function rankedRoutes(request, env, path) {
  const who = await signedIn(request, env);
  const b = await bodyOf(request, 2_600_000); // a ranked play's replay comes with it
  const id = who.playerId, now = Date.now(), what = path.slice("/play/ranked/".length);
  let mode = rkMode(b.mode); // the ladder: 4 (the main one) or 7 (it can change below: a match's own, an invite's)
  await freshModeration(env);
  if (moderation.bans[id]) fail(403, "This account is banned.");
  const season = rkSeason(now), seasonOut = { n: season.n, ends: season.ends }, staff = id === OWNER || isOfficial(id);
  let rec = await rkLoadM(mode, env, id);
  const name = await rkName(env, id);
  const platform = String(b.platform || "").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 16);
  const openMatch = async (mid) => {
    if (!/^[a-f0-9]{20}$/.test(String(mid || ""))) fail(400, "That match can't be found.");
    const m = await r2json(env, rkMatchKey(mid), null);
    if (!m) fail(404, "That match can't be found.");
    const me = m.players[0] && m.players[0].id === id ? 0 : m.players[1] && m.players[1].id === id ? 1 : -1;
    if (me < 0) fail(403, "That isn't your match.");
    return { m, me };
  };
  const clearActive = (mid) => rkChangeM(mode, env, id, (d) => { if (d.active !== mid) return false; d.active = null; });
  // the player's open match, moved on (it may have ended meanwhile)
  const activeMatch = async () => {
    if (!rec.active) return null;
    let found;
    try { found = await openMatch(rec.active); }
    catch (e) { if (e.status >= 400 && e.status < 500) { await clearActive(rec.active); rec.active = null; return null; } throw e; }
    const m = await rkUpdateMatch(env, found.m.id, async (x) => { await rkAdvance(env, x, now); });
    await rkLiveIndex(env, m);
    const over = m.state === "done" || m.state === "cancelled";
    if (over) { await clearActive(m.id); rec.active = null; }
    return { m, me: found.me, over };
  };

  // ---- live matches: the list, and watching one player's play (anyone signed in)
  if (what === "live/list") {
    const d = await r2json(env, RK_LIVE, { matches: {} });
    const top = (x) => Math.max(0, ...(x.players || []).map((p) => p.tier || 0));
    const list = Object.values(d.matches || {}).filter((x) => now - (x.at || 0) < 20 * 60_000 && !(x.players || []).some((p) => p.id === id))
      .sort((a, b) => top(b) - top(a) || (b.created || 0) - (a.created || 0)).slice(0, 40);
    return reply({ matches: list, now });
  }
  if (what === "live/watch") {
    if (!/^[a-f0-9]{20}$/.test(String(b.match || ""))) fail(400, "That match can't be found.");
    const m = await r2json(env, rkMatchKey(String(b.match)), null);
    if (!m) fail(404, "That match can't be found.");
    const w = Number(b.who) === 1 ? 1 : 0, pl = m.players[w];
    const r = b.round ? m.rounds.find((x) => x.n === Number(b.round)) : [...m.rounds].reverse().find((x) => x.pick !== null);
    if (!r || r.pick === null) return reply({ chart: null, state: m.state, now });
    const from = Math.max(0, Math.floor(Number(b.from) || 0));
    let inputs = [], at = 0, age = 0, ended = false, left = false;
    if (pl.bot) {
      // the AI's play on the clock its opponent's would be on (it starts a few seconds after the pick)
      const chartNow = (now - ((r.playFrom || now) + 9000)) * 1000, all = r.live || [];
      let t = 0, total = 0;
      for (let i = 0; i + 2 < all.length; i += 3) total += all[i];
      for (let i = 0; i + 2 < all.length; i += 3) { t += all[i]; if (t > chartNow) break; inputs.push(t, all[i + 1], all[i + 2]); }
      inputs = inputs.slice(from * 3); at = Math.max(0, Math.round(chartNow)); ended = chartNow > total + 2_000_000;
    } else {
      const d = await r2json(env, rkLiveKey(m.id, r.n, w), null);
      if (d) { inputs = (d.inputs || []).slice(from * 3); at = d.now || 0; age = d.at ? Math.max(0, now - d.at) : 0; ended = !!d.ended; left = !!d.left; }
      if (r.results[w] || m.state === "done" || m.state === "cancelled") ended = true;
    }
    return reply({ round: r.n, chart: r.charts[r.pick], inputs, now: at, age, ended, left, name: pl.name, state: m.state });
  }
  // (staff: the weekly Discord post on or off, its channel, or a look at it in #moderator-only)
  if (what === "discord") {
    if (!staff) fail(403, "Only Senterra and the official OCTIVE account can do that.");
    const cfgD = await r2json(env, RK_DISCORD, { on: false });
    const action = String(b.action || "status");
    if (action === "on" || action === "off") {
      cfgD.on = action === "on";
      if (b.channel) cfgD.channel = String(b.channel).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 60) || cfgD.channel;
      if (cfgD.on && !cfgD.week) cfgD.week = isoWeek(new Date(Date.now())); // (the first post is next Monday's)
      if (cfgD.on && !cfgD.seasons) cfgD.seasons = Array.from({ length: Math.max(0, season.n) }, (_, k) => k); // (no posts for seasons before it was on)
      await r2put(env, RK_DISCORD, cfgD);
    }
    if (action === "preview") await modPost(env, rkTopEmbed(await rkBoardList(env, season.n), `Preview: Ranked top 10 · Season ${season.n}`, "This is how the weekly post looks (it goes to #" + (cfgD.channel || "octive-scores") + " on Mondays from 18:00 UTC when it's on)."));
    return reply({ on: !!cfgD.on, channel: cfgD.channel || "octive-scores", week: cfgD.week || null });
  }
  // ---- the ranks shown beside names (boards, rooms, chat, pop-ups): this season's division of each placed player
  if (what === "ranks") {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x)).slice(0, 100);
    const all = (await r2json(env, RK_BOARD, { players: {} })).players || {}; // (the 4K ladder's: the emblem beside a name)
    const ranks = {};
    for (const pid of ids) { const p = all[pid]; if (p && p.season === season.n && !moderation.bans[pid] && !isOfficial(pid)) ranks[pid] = p.tier; }
    return reply({ ranks });
  }
  const invitesOf = async () => Object.entries((await r2json(env, rkInviteKey(id), { invites: {} })).invites || {})
    .filter(([pid, v]) => now - v.at < RK_INVITE_TTL && !moderation.bans[pid]).map(([from, v]) => ({ from, name: v.name, tier: v.tier || 0, at: v.at, mode: rkMode(v.mode) }));
  const invitedOut = () => rec.invited && now - rec.invited.at < RK_INVITE_TTL ? rec.invited : null;
  if ((rec.seasons || []).some((x) => !x.rewarded)) rec = await rkSeasonRewardsM(mode, env, id, rec);
  const rewardOut = () => rec.reward && !rec.reward.seen ? rec.reward : null;
  if (what === "season/seen") { await rkChangeM(mode, env, id, (d) => { if (!d.reward || d.reward.seen) return false; d.reward.seen = true; }); return reply({ ok: true }); }
  // (staff, for testing: this season's rewards now, as if it had just ended; the real end then skips them)
  if (what === "season/preview") {
    if (!staff) fail(403, "Only Senterra and the official OCTIVE account can do that.");
    if (!rec.placed) fail(400, "Get placed first.");
    rec = await rkChangeM(mode, env, id, (d) => {
      if (d.seasons.some((x) => x.n === d.season)) return false;
      d.seasons.push({ n: d.season, tier: d.tier, peak: d.peak || d.tier, wins: d.wins || 0, losses: d.losses || 0, rating: Math.round(d.rating || 0), stats: d.stats || {}, preview: true });
    });
    rec = await rkSeasonRewardsM(mode, env, id, rec);
    return reply({ ok: true, reward: rewardOut() });
  }
  if (what === "state") {
    const a = await activeMatch();
    const unlock = await rkUnlockedM(mode, env, id, rec);
    // the ladder: open once there are enough charts; the other ladder: a match going on there, or its season rewards
    const songs = await rkPoolSongs(env, mode), open = songs >= RK_MIN_SONGS;
    const other = mode === 7 ? 4 : 7;
    let orec = await rkLoadM(other, env, id);
    if ((orec.seasons || []).some((x) => !x.rewarded)) orec = await rkSeasonRewardsM(other, env, id, orec);
    const oreward = !!(orec.reward && !orec.reward.seen);
    const ladder = { mode, open, songs, songsNeeded: RK_MIN_SONGS, testing: !open && staff,
      elsewhere: orec.active || oreward ? { mode: other, match: orec.active || null, reward: oreward } : null };
    if (a && !a.over) return reply({ ...ladder, season: seasonOut, rank: rkPublic(rec), unlocked: unlock.ok, plays: unlock.plays, needed: RK_UNLOCK_PLAYS, match: rkView(a.m, a.me, now) });
    if (a) rec = await rkLoadM(mode, env, id); // its result has just moved the rank
    const pl = rec.placement;
    return reply({ ...ladder, season: seasonOut, rank: rkPublic(rec, await rkLegendNoM(mode, env, id, rec)), unlocked: unlock.ok, plays: unlock.plays, needed: RK_UNLOCK_PLAYS,
      placement: rec.placed ? null : { started: !!pl, step: pl ? pl.results.length : 0, total: 3, song: pl ? pl.charts[pl.results.length] || null : null, results: pl ? pl.results : [] },
      recent: rec.recent.slice(0, 10), ended: a ? rkView(a.m, a.me, now) : null, match: null, invites: await invitesOf(), invited: invitedOut(), reward: rewardOut() });
  }
  if (what === "board") {
    const all = (await r2json(env, rkBoardKey(mode), { players: {} })).players || {};
    const list = Object.entries(all).filter(([pid, p]) => p.season === season.n && !moderation.bans[pid] && !isOfficial(pid))
      .sort((x, y) => y[1].tier - x[1].tier || (x[1].tier >= RK_LEGEND ? y[1].rating - x[1].rating : y[1].progress - x[1].progress) || y[1].wins - x[1].wins);
    const players = list.slice(0, 100).map(([pid, p], i) => ({ id: pid, name: p.name, tier: p.tier, rank: RK_NAMES[p.tier] || "Rookie", progress: p.progress,
      wins: p.wins || 0, losses: p.losses || 0, platform: p.platform || "", place: i + 1, legend: p.tier >= RK_LEGEND ? i + 1 : null }));
    const mine = list.findIndex(([pid]) => pid === id);
    return reply({ season: season.n, ends: season.ends, players, me: mine >= 0 ? mine + 1 : null, total: list.length, mode });
  }
  // (staff only, for testing: start Ranked over, unplaced or at a given division)
  if (what === "reset") {
    if (!staff) fail(403, "Only Senterra and the official OCTIVE account can do that.");
    const tier = Number.isInteger(b.tier) && b.tier >= 1 && b.tier <= RK_LEGEND ? b.tier : 0;
    const fresh = rkFresh(season.n);
    fresh.unlocked = true;
    if (tier) Object.assign(fresh, { placed: true, tier, peak: tier, rating: 900 + tier * 60 });
    await r2put(env, rkPlayerKey(id, mode), fresh);
    await r2update(env, rkBoardKey(mode), () => ({ players: {} }), (d) => { d.players ||= {}; if (!d.players[id]) return false; delete d.players[id]; }).catch(() => {});
    await rkBoardSetM(mode, env, id, fresh, name);
    return reply({ ok: true, rank: rkPublic(fresh) });
  }
  const unlock = await rkUnlockedM(mode, env, id, rec);
  if (!unlock.ok) fail(403, `Ranked opens after ${RK_UNLOCK_PLAYS} played songs (you've played ${unlock.plays}).`);
  if (!staff && (what === "placement/start" || what === "queue" || what === "friendly/invite")) {
    const songs = await rkPoolSongs(env, mode);
    if (songs < RK_MIN_SONGS) fail(403, `${mode}K Ranked opens once the Workshop has ${RK_MIN_SONGS} verified ${mode}K songs (${songs} so far).`);
  }

  // ---- placement: three solo songs, each shown only when it's up
  if (what === "placement/start") {
    if (rec.placed) fail(400, "You've already been placed this season.");
    if (!rec.placement) {
      const pool = await rkPoolM(mode, env), rnd = seededRandom(rkSeed()), used = new Set(), charts = [];
      for (const [lo, hi] of RK_PLACE_BANDS) {
        const c = rkPick(pool, lo, hi + 0.001, 1, used, rnd)[0];
        if (!c) fail(503, "There aren't enough verified charts for placement yet.");
        used.add(c.songId); charts.push(c);
      }
      rec = await rkChangeM(mode, env, id, (d) => { if (d.placed || d.placement) return false; d.placement = { charts, results: [], started: now }; });
    }
    const pl = rec.placement;
    if (!pl) fail(400, "You've already been placed this season.");
    return reply({ step: pl.results.length, total: 3, song: pl.charts[pl.results.length] || null, results: pl.results });
  }
  if (what === "placement/submit" || what === "placement/quit") {
    const pl = rec.placement;
    if (rec.placed || !pl) fail(400, "There's no placement going on.");
    const step = pl.results.length, c = pl.charts[step];
    if (!c) fail(400, "Placement is already done.");
    let entries;
    if (what === "placement/quit") {
      // quitting a placement song fails all three
      entries = pl.charts.map((x) => ({ stars: x.stars, acc: 0, failed: true, quit: true, level: round2(rkLevel(x.stars, 0, true, false)) }));
    } else {
      if (Number(b.step) !== step) fail(409, "That placement song was already sent.");
      const result = await rkJudge(env, who, b, c, `ranked placement ${step + 1}`);
      const acc = round2(result.accuracy), failed = b.failed === true;
      entries = [...pl.results, { stars: c.stars, acc, failed, fc: !!result.fullCombo && !failed, level: round2(rkLevel(c.stars, acc, failed, !!result.fullCombo)) }];
      if (result.signature) await rememberReplay(env, rkScope(c), id, result.signature);
    }
    let done = false;
    rec = await rkChangeM(mode, env, id, (d) => {
      if (d.placed || !d.placement || d.placement.results.length !== step) return false;
      d.placement.results = entries;
      if (entries.length < 3) return;
      const level = Math.max(...entries.map((x) => x.level));
      Object.assign(d, { tier: rkTierOfLevel(level), progress: 0, placed: true });
      d.peak = Math.max(d.peak || 0, d.tier); d.rating = 900 + d.tier * 60; d.placedWith = { level: round2(level), at: new Date(now).toISOString() };
      if (platform) d.platform = platform;
      done = true;
    });
    if (done) {
      await rkBoardSetM(mode, env, id, rec, name);
      return reply({ done: true, level: rec.placedWith.level, rank: rkPublic(rec), results: rec.placement.results });
    }
    const p2 = rec.placement || { results: [], charts: [] };
    return reply({ done: !!rec.placed, step: p2.results.length, total: 3, song: p2.charts[p2.results.length] || null, results: p2.results, rank: rkPublic(rec) });
  }
  // ---- friendly matches: the Ranked format against a player you invite, nothing on the line (no rank, no AI opponents)
  if (what === "friendly/invite") {
    const to = String(b.to || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(to) || to === id || moderation.bans[to] || isOfficial(to)) fail(400, "That player can't be invited.");
    if (rec.invited && rec.invited.to !== to && now - rec.invited.at < 10_000) fail(429, "Wait a moment before inviting someone else.");
    const toName = await rkName(env, to);
    await r2update(env, rkInviteKey(to), () => ({ invites: {} }), (d) => {
      d.invites ||= {};
      for (const [k, v] of Object.entries(d.invites)) if (now - v.at > RK_INVITE_TTL) delete d.invites[k];
      d.invites[id] = { name, at: now, tier: rec.placed ? rec.tier : 0, mode };
    });
    if (rec.invited && rec.invited.to !== to)
      await r2update(env, rkInviteKey(rec.invited.to), () => ({ invites: {} }), (d) => { if (!d.invites || !d.invites[id]) return false; delete d.invites[id]; }).catch(() => {});
    rec = await rkChangeM(mode, env, id, (d) => { d.invited = { to, name: toName, at: now }; });
    // a pop-up in their game
    await r2update(env, `chat/pings/${to}.json`, () => ({ items: [] }), (pg) => {
      pg.items = (pg.items || []).filter((x) => !(x.kind === "friendly" && x.byId === id))
        .concat([{ id: `friendly-${id}-${now}`, at: now, kind: "friendly", by: name, byId: id, text: `${name} challenged you to a friendly ${mode === 7 ? "7K " : ""}Ranked match. Open Ranked to play.` }]).slice(-20);
    }).catch((e) => console.log("friendly ping", e && e.message));
    return reply({ ok: true, invited: invitedOut() });
  }
  if (what === "friendly/cancel") {
    const inv = rec.invited;
    if (inv) {
      await r2update(env, rkInviteKey(inv.to), () => ({ invites: {} }), (d) => { if (!d.invites || !d.invites[id]) return false; delete d.invites[id]; }).catch(() => {});
      await rkChangeM(mode, env, id, (d) => { d.invited = null; });
    }
    return reply({ ok: true });
  }
  if (what === "friendly/accept" || what === "friendly/decline") {
    const from = String(b.from || "");
    let inv = null;
    await r2update(env, rkInviteKey(id), () => ({ invites: {} }), (d) => { d.invites ||= {}; inv = d.invites[from] || null; if (!inv) return false; delete d.invites[from]; });
    if (!inv || now - inv.at > RK_INVITE_TTL) fail(404, "That invite has run out.");
    if (rkMode(inv.mode) !== mode) { mode = rkMode(inv.mode); rec = await rkLoadM(mode, env, id); } // (the invite's ladder)
    const frec = await rkLoadM(mode, env, from);
    if (!frec.invited || frec.invited.to !== id) fail(409, "They've invited someone else since.");
    if (what === "friendly/decline") { await rkChangeM(mode, env, from, (d) => { if (d.invited && d.invited.to === id) d.invited.declined = true; }); return reply({ ok: true }); }
    if (frec.active) fail(409, "They're in another match right now.");
    const a = await activeMatch();
    if (a && !a.over) fail(409, "Finish your match first.");
    const m = rkNewMatchM(mode, rkNewId(), { id: from, name: inv.name || await rkName(env, from), tier: frec.placed ? frec.tier : 0, rating: Math.round(frec.rating), platform: frec.platform || "" },
      { id, name, tier: rec.placed ? rec.tier : 0, rating: Math.round(rec.rating), platform: platform || rec.platform || "" }, now, new Set());
    m.kind = "friendly"; m.accepted = [true, true]; // (both said yes already: straight to the bans)
    await r2put(env, rkMatchKey(m.id), m);
    await rkLiveIndex(env, m);
    await rkChangeM(mode, env, id, (d) => { d.active = m.id; });
    await rkChangeM(mode, env, from, (d) => { d.active = m.id; d.invited = null; });
    return reply({ match: rkView(m, 1, now) });
  }
  if (!rec.placed && what === "queue") fail(400, "Play your placement songs first."); // (friendly matches don't need it)

  // ---- the queue: a real opponent near your rank, or an AI one after a random 7-11 seconds (drawn when the search starts)
  if (what === "queue") {
    const action = String(b.action || "poll");
    const a = action === "leave" ? null : await activeMatch();
    if (a && !a.over) return reply({ match: rkView(a.m, a.me, now) });
    const newId = rkNewId();
    let pair = null, joined = null, bot = false, since = now;
    await r2update(env, rkQueueKey(mode), () => ({ players: {} }), (q) => {
      pair = null; joined = null; bot = false;
      q.players ||= {};
      // (the game asks twice a second while searching: the list is only written when something changed, or every 4 s to
      // say the player is still there)
      let changed = false;
      for (const [pid, e] of Object.entries(q.players)) if (now - e.seen > RK_QUEUE_STALE || (e.match && now - e.matchAt > RK_RESERVE)) { delete q.players[pid]; changed = true; }
      if (action === "leave") { if (!q.players[id]) return changed ? undefined : false; delete q.players[id]; return; }
      let mine = q.players[id];
      if (mine && mine.match) { joined = mine.match; if (now - mine.seen > 4000) { mine.seen = now; return; } return changed ? undefined : false; }
      if (!mine) { mine = q.players[id] = { since: now, botAfter: RK_BOT_MIN + Math.floor(Math.random() * (RK_BOT_MAX - RK_BOT_MIN + 1)) }; changed = true; }
      if (mine.tier !== rec.tier || mine.name !== name) { mine.tier = rec.tier; mine.name = name; changed = true; }
      if (!(now - mine.seen <= 4000)) { mine.seen = now; changed = true; }
      since = mine.since;
      const other = Object.entries(q.players).filter(([pid, e]) => pid !== id && !e.match && Math.abs(e.tier - rec.tier) <= 4)
        .sort((x, y) => Math.abs(x[1].tier - rec.tier) - Math.abs(y[1].tier - rec.tier) || x[1].since - y[1].since)[0];
      if (other) { other[1].match = newId; other[1].matchAt = now; pair = other[0]; delete q.players[id]; return; }
      // nobody near your rank: an AI opponent once this search's wait is up (never at Champion or Legend)
      if (now - mine.since >= (mine.botAfter || RK_BOT_MAX) && rec.tier <= RK_BOT_MAX_TIER) { bot = true; delete q.players[id]; return; }
      if (!changed) return false;
    });
    if (action === "leave") return reply({ left: true });
    if (pair || bot) {
      const taken = bot ? new Set(Object.values((await r2json(env, rkBoardKey(mode), { players: {} })).players || {}).map((p) => String(p.name || "").toLowerCase())) : new Set();
      const orec = pair ? await rkLoadM(mode, env, pair) : null;
      const mine = { id, name, tier: rec.tier, rating: Math.round(rec.rating), platform: platform || rec.platform || "" };
      const them = pair ? { id: pair, name: await rkName(env, pair), tier: orec.tier, rating: Math.round(orec.rating), platform: orec.platform || "" } : null;
      const m = rkNewMatchM(mode, newId, mine, them, now, taken);
      await r2put(env, rkMatchKey(m.id), m);
      await rkLiveIndex(env, m);
      await rkChangeM(mode, env, id, (d) => { d.active = m.id; if (platform) d.platform = platform; });
      if (pair) await rkChangeM(mode, env, pair, (d) => { d.active = m.id; });
      return reply({ match: rkView(m, 0, now) });
    }
    if (joined) {
      const m = await r2json(env, rkMatchKey(joined), null);
      if (!m) return reply({ waiting: true, since, now, found: true }); // the other player's request is still making it
      await r2update(env, rkQueueKey(mode), () => ({ players: {} }), (q) => { if (!q.players || !q.players[id]) return false; delete q.players[id]; });
      await rkChangeM(mode, env, id, (d) => { d.active = m.id; if (platform) d.platform = platform; });
      return reply({ match: rkView(m, m.players[0].id === id ? 0 : 1, now) });
    }
    return reply({ waiting: true, since, now }); // (never says whether an AI opponent may come: they stay hidden)
  }

  // ---- the play of a round as it's played (for anyone watching): every second or two, the new inputs and where the song is
  if (what === "live/push") {
    const { m, me } = await openMatch(b.match);
    const r = m.rounds[m.rounds.length - 1];
    if (m.state !== "play" || !r || r.pick === null || r.n !== Number(b.round)) return reply({ ok: false });
    const from = Math.max(0, Math.floor(Number(b.from) || 0));
    const add = (Array.isArray(b.inputs) ? b.inputs : []).slice(0, 9000).map((x) => Math.round(Number(x) || 0));
    let need = null;
    await r2update(env, rkLiveKey(m.id, r.n, me), () => ({ inputs: [], now: 0, at: 0 }), (d) => {
      d.inputs ||= [];
      need = null;
      const have = Math.floor(d.inputs.length / 3);
      if (from > have) { need = have; return false; } // a gap: send from there
      const fresh = add.slice((have - from) * 3);
      if (d.inputs.length + fresh.length > 120_000) return false;
      d.inputs = d.inputs.concat(fresh);
      d.now = Math.round(Number(b.now) || 0); d.at = now; d.ended = b.ended === true; d.left = b.left === true;
    });
    return reply(need !== null ? { need } : { ok: true });
  }

  // ---- a finished match's details, its plays and reporting the opponent
  if (what === "history") {
    const { m, me } = await openMatch(b.match);
    return reply({ match: rkSummary(m, me) });
  }
  if (what === "replay") {
    const { m, me } = await openMatch(b.match);
    const r = m.rounds.find((x) => x.n === Number(b.round));
    if (!r || r.pick === null) fail(404, "That round can't be found.");
    const idx = b.who === "opp" ? 1 - me : me;
    if (idx !== me && r.winner === null) fail(409, "Their play shows once the round is over.");
    const p = m.players[idx];
    let bytes = null;
    if (p.bot) bytes = r.live ? await rkBotReplay(m, r, p) : null;
    else { const o = await env.RELEASES.get(rkReplayKey(m.id, r.n, idx)); if (o) bytes = new Uint8Array(await o.arrayBuffer()); }
    if (!bytes) fail(404, "That play wasn't kept.");
    return reply({ replay: rkB64(bytes), name: p.name });
  }
  if (what === "report") {
    const { m, me } = await openMatch(b.match);
    const opp = m.players[1 - me];
    if (!opp || opp.bot) return reply({ ok: true }); // (an AI opponent: nothing to send; they stay hidden)
    await fileReport(env, who, opp.id, b.reason, b.details, `Ranked match ${m.id}`);
    return reply({ ok: true });
  }

  // ---- a match: accept, bans, rounds, leaving
  if (["match", "accept", "ban", "round", "forfeit"].includes(what)) {
    const { m: peek, me } = await openMatch(b.match);
    mode = rkMode(peek.mode); // (the match's ladder: whose records it clears)
    let judged = null;
    if (what === "round") {
      // judged before the match is changed (judging takes a moment, and both players can send at once)
      await rkAdvance(env, peek, now);
      const r = peek.rounds[peek.rounds.length - 1];
      if (peek.state !== "play" || !r || r.pick === null || r.n !== Number(b.round)) fail(409, "This round isn't being played any more.");
      if (!r.results[me]) {
        const c = r.charts[r.pick];
        if (c.len > 0 && now - r.playFrom < c.len * 1000 * 0.6) fail(409, "That play finished too quickly.");
        const result = await rkJudge(env, who, b, c, `ranked match ${peek.id} round ${r.n}`);
        judged = { n: r.n, acc: round2(result.accuracy), score: result.score, maxCombo: result.maxCombo, fullCombo: !!result.fullCombo, failed: b.failed === true, at: now, sig: result.signature, scope: rkScope(c) };
        // the play itself is kept for the match's history (watch it, or both side by side)
        const rep = replayBytes(b.replay);
        if (rep) { try { await env.RELEASES.put(rkReplayKey(peek.id, r.n, me), rep, { httpMetadata: { contentType: "application/gzip" } }); judged.kept = true; } catch (e) { console.log("ranked replay", e && e.message); } }
        // the server times every round: a play sent back far later than the song is long may come from a slowed-down game
        if (c.len > 0 && now - r.playFrom > c.len * 1000 * 1.6 + 120_000)
          await flagPlayer(env, id, `ranked round took ${Math.round((now - r.playFrom) / 1000)} s for a ${c.len} s song (a slowed-down game?)`);
      }
    }
    let counted = false;
    const m = await rkUpdateMatch(env, peek.id, async (x) => {
      counted = false;
      await rkAdvance(env, x, now);
      const r = x.rounds[x.rounds.length - 1];
      if (what === "accept") { if (x.state !== "accept") return; x.accepted[me] = true; await rkAdvance(env, x, now); }
      else if (what === "ban") {
        const i = Number(b.index);
        if (x.state !== "bans" || !r || now < r.opens || r.bans[me] !== null || !Number.isInteger(i) || i < 0 || i >= r.charts.length) return;
        r.bans[me] = i; await rkAdvance(env, x, now);
      } else if (what === "round") {
        if (!judged || x.state !== "play" || !r || r.n !== judged.n || r.results[me]) return;
        r.results[me] = { acc: judged.acc, score: judged.score, maxCombo: judged.maxCombo, fullCombo: judged.fullCombo, failed: judged.failed, at: judged.at };
        if (judged.kept) { r.replays ||= [false, false]; r.replays[me] = true; }
        counted = true;
        await rkAdvance(env, x, now);
      } else if (what === "forfeit") {
        if (x.state === "done" || x.state === "cancelled") return;
        if (x.state === "accept") { x.state = "cancelled"; x.why = "The match was declined."; x.declined = [me === 0, me === 1]; return; }
        rkEnd(x, 1 - me, now, me);
      }
    });
    if (counted && judged.sig) await rememberReplay(env, judged.scope, id, judged.sig);
    await rkLiveIndex(env, m);
    if (m.state === "done" || m.state === "cancelled") await clearActive(m.id);
    return reply({ match: rkView(m, me, now, b.live === true) });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- missions, events and season collections (2.0)
// Weekly missions: four a week (Monday 00:00 UTC to the next), the same for everyone, picked from the week's number.
// They only count what the server judges itself: board plays on verified charts (with their replays), daily charts and
// Ranked rounds. A finished mission's points go straight into the wallet, and finishing all four adds a bonus.
// Events (run by Senterra or the official account): a name, a colour, some days and a pack of verified Workshop songs;
// their missions give points and the event's title, icon colour and animated frame (shop items nobody can buy).
// Season collections: four new shop items every Ranked season, for sale only while that season runs.
const WEEK_MS = 7 * 86_400_000, MISSION_BONUS = 400;
/** The week (Monday 00:00 UTC): its key ("YYYY-MM-DD"), when it ends and its number. */
function weekOf(now = Date.now()) {
  const d = new Date(now), back = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
  return { key: new Date(start).toISOString().slice(0, 10), start, ends: start + WEEK_MS, n: Math.round(start / WEEK_MS) };
}
const MISSION_KINDS = {
  plays: { title: (n) => `Play ${n} verified charts`, desc: "Any verified chart or OCTIVE song counts once it's on its leaderboard (its replay is judged).", targets: [15, 20, 25], points: [150, 200, 250] },
  acc95: { title: (n) => `Get 95%+ on ${n} different verified charts`, desc: "Accuracy as the server judges it from the play's replay.", targets: [3, 5, 6], points: [200, 250, 300] },
  fc: { title: (n) => `Full combo ${n} different verified charts`, desc: "No misses from the first note to the last.", targets: [2, 3, 4], points: [200, 250, 300] },
  fresh: { title: (n) => `Play ${n} verified charts that are new to you`, desc: "Charts you have no leaderboard score on yet.", targets: [3, 5, 6], points: [150, 200, 250] },
  daily: { title: (n) => `Play a daily chart on ${n} days`, desc: "Any of the day's daily charts counts for its day.", targets: [3, 4, 5], points: [200, 250, 300] },
  ranked: { title: (n) => `Win ${n} Ranked rounds`, desc: "Rounds of Ranked matches (friendly matches don't count).", targets: [3, 5, 6], points: [250, 300, 350] },
};
const MISSION_SLOTS = [["plays"], ["acc95", "fc"], ["daily", "fresh"], ["ranked", "fresh", "fc"]];
/** The week's missions: one from each slot (no kind twice), with the week's target and points. */
function weekMissions(wk = weekOf()) {
  const rnd = seededRandom(Math.imul(wk.n, 2654435761) >>> 0), used = new Set(), out = [];
  for (const slot of MISSION_SLOTS) {
    const left = slot.filter((k) => !used.has(k));
    if (!left.length) continue;
    const kind = left[Math.floor(rnd() * left.length) % left.length];
    used.add(kind);
    const def = MISSION_KINDS[kind], v = Math.floor(rnd() * def.targets.length) % def.targets.length;
    out.push({ id: `${wk.key}:${kind}`, kind, target: def.targets[v], points: def.points[v], title: def.title(def.targets[v]), desc: def.desc });
  }
  return out;
}

const EVENT_KEY = "events/current.json", EVENT_ITEMS_KEY = "events/items.json";
const EVENT_COLORS = [["#8FE8FF", "#FFFFFF"], ["#FF6A3D", "#FFC94D"], ["#FF4FA3", "#8A5CFF"], ["#39FFB0", "#3FA9FF"], ["#FFC94D", "#FF4FA3"], ["#A77BFF", "#3FE0C5"]];
let eventCache = null, eventCacheAt = 0, eventItemsAt = 0;
const eventLive = (ec, now = Date.now()) => !!ec && now >= Date.parse(ec.starts) && now < Date.parse(ec.ends);
/** The event record (its charts' board keys and its songs worked out), live or not; null when there's none. */
async function eventRecord(env, fresh = false) {
  if (!fresh && eventCacheAt && Date.now() - eventCacheAt < 60_000) return eventCache;
  const ec = await r2json(env, EVENT_KEY, null);
  let out = null;
  if (ec && ec.id) {
    const db = await judgeDb(env), keys = new Set(), songs = [];
    for (const itemId of ec.items || []) {
      const it = (db.items || []).find((x) => x.id === itemId);
      if (!it || it.removed || !it.meta) continue;
      for (const sg of it.meta.songs || []) {
        if (!sg || !sg.songId) continue;
        const set = Math.round(Number(sg.osuSet) || 0), board = set > 0 ? "osu-" + set : sg.songId;
        const charts = (sg.charts || []).filter((c) => (set > 0 && c.osuMd5) || c.chartId);
        for (const c of charts) keys.add(`${board}/${set > 0 && c.osuMd5 ? c.osuMd5 : c.chartId}`);
        const stars = charts.map((c) => Number(c.stars) || 0).filter((x) => x > 0);
        songs.push({ itemId: it.id, board, title: sg.title || it.title || "", artist: sg.artist || "", creator: it.creator || "", verified: !!it.verified, osuSet: set || undefined,
          charts: charts.length, starsLo: stars.length ? Math.min(...stars) : 0, starsHi: stars.length ? Math.max(...stars) : 0, keys: [...new Set(charts.map((c) => Number(c.keys) || 0))].filter((k) => k > 0) });
      }
    }
    out = { ...ec, keys: [...keys], songs };
  }
  eventCache = out; eventCacheAt = Date.now();
  return out;
}
async function eventNow(env) { const ec = await eventRecord(env); return eventLive(ec) ? ec : null; }

/** The event's rewards: shop items nobody can buy (kept in events/items.json, so players keep them after it). */
function eventRewardItems(ec) {
  const r = { price: 0, reward: true, minVersion: "2.0.0", note: `From the ${ec.name} event` };
  const year = new Date(Date.parse(ec.starts) || Date.now()).getUTCFullYear();
  return [
    { ...r, id: `title-ev-${ec.id}`, kind: "title", name: /\b\d{4}\b/.test(ec.name) ? ec.name : `${ec.name} ${year}` },
    { ...r, id: `iconcolor-ev-${ec.id}`, kind: "iconcolor", name: `${ec.name} icon colour`, color: ec.color },
    { ...r, id: `frame-ev-${ec.id}`, kind: "frame", name: `${ec.name} frame (animated)`, color: ec.color, color2: ec.color2, anim: "duo" },
  ];
}
/** Every event's reward items in the shop's list (read again every few minutes). */
async function ensureEventItems(env) {
  if (Date.now() - eventItemsAt < 300_000) return;
  eventItemsAt = Date.now();
  const d = await r2json(env, EVENT_ITEMS_KEY, { items: [] }).catch(() => ({ items: [] }));
  const have = new Set(SHOP.map((x) => x.id));
  for (const x of d.items || []) if (x && x.id && !have.has(x.id)) SHOP.push(x);
}
/** The event's missions: plays, 95%s and a full combo on its charts, and every one of its songs (2 or more). */
function eventMissions(ec) {
  const charts = ec.keys.length, songs = new Set(ec.songs.map((s) => s.board)).size;
  if (!charts) return [];
  const a = Math.min(3, charts), b = Math.min(2, charts);
  const out = [
    { kind: "evplay", target: a, points: 300, title: `Play ${a} different event charts`, reward: null },
    { kind: "ev95", target: b, points: 200, title: `Get 95%+ on ${b} event charts`, reward: `title-ev-${ec.id}` },
    { kind: "evfc", target: 1, points: 200, title: "Full combo an event chart", reward: `iconcolor-ev-${ec.id}` },
  ];
  if (songs >= 2) out.push({ kind: "evall", target: songs, points: 300, title: `Play every event song (${songs})`, reward: `frame-ev-${ec.id}` });
  return out.map((m) => ({ ...m, id: `${ec.id}:${m.kind}` }));
}

/**
 * Something that counts for missions: a judged board play {kind:"board", chart:"song/chart", acc, fc, fresh}, a daily
 * chart {kind:"daily", day} or a Ranked match {kind:"ranked", roundsWon}. Moves the week's (and the event's) missions;
 * finished ones pay out at once. Gives what was finished (for the game to show).
 */
async function missionEvent(env, id, ev) {
  if (!okPlayerId(id) || isOfficial(id)) return [];
  const wk = weekOf(), list = weekMissions(wk);
  const ec = ev.kind === "board" ? await eventNow(env).catch(() => null) : null;
  const evList = ec && ec.keys.includes(ev.chart) ? eventMissions(ec) : [];
  const free = infinitePoints(id), finished = [];
  await walletUpdate(env, id, (w) => {
    finished.length = 0;
    let changed = false;
    const once = (st, kind, key) => { st.seen[kind] ||= []; if (st.seen[kind].includes(key)) return 0; st.seen[kind] = [...st.seen[kind], key].slice(-80); return 1; };
    const pay = (title, points, item) => {
      if (!free) { w.balance = (w.balance || 0) + points; w.earned = (w.earned || 0) + points; }
      if (item && !w.owned.includes(item)) w.owned.push(item);
      remember(w, { kind: "mission", title, points, item: item || undefined });
      finished.push({ title, points, item: item || undefined });
    };
    if (!w.weekly || w.weekly.week !== wk.key) w.weekly = { week: wk.key, p: {}, seen: {}, done: [], bonus: false };
    const st = w.weekly;
    for (const m of list) {
      if (st.done.includes(m.kind)) continue;
      let add = 0;
      if (ev.kind === "board") {
        if (m.kind === "plays") add = 1;
        else if (m.kind === "acc95" && ev.acc >= 95) add = once(st, m.kind, ev.chart);
        else if (m.kind === "fc" && ev.fc) add = once(st, m.kind, ev.chart);
        else if (m.kind === "fresh" && ev.fresh) add = once(st, m.kind, ev.chart);
      } else if (ev.kind === "daily" && m.kind === "daily") add = once(st, m.kind, ev.day);
      else if (ev.kind === "ranked" && m.kind === "ranked") add = Math.max(0, Math.min(3, ev.roundsWon || 0));
      if (!add) continue;
      st.p[m.kind] = Math.min(m.target, (st.p[m.kind] || 0) + add);
      changed = true;
      if (st.p[m.kind] >= m.target) { st.done.push(m.kind); pay(m.title, m.points); }
    }
    if (!st.bonus && list.length && list.every((m) => st.done.includes(m.kind))) { st.bonus = true; changed = true; pay("Every mission this week", MISSION_BONUS); }
    if (evList.length) {
      if (!w.event || w.event.id !== ec.id) w.event = { id: ec.id, p: {}, seen: {}, done: [] };
      const es = w.event, song = String(ev.chart).split("/")[0];
      for (const m of evList) {
        if (es.done.includes(m.kind)) continue;
        let add = 0;
        if (m.kind === "evplay") add = once(es, m.kind, ev.chart);
        else if (m.kind === "ev95" && ev.acc >= 95) add = once(es, m.kind, ev.chart);
        else if (m.kind === "evfc" && ev.fc) add = once(es, m.kind, ev.chart);
        else if (m.kind === "evall") add = once(es, m.kind, song);
        if (!add) continue;
        es.p[m.kind] = Math.min(m.target, (es.p[m.kind] || 0) + add);
        changed = true;
        if (es.p[m.kind] >= m.target) { es.done.push(m.kind); pay(m.title, m.points, m.reward); }
      }
    }
    if (!changed) return false;
  });
  if (finished.some((f) => f.item)) await writeCosmetics(env, id, await walletOf(env, id)).catch(() => {});
  return finished;
}

/** Four new shop items every Ranked season, for sale only while it runs (owners keep them). */
// Season n is month RK_SEASON0_MONTH + n (Season 0 = November 2026), so the list runs Nov, Dec, Jan... (2.1.2: Glacier moved
// to December for the winter season, Cinder to June)
const SEASON_THEMES = [
  ["Borealis", "Chaser", "#3FE0C5", "#8A5CFF"], ["Glacier", "Soul", "#B9F2FF", "#3FA9FF"], ["Tidal", "Rider", "#2E7BFF", "#3FE0C5"],
  ["Bloom", "Dancer", "#FF8AD8", "#FFF06B"], ["Storm", "Caller", "#8FA8FF", "#FFFFFF"], ["Venom", "Fang", "#7CFF3D", "#1B1F5E"],
  ["Dusk", "Walker", "#FF4FA3", "#2F5BFF"], ["Cinder", "Heart", "#FF6A3D", "#FFC94D"], ["Solar", "Flare", "#FFC94D", "#FF2E00"],
  ["Nebula", "Drifter", "#A77BFF", "#FF6FB5"], ["Jade", "Spirit", "#1FCB76", "#FFF8E7"], ["Scarlet", "Tide", "#E0193A", "#FFB38A"],
];
function seasonCollection(n) {
  const [theme, noun, c1, c2] = SEASON_THEMES[n % SEASON_THEMES.length];
  const m = RK_SEASON0_MONTH + n;
  const from = new Date(Date.UTC(Math.floor(m / 12), m % 12, 1)).toISOString(), to = new Date(Date.UTC(Math.floor(m / 12), m % 12 + 1, 1)).toISOString();
  const base = { from, to, collection: n, minVersion: "2.0.0", note: `Season ${n} collection: only in the shop until the season ends` };
  return [
    { ...base, id: `frame-sc${n}-duo`, kind: "frame", name: `${theme} frame (animated)`, color: c1, color2: c2, anim: "duo", price: 3500 },
    { ...base, id: `frame-sc${n}`, kind: "frame", name: `${theme} frame`, color: c1, price: 900 },
    { ...base, id: `iconcolor-sc${n}`, kind: "iconcolor", name: `${theme} icon colour`, color: c1, price: 300 },
    { ...base, id: `title-sc${n}`, kind: "title", name: `${theme} ${noun}`, price: 600 },
  ];
}
let seasonColUpTo = -1;
function ensureSeasonCollections() {
  const want = rkSeason().n;
  if (seasonColUpTo >= want) return;
  const have = new Set(SHOP.map((x) => x.id));
  for (let n = 0; n <= want; n++) for (const x of seasonCollection(n)) if (!have.has(x.id)) SHOP.push(x);
  seasonColUpTo = want;
}

/** The Missions page: this week's missions, the event (if one is on) and the season's new shop items. */
async function missionsView(env, who) {
  const wk = weekOf(), list = weekMissions(wk);
  const w = who ? await walletOf(env, who.playerId) : null;
  const st = w && w.weekly && w.weekly.week === wk.key ? w.weekly : { p: {}, done: [], bonus: false };
  const ec = await eventNow(env).catch(() => null);
  const es = ec && w && w.event && w.event.id === ec.id ? w.event : { p: {}, done: [] };
  ensureSeasonCollections();
  const sn = rkSeason();
  return {
    week: wk.key, ends: new Date(wk.ends).toISOString(),
    missions: list.map((m) => ({ id: m.id, kind: m.kind, title: m.title, desc: m.desc, target: m.target, progress: Math.min(m.target, st.p[m.kind] || 0), points: m.points, done: st.done.includes(m.kind) })),
    bonus: { points: MISSION_BONUS, done: !!st.bonus },
    event: ec ? {
      id: ec.id, name: ec.name, color: ec.color, color2: ec.color2, starts: ec.starts, ends: ec.ends, songs: ec.songs,
      missions: eventMissions(ec).map((m) => ({ id: m.id, kind: m.kind, title: m.title, target: m.target, progress: Math.min(m.target, es.p[m.kind] || 0), points: m.points, reward: m.reward, done: es.done.includes(m.kind) })),
      rewards: eventRewardItems(ec),
    } : null,
    collection: { season: sn.n, ends: new Date(sn.ends).toISOString(), items: seasonCollection(sn.n) },
  };
}

/** Staff: an event's start, songs, end and announcement (Senterra and the official account; the command bar's /event). */
async function eventAdmin(env, who, b) {
  if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account can run events.");
  const action = String(b.action || "status"), now = Date.now();
  let ec = await r2json(env, EVENT_KEY, null);
  const save = async () => { await r2put(env, EVENT_KEY, ec); eventCacheAt = 0; };
  const itemIdOf = (v) => { const m = /([a-z0-9]{16,40})\s*$/i.exec(String(v || "").trim()); return m ? m[1].toLowerCase() : ""; };
  const describe = async () => {
    const r = await eventRecord(env, true);
    if (!r) return "No event.";
    const live = eventLive(r), when = live ? `ends ${r.ends.slice(0, 10)}` : now < Date.parse(r.starts) ? `starts ${r.starts.slice(0, 10)}` : `ended ${r.ends.slice(0, 10)}`;
    return `${r.name} (${when}): ${r.songs.length} songs, ${r.keys.length} charts.` + (r.songs.some((s) => !s.verified) ? " Some songs aren't verified: their plays aren't judged, so they don't count." : "");
  };
  if (action === "start") {
    // (2.1.2) "2026-12-01 Winter Festival" sets it up to begin that day (midnight UTC) instead of now
    let startAt = now, rawName = String(b.name || "");
    const dated = /^\s*(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(rawName);
    if (dated) {
      const t = Date.parse(dated[1] + "T00:00:00Z");
      if (!(t > now - 86_400_000 && t < now + 60 * 86_400_000)) fail(400, "The start date must be within the next 60 days (YYYY-MM-DD before the name).");
      startAt = Math.max(now, t); rawName = dated[2];
    }
    const name = cleanText(rawName, 40);
    if (name.length < 3) fail(400, "Give the event a name (3 to 40 letters).");
    const days = Math.round(Number(b.days) || 0);
    if (!(days >= 1 && days <= 60)) fail(400, "An event runs 1 to 60 days.");
    if (eventLive(ec, now)) fail(409, `${ec.name} is still on: end it first (/event end).`);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "event";
    const pick = EVENT_COLORS[[...slug].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % EVENT_COLORS.length];
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(b.color || "")) ? String(b.color).toUpperCase() : pick[0];
    ec = { id: `${slug}-${new Date(startAt).toISOString().slice(0, 10).replace(/-/g, "")}`, name, color, color2: color === pick[0] ? pick[1] : "#FFFFFF",
      starts: new Date(startAt).toISOString(), ends: new Date(startAt + days * 86_400_000).toISOString(), items: [], by: who.playerId, at: new Date(now).toISOString() };
    await save();
    await r2update(env, EVENT_ITEMS_KEY, () => ({ items: [] }), (d) => { d.items ||= []; const have = new Set(d.items.map((x) => x.id)); for (const x of eventRewardItems(ec)) if (!have.has(x.id)) d.items.push(x); });
    eventItemsAt = 0;
    const when = startAt > now + 60_000 ? `set to start ${new Date(startAt).toISOString().slice(0, 10)}` : "started";
    return { ok: true, text: `${name} ${when}: ${days} days. Add its songs with /event add <Workshop link or id>, then /event announce.` };
  }
  if (!ec) fail(404, "There's no event. Start one: /event start <days> <name>");
  if (action === "add" || action === "remove") {
    const id = itemIdOf(b.item);
    if (!id) fail(400, "Give a Workshop link or item id.");
    if (action === "add") {
      const it = ((await judgeDb(env)).items || []).find((x) => x.id === id);
      if (!it || it.removed || it.type !== "charts") fail(404, "That Workshop chart can't be found.");
      if (!it.verified) fail(400, `"${it.title}" isn't verified: only verified songs' plays are judged, so verify it first.`);
      ec.items = [...new Set([...(ec.items || []), id])].slice(0, 30);
    } else ec.items = (ec.items || []).filter((x) => x !== id);
    await save();
    return { ok: true, text: await describe() };
  }
  if (action === "end") { ec.ends = new Date(now).toISOString(); await save(); return { ok: true, text: `${ec.name} ended.` }; }
  if (action === "announce") {
    const r = await eventRecord(env, true);
    if (!eventLive(r)) fail(400, "The event isn't on.");
    if (!r.songs.length) fail(400, "Add its songs first (/event add).");
    const item = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), at: new Date(now).toISOString(), kind: "custom", title: `${r.name} has started`,
      message: `A new event until ${new Date(Date.parse(r.ends)).toUTCString().slice(5, 16)}: play its ${r.songs.length} songs for points, a title, an icon colour and an animated frame. Open Daily & Shop → Missions.`,
      fromId: who.playerId, fromName: isOfficial(who.playerId) ? "OCTIVE" : await displayName(env, who.playerId) };
    await r2update(env, "notices/everyone.json", () => ({ items: [] }), (d) => { d.items = [item, ...(d.items || [])].slice(0, 50); });
    return { ok: true, text: "Everyone was told (News)." };
  }
  return { ok: true, text: await describe() };
}

// ---------------------------------------------------------------- crews (2.0)
// Small teams of up to 12: a name, a 2-4 letter tag shown beside members' names, a colour. The owner invites players
// (they accept from their notifications), can remove members and edit the crew; anyone can leave. A crew's score is the
// sum of its 5 best members' PR (the server's ranking PR), so bigger isn't better past five. R2: crews/<id>.json, and
// crews/index.json for the crew board and name / tag checks; a player's crew is on their wallet (w.crew: id, tag, colour),
// so it goes out with their cosmetics like a title.
const CREW_MAX = 12, CREW_INDEX = "crews/index.json";
const crewKey = (id) => `crews/${id}.json`;
/** (2.0.2) A crew's chat: crews/chat/<id>.json { seq, msgs: [{ seq, id, at, text, from: { id, name } }] }. */
const crewChatKey = (id) => `crews/chat/${id}.json`;
const CREW_CHAT_KEEP = 150;
const CREW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{1,22}[A-Za-z0-9.']$/, CREW_TAG_RE = /^[A-Z0-9]{2,4}$/;
const CREW_TAG_RESERVED = ["DEV", "MOD", "OCT", "GM", "ADMN", "STAF", "OCTV", "BOT", "AI"];
function crewCheck(name, tag, staff) {
  if (!CREW_NAME_RE.test(name)) fail(400, "A crew name is 3 to 24 letters, numbers, spaces and - _ . '");
  if (!CREW_TAG_RE.test(tag)) fail(400, "A tag is 2 to 4 capital letters or numbers.");
  if (!staff && (/octive|official|moderat|admin|developer/i.test(name) || CREW_TAG_RESERVED.includes(tag))) fail(400, "That name or tag is kept for OCTIVE.");
}
const crewColor = (c) => (/^#[0-9A-Fa-f]{6}$/.test(String(c || "")) ? String(c).toUpperCase() : "#3FD8FF");
/** What a member's cosmetics carry: the crew's id, tag and colour. */
const crewBadge = (c) => ({ id: c.id, tag: c.tag, color: c.color });

/** The sum of the 5 best members' PR (from their ranking records). */
async function crewScore(env, c) {
  const pps = await Promise.all((c.members || []).map(async (m) => { const r = await r2json(env, `rank/players/${m.id}.json`, null); return r && Number(r.pp) > 0 ? round2(Number(r.pp)) : 0; }));
  (c.members || []).forEach((m, i) => { m.pp = pps[i]; });
  return round2([...pps].sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0));
}
/** Writes the crew's line on the crew board (or takes it off when it's gone). */
async function crewIndexSet(env, c) {
  await r2update(env, CREW_INDEX, () => ({ crews: {} }), (d) => {
    d.crews ||= {};
    if (!c || c.gone) { if (c) delete d.crews[c.id]; return; }
    d.crews[c.id] = { name: c.name, tag: c.tag, color: c.color, members: (c.members || []).length, score: c.score || 0, updated: new Date(Date.now()).toISOString() };
  });
}
/** Puts a player's crew on their wallet and cosmetics (null: none). */
async function crewSetMember(env, playerId, c) {
  const w = await walletUpdate(env, playerId, (w) => { if (c) w.crew = crewBadge(c); else { if (!w.crew) return false; delete w.crew; } });
  if (w) await writeCosmetics(env, playerId, w);
}
async function crewOfPlayer(env, playerId) { const w = await walletOf(env, playerId); return w.crew && w.crew.id ? await r2json(env, crewKey(w.crew.id), null) : null; }
function crewPublic(c, me) {
  return { id: c.id, name: c.name, tag: c.tag, color: c.color, desc: c.desc || "", owner: c.owner, created: c.created, score: c.score || 0,
    members: (c.members || []).map((m) => ({ id: m.id, name: m.name, role: m.id === c.owner ? "owner" : "member", joined: m.joined, pp: m.pp || 0 })).sort((a, b) => (b.role === "owner") - (a.role === "owner") || b.pp - a.pp),
    invites: me && me === c.owner ? (c.invites || []).map((x) => ({ id: x.id, name: x.name, at: x.at })) : undefined,
    invited: me ? (c.invites || []).some((x) => x.id === me) : undefined, max: CREW_MAX, wars: c.wars || { wins: 0, podiums: 0 } };
}
/** Keeps a member's PR on their crew current (from the ranking sync): only when it moved. */
async function crewTouch(env, playerId, pp) {
  const w = await walletOf(env, playerId);
  if (!w.crew || !w.crew.id) return;
  const cur = await r2json(env, crewKey(w.crew.id), null);
  if (!cur || cur.gone) return;
  const m = (cur.members || []).find((x) => x.id === playerId);
  if (!m || Math.abs((m.pp || 0) - pp) < 0.5) return;
  let out = null;
  await r2update(env, crewKey(cur.id), () => null, (c) => {
    if (!c || c.gone) return false;
    const mm = (c.members || []).find((x) => x.id === playerId);
    if (!mm) return false;
    mm.pp = round2(pp);
    c.score = round2((c.members || []).map((x) => x.pp || 0).sort((a, b) => b - a).slice(0, 5).reduce((s, x) => s + x, 0));
    out = c;
  });
  if (out) await crewIndexSet(env, out);
}

// =====================================================================================================
// Crew wars (2.0): every week, five verified 4K charts (one per difficulty band, the same for everyone). A crew's war
// score is the sum, over the five, of its best member's PR on each (judged leaderboard plays during that week).
// When the week ends the top three crews win: every member gets points, the crew keeps the trophy count.
//   crews/war/<week>.json  { week, ends, charts: [...], crews: { crewId: { name, tag, color, best: { chartKey: { pp, by, name } }, total } }, settled }
// =====================================================================================================
const warKey = (wk) => `crews/war/${wk}.json`;
const WAR_BANDS = [[1.5, 2.5], [2.5, 3.5], [3.5, 4.5], [4.5, 5.5], [5.5, 99]];
const WAR_PRIZES = [500, 300, 150];

/** The week's five charts: verified 4K difficulties, one per band, picked by the week (so everyone gets the same). */
async function warCharts(env, wk) {
  const db = await r2json(env, WS_DB, { items: [] });
  const pool = [];
  for (const it of db.items || []) {
    if (it.removed || it.type !== "charts" || !it.verified) continue;
    for (const c of wsChartsOf(it)) {
      const st = Number(c.stars) || 0, keys = Number(c.keys) || 4;
      if (keys !== 4 || st < 1) continue;
      const key = wsChartKey(c);
      pool.push({ key, songId: c.songId, chartId: c.chartId, osuMd5: c.osuMd5 || undefined, osuSet: Number(c.osuSet) || undefined, itemId: it.id,
        title: String(it.title || "").slice(0, 80), difficulty: String(c.difficulty || c.name || "").slice(0, 60), stars: round2(st), keys });
    }
  }
  const rnd = seededRandom(((wk.n * 2654435761) >>> 0) || 1);
  const picked = [], used = new Set();
  for (const [lo, hi] of WAR_BANDS) {
    const band = pool.filter((c) => c.stars >= lo && c.stars < hi && !used.has(c.itemId));
    const from = band.length ? band : pool.filter((c) => !used.has(c.itemId));
    if (!from.length) continue;
    const c = from[Math.floor(rnd() * from.length) % from.length];
    picked.push(c);
    used.add(c.itemId);
  }
  return picked.sort((a, b) => a.stars - b.stars);
}

/** This week's war (made on first use). */
async function warNow(env, wk = weekOf()) {
  let w = await r2json(env, warKey(wk.key), null);
  if (!w) {
    const fresh = { week: wk.key, ends: new Date(wk.ends).toISOString(), charts: await warCharts(env, wk), crews: {} };
    // another request may have made it meanwhile: theirs stays
    w = await r2update(env, warKey(wk.key), () => fresh, (cur) => { if (cur !== fresh) return false; });
  }
  return w;
}

/** A judged leaderboard play: when its chart is in this week's war and the player is in a crew, it may raise the crew's best. */
async function warPlay(env, playerId, board, chartId, pp) {
  if (!(pp > 0)) return;
  const wk = weekOf();
  const w = await warNow(env, wk);
  const key = `${board}/${chartId}`;
  const ch = (w.charts || []).find((c) => c.key === key);
  if (!ch) return;
  const crew = await crewOfPlayer(env, playerId);
  if (!crew || crew.gone) return;
  const name = await rkName(env, playerId).catch(() => "");
  await r2update(env, warKey(wk.key), () => w, (d) => {
    d.crews ||= {};
    const c = d.crews[crew.id] ||= { name: crew.name, tag: crew.tag, color: crew.color, best: {}, total: 0 };
    Object.assign(c, { name: crew.name, tag: crew.tag, color: crew.color });
    const cur = c.best[key];
    if (cur && cur.pp >= pp) return false;
    c.best[key] = { pp: round2(pp), by: playerId, name };
    c.total = round2(Object.values(c.best).reduce((s2, x) => s2 + (x.pp || 0), 0));
  });
}

function warStandings(w) {
  return Object.entries(w.crews || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).map((c, i) => ({ ...c, rank: i + 1 }));
}

/** A finished week: the top three crews' members get points and a notice; the crew keeps a trophy. Once. */
async function warSettle(env, wkKey) {
  let w = null;
  await r2update(env, warKey(wkKey), () => null, (d) => { if (!d || d.settled) return false; d.settled = new Date(Date.now()).toISOString(); w = d; });
  if (!w) return;
  const top = warStandings(w).filter((c) => c.total > 0).slice(0, WAR_PRIZES.length);
  for (const [i, c] of top.entries()) {
    const crew = await r2json(env, crewKey(c.id), null);
    if (!crew || crew.gone) continue;
    await r2update(env, crewKey(c.id), () => null, (x) => { if (!x || x.gone) return false; x.wars ||= { wins: 0, podiums: 0 }; x.wars.podiums++; if (i === 0) x.wars.wins++; });
    const prize = WAR_PRIZES[i];
    for (const m of crew.members || []) {
      await walletUpdate(env, m.id, (wl) => { wl.balance += prize; wl.earned = (wl.earned || 0) + prize; remember(wl, { kind: "crew-war", place: i + 1, points: prize, week: wkKey }); }).catch(() => {});
      await addNotice(env, m.id, { kind: "crew", what: "war", place: i + 1, points: prize, crewId: c.id, tag: crew.tag, crewName: crew.name, week: wkKey }).catch(() => {});
    }
  }
}

/** The hourly check: last week's war is settled once it's over. */
async function warTick(env) {
  const last = weekOf(Date.now() - 7 * 86_400_000);
  const w = await r2json(env, warKey(last.key), null);
  if (w && !w.settled) await warSettle(env, last.key);
}

async function warView(env, me, which) {
  const wk = which === "last" ? weekOf(Date.now() - 7 * 86_400_000) : weekOf();
  const w = which === "last" ? await r2json(env, warKey(wk.key), null) : await warNow(env, wk);
  if (!w) return { week: wk.key, charts: [], standings: [], mine: null };
  const all = warStandings(w);
  let mine = null;
  if (me) {
    const crew = await crewOfPlayer(env, me).catch(() => null);
    if (crew && !crew.gone) mine = all.find((c) => c.id === crew.id) || { id: crew.id, name: crew.name, tag: crew.tag, color: crew.color, best: {}, total: 0, rank: null };
  }
  return { week: w.week, ends: w.ends, settled: w.settled || null, charts: w.charts || [], standings: all.slice(0, 50), total: all.length, mine, prizes: WAR_PRIZES };
}

async function crewRoutes(request, env, url, path) {
  if (path === "/play/crews/war" && request.method === "GET") {
    let me = null;
    if (request.headers.get("Authorization")) me = (await signedIn(request, env).catch(() => null))?.playerId || null;
    if (url.searchParams.get("week") !== "last") await warTick(env).catch(() => {});
    return reply(await warView(env, me, url.searchParams.get("week")));
  }
  if (path === "/play/crews" && request.method === "GET") {
    const d = await r2json(env, CREW_INDEX, { crews: {} });
    const list = Object.entries(d.crews || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 100);
    return reply({ crews: list.map((c, i) => ({ ...c, rank: i + 1 })), total: Object.keys(d.crews || {}).length });
  }
  if (path === "/play/crews/of" && request.method === "GET") {
    const id = String(url.searchParams.get("id") || "");
    let me = null;
    if (request.headers.get("Authorization")) me = (await signedIn(request, env).catch(() => null))?.playerId || null;
    const c = /^[a-z0-9]{10,24}$/.test(id) ? await r2json(env, crewKey(id), null) : me ? await crewOfPlayer(env, me) : null;
    if (!c || c.gone) return reply({ crew: null });
    const idx = await r2json(env, CREW_INDEX, { crews: {} });
    const rank = Object.values(idx.crews || {}).filter((x) => x.score > (c.score || 0)).length + 1;
    return reply({ crew: { ...crewPublic(c, me), rank } });
  }
  // (2.0.2) the crew's chat: its members only (the last CREW_CHAT_KEEP messages, read from a sequence number on)
  if (path === "/play/crews/chat" && request.method === "GET") {
    const who = await signedIn(request, env);
    const crew = await crewOfPlayer(env, who.playerId);
    if (!crew || crew.gone) fail(404, "You're not in a crew.");
    const box = await r2json(env, crewChatKey(crew.id), { seq: 0, msgs: [] });
    const after = Number(url.searchParams.get("after")) || 0;
    return reply({ crew: crew.id, seq: box.seq || 0, msgs: (box.msgs || []).filter((m) => m.seq > after).slice(-CREW_CHAT_KEEP) });
  }
  if (request.method !== "POST") fail(404, "Not found.");
  const who = await signedIn(request, env), me = who.playerId;
  const b = await bodyOf(request, 4_000);
  const staff = me === OWNER || isOfficial(me);
  if (moderation.bans[me]) fail(403, "This account is banned.");
  const myName = await displayName(env, me);
  if (path === "/play/crews/chat") {
    const crew = await crewOfPlayer(env, me);
    if (!crew || crew.gone || !(crew.members || []).some((m) => m.id === me)) fail(403, "You're not in a crew.");
    const text = chatClean(b.text);
    if (!text) fail(400, "Type a message first.");
    if (text.length > CHAT_MAX) fail(400, `Messages can be ${CHAT_MAX} characters at most.`);
    await chatRate(env, me, false);
    let msg = null;
    const box = await r2update(env, crewChatKey(crew.id), () => ({ seq: 0, msgs: [] }), (bx) => {
      bx.seq = (bx.seq || 0) + 1;
      msg = { seq: bx.seq, id: "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 14), at: new Date().toISOString(), text, from: { id: me, name: myName } };
      bx.msgs = [...(bx.msgs || []), msg].slice(-CREW_CHAT_KEEP);
    });
    return reply({ ok: true, msg, seq: box.seq });
  }
  if (path === "/play/crews/create") {
    if ((await walletOf(env, me)).crew) fail(409, "You're in a crew already: leave it first.");
    const name = cleanText(b.name, 24), tag = String(b.tag || "").trim().toUpperCase();
    crewCheck(name, tag, staff);
    const idx = await r2json(env, CREW_INDEX, { crews: {} });
    for (const x of Object.values(idx.crews || {})) {
      if (x.tag === tag) fail(409, `The tag ${tag} is taken.`);
      if (String(x.name).toLowerCase() === name.toLowerCase()) fail(409, "A crew has that name already.");
    }
    const c = { id: rkNewId().slice(0, 16), name, tag, color: crewColor(b.color), desc: cleanText(b.desc, 120), owner: me, created: new Date(Date.now()).toISOString(),
      members: [{ id: me, name: myName, joined: new Date(Date.now()).toISOString() }], invites: [] };
    c.score = await crewScore(env, c);
    await r2put(env, crewKey(c.id), c);
    await crewIndexSet(env, c);
    await crewSetMember(env, me, c);
    return reply({ ok: true, crew: crewPublic(c, me) });
  }
  if (path === "/play/crews/accept" || path === "/play/crews/decline") {
    const id = String(b.crew || "");
    const accept = path.endsWith("accept");
    if (accept && (await walletOf(env, me)).crew) fail(409, "You're in a crew already: leave it first.");
    let why = null, out = null;
    await r2update(env, crewKey(id), () => null, (c) => {
      if (!c || c.gone) { why = "That crew isn't there any more."; return false; }
      if (!(c.invites || []).some((x) => x.id === me)) { why = accept ? "That invite was taken back (or it's too old)." : null; return false; }
      c.invites = c.invites.filter((x) => x.id !== me);
      if (accept) {
        if ((c.members || []).length >= CREW_MAX) { why = `That crew is full (${CREW_MAX} members).`; return false; }
        c.members.push({ id: me, name: myName, joined: new Date(Date.now()).toISOString() });
      }
      out = c;
    });
    if (why) fail(409, why);
    if (accept && out) {
      out.score = await crewScore(env, out);
      await r2put(env, crewKey(out.id), out);
      await crewIndexSet(env, out);
      await crewSetMember(env, me, out);
      await addNotice(env, out.owner, { kind: "crew", what: "joined", crewId: out.id, crewName: out.name, tag: out.tag, byId: me, byName: myName }).catch(() => {});
    }
    return reply({ ok: true, crew: out ? crewPublic(out, me) : null });
  }
  // the rest: your crew
  const mine = await crewOfPlayer(env, me);
  if (!mine || mine.gone) fail(404, "You're not in a crew.");
  const owner = mine.owner === me;
  if (path === "/play/crews/invite") {
    if (!owner) fail(403, "Only the crew's owner can invite.");
    const to = String(b.player || "");
    if (!okPlayerId(to) || to === me || isOfficial(to)) fail(400, "You can't invite that player.");
    if (moderation.bans[to]) fail(403, "That player is banned.");
    if ((await walletOf(env, to)).crew) fail(409, "They're in a crew already.");
    const toName = await displayName(env, to);
    let why = null;
    await r2update(env, crewKey(mine.id), () => null, (c) => {
      if (!c || c.gone) { why = "Your crew isn't there any more."; return false; }
      if ((c.members || []).length + (c.invites || []).length >= CREW_MAX + 8) { why = "Too many invites waiting: wait for some answers first."; return false; }
      if ((c.members || []).length >= CREW_MAX) { why = `Your crew is full (${CREW_MAX} members).`; return false; }
      if ((c.invites || []).some((x) => x.id === to)) { why = "They're invited already."; return false; }
      c.invites = [...(c.invites || []), { id: to, name: toName, by: me, at: new Date(Date.now()).toISOString() }].slice(-20);
    });
    if (why) fail(409, why);
    await addNotice(env, to, { kind: "crew", what: "invite", crewId: mine.id, crewName: mine.name, tag: mine.tag, byId: me, byName: myName });
    return reply({ ok: true, text: `${toName} was invited to ${mine.name}.` });
  }
  if (path === "/play/crews/uninvite") {
    if (!owner) fail(403, "Only the crew's owner can do that.");
    const to = String(b.player || "");
    await r2update(env, crewKey(mine.id), () => null, (c) => { if (!c) return false; c.invites = (c.invites || []).filter((x) => x.id !== to); });
    return reply({ ok: true });
  }
  if (path === "/play/crews/leave" || path === "/play/crews/kick") {
    const kick = path.endsWith("kick");
    const out = kick ? String(b.player || "") : me;
    if (kick && !owner) fail(403, "Only the crew's owner can remove members.");
    if (kick && out === me) fail(400, "Leave the crew instead.");
    let next = null;
    await r2update(env, crewKey(mine.id), () => null, (c) => {
      if (!c || c.gone) return false;
      if (!(c.members || []).some((x) => x.id === out)) return false;
      c.members = c.members.filter((x) => x.id !== out);
      // the owner left: the member who joined first takes over; nobody left: the crew is gone
      if (c.owner === out) { if (c.members.length) c.owner = [...c.members].sort((x, y) => Date.parse(x.joined) - Date.parse(y.joined))[0].id; else c.gone = true; }
      next = c;
    });
    await crewSetMember(env, out, null);
    if (next) {
      if (!next.gone) next.score = await crewScore(env, next);
      await r2put(env, crewKey(next.id), next);
      await crewIndexSet(env, next);
      if (kick) await addNotice(env, out, { kind: "crew", what: "removed", crewId: next.id, crewName: next.name, tag: next.tag, byId: me, byName: myName }).catch(() => {});
    }
    return reply({ ok: true, gone: !!(next && next.gone) });
  }
  if (path === "/play/crews/edit") {
    if (!owner) fail(403, "Only the crew's owner can edit it.");
    const name = b.name !== undefined ? cleanText(b.name, 24) : mine.name, tag = b.tag !== undefined ? String(b.tag || "").trim().toUpperCase() : mine.tag;
    crewCheck(name, tag, staff);
    const idx = await r2json(env, CREW_INDEX, { crews: {} });
    for (const [id, x] of Object.entries(idx.crews || {})) {
      if (id === mine.id) continue;
      if (x.tag === tag) fail(409, `The tag ${tag} is taken.`);
      if (String(x.name).toLowerCase() === name.toLowerCase()) fail(409, "A crew has that name already.");
    }
    let out = null;
    await r2update(env, crewKey(mine.id), () => null, (c) => {
      if (!c || c.gone) return false;
      c.name = name; c.tag = tag; if (b.color !== undefined) c.color = crewColor(b.color); if (b.desc !== undefined) c.desc = cleanText(b.desc, 120);
      out = c;
    });
    if (!out) fail(404, "Your crew isn't there any more.");
    await crewIndexSet(env, out);
    // every member's tag changes with it
    for (const m of out.members || []) await crewSetMember(env, m.id, out).catch(() => {});
    return reply({ ok: true, crew: crewPublic(out, me) });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- chart requests (2.0)
// Players ask for a song to be charted (a title, an artist, a link to the music, the key count they'd like, a note);
// others say "me too"; anyone who charts claims one (3 at a time), and when they upload it to the Workshop they mark it
// done with that upload: the player who asked, and everyone who wanted it, are told. R2: requests/charts.json.
const REQ_KEY = "requests/charts.json", REQ_OPEN_MAX = 3, REQ_CLAIM_MAX = 3, REQ_TOTAL_MAX = 400;
const REQ_LINK_HOSTS = ["osu.ppy.sh", "youtube.com", "youtu.be", "soundcloud.com", "open.spotify.com", "spotify.com", "bandcamp.com", "nicovideo.jp", "music.apple.com"];
/** A link to the music, only to well-known music sites (https). */
function reqLink(v) {
  try {
    const u = new URL(String(v || "").trim());
    const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !REQ_LINK_HOSTS.some((x) => h === x || h.endsWith("." + x))) return "";
    return u.toString().slice(0, 200);
  } catch { return ""; }
}
function reqPublic(r, me) {
  return { id: r.id, title: r.title, artist: r.artist, link: r.link || undefined, keys: r.keys || 0, note: r.note || "", by: r.by, byName: r.byName, at: r.at,
    votes: (r.votes || []).length, voted: me ? (r.votes || []).includes(me) : undefined,
    claimedBy: r.claimedBy || undefined, claimedName: r.claimedName || undefined, claimedAt: r.claimedAt || undefined,
    filled: r.filled ? { itemId: r.filled.itemId, title: r.filled.title, at: r.filled.at, by: r.filled.by, byName: r.filled.byName } : undefined };
}
async function requestRoutes(request, env, url, path) {
  if (path === "/play/requests" && request.method === "GET") {
    let me = null;
    if (request.headers.get("Authorization")) me = (await signedIn(request, env).catch(() => null))?.playerId || null;
    const d = await r2json(env, REQ_KEY, { items: [] }), now = Date.now();
    const live = (d.items || []).filter((r) => !r.removed && !moderation.bans[r.by]);
    // still wanted (the most wanted first), then the last 30 days' charted ones
    const open = live.filter((r) => !r.filled).sort((a, b) => (b.votes || []).length - (a.votes || []).length || Date.parse(b.at) - Date.parse(a.at));
    const done = live.filter((r) => r.filled && now - Date.parse(r.filled.at) < 30 * 86_400_000).sort((a, b) => Date.parse(b.filled.at) - Date.parse(a.filled.at)).slice(0, 40);
    return reply({ items: [...open, ...done].map((r) => reqPublic(r, me)), openMax: REQ_OPEN_MAX, claimMax: REQ_CLAIM_MAX });
  }
  if (request.method !== "POST") fail(404, "Not found.");
  const who = await signedIn(request, env), me = who.playerId;
  if (moderation.bans[me]) fail(403, "This account is banned.");
  const b = await bodyOf(request, 4_000);
  const id = String(b.id || "");
  const myName = await displayName(env, me);
  const now = new Date(Date.now()).toISOString();
  const tell = async (to, n) => { if (to && to !== me) await addNotice(env, to, { kind: "request", ...n }).catch(() => {}); };
  if (path === "/play/requests/new") {
    const title = cleanText(b.title, 80), artist = cleanText(b.artist, 60), note = cleanText(b.note, 200), link = reqLink(b.link);
    const keys = [4, 5, 6, 7, 8, 9, 10].includes(Number(b.keys)) ? Number(b.keys) : 0;
    if (title.length < 2) fail(400, "Give the song's title.");
    if (b.link && !link) fail(400, "Links can only go to osu!, YouTube, SoundCloud, Spotify, Bandcamp, Niconico or Apple Music (https).");
    let out = null, why = null;
    await r2update(env, REQ_KEY, () => ({ items: [] }), (d) => {
      d.items ||= [];
      const open = d.items.filter((r) => !r.removed && !r.filled);
      if (open.filter((r) => r.by === me).length >= REQ_OPEN_MAX) { why = `You have ${REQ_OPEN_MAX} requests waiting: wait for one to be charted (or take one back).`; return false; }
      // the same song asked again: a "me too" on it instead
      const same = open.find((r) => r.title.toLowerCase() === title.toLowerCase() && (r.artist || "").toLowerCase() === artist.toLowerCase());
      if (same) { if (same.by !== me && !(same.votes || []).includes(me)) same.votes = [...(same.votes || []), me]; out = same; return; }
      if (open.length >= REQ_TOTAL_MAX) { why = "There are a lot of requests waiting: try again once some are charted."; return false; }
      out = { id: rkNewId().slice(0, 14), title, artist, note, link, keys, by: me, byName: myName, at: now, votes: [] };
      d.items.push(out);
      // charted ones over 60 days old and removed ones leave the file
      d.items = d.items.filter((r) => !(r.removed || (r.filled && Date.now() - Date.parse(r.filled.at) > 60 * 86_400_000)) || r === out);
    });
    if (why) fail(409, why);
    return reply({ ok: true, request: reqPublic(out, me), merged: out.by !== me });
  }
  let r0 = null, why = null, changed = null;
  const update = (fn) => r2update(env, REQ_KEY, () => ({ items: [] }), (d) => {
    const r = (d.items || []).find((x) => x.id === id && !x.removed);
    if (!r) { why = "That request isn't there any more."; return false; }
    r0 = { ...r };
    const res = fn(r, d);
    if (res === false) return false;
    changed = r;
  });
  if (path === "/play/requests/vote") {
    await update((r) => { if (r.by === me || r.filled) return false; r.votes = (r.votes || []).includes(me) ? r.votes.filter((x) => x !== me) : [...(r.votes || []), me]; });
    if (why) fail(404, why);
    return reply({ ok: true, request: changed ? reqPublic(changed, me) : null });
  }
  if (path === "/play/requests/claim") {
    await update((r, d) => {
      if (r.filled) { why = "It's charted already."; return false; }
      if (r.claimedBy && r.claimedBy !== me) { why = `${r.claimedName || "Someone"} is charting it.`; return false; }
      if ((d.items || []).filter((x) => !x.removed && !x.filled && x.claimedBy === me).length >= REQ_CLAIM_MAX) { why = `You're charting ${REQ_CLAIM_MAX} requests already: finish one first.`; return false; }
      r.claimedBy = me; r.claimedName = myName; r.claimedAt = now;
    });
    if (why) fail(409, why);
    if (changed) await tell(changed.by, { what: "claimed", requestId: id, title: changed.title, byId: me, byName: myName });
    return reply({ ok: true, request: changed ? reqPublic(changed, me) : null });
  }
  if (path === "/play/requests/unclaim") {
    const staff = me === OWNER || isOfficial(me);
    await update((r) => { if (r.filled || (r.claimedBy !== me && !staff)) { why = "You're not charting it."; return false; } delete r.claimedBy; delete r.claimedName; delete r.claimedAt; });
    if (why) fail(409, why);
    return reply({ ok: true, request: changed ? reqPublic(changed, me) : null });
  }
  if (path === "/play/requests/fill") {
    const itemId = String(b.item || "").trim().toLowerCase();
    const it = ((await r2json(env, WS_DB, { items: [] })).items || []).find((x) => x.id === itemId && !x.removed);
    if (!it || it.type !== "charts") fail(404, "Pick one of your chart uploads in the Workshop.");
    const staff = me === OWNER || isOfficial(me);
    if (it.creatorId !== me && !staff) fail(403, "That upload isn't yours.");
    await update((r) => {
      if (r.filled) { why = "It's charted already."; return false; }
      if (r.claimedBy && r.claimedBy !== me && !staff) { why = `${r.claimedName || "Someone"} is charting it: they mark it done.`; return false; }
      r.filled = { itemId: it.id, title: String(it.title || "").slice(0, 80), at: now, by: me, byName: myName };
      r.claimedBy ||= me; r.claimedName ||= myName;
    });
    if (why) fail(409, why);
    if (changed) for (const to of [changed.by, ...(changed.votes || [])]) await tell(to, { what: "filled", requestId: id, title: changed.title, itemId: it.id, byId: me, byName: myName });
    return reply({ ok: true, request: changed ? reqPublic(changed, me) : null });
  }
  if (path === "/play/requests/remove") {
    let mod = false;
    try { await modGate(env, who, null); mod = true; } catch { /* not a moderator */ }
    await update((r) => { if (r.by !== me && !mod) { why = "Only the player who asked (or a moderator) can take it back."; return false; } r.removed = true; });
    if (why) fail(403, why);
    return reply({ ok: true });
  }
  fail(404, "Not found.");
}

// ---------------------------------------------------------------- tournaments (2.0)
// Official only: Senterra or the official account starts one (the game's command bar /tournament, or the Discord bot's
// /tournament): a name, a star range, a size (4 to 32), how long sign-ups stay open, a prize title and the channel the
// bot posts in. Players sign up in the game (Play → Tournaments, shown only while one is on). When sign-ups close the
// server seeds a bracket by Ranked rating (the top seeds get byes). Every match is the friendly Ranked format on the
// tournament's stars: both players press Ready on the tournament screen and the match starts for both; the winner moves
// on. A round lasts a day at most: a player who was ready wins a match the other missed (neither: the higher seed goes
// through). The bot posts the start and the results; the champion and the runner-up get titles. R2: tournaments/current.json.
const TOUR_KEY = "tournaments/current.json", TOUR_ROUND_MS = 24 * 3_600_000, TOUR_READY_MS = 10 * 60_000;
/** Bracket places for n seeds (a power of 2): the best seeds meet as late as they can. */
function tourSeedOrder(n) {
  let order = [1];
  while (order.length < n) { const m = order.length * 2 + 1; order = order.flatMap((s) => [s, m - s]); }
  return order;
}
const tourName = (t, id) => (t.players.find((p) => p.id === id) || {}).name || "Player";
/** The undecided match a player is in (this round), or null. */
function tourMatchOf(t, id) {
  const r = (t.rounds || [])[(t.rounds || []).length - 1] || [];
  return r.find((m) => !m.winner && (m.a === id || m.b === id)) || null;
}
function tourRewardItems(t) {
  const r = { price: 0, reward: true, minVersion: "2.0.0" };
  return [
    { ...r, id: `title-tour-${t.id}-1`, kind: "title", name: t.prize || `${t.name} Champion`, note: `Won the ${t.name} tournament` },
    { ...r, id: `title-tour-${t.id}-2`, kind: "title", name: `${t.name} Finalist`, note: `Made the final of the ${t.name} tournament` },
  ];
}
let tourChannel = { name: null, id: null, at: 0 };
async function channelByName(env, name) {
  if (tourChannel.name === name && Date.now() - tourChannel.at < 600_000) return tourChannel.id;
  const list = await discordApi(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  const c = (list || []).find((x) => x.name === name && (x.type === 0 || x.type === 5));
  tourChannel = { name, id: c ? c.id : null, at: Date.now() };
  return tourChannel.id;
}
async function tourPost(env, t, embed) {
  try {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return;
    const ch = await channelByName(env, t.channel || "octive-scores");
    if (!ch) { console.log("tournament post: #" + (t.channel || "octive-scores") + " not found"); return; }
    await discordApi(env, "POST", `/channels/${ch}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } });
  } catch (e) { console.log("tournament post", e && e.message); }
}

/** Moves a tournament along: sign-ups closing, missed matches, the next round, the end. True when it changed. */
async function tourTick(env, t, now = Date.now()) {
  if (!t) return false;
  let changed = false;
  if (t.state === "signup" && now >= Date.parse(t.signupEnds)) { tourStart(t, now); changed = true; }
  if (t.state === "running") {
    const r = t.rounds[t.rounds.length - 1];
    if (now >= (t.roundEnds[t.rounds.length - 1] || 0)) {
      for (const m of r) {
        if (m.winner) continue;
        if (m.match) { // a match still being played gets an hour more
          const live = await r2json(env, rkMatchKey(m.match), null);
          if (live && live.state !== "done" && live.state !== "cancelled" && now < (t.roundEnds[t.rounds.length - 1] || 0) + 3_600_000) continue;
        }
        const ra = m.ready && m.ready[m.a], rb = m.ready && m.ready[m.b];
        m.winner = ra && !rb ? m.a : rb && !ra ? m.b : t.seeds.indexOf(m.a) <= t.seeds.indexOf(m.b) ? m.a : m.b;
        m.walkover = true;
        changed = true;
      }
    }
    if (tourNextRound(t, now)) changed = true;
  }
  if (t.state === "done" && !t.rewarded) { await tourFinish(env, t); changed = true; }
  return changed;
}
function tourStart(t, now) {
  const ps = [...t.players].sort((x, y) => (y.rating || 0) - (x.rating || 0)).slice(0, t.size);
  if (ps.length < 2) { t.state = "cancelled"; t.why = "Not enough players signed up."; return; }
  let n = 2; while (n < ps.length) n *= 2;
  const slots = tourSeedOrder(n).map((s) => (ps[s - 1] ? ps[s - 1].id : null));
  const round = [];
  for (let i = 0; i < n; i += 2) {
    const m = { a: slots[i], b: slots[i + 1], winner: null, match: null, ready: {} };
    if (!m.b) { m.winner = m.a; m.bye = true; } else if (!m.a) { m.winner = m.b; m.bye = true; }
    round.push(m);
  }
  t.seeds = ps.map((p) => p.id);
  t.rounds = [round]; t.roundEnds = [now + TOUR_ROUND_MS]; t.state = "running";
  tourNextRound(t, now);
}
/** The round is decided: the next one (or the end). */
function tourNextRound(t, now) {
  let changed = false;
  for (;;) {
    const r = t.rounds[t.rounds.length - 1];
    if (r.some((m) => !m.winner)) return changed;
    if (r.length === 1) {
      const f = r[0];
      t.champion = f.winner; t.runnerUp = f.a === f.winner ? f.b : f.a; t.state = "done"; t.ended = new Date(now).toISOString();
      return true;
    }
    const next = [];
    for (let i = 0; i < r.length; i += 2) next.push({ a: r[i].winner, b: r[i + 1].winner, winner: null, match: null, ready: {} });
    t.rounds.push(next); t.roundEnds.push(now + TOUR_ROUND_MS);
    changed = true;
  }
}
async function tourFinish(env, t) {
  t.rewarded = true;
  const items = tourRewardItems(t);
  for (const [who, item] of [[t.champion, items[0]], [t.runnerUp, items[1]]]) {
    if (!who) continue;
    const w = await walletUpdate(env, who, (w) => { if (w.owned.includes(item.id)) return false; w.owned.push(item.id); remember(w, { kind: "tournament", item: item.id, title: t.name }); });
    if (w) await writeCosmetics(env, who, w).catch(() => {});
    await addNotice(env, who, { kind: "tournament", what: who === t.champion ? "won" : "final", name: t.name, item: item.id }).catch(() => {});
  }
  await tourPost(env, t, { color: 0xffc94d, title: `🏆 ${modText(t.name, 60)} is over!`,
    description: `**Champion:** ${modText(tourName(t, t.champion), 40)}\n**Runner-up:** ${modText(tourName(t, t.runnerUp), 40)}\n${t.players.length} players · ★${t.lo}–${t.hi}` });
}

function tourPublic(t, me) {
  if (!t) return null;
  const nm = (id) => (id ? tourName(t, id) : null);
  const mine = me ? tourMatchOf(t, me) : null;
  return {
    id: t.id, name: t.name, lo: t.lo, hi: t.hi, size: t.size, prize: t.prize || `${t.name} Champion`, signupEnds: t.signupEnds, state: t.state, created: t.created, why: t.why,
    players: t.players.map((p) => ({ id: p.id, name: p.name, tier: p.tier || 0 })), joined: !!(me && t.players.some((p) => p.id === me)),
    rounds: (t.rounds || []).map((r) => r.map((m) => ({ a: m.a, b: m.b, aName: nm(m.a), bName: nm(m.b), winner: m.winner, bye: !!m.bye, walkover: !!m.walkover, match: m.match || null,
      readyA: !!(m.ready && m.ready[m.a]), readyB: !!(m.ready && m.ready[m.b]) }))),
    roundEnds: (t.roundEnds || []).map((x) => new Date(x).toISOString()),
    champion: t.champion || null, championName: nm(t.champion), runnerUp: t.runnerUp || null, runnerUpName: nm(t.runnerUp),
    mine: mine ? { a: mine.a, b: mine.b, opponent: mine.a === me ? mine.b : mine.a, opponentName: nm(mine.a === me ? mine.b : mine.a), match: mine.match || null,
      ready: !!(mine.ready && mine.ready[me]), theyReady: !!(mine.ready && mine.ready[mine.a === me ? mine.b : mine.a]) } : null,
    rewards: tourRewardItems(t),
  };
}

/** Staff: create, start (close sign-ups now), cancel, win (a player wins their match) or status. */
async function tourAdmin(env, who, b) {
  if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account run tournaments.");
  const action = String(b.action || "status"), now = Date.now();
  let t = await r2json(env, TOUR_KEY, null);
  const live = t && (t.state === "signup" || t.state === "running");
  if (action === "create") {
    if (live) fail(409, `${t.name} is still on: cancel it first.`);
    const name = cleanText(b.name, 40);
    if (name.length < 3) fail(400, "Give the tournament a name (3 to 40 letters).");
    const size = [4, 8, 16, 32].includes(Number(b.size)) ? Number(b.size) : 0;
    if (!size) fail(400, "The size is 4, 8, 16 or 32 players.");
    const minutes = Math.round(Number(b.minutes) || 0);
    if (!(minutes >= 5 && minutes <= 7 * 24 * 60)) fail(400, "Sign-ups stay open 5 minutes to 7 days.");
    const lo = round2(Number(b.lo)), hi = round2(Number(b.hi));
    if (!(lo >= 1 && hi <= 12 && hi - lo >= 0.5)) fail(400, "The star range is like 4-5.5 (at least half a star wide).");
    t = { id: rkNewId().slice(0, 12), name, size, lo, hi, prize: cleanText(b.prize, 40) || `${name} Champion`, channel: /^[a-z0-9-]{2,60}$/.test(String(b.channel || "")) ? String(b.channel) : "octive-scores",
      signupEnds: new Date(now + minutes * 60_000).toISOString(), state: "signup", created: new Date(now).toISOString(), by: who.playerId, players: [] };
    await r2put(env, TOUR_KEY, t);
    await r2update(env, EVENT_ITEMS_KEY, () => ({ items: [] }), (d) => { d.items ||= []; const have = new Set(d.items.map((x) => x.id)); for (const x of tourRewardItems(t)) if (!have.has(x.id)) d.items.push(x); });
    eventItemsAt = 0;
    await tourPost(env, t, { color: 0xffc94d, title: `🏆 ${modText(name, 60)}`,
      description: `A **${size}-player** OCTIVE tournament, the Ranked format on **★${lo}–${hi}** charts.\nSign up in the game: **Play → Tournaments**. Sign-ups close <t:${Math.floor((now + minutes * 60_000) / 1000)}:R>.\nPrize: the **${modText(t.prize, 40)}** title.` });
    return { ok: true, text: `${name} is open for sign-ups for ${minutes} minutes (posted in #${t.channel}).`, tournament: tourPublic(t, who.playerId) };
  }
  if (!t) fail(404, "There's no tournament. Make one: /tournament create <size> <minutes> <lo>-<hi> <name>");
  if (action === "start") {
    if (t.state !== "signup") fail(409, "Sign-ups are closed already.");
    t.signupEnds = new Date(now).toISOString();
    await tourTick(env, t, now);
    await r2put(env, TOUR_KEY, t);
    return { ok: true, text: t.state === "cancelled" ? "Not enough players: it's cancelled." : `Sign-ups closed: ${t.players.length} players, round 1 is on.` };
  }
  if (action === "cancel") {
    if (!live) fail(409, "It's over already.");
    t.state = "cancelled"; t.why = "Cancelled by OCTIVE.";
    await r2put(env, TOUR_KEY, t);
    return { ok: true, text: `${t.name} is cancelled.` };
  }
  if (action === "win") {
    if (t.state !== "running") fail(409, "It isn't running.");
    const q = String(b.player || "").trim().toLowerCase();
    const p = t.players.find((x) => x.id === b.player || x.name.toLowerCase() === q);
    if (!p) fail(404, "That player isn't in it.");
    const m = tourMatchOf(t, p.id);
    if (!m) fail(409, `${p.name} has no match to win right now.`);
    m.winner = p.id; m.byStaff = true;
    await tourTick(env, t, now);
    await r2put(env, TOUR_KEY, t);
    return { ok: true, text: `${p.name} goes through.` + (t.state === "done" ? ` ${tourName(t, t.champion)} won the tournament!` : "") };
  }
  if (await tourTick(env, t, now)) await r2put(env, TOUR_KEY, t);
  const r = t.rounds ? t.rounds.length : 0;
  return { ok: true, text: `${t.name}: ${t.state}${t.state === "signup" ? `, ${t.players.length}/${t.size} signed up, closes ${t.signupEnds.slice(11, 16)} UTC` : t.state === "running" ? `, round ${r}` : t.state === "done" ? `, won by ${tourName(t, t.champion)}` : ""}.` };
}

async function tourRoutes(request, env, url, path) {
  const now = Date.now();
  if (path === "/play/tournament" && request.method === "GET") {
    let me = null;
    if (request.headers.get("Authorization")) me = (await signedIn(request, env).catch(() => null))?.playerId || null;
    const t = await r2json(env, TOUR_KEY, null);
    if (t && await tourTick(env, t, now)) await r2put(env, TOUR_KEY, t);
    // a finished or cancelled one shows for 3 days
    const shown = t && (t.state === "signup" || t.state === "running" || now - Date.parse(t.ended || t.signupEnds) < 3 * 86_400_000) ? t : null;
    return reply({ tournament: tourPublic(shown, me) });
  }
  if (request.method !== "POST") fail(404, "Not found.");
  const who = await signedIn(request, env), me = who.playerId;
  const b = await bodyOf(request, 4_000);
  if (path === "/play/tournament/admin") return reply(await tourAdmin(env, who, b));
  if (moderation.bans[me]) fail(403, "This account is banned.");
  let out = null, why = null, readyBoth = null;
  const rec = await rkLoad(env, me);
  const myName = await rkName(env, me);
  await r2update(env, TOUR_KEY, () => null, (t) => {
    why = null; readyBoth = null;
    if (!t) { why = "There's no tournament right now."; return false; }
    if (path === "/play/tournament/join") {
      if (t.state !== "signup") { why = "Sign-ups are closed."; return false; }
      if (t.players.some((p) => p.id === me)) { out = t; return false; }
      if (t.players.length >= t.size * 2) { why = "It's full."; return false; }
      t.players.push({ id: me, name: myName, tier: rec.placed ? rec.tier : 0, rating: Math.round(rec.rating || 0), at: new Date(now).toISOString() });
    } else if (path === "/play/tournament/leave") {
      if (t.state !== "signup") { why = "It has started: you can't leave now (a missed match goes to your opponent)."; return false; }
      t.players = t.players.filter((p) => p.id !== me);
    } else if (path === "/play/tournament/ready") {
      if (t.state !== "running") { why = "It isn't running."; return false; }
      const m = tourMatchOf(t, me);
      if (!m) { why = "You have no match right now."; return false; }
      if (m.match) { readyBoth = { m, existing: true }; out = t; return false; }
      m.ready ||= {};
      m.ready[me] = now;
      const other = m.a === me ? m.b : m.a;
      if (m.ready[other] && now - m.ready[other] < TOUR_READY_MS) readyBoth = { m, other };
    } else { why = "Not found."; return false; }
    out = t;
  });
  if (why) fail(409, why);
  if (path === "/play/tournament/ready" && readyBoth && !readyBoth.existing) {
    // both ready: the match starts for both (the Ranked screen picks it up)
    const m = readyBoth.m, other = readyBoth.other;
    const orec = await rkLoad(env, other);
    for (const [pid, r] of [[me, rec], [other, orec]]) {
      if (r.active) { const live = await r2json(env, rkMatchKey(r.active), null); if (live && live.state !== "done" && live.state !== "cancelled") fail(409, pid === me ? "Finish your other match first." : "Your opponent is in another match right now."); }
    }
    const t = out;
    const pa = { id: m.a, name: tourName(t, m.a), tier: (m.a === me ? rec : orec).placed ? (m.a === me ? rec : orec).tier : 0, rating: Math.round((m.a === me ? rec : orec).rating || 0), platform: (m.a === me ? rec : orec).platform || "" };
    const pb = { id: m.b, name: tourName(t, m.b), tier: (m.b === me ? rec : orec).placed ? (m.b === me ? rec : orec).tier : 0, rating: Math.round((m.b === me ? rec : orec).rating || 0), platform: (m.b === me ? rec : orec).platform || "" };
    const match = rkNewMatch(rkNewId(), pa, pb, now, new Set());
    match.kind = "tournament"; match.accepted = [true, true]; match.stars = [t.lo, t.hi]; match.tournament = t.id; match.tournamentName = t.name;
    await r2put(env, rkMatchKey(match.id), match);
    await rkLiveIndex(env, match);
    await rkChange(env, m.a, (d) => { d.active = match.id; });
    await rkChange(env, m.b, (d) => { d.active = match.id; });
    out = await r2update(env, TOUR_KEY, () => null, (tt) => { const mm = tt && tourMatchOf(tt, me); if (!mm || mm.match) return false; mm.match = match.id; }) || out;
    return reply({ ok: true, started: true, match: match.id, tournament: tourPublic(out, me) });
  }
  if (path === "/play/tournament/ready" && !readyBoth) {
    const t = out, m = tourMatchOf(t, me), other = m ? (m.a === me ? m.b : m.a) : null;
    if (other) await addNotice(env, other, { kind: "tournament", what: "ready", name: t.name, byId: me, byName: myName }).catch(() => {});
  }
  return reply({ ok: true, started: !!(readyBoth && readyBoth.existing), match: readyBoth && readyBoth.existing ? readyBoth.m.match : undefined, tournament: tourPublic(out, me) });
}

/** A tournament match is over: its winner goes through. */
async function tourMatchDone(env, m) {
  if (!m.tournament || m.state !== "done" || m.winner === null || m.winner === undefined) return;
  const winner = m.players[m.winner] && m.players[m.winner].id;
  let t = null;
  await r2update(env, TOUR_KEY, () => null, (tt) => {
    if (!tt || tt.id !== m.tournament || tt.state !== "running") return false;
    const bm = (tt.rounds[tt.rounds.length - 1] || []).find((x) => x.match === m.id && !x.winner);
    if (!bm) return false;
    bm.winner = winner;
    tourNextRound(tt, Date.now());
    t = tt;
  });
  if (t && t.state === "done" && !t.rewarded) { await tourFinish(env, t); await r2put(env, TOUR_KEY, t); }
}

/** Moderators: a crew renamed (to its tag) or disbanded. */
async function crewMod(env, who, b) {
  await modGate(env, who, null);
  const c = await r2json(env, crewKey(String(b.crew || "")), null);
  if (!c || c.gone) fail(404, "That crew can't be found.");
  if (b.action === "disband") {
    c.gone = true;
    await r2put(env, crewKey(c.id), c);
    await crewIndexSet(env, c);
    for (const m of c.members || []) await crewSetMember(env, m.id, null).catch(() => {});
    return { ok: true, text: `${c.name} was disbanded.` };
  }
  if (b.action === "rename") {
    c.name = `Crew ${c.id.slice(0, 6)}`; c.tag = "CRW" + c.id.slice(0, 1).toUpperCase().replace(/[^A-Z0-9]/, "X"); c.desc = "";
    await r2put(env, crewKey(c.id), c);
    await crewIndexSet(env, c);
    for (const m of c.members || []) await crewSetMember(env, m.id, c).catch(() => {});
    return { ok: true, text: `Renamed to ${c.name} [${c.tag}].` };
  }
  fail(400, "Rename or disband.");
}

async function playRoutes(request, env, url) {
  const path = url.pathname;
  // the shop's earned and seasonal items, before anything looks an item up
  await ensureEventItems(env).catch(() => {});
  rkEnsureRewardItems(); ensureSeasonCollections();
  const optionalWho = async () => (request.headers.get("Authorization") ? await signedIn(request, env).catch(() => null) : null);

  // ---- Ranked (2.0): see rankedRoutes (the board for the website: GET, no sign-in; sharing a rank card: multipart)
  if (path === "/play/ranked/public-board" && request.method === "GET") return rankedPublicBoard(env, url.searchParams.get("mode"));
  if (path === "/play/ranked/share" && request.method === "POST") return rankedShare(request, env);
  if (path.startsWith("/play/ranked/") && request.method === "POST") return rankedRoutes(request, env, path);

  // ---- thanks for a gift: the giver gets a notice (once per gift, only for a gift that really came from them)
  //   { to, kind: "shop", at }  a points-shop gift (its time in your wallet's history)
  //   { to, kind: "supporter", id }  a supporter gift (waiting, or already accepted)
  if (path === "/play/thank" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 2_000);
    const to = String(b.to || ""), kind = String(b.kind || "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(to) || to === who.playerId) fail(400, "That gift can't be found.");
    let what = null, giftKey = null;
    if (kind === "shop") {
      const at = String(b.at || "");
      const w = await walletOf(env, who.playerId);
      const h = (w.history || []).find((x) => x.kind === "gift" && x.from === to && x.at === at);
      if (h) { const item = SHOP.find((x) => x.id === h.item); what = item ? item.name : "a gift from the shop"; giftKey = `shop:${at}`; }
    } else if (kind === "supporter") {
      const id = String(b.id || "");
      const pend = (await r2json(env, `gifts/${who.playerId}.json`, { pending: [] })).pending || [];
      const rec = await r2json(env, `supporters/${who.playerId}.json`, { purchases: [] });
      const g = pend.find((x) => x.id === id && x.from === to) || (rec.purchases || []).find((x) => x.session === id && x.gift === to);
      if (g) { what = `${g.months} month${g.months === 1 ? "" : "s"} of OCTIVE Supporter`; giftKey = `supporter:${id}`; }
    }
    if (!what) fail(404, "That gift can't be found.");
    let again = false;
    await r2update(env, `thanks/${who.playerId}.json`, () => ({ keys: [] }), (d) => {
      d.keys ||= [];
      if (d.keys.includes(giftKey)) { again = true; return false; }
      d.keys = [giftKey, ...d.keys].slice(0, 300);
    });
    if (again) return reply({ ok: true, already: true });
    await addNotice(env, to, { kind: "thanks", fromId: who.playerId, fromName: await displayName(env, who.playerId), what });
    return reply({ ok: true });
  }

  // ---- your notices (a #1 taken, your upload picked as a daily chart): the game turns them into notifications
  if (path === "/play/notices" && request.method === "GET") {
    const who = await signedIn(request, env);
    const d = await r2json(env, `notices/${who.playerId}.json`, { items: [] });
    // and the announcements to everyone (the last 30 days)
    const all = await r2json(env, "notices/everyone.json", { items: [] });
    const since = Date.now() - 30 * 86_400_000;
    const items = [...(d.items || []), ...(all.items || []).filter((x) => Date.parse(x.at) > since)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return reply({ items: items.slice(0, NOTICES_MAX) });
  }

  // ---- a notification from Senterra or the official OCTIVE account: to everyone, or to players by id or name
  if (path === "/play/notices/send" && request.method === "POST") {
    const who = await signedIn(request, env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId)) fail(403, "Only Senterra and the official OCTIVE account can send notifications.");
    const b = await bodyOf(request, 8_000);
    const title = cleanText(b.title, 80), message = cleanText(b.message, 600);
    if (message.length < 2) fail(400, "Write a message.");
    const n = { kind: "custom", title: title || undefined, message, fromId: who.playerId, fromName: isOfficial(who.playerId) ? "OCTIVE" : await displayName(env, who.playerId) };
    if (b.to === "everyone") {
      const item = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), at: new Date().toISOString(), ...n };
      await r2update(env, "notices/everyone.json", () => ({ items: [] }), (d) => { d.items = [item, ...(d.items || [])].slice(0, 50); });
      return reply({ ok: true, to: "everyone" });
    }
    // players: ids, or names as they show on the ranking
    let ids = (Array.isArray(b.to) ? b.to : [b.to]).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 50);
    const names = ids.filter((x) => !/^[A-Za-z0-9_-]{20,64}$/.test(x));
    if (names.length) {
      const players = (await leaderboard(env)).players || [];
      const found = [], missing = [];
      for (const name of names) {
        const p = players.find((x) => String(x.name || "").toLowerCase() === name.toLowerCase().replace(/#\d+$/, ""));
        if (p) found.push(p.id); else missing.push(name);
      }
      if (missing.length) fail(404, `No player found called ${missing.join(", ")}.`);
      ids = [...ids.filter((x) => !names.includes(x)), ...found];
    }
    ids = [...new Set(ids)].filter((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x));
    if (!ids.length) fail(400, "Say who it's for.");
    for (const id of ids) await addNotice(env, id, n);
    return reply({ ok: true, sent: ids.length });
  }

  // ---- the daily chart (and, signed in, your attempt and points)
  if (path === "/play/daily" && request.method === "GET") {
    const date = todayUtc();
    const d = await dailyOf(env, date);
    const who = await optionalWho();
    const w = who ? await walletOf(env, who.playerId) : null;
    // days picked before the osu! set was kept: it's looked up
    let wsdb = null;
    for (const t of DAILY_TIERS) {
      const c = d.charts[t.tier];
      if (!c || c.osuSet !== undefined) continue;
      if (!wsdb) wsdb = await r2json(env, WS_DB, { items: [] });
      const it = (wsdb.items || []).find((x) => x.id === c.itemId);
      const sg = it && ((it.meta && it.meta.songs) || []).find((x) => x.songId === c.songId);
      c.osuSet = (sg && sg.osuSet) || 0;
    }
    const tiers = DAILY_TIERS.filter((t) => d.charts[t.tier]).map((t) => {
      const c = d.charts[t.tier];
      const all = (c.scores || []).slice().sort((a, b) => b.points - a.points || b.acc - a.acc || Date.parse(a.at) - Date.parse(b.at));
      const at = who ? all.findIndex((x) => x.id === who.playerId) : -1;
      const me = at >= 0 ? { ...all[at], rank: at + 1 } : null;
      return { ...c, scores: undefined, top: all.slice(0, 200), players: all.length, me, mine: w ? w.attempts[attemptKey(d, date, t.tier)] || null : null, preview: c.itemId ? `${WORKER_BASE}/api/preview/${c.itemId}` : null };
    });
    const supporterMultiplier = who && (await isSupporterNow(env, who.playerId)) ? SUPPORTER_DAILY_MULT : 1;
    return reply({ date, tiers, wallet: w ? walletPublic(w, who.playerId) : null, supporterMultiplier, nextAt: new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString() });
  }
  if (path === "/play/daily/start" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 4_000);
    await loadModeration(config(env)).catch(() => {});
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    const t = dailyTier(String(b.tier || ""));
    if (!t) fail(400, "Pick Easy, Normal or Hard.");
    // a daily play only counts with its replay (judged here): a game too old to send it is stopped before the attempt is used
    if (!versionAtLeast(b.v, DAILY_REPLAY_GAME)) fail(426, `Update OCTIVE to play the daily charts: plays are now checked from their replays (OCTIVE ${DAILY_REPLAY_GAME} or newer).`);
    const date = todayUtc();
    const d = await dailyOf(env, date);
    if (!d.charts[t.tier]) fail(404, `There's no ${t.name} daily chart today.`);
    if (b.chart && typeof b.chart === "object") {
      const dc = d.charts[t.tier];
      const it = ((await r2json(env, WS_DB, { items: [] })).items || []).find((x) => x.id === dc.itemId);
      // the upload's own record of the chart (its id and osu! fingerprint), else what the day kept
      const mc = ((it && it.meta && it.meta.songs) || []).find((x) => x.songId === dc.songId)?.charts?.find((x) => x.difficulty === dc.difficulty);
      const changed = chartProblems(it, mc || dc, b.chart, dc.songId, String(b.chart.songId || "") === dc.songId ? "id" : "osu");
      if (changed.length) failModified(changed, dc.itemId, "the daily chart");
    }
    const key = attemptKey(d, date, t.tier);
    let used = false;
    const w = await walletUpdate(env, who.playerId, (w) => {
      if (w.attempts[key]) { used = true; return false; }
      w.attempts[key] = { start: new Date().toISOString() };
      // the streak: days in a row with a daily attempt (freezes cover missed days)
      if (w.lastDay !== date) {
        const gap = w.lastDay ? dayDiff(w.lastDay, date) : null;
        if (gap === 1) w.streak = (w.streak || 0) + 1;
        else if (gap > 1 && (w.freezes || 0) >= gap - 1) { w.freezes -= gap - 1; w.streak = (w.streak || 0) + 1; remember(w, { kind: "freeze-used", days: gap - 1 }); }
        else w.streak = 1;
        w.bestStreak = Math.max(w.bestStreak || 0, w.streak);
        w.lastDay = date;
      }
      for (const k of Object.keys(w.attempts)) if (dayDiff(k.slice(0, 10), date) > 14) delete w.attempts[k];
    });
    if (used) fail(409, `You've had your attempt at today's ${t.name} daily chart. New ones come tomorrow.`);
    return reply({ ok: true, streak: w.streak, freezes: w.freezes });
  }
  if (path === "/play/daily/submit" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 2_600_000); // the play's replay comes with it
    const t = dailyTier(String(b.tier || ""));
    if (!t) fail(400, "Pick Easy, Normal or Hard.");
    const date = todayUtc();
    const d = await dailyOf(env, date);
    const c = d.charts[t.tier];
    if (!c) fail(404, `There's no ${t.name} daily chart today.`);
    if (String(b.mods || "").trim()) fail(400, "The daily charts are played without mods.");
    // the play is judged again from its replay, against the day's chart in its Workshop upload: the accuracy (and the
    // points) come from that, never from the game's numbers
    const rep = replayBytes(b.replay);
    if (!rep) fail(400, "The daily chart only counts with the play's replay. Update OCTIVE.");
    const it = ((await judgeDb(env)).items || []).find((x) => x.id === c.itemId);
    const mc = ((it && it.meta && it.meta.songs) || []).find((x) => x.songId === c.songId)?.charts?.find((x) => x.difficulty === c.difficulty);
    const where = it ? await judgeChartOf(env, it, c.songId, { chartId: mc && mc.chartId, difficulty: c.difficulty }) : null;
    const { result } = await judgePlay(who, rep, where, { what: "The daily chart", noMods: true, noModsText: "The daily charts are played without mods." });
    // the same chart can come round again on another day: a replay counts once, for one player
    const scope = `daily|${c.itemId}|${c.songId}|${c.difficulty}`;
    await refuseCopies(env, scope, who, result, false);
    await judgeFlags(env, who.playerId, `daily ${date} ${t.tier}`, result, { accuracy: claimedAccuracy(b.counts) });
    const acc = result.accuracy;
    const points = dailyPoints(acc, t);
    const mult = (await isSupporterNow(env, who.playerId)) ? SUPPORTER_DAILY_MULT : 1;
    const earned = points * mult;
    const key = attemptKey(d, date, t.tier);
    let why = null;
    const w = await walletUpdate(env, who.playerId, (w) => {
      const a = w.attempts[key];
      if (!a) { why = "Start the daily chart first."; return false; }
      if (a.done) { why = `You've had your attempt at today's ${t.name} daily chart.`; return false; }
      // the play can't be shorter than the song
      const took = Date.now() - Date.parse(a.start);
      if (c.durationUs > 0 && took < c.durationUs / 1000 * 0.6) { why = "That play finished too quickly."; return false; }
      a.done = true; a.acc = Math.round(acc * 100) / 100; a.points = points; if (mult > 1) a.earned = earned;
      w.balance = (w.balance || 0) + earned; w.earned = (w.earned || 0) + earned;
      remember(w, { kind: "daily", tier: t.tier, points: earned, base: mult > 1 ? points : undefined, mult: mult > 1 ? mult : undefined, acc: a.acc, title: c.title });
    });
    if (!w) fail(409, why || "That didn't count.");
    await rememberReplay(env, scope, who.playerId, result.signature);
    const name = await displayName(env, who.playerId);
    await r2update(env, `daily/${date}.json`, () => null, (x) => {
      if (!x || !x.charts || !x.charts[t.tier]) return false;
      const ch = x.charts[t.tier];
      ch.scores = (ch.scores || []).filter((s) => s.id !== who.playerId);
      ch.scores.push({ id: who.playerId, name, acc: Math.round(acc * 100) / 100, points, at: new Date().toISOString() });
    });
    const missions = await missionEvent(env, who.playerId, { kind: "daily", day: date }).catch((e) => { console.log("missions", e && e.message); return []; });
    // "points": what went into the wallet (older games show this); the board keeps basePoints
    return reply({ ok: true, tier: t.tier, points: earned, basePoints: points, multiplier: mult, accuracy: Math.round(acc * 100) / 100, balance: w.balance, streak: w.streak, missions: missions.length ? missions : undefined,
      judged: { score: result.score, counts: result.counts, maxCombo: result.maxCombo, fullCombo: result.fullCombo, grade: result.grade } });
  }

  // ---- the shop
  if (path === "/play/shop" && request.method === "GET") {
    const who = await optionalWho();
    const wallet = who ? walletPublic(await retireItems(env, who.playerId), who.playerId) : null;
    const discount = who && (await isSupporterNow(env, who.playerId)) ? SUPPORTER_DISCOUNT : 0;
    return reply({ items: shopFor(url), wallet, discount, danLevels: DAN_LEVELS, danClearAcc: DAN_CLEAR_ACC });
  }
  if (path === "/play/wallet" && request.method === "GET") {
    const who = await signedIn(request, env);
    const w = await retireItems(env, who.playerId);
    // showcases bought before others could see who owns one
    if (w.owned.includes("showcase")) {
      const idx = (await r2json(env, COSMETICS_KEY, { players: {} })).players || {};
      if (!(idx[who.playerId] && idx[who.playerId].hasShowcase)) await writeCosmetics(env, who.playerId, w);
    }
    return reply({ wallet: walletPublic(w, who.playerId) });
  }
  if (path === "/play/shop/buy" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 2_000);
    const item = shopItem(String(b.id || ""));
    if (!item) fail(404, "That isn't in the shop.");
    if (item.reward) fail(400, "That's a Ranked season reward: it can't be bought or gifted.");
    if (item.minVersion && !versionAtLeast(b.v, item.minVersion)) fail(400, `That needs OCTIVE ${item.minVersion} or newer: update the game first.`);
    const giftTo = b.giftTo ? String(b.giftTo) : null;
    if (giftTo && (!okPlayerId(giftTo) || giftTo === who.playerId)) fail(400, "Pick someone else to gift it to.");
    if (giftTo && item.noGift) fail(400, "That can't be gifted.");
    const to = giftTo || who.playerId;
    // can it go to them?
    const target = await walletOf(env, to);
    if (["title", "frame", "icon", "iconcolor", "showcase", "titlecolor", "titlerainbow"].includes(item.kind) && target.owned.includes(item.id)) fail(409, giftTo ? "They already have that." : "You already have that.");
    if (item.kind === "freeze" && (target.freezes || 0) >= 2) fail(409, giftTo ? "They already hold 2 streak freezes." : "You already hold 2 streak freezes.");
    let spot = null;
    if (item.kind === "spotlight") {
      const db = await r2json(env, WS_DB, { items: [] });
      spot = (db.items || []).find((x) => x.id === String(b.target || "") && !x.removed);
      if (!spot || spot.creatorId !== who.playerId) fail(400, "Pick one of your own Workshop uploads.");
    }
    // pay (supporters: 10% off)
    let short = false;
    const free = infinitePoints(who.playerId); // Senterra and Octive never run out
    const price = shopPriceFor(item, await isSupporterNow(env, who.playerId));
    const paid = await walletUpdate(env, who.playerId, (w) => {
      if (!free && (w.balance || 0) < price) { short = true; return false; }
      if (!free) w.balance -= price;
      remember(w, { kind: "buy", item: item.id, price, giftTo: giftTo || undefined });
    });
    if (short || !paid) fail(400, "You don't have enough points.");
    // deliver
    try {
      if (item.kind === "supporter") {
        await grantMonths(env, to, 1, { id: `points-${who.playerId}-${Date.now()}`, amount_total: 0, currency: "points", metadata: giftTo ? { gift: "1", buyer: who.playerId } : {} });
        if (giftTo) { const fromName = await displayName(env, who.playerId); await walletUpdate(env, to, (w) => remember(w, { kind: "gift", item: item.id, from: who.playerId, fromName })); }
      } else if (item.kind === "spotlight") {
        await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
          const x = (d.items || []).find((y) => y.id === spot.id); if (!x) return false;
          const from = Math.max(Date.now(), Date.parse(x.spotlightUntil || "") || 0);
          x.spotlightUntil = new Date(from + 86_400_000).toISOString();
        });
      } else {
        const fromName = giftTo ? await displayName(env, who.playerId) : undefined;
        const got = await walletUpdate(env, to, (w) => {
          if (item.kind === "freeze") w.freezes = Math.min(2, (w.freezes || 0) + 1);
          else if (!w.owned.includes(item.id)) w.owned.push(item.id);
          if (giftTo) remember(w, { kind: "gift", item: item.id, from: who.playerId, fromName });
        });
        // others see a showcase once it's owned
        if (got && item.kind === "showcase") await writeCosmetics(env, to, got);
      }
    } catch (e) {
      if (!free) await walletUpdate(env, who.playerId, (w) => { w.balance += price; remember(w, { kind: "refund", item: item.id, price }); });
      throw e;
    }
    return reply({ ok: true, wallet: walletPublic(await walletOf(env, who.playerId), who.playerId) });
  }
  if (path === "/play/shop/equip" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 1_000);
    const slot = String(b.slot || "");
    if (!["title", "frame", "icon", "iconColor"].includes(slot)) fail(400, "Pick a title, frame, icon or icon colour.");
    const slotKind = slot === "iconColor" ? "iconcolor" : slot;
    const id = b.id ? String(b.id) : null;
    let bad = false;
    const w = await walletUpdate(env, who.playerId, (w) => {
      if (id && (!w.owned.includes(id) || !SHOP.some((x) => x.id === id && x.kind === slotKind))) { bad = true; return false; }
      if (id) w.equipped[slot] = id; else delete w.equipped[slot];
    });
    if (bad || !w) fail(400, "You don't own that.");
    await writeCosmetics(env, who.playerId, w);
    return reply({ ok: true, wallet: walletPublic(w, who.playerId) });
  }
  if (path === "/play/shop/title-color" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 500);
    const color = String(b.color || "").trim();
    let why = null;
    const w = await walletUpdate(env, who.playerId, (w) => {
      if (color === "") { delete w.equipped.titleColor; return; }
      if (color === "rainbow") { if (!w.owned.includes("title-rainbow")) { why = "Get the Rainbow title in the shop first."; return false; } }
      else if (!/^#[0-9A-Fa-f]{6}$/.test(color)) { why = "That isn't a colour (#RRGGBB)."; return false; }
      else if (!w.owned.includes("title-color")) { why = "Get the title colour customizer in the shop first."; return false; }
      w.equipped.titleColor = color === "rainbow" ? "rainbow" : color.toUpperCase();
    });
    if (why) fail(403, why);
    if (!w) fail(400, "Couldn't change it.");
    await writeCosmetics(env, who.playerId, w);
    return reply({ ok: true, wallet: walletPublic(w, who.playerId) });
  }
  // ---- a player's items (their profile's Items): what they own, and what they have on
  if (path === "/play/items/of" && request.method === "GET") {
    const id = String(url.searchParams.get("player") || "");
    if (!okPlayerId(id)) fail(400, "That player can't be found.");
    const w = await retireItems(env, id);
    const owned = (w.owned || []).filter((x) => SHOP.some((y) => y.id === x && OWNABLE.includes(y.kind)));
    const eq = w.equipped || {};
    return reply({ owned, equipped: { title: eq.title || null, frame: eq.frame || null, icon: eq.icon || null, iconColor: eq.iconColor || null, titleColor: eq.titleColor || null } });
  }
  // ---- missions (2.0): the week's, the event's, and the season's new shop items
  if (path === "/play/missions" && request.method === "GET") return reply(await missionsView(env, await optionalWho()));
  // ---- the friends feed (2.0)
  if (path === "/play/feed" && request.method === "GET") return reply(await feedFor(env, (await signedIn(request, env)).playerId));
  // ---- crews (2.0)
  if (path === "/play/crews/mod" && request.method === "POST") return reply(await crewMod(env, await signedIn(request, env), await bodyOf(request, 2_000)));
  if (path === "/play/crews" || path.startsWith("/play/crews/")) return crewRoutes(request, env, url, path);
  // ---- chart requests (2.0)
  if (path === "/play/requests" || path.startsWith("/play/requests/")) return requestRoutes(request, env, url, path);
  // ---- tournaments (2.0)
  if (path === "/play/tournament" || path.startsWith("/play/tournament/")) return tourRoutes(request, env, url, path);
  if (path === "/play/event" && request.method === "POST") return reply(await eventAdmin(env, await signedIn(request, env), await bodyOf(request, 4_000)));
  // ---- a player's progress (2.0): PR, accuracy and rank over time, and their skill radar
  if (path === "/play/progress" && request.method === "GET") {
    const id = String(url.searchParams.get("player") || "");
    if (!okPlayerId(id)) fail(400, "That player can't be found.");
    if (isOfficial(id)) return reply({ days: [], built: [], skills: { overall: 0, plays: 0, axes: [] }, official: true });
    return reply(await progressOf(env, id));
  }
  // ---- a player's cleared dans (their profile's View Dans)
  if (path === "/play/dans/of" && request.method === "GET") {
    const id = String(url.searchParams.get("player") || "");
    if (!okPlayerId(id)) fail(400, "That player can't be found.");
    const w = await walletOf(env, id);
    const list = Object.entries(w.dans || {}).map(([key, d]) => ({ key, level: d.level, title: d.title, difficulty: d.difficulty, acc: d.acc, at: d.at, itemId: d.itemId, songId: d.songId }))
      .sort((a, c) => DAN_LEVELS.indexOf(c.level) - DAN_LEVELS.indexOf(a.level) || (c.acc || 0) - (a.acc || 0));
    return reply({ dans: list, levels: DAN_LEVELS, clearAcc: DAN_CLEAR_ACC });
  }
  if (path === "/play/shop/showcase" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 4_000);
    const cur = await walletOf(env, who.playerId);
    if (!cur.owned.includes("showcase")) fail(403, "Get the profile showcase in the shop first.");
    const picks = (Array.isArray(b.picks) ? b.picks : []).slice(0, 3);
    const out = [];
    let scores = null, card = null, db = null;
    for (const p of picks) {
      if (p && (p.kind === "play" || p.kind === "song")) {
        if (!scores) scores = ((await privateItems(env, who.playerId, ["scores"]).catch(() => ({}))).scores || {}).charts || {};
        const songId = String(p.songId || "").slice(0, 100), chartId = String(p.chartId || "").slice(0, 100);
        const c = scores[`${songId}/${chartId}`];
        if (!c) fail(400, "That song isn't in your synced scores yet. Wait a moment for the sync and try again.");
        // the score they picked, from their own synced plays (its details are copied from there, not from the request)
        // (2.1.2) found by its date: picks saved before the 2.1.1 score change still send their old 0-1,000,000 score,
        // which never matched the converted synced plays (so no showcase could be changed); the score only breaks a tie
        const date = String(p.date || ""), want = Math.round(Number(p.score) || 0);
        const same = (Array.isArray(c.top) ? c.top : []).filter((x) => x && String(x.date) === date);
        const play = same.find((x) => Math.round(Number(x.score) || 0) === want) || same[0];
        if (!play) fail(400, "That score isn't in your synced scores yet. Wait a moment for the sync and try again.");
        const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : 0; };
        const r2 = (n) => Math.round(n * 100) / 100;
        // where to see it: its Workshop upload, or its osu! beatmap set
        if (!db) db = await r2json(env, WS_DB, { items: [] });
        const ws = (db.items || []).find((x) => !x.removed && (x.songIds || []).includes(songId));
        const wsSong = ws && ((ws.meta && ws.meta.songs) || []).find((x) => x.songId === songId);
        const osuSet = (wsSong && wsSong.osuSet) || (Number.isInteger(Number(p.osuSet)) && Number(p.osuSet) > 0 && Number(p.osuSet) < 1e8 ? Number(p.osuSet) : 0);
        out.push({
          kind: "song", songId, chartId, title: String(c.title || p.title || "").slice(0, 80), artist: String(c.artist || p.artist || "").slice(0, 80), difficulty: String(c.difficulty || p.difficulty || "").slice(0, 60),
          keys: num(c.keyCount || play.keyCount, 0, 20), score: Math.round(num(play.score, 0, SCORE_MAX)), acc: r2(num(play.accuracy, 0, 100)), grade: String(play.grade || "").replace(/[^A-Z+]/g, "").slice(0, 3),
          maxCombo: Math.round(num(play.maxCombo, 0, V.maxCombo)), fullCombo: !!play.fullCombo,
          counts: Array.isArray(play.counts) ? play.counts.slice(0, 6).map((n) => Math.round(num(n, 0, 1_000_000))) : [],
          mods: String(play.mods || "").replace(/[^A-Za-z0-9. ]/g, "").slice(0, 40), pp: r2(num(play.pp, 0, playPRMax(V.maxStars))), stars: r2(num(play.stars || c.stars, 0, V.maxStars)), date: date.slice(0, 40), pv: 1,
          workshopId: ws ? ws.id : undefined, osuSet: osuSet || undefined,
          cover: ws && ws.preview ? `${WORKER_BASE}/api/preview/${ws.id}` : osuSet ? `https://assets.ppy.sh/beatmaps/${osuSet}/covers/card.jpg` : undefined,
        });
      } else if (p && p.kind === "ach") {
        if (!card) card = (await publicItems(config(env), who.playerId, ["card"])).card || {};
        const id = String(p.id || "");
        if (!card.achievements || !(id in card.achievements)) fail(400, "That achievement isn't unlocked.");
        out.push({ kind: "ach", id: id.slice(0, 60) });
      }
    }
    const w = await walletUpdate(env, who.playerId, (w) => { w.showcase = out; });
    await writeCosmetics(env, who.playerId, w);
    return reply({ ok: true, wallet: walletPublic(w, who.playerId) });
  }
  // ---- what everyone has equipped (titles, frames, icons, showcases, dans)
  if (path === "/play/cosmetics" && request.method === "GET") {
    if (!cosmeticsCache || Date.now() - cosmeticsAt > 30_000) {
      let doc = await r2json(env, COSMETICS_KEY, { players: {} });
      if (!doc.danClears) doc = await backfillDanClears(env, doc).catch((err) => { console.log("dan clears", err && err.message); return doc; });
      const raw = doc.players || {};
      cosmeticsCache = Object.fromEntries(Object.entries(raw).map(([k, e]) => { const x = iconsV2Entry(e); return [k, x && x.showcase ? { ...x, showcase: showcasePoints(x.showcase) } : x]; }));
      cosmeticsAt = Date.now();
    }
    return reply({ players: cosmeticsCache });
  }

  // ---- dans: the Workshop songs marked as dans, and clearing one
  if (path === "/play/dans" && request.method === "GET") {
    const db = await r2json(env, WS_DB, { items: [] });
    const dans = [];
    for (const it of (db.items || []).filter((x) => !x.removed && Array.isArray(x.dans)))
      for (const d of it.dans) {
        const song = ((it.meta && it.meta.songs) || []).find((x) => x.songId === d.songId);
        dans.push({ itemId: it.id, songId: d.songId, difficulty: d.difficulty, level: d.level, title: it.title, osuSet: song && song.osuSet ? song.osuSet : undefined });
      }
    dans.sort((a, b) => DAN_LEVELS.indexOf(a.level) - DAN_LEVELS.indexOf(b.level));
    return reply({ dans, levels: DAN_LEVELS, clearAcc: DAN_CLEAR_ACC });
  }
  // ---- is this copy the verified chart? (a few at once)
  if (path === "/play/chart-check" && request.method === "POST") {
    const b = await bodyOf(request, 20_000);
    const idx = await verifiedIndex(env);
    const charts = (Array.isArray(b.charts) ? b.charts : []).slice(0, 40).map((c) => {
      const e = c && typeof c === "object" ? findVerified(idx, String(c.songId || ""), String(c.difficulty || ""), c.board) : null;
      if (!e) return { verified: false, ok: true };
      const problems = chartProblems(e.it, e.chart, c, e.song.songId, e.via);
      return { verified: true, ok: problems.length === 0, problems, itemId: e.it.id, title: e.song.title || e.it.title, difficulty: e.chart.difficulty };
    });
    return reply({ charts });
  }
  if (path === "/play/dan/clear" && request.method === "POST") {
    const who = await signedIn(request, env);
    const b = await bodyOf(request, 2_600_000); // the play's replay comes with it
    if (String(b.mods || "").trim()) fail(400, "Dans are played without mods.");
    const songId = String(b.songId || ""), difficulty = String(b.difficulty || "");
    // the marked song, or any copy of it (another upload, their own osu! import)
    const e = findDan(await danIndex(env), songId, difficulty, b.board);
    if (!e) fail(404, "That difficulty isn't a dan.");
    const changed = chartProblems(e.it, e.chart, b.chart, e.dan.songId, e.via);
    if (changed.length) failModified(changed, e.it.id, "the dan");
    // the play is judged again from its replay, against the dan's own chart: the accuracy comes from that
    const rep = replayBytes(b.replay);
    if (!rep) fail(400, "A dan only counts with the play's replay. Update OCTIVE.");
    const where = await judgeChartOf(env, e.it, e.dan.songId, { chartId: e.chart.chartId, difficulty: e.dan.difficulty });
    const { result } = await judgePlay(who, rep, where, { what: "A dan", noMods: true, noModsText: "Dans are played without mods." });
    const scope = `dan|${e.dan.songId}|${e.dan.difficulty}`;
    await refuseCopies(env, scope, who, result);
    await judgeFlags(env, who.playerId, `dan ${e.dan.level} ${e.dan.difficulty}`, result, { accuracy: claimedAccuracy(b.counts) });
    const acc = result.accuracy;
    const cleared = acc >= DAN_CLEAR_ACC;
    if (cleared) {
      const w = await recordDanClears(env, who.playerId, [{ e, acc, at: new Date().toISOString() }]);
      if (w) await writeCosmetics(env, who.playerId, w);
    }
    await rememberReplay(env, scope, who.playerId, result.signature);
    return reply({ ok: true, cleared, level: e.dan.level, accuracy: Math.round(acc * 100) / 100, needed: DAN_CLEAR_ACC,
      judged: { score: result.score, counts: result.counts, maxCombo: result.maxCombo, fullCombo: result.fullCombo, grade: result.grade } });
  }
  fail(404, "Not found");
}

const wsPublic = (it) => ({
  id: it.id, type: it.type, title: it.title, description: it.description, creator: it.creator, creatorId: it.creatorId,
  fileName: it.fileName, fileNames: it.fileNames || [it.fileName], size: it.size, at: it.at, downloads: it.downloads || 0, updated: it.updatedAt || null, version: it.version || 1,
  // verified by OCTIVE (its own content, or checked by Senterra / Octive); skins and styles not locked can be changed
  verified: !!it.verified, builtin: !!it.builtin, originalId: it.originalId || null, customizable: it.type === "themes" ? true : it.type === "skins" || it.type === "styles" ? !(it.meta && it.meta.locked) : undefined,
  songIds: it.songIds || [], songs: it.meta && it.meta.songs ? it.meta.songs : undefined,
  tags: Array.isArray(it.tags) ? it.tags : [],
  removedTags: Array.isArray(it.removedTags) && it.removedTags.length ? it.removedTags : undefined,
  likes: it.likes || 0, reviews: it.reviews || 0,
  verifyRequested: it.verifyRequest && !it.verified ? it.verifyRequest.at : undefined,
  verifyDenied: it.verifyDenied && !it.verified ? { reason: it.verifyDenied.reason, byName: it.verifyDenied.byName, at: it.verifyDenied.at } : undefined,
  dans: Array.isArray(it.dans) && it.dans.length ? it.dans.map((d) => ({ songId: d.songId, difficulty: d.difficulty, level: d.level })) : undefined,
  spotlight: it.spotlightUntil && Date.parse(it.spotlightUntil) > Date.now() ? it.spotlightUntil : undefined,
  preview: it.preview ? `${WORKER_BASE}/api/preview/${it.id}` : null,
  discord: it.channelId && it.messageId && it.guildId ? `https://discord.com/channels/${it.guildId}/${it.channelId}/${it.messageId}` : null,
});

/** Reads an older upload's details (songs, difficulties, keys, stars, charters; a skin's lock) from its files once. */
async function wsBackfill(env, it) {
  if (it.meta || it.type === "themes" || !env.DISCORD_BOT_TOKEN) return it;
  try {
    const metas = [], hashes = [];
    if (it.b2Files && it.b2Files.length) {
      for (const f of it.b2Files.slice(0, 20)) {
        if (f.size > 60 * 1048576) continue;
        const r = await b2Get(env, f.key); if (!r.ok) continue;
        const u8 = new Uint8Array(await r.arrayBuffer());
        metas.push(await wsMeta(it.type, u8)); hashes.push(await bytesHash(u8));
      }
    } else {
    const msg = await discordApi(env, "GET", `/channels/${it.channelId}/messages/${it.messageId}`);
    const names = it.fileNames && it.fileNames.length ? it.fileNames : [it.fileName];
    for (const a of (msg.attachments || []).filter((x) => names.includes(x.filename)).slice(0, 20)) {
      if (a.size > 60 * 1048576) continue;
      const u8 = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
      metas.push(await wsMeta(it.type, u8)); hashes.push(await bytesHash(u8));
    }
    }
    const meta = it.type === "charts" ? { songs: metas.filter(Boolean), locked: false } : (metas[0] || { locked: false });
    const songIds = it.type === "charts" ? meta.songs.map((x) => x.songId).filter(Boolean) : [];
    let out = it;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; x.meta = meta; x.hashes = x.hashes || hashes; x.songIds = x.songIds || songIds; out = x; });
    return out;
  } catch (e) { console.log("workshop details", e && e.message); return null; }
}
async function wsBackfillSome(env, list) { for (const it of list) await wsBackfill(env, it); }

/** The developer's import key (an HMAC of a server secret): uploads as the official account. Null without it. */
async function officialImporter(request, env) {
  const given = String(request.headers.get("X-Octive-Import") || "");
  if (!given || !env.DISCORD_BOT_TOKEN) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.DISCORD_BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("octive-official-import-v1")));
  const want = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (given.length !== want.length) fail(403, "That import key isn't valid.");
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) fail(403, "That import key isn't valid.");
  return { playerId: OFFICIAL_ID, username: "Octive", until: Date.now() + 60_000 };
}

// =====================================================================================================
// Workshop likes, reviews, charter pages, For you and More like this (2.0)
//   workshop/reviews/<itemId>.json  { likes: [playerIds], notified: [playerIds], reviews: [{ id, by, name, text, rating, at }] }
//   items keep a "likes" and "reviews" count (sorting, cards)
// =====================================================================================================
const wsReviewKey = (id) => `workshop/reviews/${id}.json`;
const WS_REVIEW_MAX = 300;
const wsChartsOf = (it) => ((it.meta && it.meta.songs) || []).flatMap((sg) => (sg.charts || []).map((c) => ({ ...c, songId: sg.songId, osuSet: sg.osuSet })));
const wsChartKey = (c) => { const set = Math.round(Number(c.osuSet) || 0); return set > 0 && c.osuMd5 ? `osu-${set}/${c.osuMd5}` : `${c.songId}/${c.chartId}`; };

function wsReviewText(s) {
  const t = String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, WS_REVIEW_MAX);
  if (/https?:\/\/|www\.|discord\.gg|\.com\b/i.test(t)) fail(400, "Reviews can't have links.");
  if (/@(everyone|here)\b/i.test(t)) fail(400, "Reviews can't mention everyone.");
  return t;
}

/** What a card needs, plus the chart that made it a pick (For you / More like this). */
function wsBrief(it, c) {
  const charts = wsChartsOf(it);
  return {
    id: it.id, type: it.type, title: it.title, creator: it.creator, creatorId: it.creatorId, verified: !!it.verified, downloads: it.downloads || 0,
    likes: it.likes || 0, reviews: it.reviews || 0, at: it.at, version: it.version || 1, size: it.size, fileName: it.fileName,
    preview: it.preview ? `${WORKER_BASE}/api/preview/${it.id}` : null,
    keys: [...new Set(charts.map((x) => x.keys))].filter(Boolean).sort((a, b) => a - b),
    topStars: charts.length ? Math.max(...charts.map((x) => Number(x.stars) || 0)) : undefined,
    pick: c ? { songId: c.songId, chartId: c.chartId, difficulty: c.difficulty || c.name || null, stars: Number(c.stars) || 0, keys: c.keys || 0, tags: (c.autoTags || []).slice(0, 4) } : undefined,
  };
}

/** Charts near one chart: the same key count, stars within ±0.6, sharing its patterns. Best chart per upload. */
function wsSimilar(db, it, chartId) {
  const own = wsChartsOf(it);
  if (!own.length) return [];
  const ref = (chartId && own.find((c) => c.chartId === chartId)) || own.slice().sort((a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0))[Math.floor(own.length / 2)];
  const rs = Number(ref.stars) || 0, rk = Number(ref.keys) || 4, rt = new Set((ref.autoTags || []).map(String));
  const best = new Map();
  for (const x of db.items || []) {
    if (x.removed || x.type !== "charts" || x.id === it.id) continue;
    for (const c of wsChartsOf(x)) {
      const st = Number(c.stars) || 0;
      if (!st || (Number(c.keys) || 4) !== rk || Math.abs(st - rs) > 0.6) continue;
      const overlap = (c.autoTags || []).filter((t) => rt.has(String(t))).length;
      const score = -Math.abs(st - rs) + 0.25 * overlap + (x.verified ? 0.15 : 0) + Math.min(0.2, (x.likes || 0) * 0.02);
      const cur = best.get(x.id);
      if (!cur || score > cur.score) best.set(x.id, { it: x, c, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 12).map((b) => ({ it: b.it, c: b.c }));
}

/** For you: charts at the player's level (their skill radar's overall), in the key counts they play, not played yet. */
async function wsForYou(env, playerId) {
  const [db, judged, idx] = await Promise.all([r2json(env, WS_DB, { items: [] }), r2json(env, judgedKey(playerId), null), chartShapeIndex(env)]);
  const plays = Object.entries((judged && judged.charts) || {}).filter(([, p]) => p && isNum(p.pp, 0, V.maxTotalPR) && p.pp > 0 && isNum(p.acc, 0, 100));
  const played = new Set(plays.map(([k]) => k));
  const skills = skillsFrom(plays, idx);
  // the level to aim at: the radar's overall, a little above it (something to grow into)
  let target = skills.overall;
  if (!(target > 0)) target = 2;
  target += 0.25;
  const keyCount = new Map();
  for (const [k] of plays) { const sh = idx.get(k); if (sh && sh.keys) keyCount.set(sh.keys, (keyCount.get(sh.keys) || 0) + 1); }
  const topKeys = [...keyCount.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const favKeys = new Set(topKeys.length ? topKeys.slice(0, 2) : [4]);
  // their weakest pattern with some plays: something to practise
  const weak = skills.axes.filter((a) => a.plays > 0).sort((a, b) => a.level - b.level)[0];
  const weakTags = weak ? new Set((SKILL_AXES.find((x) => x[0] === weak.key) || [, , []])[2]) : new Set();
  const best = new Map();
  for (const it of db.items || []) {
    if (it.removed || it.type !== "charts") continue;
    for (const c of wsChartsOf(it)) {
      const st = Number(c.stars) || 0;
      if (!st || played.has(wsChartKey(c))) continue;
      if (!favKeys.has(Number(c.keys) || 4)) continue;
      const tags = (c.autoTags || []).map(String);
      const score = -Math.abs(st - target) + (tags.some((t) => weakTags.has(t)) ? 0.35 : 0) + (it.verified ? 0.3 : 0) + Math.min(0.25, (it.likes || 0) * 0.025) + Math.min(0.15, (it.downloads || 0) / 400);
      if (Math.abs(st - target) > 1.5) continue;
      const cur = best.get(it.id);
      if (!cur || score > cur.score) best.set(it.id, { it, c, score });
    }
  }
  return { target: round2(target), weak: weak ? weak.name : null, keys: [...favKeys], items: [...best.values()].sort((a, b) => b.score - a.score).slice(0, 24).map((b) => wsBrief(b.it, b.c)) };
}

/** The players following an uploader hear about it (a notice; at most 500 of them). */
async function wsNotifyFollowers(env, creatorId, item) {
  const fr = await r2json(env, `followers/${creatorId}.json`, { followers: [] });
  const name = await rkName(env, creatorId).catch(() => item.creator || "");
  for (const f of (fr.followers || []).slice(0, 500))
    if (f !== creatorId) await addNotice(env, f, { kind: "upload", itemId: item.id, title: String(item.title || "").slice(0, 80), type: item.type, from: creatorId, fromName: name }).catch(() => {});
}

async function wsSocialRoutes(request, env, url, ctx) {
  const path = url.pathname;
  const m = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/(like|reviews|review|unreview|similar)$/);
  if (m) {
    const id = m[1], what = m[2];
    const db = await r2json(env, WS_DB, { items: [] });
    const it = (db.items || []).find((x) => x.id === id && !x.removed);
    if (!it) fail(404, "That item isn't in the Workshop any more.");
    if (what === "similar") return reply({ items: wsSimilar(db, it, url.searchParams.get("chart")).map(({ it: x, c }) => wsBrief(x, c)) });
    if (what === "reviews") {
      const r = await r2json(env, wsReviewKey(id), { likes: [], reviews: [] });
      let me = null;
      try { me = (await signedIn(request, env)).playerId; } catch { /* a guest */ }
      const list = (r.reviews || []).slice().sort((a, b) => b.at - a.at);
      return reply({ likes: (r.likes || []).length, liked: !!me && (r.likes || []).includes(me), reviews: list.slice(0, 100), count: list.length, mine: me ? list.find((x) => x.by === me) || null : null });
    }
    if (request.method !== "POST") fail(405, "Use POST.");
    const who = await signedIn(request, env);
    const b = await bodyOf(request);
    const setCount = (field, n) => r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === id); if (x) x[field] = n; });
    if (what === "like") {
      const like = b.like !== false;
      let first = false, count = 0;
      await r2update(env, wsReviewKey(id), () => ({ likes: [], reviews: [], notified: [] }), (r) => {
        r.likes = (r.likes || []).filter((x) => x !== who.playerId);
        if (like) r.likes.push(who.playerId);
        r.notified = r.notified || [];
        if (like && !r.notified.includes(who.playerId)) { r.notified.push(who.playerId); first = true; if (r.notified.length > 5000) r.notified = r.notified.slice(-5000); }
        count = r.likes.length;
      });
      await setCount("likes", count);
      if (first && it.creatorId && it.creatorId !== who.playerId)
        await addNotice(env, it.creatorId, { kind: "like", itemId: id, title: String(it.title || "").slice(0, 80), from: who.playerId, fromName: await rkName(env, who.playerId) }).catch(() => {});
      return reply({ likes: count, liked: like });
    }
    if (what === "review") {
      const text = wsReviewText(b.text);
      if (!text) fail(400, "Write something first.");
      const rating = Number(b.rating) >= 1 && Number(b.rating) <= 5 ? Math.round(Number(b.rating)) : undefined;
      const name = await rkName(env, who.playerId);
      let isNew = false, count = 0, review = null;
      await r2update(env, wsReviewKey(id), () => ({ likes: [], reviews: [] }), (r) => {
        r.reviews = r.reviews || [];
        const old = r.reviews.find((x) => x.by === who.playerId);
        isNew = !old;
        review = { id: old ? old.id : "r" + crypto.randomUUID().replace(/-/g, "").slice(0, 12), by: who.playerId, name, text, rating, at: Date.now(), edited: old ? true : undefined };
        r.reviews = r.reviews.filter((x) => x.by !== who.playerId);
        r.reviews.push(review);
        if (r.reviews.length > 2000) r.reviews = r.reviews.slice(-2000);
        count = r.reviews.length;
      });
      await setCount("reviews", count);
      if (isNew && it.creatorId && it.creatorId !== who.playerId)
        await addNotice(env, it.creatorId, { kind: "review", itemId: id, title: String(it.title || "").slice(0, 80), from: who.playerId, fromName: name, text: text.slice(0, 120) }).catch(() => {});
      return reply({ ok: true, review, reviews: count });
    }
    if (what === "unreview") {
      const target = String(b.by || who.playerId);
      if (target !== who.playerId) await modGate(env, who, target);
      let count = 0;
      await r2update(env, wsReviewKey(id), () => ({ likes: [], reviews: [] }), (r) => { r.reviews = (r.reviews || []).filter((x) => x.by !== target); count = r.reviews.length; });
      await setCount("reviews", count);
      return reply({ ok: true, reviews: count });
    }
  }
  // a charter's page: their uploads, their numbers and whether you follow them
  const cm = path.match(/^\/api\/creators\/([A-Za-z0-9_-]{8,64})$/);
  if (cm && request.method === "GET") {
    const id = cm[1];
    const db = await r2json(env, WS_DB, { items: [] });
    const mine = (db.items || []).filter((x) => !x.removed && x.creatorId === id).sort((a, b) => b.at - a.at);
    const charts = mine.filter((x) => x.type === "charts");
    let youFollow = false;
    try { const who = await signedIn(request, env); youFollow = ((await r2json(env, `follows/${who.playerId}.json`, { following: [] })).following || []).includes(id); } catch { /* a guest */ }
    return reply({
      id, name: mine.length ? mine[0].creator : await rkName(env, id).catch(() => ""),
      uploads: mine.length, charts: charts.length, verified: charts.filter((x) => x.verified).length,
      difficulties: charts.reduce((s, x) => s + wsChartsOf(x).length, 0),
      downloads: mine.reduce((s, x) => s + (x.downloads || 0), 0), likes: mine.reduce((s, x) => s + (x.likes || 0), 0), reviews: mine.reduce((s, x) => s + (x.reviews || 0), 0),
      followers: await followerCount(env, id).catch(() => 0), youFollow,
      latest: mine.slice(0, 12).map((x) => wsBrief(x)),
    });
  }
  if (path === "/api/foryou" && request.method === "GET") {
    const who = await signedIn(request, env);
    return reply(await wsForYou(env, who.playerId));
  }
  return null;
}

async function workshopRoutes(request, env, url, ctx) {
  const path = url.pathname;
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  { const r = await wsSocialRoutes(request, env, url, ctx); if (r) return r; }

  // ---- list
  if (path === "/api/items" && request.method === "GET") {
    const type = url.searchParams.get("type");
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const sort = url.searchParams.get("sort") || "new";
    const db = await r2json(env, WS_DB, { items: [] });
    // ?creator=<playerId>: only that player's uploads (their profile and their Workshop page)
    const creator = String(url.searchParams.get("creator") || "").trim();
    // ?ids=a,b: those uploads (the game opening one from a link or a notification)
    const ids = String(url.searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9]{16,40}$/.test(x)).slice(0, 50);
    let items = (db.items || []).filter((it) => !it.removed && (!type || it.type === type) && (!creator || it.creatorId === creator) && (!ids.length || ids.includes(it.id)));
    if (q) items = items.filter((it) => `${it.title} ${it.creator} ${it.description}`.toLowerCase().includes(q));
    const sp = url.searchParams;
    // ?verified=1 / 0, ?customizable=1 (skins and styles anyone may change), ?builtin=1 (OCTIVE's own content)
    const ver = sp.get("verified");
    if (ver === "1") items = items.filter((it) => !!it.verified); else if (ver === "0") items = items.filter((it) => !it.verified);
    if (sp.get("customizable") === "1") items = items.filter((it) => it.type === "themes" || !(it.meta && it.meta.locked));
    if (sp.get("builtin") === "1") items = items.filter((it) => !!it.builtin);
    // ?song=<songId>: the upload holding that song (multiplayer: get the room's song)
    const song = String(sp.get("song") || "").slice(0, 120);
    if (song) items = items.filter((it) => (it.songIds || []).includes(song));
    // ?by=<name>: uploads by a player whose name has these letters
    const by = String(sp.get("by") || "").trim().toLowerCase().slice(0, 40);
    if (by) items = items.filter((it) => String(it.creator || "").toLowerCase().includes(by));
    // songs: ?charter=<name>, ?keys=4,7, ?minStars= / ?maxStars= (some difficulty matches all of them)
    const charter = String(sp.get("charter") || "").trim().toLowerCase().slice(0, 60);
    const keys = String(sp.get("keys") || "").split(",").map((k) => parseInt(k, 10)).filter((k) => k >= 1 && k <= 20).slice(0, 12);
    const minS = Number(sp.get("minStars")), maxS = Number(sp.get("maxStars"));
    const hasMin = Number.isFinite(minS) && minS > 0, hasMax = Number.isFinite(maxS) && maxS > 0;
    let pending = 0;
    if (charter || keys.length || hasMin || hasMax) {
      // older uploads get their details read in the background (they show once that's done)
      const missing = items.filter((it) => it.type === "charts" && !it.meta);
      pending = missing.length;
      if (missing.length && ctx) ctx.waitUntil(wsBackfillSome(env, missing.slice(0, 6)).catch(() => {}));
      items = items.filter((it) => {
        if (it.type !== "charts") return !charter && !keys.length && !hasMin && !hasMax;
        const charts = ((it.meta && it.meta.songs) || []).flatMap((sg) => sg.charts || []);
        return charts.some((c) => (!charter || String(c.creator || "").toLowerCase().includes(charter))
          && (!keys.length || keys.includes(c.keys)) && (!hasMin || c.stars >= minS) && (!hasMax || c.stars <= maxS));
      });
    }
    // ?tags=sv,ln: every one of them
    const wantTags = wsTags(sp.get("tags"));
    // the uploader's tags, or the tags worked out from its charts' notes (chart shapes)
    const autoTagsOf = (it) => ((it.meta && it.meta.songs) || []).flatMap((sg) => (sg.charts || []).flatMap((c) => c.autoTags || []));
    if (wantTags.length) items = items.filter((it) => { const auto = autoTagsOf(it); return wantTags.every((t) => (it.tags || []).includes(t) || auto.includes(t)); });
    // ?requested=1: songs waiting for a verification check (Senterra and Octive)
    if (sp.get("requested") === "1") items = items.filter((it) => it.verifyRequest && !it.verified);
    if (sp.get("dan") === "1") items = items.filter((it) => Array.isArray(it.dans) && it.dans.length > 0);
    const topStars = (it) => Math.max(0, ...((it.meta && it.meta.songs) || []).flatMap((sg) => (sg.charts || []).map((c) => c.stars || 0)));
    items.sort(
      sort === "popular" ? (a, b) => (b.downloads || 0) - (a.downloads || 0) || b.at - a.at
      : sort === "liked" ? (a, b) => (b.likes || 0) - (a.likes || 0) || (b.downloads || 0) - (a.downloads || 0) || b.at - a.at
      : sort === "title" ? (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "en", { sensitivity: "base" })
      : sort === "hardest" ? (a, b) => topStars(b) - topStars(a) || b.at - a.at
      : sort === "easiest" ? (a, b) => (topStars(a) || 1e9) - (topStars(b) || 1e9) || b.at - a.at
      : sort === "oldest" ? (a, b) => a.at - b.at
      : sort === "pr" ? (a, b) => wsTopPR(b) - wsTopPR(a) || b.at - a.at
      : sort === "requested" ? (a, b) => ((a.verifyRequest && Date.parse(a.verifyRequest.at)) || 0) - ((b.verifyRequest && Date.parse(b.verifyRequest.at)) || 0)
      : (a, b) => b.at - a.at);
    const counts = {};
    for (const it of db.items || []) if (!it.removed) counts[it.type] = (counts[it.type] || 0) + 1;
    // a spotlight (bought in the points shop) puts an upload first for a day
    if (sort === "new" || sort === "popular") {
      const lit = (it) => it.spotlightUntil && Date.parse(it.spotlightUntil) > Date.now();
      items = [...items.filter(lit), ...items.filter((it) => !lit(it))];
    }
    return reply({ items: items.slice(0, 300).map((it) => ({ ...wsPublic(it), keys: [...new Set(((it.meta && it.meta.songs) || []).flatMap((sg) => (sg.charts || []).map((c) => c.keys)))].filter(Boolean).sort((a, b) => a - b), topStars: it.type === "charts" ? topStars(it) : undefined, topPR: it.type === "charts" ? wsTopPR(it) : undefined })), counts, pending, tagList: WS_TAGS, maxBytes: await wsMaxBytes(env).catch(() => null) });
  }

  // ---- a file of an item, through this server (the browser version can't read Discord's files directly)
  let mf = path.match(/^\/api\/file\/([a-z0-9]{16,40})$/);
  if (mf && request.method === "GET") {
    const db = await r2json(env, WS_DB, { items: [] });
    const it = (db.items || []).find((x) => x.id === mf[1] && !x.removed);
    if (!it) fail(404, "That item isn't available any more.");
    if (it.b2Files && it.b2Files.length) {
      const f = it.b2Files[Math.max(0, Math.min(it.b2Files.length - 1, Number(url.searchParams.get("n")) || 0))];
      // Cloudflare's cache first: a file's key is new for every version, so a cached copy never goes stale and
      // Backblaze is read once per file per Cloudflare location. (The Cache API only works when this server is on a
      // custom domain; on workers.dev it does nothing and every download reads Backblaze.)
      const edge = typeof caches !== "undefined" ? caches.default : null;
      const cacheKey = new Request(`${WORKER_BASE}/api/file-cache/${encodeURIComponent(f.key)}`);
      const hit = edge ? await edge.match(cacheKey).catch(() => null) : null;
      if (hit) { const r = new Response(hit.body, hit); r.headers.set("X-Octive-Cache", "HIT"); return cors(r); }
      const res = await b2Get(env, f.key);
      if (!res.ok) fail(res.status === 404 ? 404 : 502, "That item's file couldn't be read right now.");
      const h = { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${String(f.name || "item").replace(/["\\]/g, "")}"`, "Cache-Control": "public, max-age=31536000, immutable" };
      const cl = res.headers.get("Content-Length"); if (cl) h["Content-Length"] = cl;
      const out = new Response(res.body, { status: 200, headers: h });
      if (edge) ctx.waitUntil(edge.put(cacheKey, out.clone()).catch((e) => console.log("file cache", e && e.message)));
      out.headers.set("X-Octive-Cache", "MISS");
      return cors(out);
    }
    fail(404, "That item's file is missing.");
  }

  // ---- one item with its details: songs and difficulties, or the skin's lock (older items get them now, once)
  let mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})$/);
  if (mi && request.method === "GET") {
    const db = await r2json(env, WS_DB, { items: [] });
    let it = (db.items || []).find((x) => x.id === mi[1] && !x.removed);
    if (!it) fail(404, "That item isn't in the Workshop any more.");
    if (!it.meta && it.type !== "themes" && env.DISCORD_BOT_TOKEN) it = (await wsBackfill(env, it)) || it;
    return reply({ item: { ...wsPublic(it), meta: it.meta || null } });
  }

  // ---- ask for a verification check (the uploader of a song)
  mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/request-verify$/);
  if (mi && request.method === "POST") {
    const who = await signedIn(request, env);
    let out = null, why = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === mi[1] && !y.removed);
      if (!x) { why = "That item isn't in the Workshop any more."; return false; }
      if (x.creatorId !== who.playerId) { why = "Only the person who shared it can ask for that."; return false; }
      if (x.type !== "charts") { why = "Only songs can be verified."; return false; }
      if (x.verified) { why = "It's already verified."; return false; }
      if (x.verifyRequest && Date.now() - Date.parse(x.verifyRequest.at) < 7 * 86_400_000) { out = x; return false; }
      x.verifyRequest = { at: new Date().toISOString(), by: who.playerId };
      delete x.verifyDenied;
      out = x;
    });
    if (why) fail(400, why);
    return reply({ ok: true, item: wsPublic(out) });
  }

  // ---- an upload's auto-tags (2.0.1): its uploader (or staff) takes off ones that don't fit, or puts them back
  mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/autotags$/);
  if (mi && request.method === "POST") {
    const b = await bodyOf(request, 2000);
    const who = await signedIn(request, env);
    await loadModeration(config(env));
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    const staff = badgesOf(who.playerId).some((x) => x === "DEV" || x === "MOD") || who.playerId === OWNER || isOfficial(who.playerId);
    const tag = String(b.tag || "").trim().toLowerCase().slice(0, 40), off = b.removed !== false;
    let out = null, why = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === mi[1] && !y.removed);
      if (!x) { why = "That item isn't in the Workshop any more."; return false; }
      if (x.creatorId !== who.playerId && !staff) { why = "Only the person who shared it can change its tags."; return false; }
      if (x.type !== "charts" || !x.meta) { why = "Only songs have auto-tags."; return false; }
      const known = new Set((x.meta.songs || []).flatMap((sg) => ((sg && sg.charts) || []).flatMap((c) => (Array.isArray(c.autoTagsAll) ? c.autoTagsAll : c.autoTags || []))));
      if (!known.has(tag)) { why = "That isn't one of its auto-tags."; return false; }
      const list = new Set(Array.isArray(x.removedTags) ? x.removedTags : []);
      if (off) list.add(tag); else list.delete(tag);
      if (list.size) x.removedTags = [...list]; else delete x.removedTags;
      applyRemovedTags(x);
      out = x;
    });
    if (why) fail(400, why);
    judgeDbCache = null; shapeIndexCache = null;
    return reply({ ok: true, item: { ...wsPublic(out), meta: out.meta || null } });
  }

  // a verification request turned down, with the reviewer's reason (the uploader is told in the game)
  mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/deny-verify$/);
  if (mi && request.method === "POST") {
    const who = await signedIn(request, env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId)) await freshModeration(env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId) && !badgesOf(who.playerId).includes("CHARTER")) fail(403, "Only Senterra, the official OCTIVE account and charters can review verification requests.");
    const b = await bodyOf(request, 4_000);
    const reason = String(b.reason || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (reason.length < 3) fail(400, "Say why it isn't verified.");
    const byName = await displayName(env, who.playerId);
    let out = null, why = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === mi[1] && !y.removed);
      if (!x) { why = "That item isn't in the Workshop any more."; return false; }
      if (x.verified) { why = "It's already verified."; return false; }
      delete x.verifyRequest;
      x.verifyDenied = { reason, by: who.playerId, byName, at: new Date().toISOString() };
      out = x;
    });
    if (why) fail(400, why);
    return reply({ ok: true, item: wsPublic(out) });
  }

  // ---- verify (Senterra and the official account): OCTIVE vouches for it
  mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/dan$/);
  if (mi && request.method === "POST") {
    // one difficulty of a song is a dan (a pack's 1st to 10th can each be one)
    const who = await signedIn(request, env);
    const danMarker = who.playerId === OWNER || isOfficial(who.playerId) || DAN_MARKERS.includes(who.playerId);
    if (!danMarker) await freshModeration(env);
    if (!danMarker && !badgesOf(who.playerId).includes("CHARTER")) fail(403, "Only Senterra, the official OCTIVE account, charters and dan makers can mark dans.");
    const b = await bodyOf(request);
    const level = b.level ? String(b.level) : null;
    if (level && !DAN_LEVELS.includes(level)) fail(400, "Pick a dan level.");
    const songId = String(b.songId || ""), difficulty = String(b.difficulty || "");
    let out = null, missing = false;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === mi[1]); if (!x || x.type !== "charts") return false;
      const sg = ((x.meta && x.meta.songs) || []).find((g) => g.songId === songId);
      if (!sg || !(sg.charts || []).some((c) => c.difficulty === difficulty)) { missing = true; return false; }
      delete x.dan; // the older whole-upload marking
      x.dans = (x.dans || []).filter((e) => !(e.songId === songId && e.difficulty === difficulty));
      if (level) x.dans.push({ songId, difficulty, level, by: who.playerId, at: new Date().toISOString() });
      if (!x.dans.length) delete x.dans;
      out = x;
    });
    if (missing) fail(404, "That difficulty isn't in this upload.");
    if (!out) fail(404, "That song isn't in the Workshop any more.");
    danIdx = null; verIdx = null;
    return reply({ ok: true, item: wsPublic(out) });
  }

  mi = path.match(/^\/api\/items\/([a-z0-9]{16,40})\/verify$/);
  if (mi && request.method === "POST") {
    const who = await signedIn(request, env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId)) await freshModeration(env);
    if (who.playerId !== OWNER && !isOfficial(who.playerId) && !badgesOf(who.playerId).includes("CHARTER")) fail(403, "Only Senterra, the official OCTIVE account and charters can verify Workshop items.");
    const b = await bodyOf(request);
    let out = null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === mi[1]); if (!x) return false; x.verified = b.verified !== false; if (x.verified) delete x.verifyRequest; out = x; });
    if (!out) fail(404, "That item isn't in the Workshop any more.");
    // a verified song's charts get global leaderboards too
    if (out.verified && out.type === "charts") {
      await r2update(env, "verified.json", () => ({ songs: {} }), (d) => {
        d.songs ||= {};
        for (const sg of (out.meta && out.meta.songs) || []) if (sg.songId && songIdOk(sg.songId) && !officialSong(sg.songId)) d.songs[sg.osuSet > 0 ? "osu-" + sg.osuSet : sg.songId] = { title: sg.title, artist: sg.artist, osuSet: sg.osuSet || undefined, workshopId: out.id, by: who.playerId, at: new Date().toISOString() };
      });
      verifiedCache = null;
    }
    return reply({ ok: true, item: wsPublic(out) });
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
    // on B2: through /api/file (the same for the game, the website and Discord's Download button)
    if (it.b2Files && it.b2Files.length) {
      const v = it.version || 1;
      const files = it.b2Files.map((f, i) => ({ name: f.name, url: `${WORKER_BASE}/api/file/${it.id}?n=${i}&v=${v}`, size: f.size }));
      ctx.waitUntil(r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; x.downloads = (x.downloads || 0) + 1; }).catch(() => {}));
      if (url.searchParams.get("redirect") === "1") return cors(Response.redirect(files[0].url, 302));
      return reply({ url: files[0].url, files, fileName: it.fileName, size: it.size, type: it.type, title: it.title });
    }
    fail(404, "That item's file is missing.");
  }

  // ---- the move to Backblaze (the developer's tools, a few uploads per call): each upload's files are copied from
  // its Discord post to B2, a new card is posted, and the old post is deleted. Oldest first, so the channels stay in order.
  if (path === "/api/admin/b2-move" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    if (!b2Ready(env)) fail(503, "Backblaze isn't set up on the server.");
    const b = await bodyOf(request, 2_000).catch(() => ({}));
    const limit = Math.max(1, Math.min(10, Number(b.limit) || 2));
    const db = await r2json(env, WS_DB, { items: [] });
    const todo = (db.items || []).filter((x) => !x.removed && !x.moveFailed && (!x.b2Files || x.post !== 2)).sort((x, y) => (x.at || 0) - (y.at || 0));
    const done = [], errors = [];
    let retryAfter = 0;
    for (const it of todo.slice(0, limit)) {
      try {
        const files = it.b2Files || await wsMoveFiles(env, it);
        const where = await wsRepost(env, { ...it, b2Files: files });
        await r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; x.b2Files = files; x.preview = x.preview || it.preview; Object.assign(x, where, { post: 2 }); });
        wsUrls.delete(it.id);
        done.push(it.id);
      } catch (e) {
        if (e.status === 429) { retryAfter = 5; break; }
        errors.push({ id: it.id, title: it.title, error: e.message });
        if (e.lost) await r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; x.moveFailed = e.message; }).catch(() => {});
      }
    }
    return reply({ ok: true, done, errors, left: todo.length - done.length, retryAfter });
  }
  // ---- uploads of verified songs that aren't marked verified (uploaded after the song was verified, before 1.6.6)
  if (path === "/api/admin/verify-sync" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 2000).catch(() => ({}));
    const songs = (await verifiedSongs(env)).songs;
    const fixed = [];
    if (b.dry) {
      for (const x of (await r2json(env, WS_DB, { items: [] })).items || []) if (!x.removed && !x.verified && wsOfVerifiedSong(x, songs)) fixed.push({ id: x.id, title: x.title, creator: x.creator });
      return reply({ ok: true, dry: true, fixed });
    }
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      fixed.length = 0;
      for (const x of d.items || []) if (!x.removed && !x.verified && wsOfVerifiedSong(x, songs)) { x.verified = true; delete x.verifyRequest; fixed.push({ id: x.id, title: x.title, creator: x.creator }); }
      if (!fixed.length) return false;
    });
    verIdx = null; danIdx = null;
    return reply({ ok: true, fixed });
  }
  // ---- each chart's id and osu! file fingerprint, read again from the manifests of uploads read before they were kept
  // (verified uploads and dans first). A few uploads per call: they're downloaded whole.
  if (path === "/api/admin/ws-chart-ids" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 20_000).catch(() => ({}));
    const db = await r2json(env, WS_DB, { items: [] });
    const known = (x) => (x.meta.songs || []).some((sg) => (sg.charts || []).some((c) => c.chartId));
    const todo = (db.items || []).filter((x) => x.type === "charts" && !x.removed && x.meta && !x.meta.idsRead && !known(x) && (x.b2Files || []).length)
      .sort((x, y) => Number(!!(y.verified || y.dans)) - Number(!!(x.verified || x.dans)));
    const limit = Math.max(1, Math.min(6, Number(b.limit) || 3));
    const done = [], errors = [];
    for (const it of todo.slice(0, limit)) {
      try {
        const found = [];
        for (const f of it.b2Files.slice(0, 20)) {
          if (f.size > 60 * 1048576) continue;
          const r = await b2Get(env, f.key);
          if (!r.ok) throw new Error(`B2 answered ${r.status}`);
          const m = await wsMeta("charts", new Uint8Array(await r.arrayBuffer()));
          if (m) found.push(m);
        }
        let n = 0, md5s = 0;
        await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
          const x = (d.items || []).find((y) => y.id === it.id);
          if (!x || !x.meta) return false;
          n = 0; md5s = 0;
          for (const sg of x.meta.songs || []) {
            const m = found.find((y) => y.songId === sg.songId);
            if (!m) continue;
            for (const c of sg.charts || []) {
              const mc = (m.charts || []).find((y) => y.difficulty === c.difficulty);
              if (!mc) continue;
              if (mc.chartId) { c.chartId = mc.chartId; n++; }
              if (mc.osuMd5) { c.osuMd5 = mc.osuMd5; md5s++; }
            }
          }
          x.meta.idsRead = true;
        });
        done.push({ id: it.id, title: it.title, verified: !!it.verified, charts: n, osuMd5: md5s });
      } catch (err) { errors.push({ id: it.id, title: it.title, error: err.message }); if (errors.length >= 2) break; }
    }
    verIdx = null; danIdx = null;
    return reply({ ok: errors.length === 0, done, errors, left: Math.max(0, todo.length - done.length) });
  }
  // ---- dan clears from synced plays: retired (synced plays carry only the game's own numbers; clears are judged from
  // the play's replay at /play/dan/clear now)
  if (path === "/api/admin/dan-scan" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    fail(410, "Dan clears only come from replays now (/play/dan/clear); synced plays aren't scanned any more.");
  }
  // ---- board scores kept before plays were judged from their replays: each one with its replay is judged now. A dry
  // run (the default) only reports. With { dry: false } every judged replay's hit timing is kept (so a copy of it is
  // refused like any other) and the judged numbers replace different ones; { drop: true } also takes off scores that
  // can't be judged (no replay, an unreadable one, someone else's, autoplay). A few scores per call: pass "after" back
  // until "left" is 0 (Tools/board_rejudge.py does).
  // ---- 2.1.1 scores: every chart board in points per judgement (Marvelous 350 … Miss 0, no cap) instead of out of
  // 1,000,000. Each entry's score comes from its judgement counts; an entry without counts is scaled by the board's
  // note count (another entry's counts on the same chart). Every board is copied to backups/score-points/ first.
  // A batch of boards per call: pass "after" back until "left" is 0. {dry:true} only counts.
  // (2.1.1) typed Twitch names out of every content creator's card (Twitch is linked with its sign-in now)
  if (path === "/api/admin/strip-twitch-socials" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 2000).catch(() => ({}));
    const dry = b.dry === true;
    const cfg = config(env);
    await loadModeration(cfg);
    const creators = Object.keys(moderation.badges || {}).filter((id) => badgesOf(id).includes("CREATOR"));
    const out = { creators: creators.length, removed: [] };
    for (const id of creators) {
      const card = (await publicItems(cfg, id, ["card"]).catch(() => ({}))).card;
      if (!card || !card.socials || typeof card.socials !== "object") continue;
      const drop = ["twitch", ...(id === OWNER ? [] : ["discord"])].filter((k) => k in card.socials);
      if (!drop.length) continue;
      out.removed.push({ id, was: drop.map((k) => `${k}: ${String(card.socials[k]).slice(0, 60)}`).join(", ") });
      if (dry) continue;
      for (const k of drop) delete card.socials[k];
      await serverWrite(() => saveItem(env, id, "card", safeCard(card), true));
      cards.delete(id);
    }
    return reply({ ok: true, dry, ...out });
  }
  if (path === "/api/admin/score-points" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 20_000).catch(() => ({}));
    const dry = b.dry === true;
    const limit = Math.max(1, Math.min(300, Number(b.limit) || 120));
    const keys = [];
    let cursor;
    do {
      const list = await env.RELEASES.list({ prefix: "scores/", cursor });
      for (const o of list.objects) if (o.key.endsWith(".json")) keys.push(o.key);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    keys.sort();
    const after = String(b.after || "");
    const out = { boards: 0, entries: 0, converted: 0, scaled: 0, unknown: [] };
    let last = null, done = 0;
    for (const key of keys) {
      if (after && key <= after) continue;
      if (done >= limit) break;
      done++; last = key;
      const data = await r2json(env, key, null);
      if (!data || !Array.isArray(data.entries) || !data.entries.some((e) => e && e.pts !== 1)) continue;
      out.boards++;
      const targetsOf = (e) => Array.isArray(e?.counts) ? e.counts.slice(0, 6).reduce((a, x) => a + (Number(x) || 0), 0) : 0;
      const known = data.entries.map(targetsOf).filter((n) => n > 0);
      const boardTargets = known.length ? Math.max(...known) : 0;
      const convert = (x) => {
        for (const e of x.entries || []) {
          if (!e || e.pts === 1) continue;
          out.entries++;
          const pts = pointsOf(e.counts);
          if (pts != null) { e.score = pts; out.converted++; }
          else if (boardTargets > 0) { e.score = pointsFromOld(e.score, boardTargets); out.scaled++; }
          else { out.unknown.push(`${key.slice(7, -5)} ${e.name || e.playerId}`); continue; }
          e.pts = 1;
        }
        x.entries.sort((a, c) => c.score - a.score || c.accuracy - a.accuracy || Date.parse(a.date) - Date.parse(c.date));
      };
      if (dry) { convert(JSON.parse(JSON.stringify(data))); continue; }
      if (!(await env.RELEASES.head(`backups/score-points/${key}`))) await env.RELEASES.put(`backups/score-points/${key}`, JSON.stringify(data));
      await r2update(env, key, () => ({ entries: [] }), (x) => { convert(x); });
      boards.delete(key);
    }
    const left = last ? keys.filter((k) => k > last).length : 0;
    return reply({ ok: true, dry, ...out, after: last, left });
  }
  if (path === "/api/admin/board-rejudge" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 20_000).catch(() => ({}));
    const dry = b.dry !== false, drop = b.drop === true && !dry;
    let budget = Math.max(1, Math.min(40, Number(b.limit) || 8));
    const keys = [];
    let cursor;
    do {
      const list = await env.RELEASES.list({ prefix: "scores/", cursor });
      for (const o of list.objects) if (o.key.endsWith(".json")) keys.push(o.key);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    keys.sort();
    const [afterKey, afterN] = String(b.after || "").split("#");
    const out = { judged: 0, same: 0, differ: [], fixed: [], noReplay: [], unjudgeable: [], dropped: [] };
    let after = null, finished = true;
    for (const key of keys) {
      if (afterKey && key < afterKey) continue;
      const m = /^scores[/]([^/]+)[/]([^/]+)[.]json$/.exec(key);
      if (!m) continue;
      const songId = m[1], chartId = m[2];
      const data = await r2json(env, key, { entries: [] });
      const entries = data.entries || [];
      let n = key === afterKey ? Number(afterN) || 0 : 0;
      if (!entries.slice(n).some((e) => !e.judged)) continue;
      if (budget <= 0) { finished = false; break; }
      let where = null, whereWhy = null;
      try { where = await boardChartOf(env, songId, chartId, data.difficulty || null); } catch (err) { whereWhy = err.message; }
      const changes = new Map(); // playerId -> { date, drop } or { date, set }
      for (; n < entries.length && budget > 0; n++) {
        const e = entries[n];
        if (e.judged) continue; // judged when it was sent
        budget--;
        const tag = { board: `${songId}/${chartId}`, playerId: e.playerId, name: e.name, score: e.score };
        if (!e.replay) { out.noReplay.push(tag); if (drop) changes.set(e.playerId, { date: e.date, drop: true }); continue; }
        let replay = null, why = null;
        try {
          const o = await env.RELEASES.get(boardReplayKey(songId, chartId, e.playerId));
          if (!o) why = "its replay is missing";
          else replay = await readReplay(new Uint8Array(await o.arrayBuffer()));
        } catch (err) { why = err instanceof JudgeDataError ? "its replay couldn't be read: " + err.message : "its replay couldn't be read"; }
        if (!why && replay.playerId && replay.playerId !== e.playerId) why = "the replay is another player's";
        if (!why && replay.autoplay) why = "the replay is autoplay";
        if (why) { out.unjudgeable.push({ ...tag, why }); if (drop) changes.set(e.playerId, { date: e.date, drop: true }); continue; }
        if (!where) { out.unjudgeable.push({ ...tag, why: whereWhy ? "the chart couldn't be read: " + whereWhy : "the chart isn't in the Workshop" }); continue; }
        const r = judgeReplay(where.compiled, replay, { nearest: replay.version >= 2 });
        out.judged++;
        if (!dry) await rememberReplay(env, `board|${songId}|${chartId}`, e.playerId, r.signature);
        const counts = Array.isArray(e.counts) && e.counts.length === 6 ? e.counts : null;
        const set = { score: r.score, accuracy: round2(r.accuracy), grade: r.grade, maxCombo: r.maxCombo, fullCombo: r.fullCombo, counts: r.counts, judged: JUDGE_VERSION };
        if (r.score === e.score && (!counts || counts.join() === r.counts.join())) { out.same++; if (!dry) changes.set(e.playerId, { date: e.date, set: { judged: JUDGE_VERSION } }); continue; }
        const d = { ...tag, accuracy: e.accuracy, counts, judgedScore: set.score, judgedAccuracy: set.accuracy, judgedCounts: set.counts };
        if (dry) out.differ.push(d);
        else { out.fixed.push(d); changes.set(e.playerId, { date: e.date, set }); }
      }
      after = `${key}#${n}`;
      if (changes.size) {
        await r2update(env, key, () => ({ entries: [] }), (x) => {
          x.entries = (x.entries || []).filter((e) => { const c = changes.get(e.playerId); return !(c && c.drop && c.date === e.date); });
          for (const e of x.entries) { const c = changes.get(e.playerId); if (c && c.set && c.date === e.date) Object.assign(e, c.set); }
          x.entries.sort((a, c) => c.score - a.score || c.accuracy - a.accuracy || Date.parse(a.date) - Date.parse(c.date));
        });
        boards.delete(key);
        for (const [playerId, c] of changes) if (c.drop) { out.dropped.push({ board: `${songId}/${chartId}`, playerId }); await env.RELEASES.delete(boardReplayKey(songId, chartId, playerId)).catch(() => {}); }
      }
      if (budget <= 0 && n < entries.length) { finished = false; break; }
    }
    return reply({ ok: true, dry, ...out, after, left: finished ? 0 : 1 });
  }
  // ---- everyone's ranking worked out again from their plays, written to the leaderboard and their card. For when the
  // server got it wrong: it left out plays it wrongly took for impossible, kept PR formula 4 as 3, and never managed to
  // write the leaderboard (entries stayed as games wrote them before 1.5.2). A few per call: pass every id back in
  // "skip". The pace record starts over from the new numbers, so the correction isn't held as a jump.
  if (path === "/api/admin/rank-recompute" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 50_000).catch(() => ({}));
    const dry = b.dry === true;
    const skip = new Set(Array.isArray(b.skip) ? b.skip.map(String) : []);
    const cfg = config(env);
    await loadModeration(cfg);
    const ids = new Set();
    {
      let cursor;
      do {
        const list = await env.RELEASES.list({ prefix: "rank/players/", cursor });
        for (const o of list.objects) ids.add(o.key.slice("rank/players/".length).replace(/\.json$/, ""));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    const page = await api(`${cfg.scores}?offset=0&limit=${TOP + 10}`, cfg.auth);
    const onBoard = new Map();
    for (const e of page?.results || []) { ids.add(e.playerId); onBoard.set(e.playerId, e.score); }
    const todo = [...ids].filter((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id) && !isOfficial(id) && !moderation.bans[id] && !skip.has(id)).sort();
    const limit = Math.max(1, Math.min(10, Number(b.limit) || 6));
    const done = [], kept = [], errors = [];
    const now = Date.now();
    for (const id of todo.slice(0, limit)) {
      try {
        const key = `rank/players/${id}.json`;
        const rec = (await r2json(env, key, null)) || { hist: [] };
        const old = (await publicItems(cfg, id, ["card"]).catch(() => ({}))).card;
        const r = await rankFromPlays(env, cfg, id);
        const card = old && typeof old === "object" && !Array.isArray(old) ? old : {};
        const name = validName(card.name) ? card.name : "Player";
        const row = { id, name, board: onBoard.get(id) ?? null, card: typeof card.pp === "number" ? card.pp : null, pp: r.pp, level: r.level, pv: r.ppVersion, counted: r.counted, leftOut: r.problems.length };
        if (!old) { kept.push({ ...row, why: "no card yet" }); continue; }
        // "release": ids whose held jump was only this correction (given by name, never all)
        const release = Array.isArray(b.release) && b.release.map(String).includes(id);
        if (rec.held && !release) { kept.push({ ...row, why: "a jump is waiting for a moderator" }); continue; }
        if (!isNum(r.pp, 0, V.maxTotalPR) || !isInt(r.level, 1, V.maxLevel)) { kept.push({ ...row, why: "out of range" }); continue; }
        if (!dry) {
          await serverWrite(async () => {
            const meta = { n: name, l: r.level, lp: r.levelProgress, a: r.accuracy, av: typeof card.avatar === "string" ? card.avatar : "", ts: r.totalScore, pc: r.playCount, fc: r.fullCombos, pv: r.ppVersion };
            const e = await writeScore(env, id, r.pp, meta);
            row.rank = isInt(e?.rank, 0, 1e9) ? e.rank + 1 : 0;
            await saveItem(env, id, "card", { ...card, pp: r.pp, accuracy: r.accuracy, level: r.level, levelProgress: r.levelProgress, totalScore: r.totalScore, xp: r.xp,
              playCount: r.playCount, fullCombos: r.fullCombos, maxCombo: r.maxCombo, playTimeMs: r.playTimeMs, ppVersion: r.ppVersion, rank: row.rank }, true);
          });
          Object.assign(rec, { pp: r.pp, level: r.level, levelKnown: true, hist: [{ t: now, pp: r.pp, level: r.level }], at: new Date(now).toISOString() });
          if (release && rec.held) {
            delete rec.held;
            await r2update(env, "rank/flags.json", () => ({ flags: [] }), (d) => {
              const n = (d.flags || []).length;
              d.flags = (d.flags || []).filter((f) => !(f.playerId === id && String(f.what || "").startsWith("held:")));
              if (d.flags.length === n) return false;
            });
          }
          await env.RELEASES.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
          cards.delete(id);
        }
        done.push(row);
      } catch (err) { errors.push({ id, error: err.message }); if (errors.length >= 3) break; }
    }
    // the "impossible plays" notes were all wrong: off the moderators' list
    let clearedFlags = 0;
    if (!dry && b.clearFlags === true)
      await r2update(env, "rank/flags.json", () => ({ flags: [] }), (d) => {
        const before = (d.flags || []).length;
        d.flags = (d.flags || []).filter((f) => !/impossible plays? left out/.test(String(f.what || "")));
        clearedFlags = before - d.flags.length;
        if (!clearedFlags) return false;
      });
    if (done.length && !dry) { board = null; boardAt = 0; }
    return reply({ ok: errors.length === 0, dry, done, kept, errors, clearedFlags, left: Math.max(0, todo.length - limit) });
  }
  // ---- everyone who already has an account: friends with the official OCTIVE account (a few per call)
  if (path === "/api/admin/official-friends" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const b = await bodyOf(request, 20_000).catch(() => ({}));
    // the friend lists profiles show, for everyone already done (done before the server kept them itself)
    if (b.relist) {
      const done = [];
      let cursor;
      do {
        const list = await env.RELEASES.list({ prefix: "official-friends/", cursor });
        for (const o of list.objects) done.push(o.key.slice("official-friends/".length));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      let n = 0, failed = 0;
      for (const id of done) { try { await mirrorOfficialFriend(env, id); n++; } catch (e) { failed++; console.log("relist", e && e.message); } }
      const box = await r2json(env, dmInboxKey(OFFICIAL_ID), dmEmptyInbox());
      return reply({ ok: failed === 0, relisted: n, failed, officialFriends: (box.friends || []).length });
    }
    let ids;
    if (Array.isArray(b.only)) ids = b.only.map(String);
    else {
      const set = new Set();
      for (const prefix of ["rank/players/", "points/"]) {
        let cursor;
        do {
          const list = await env.RELEASES.list({ prefix, cursor });
          for (const o of list.objects) set.add(o.key.slice(prefix.length).replace(/\.json$/, ""));
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
      }
      try { for (const p of (await leaderboard(env)).players || []) set.add(p.id); } catch { /* the ranking is optional here */ }
      ids = [...set].filter((x) => /^[A-Za-z0-9_-]{8,64}$/.test(x) && !isOfficial(x)).sort();
    }
    // who has it already (one listing, not a look per player)
    {
      let cursor;
      do {
        const list = await env.RELEASES.list({ prefix: "official-friends/", cursor });
        for (const o of list.objects) if (!b.recheck) officialFriendsDone.add(o.key.slice("official-friends/".length));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    const limit = Math.max(1, Math.min(25, Number(b.limit) || 10));
    const done = [];
    let errors = 0, left = 0, firstError = null;
    for (const id of ids) {
      if (done.length >= limit) { left++; continue; }
      if (officialFriendsDone.has(id)) continue;
      try { done.push({ id, result: await befriendOfficial(env, id) }); }
      catch (e) { errors++; firstError ??= e.message; done.push({ id, error: e.message }); if (errors >= 3) break; }
    }
    return reply({ ok: errors === 0, done, left, total: ids.length, way: socialAuthWay, firstError });
  }

  // a check that the Backblaze key works: one small file stored, read back and deleted
  if (path === "/api/admin/b2-test" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    if (!b2Ready(env)) fail(503, "Backblaze isn't set up on the server.");
    const key = `workshop/_test/${Date.now()}.txt`, body = new TextEncoder().encode("OCTIVE B2 test " + new Date().toISOString());
    const steps = {};
    try { await b2Put(env, key, body); steps.put = "ok"; } catch (e) { return reply({ ok: false, step: "put", error: e.message }); }
    const r = await b2Get(env, key);
    const back = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    steps.get = back && back.length === body.length ? "ok" : `failed (${r.status})`;
    try { await b2Delete(env, key); steps.delete = "ok"; } catch (e) { steps.delete = e.message; }
    return reply({ ok: Object.values(steps).every((v) => v === "ok"), steps, bucket: env.B2_BUCKET, endpoint: env.B2_ENDPOINT });
  }
  // the bot's other posts in the four channels (older copies, removed uploads): deleted, a page at a time
  if (path === "/api/admin/b2-sweep" && request.method === "POST") {
    if (!(await officialImporter(request, env))) fail(403, "Only the developer's tools can do this.");
    const db = await r2json(env, WS_DB, { items: [] });
    const keep = new Set((db.items || []).filter((x) => !x.removed && x.messageId).map((x) => x.messageId));
    const me = await discordApi(env, "GET", "/users/@me");
    const channels = await wsChannelIds(env);
    let deleted = 0, more = false, retryAfter = 0;
    outer: for (const channelId of Object.values(channels)) {
      let before = null;
      for (let page = 0; page < 5; page++) {
        const list = await discordApi(env, "GET", `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
        if (!list || !list.length) break;
        for (const m of list) {
          if (m.author?.id !== me.id || keep.has(m.id)) continue;
          if (deleted >= 20) { more = true; break outer; }
          try { await discordApi(env, "DELETE", `/channels/${channelId}/messages/${m.id}`); deleted++; }
          catch (e) { if (e.status === 429) { more = true; retryAfter = 5; break outer; } }
        }
        before = list[list.length - 1].id;
        if (list.length < 100) break;
      }
    }
    return reply({ ok: true, deleted, more, retryAfter });
  }

  // ---- upload from the game
  // ---- (2.0.2) Ranked's connection check (the game, the first time Ranked opens each launch): the time to this server
  // and back, bytes from it (random, so nothing on the way can shrink them) and bytes to it (counted, then thrown away)
  if (path === "/api/speed/ping") return cors(new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store, no-transform" } }));
  if (path === "/api/speed/down" && request.method === "GET") {
    const n = Math.max(0, Math.min(50 * 1048576, Math.floor(Number(url.searchParams.get("bytes")) || 0)));
    const block = crypto.getRandomValues(new Uint8Array(65536));
    let sent = 0;
    const body = new ReadableStream({
      pull(c) { if (sent >= n) { c.close(); return; } const k = Math.min(block.length, n - sent); c.enqueue(block.slice(0, k)); sent += k; },
    });
    return cors(new Response(body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store, no-transform" } }));
  }
  if (path === "/api/speed/up" && request.method === "POST") {
    let n = 0;
    const rd = request.body ? request.body.getReader() : null;
    if (rd) for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > 50 * 1048576) { await rd.cancel().catch(() => {}); break; } }
    return reply({ ok: true, bytes: n });
  }

  // ---- (2.0.2) a big file sent in parts (see WS_SINGLE_MAX): start, then each part in order
  if (path === "/api/upload/stage" && request.method === "POST") {
    if (!b2Ready(env)) fail(503, "Uploads aren't set up on the server.");
    const who = await signedIn(request, env);
    await loadModeration(config(env));
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    let body;
    try { body = await request.json(); } catch { fail(400, "Expected JSON."); }
    const fileName = String((body && body.fileName) || "item").replace(/[^A-Za-z0-9 ._()\[\]'&+,-]/g, "_").slice(0, 100);
    const ext = (fileName.match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase();
    if (!WS_TYPES[ext]) fail(400, "Only .oct (charts), .octskin (skins), .octtheme (themes) and .octstyle (styles) files can be shared.");
    const size = Math.floor(Number(body && body.size) || 0);
    const max = await wsMaxBytes(env);
    if (!(size > 0)) fail(400, "The file is empty.");
    if (size > max) fail(413, `That's too big: uploads can be up to ${Math.floor(max / 1048576)} MB.`);
    const open = await env.RELEASES.list({ prefix: `workshop/stage/${who.playerId}/`, limit: 30 });
    if (open.objects.length >= 25) fail(429, "Too many uploads are on their way at once. Try again in a while.");
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const key = `workshop/staged/${id}${ext}`;
    const r = await b2S3(env, "POST", key, { uploads: "" }, null, "application/octet-stream");
    const text = await r.text().catch(() => "");
    const uploadId = (/<UploadId>([^<]+)<\/UploadId>/.exec(text) || [])[1];
    if (!r.ok || !uploadId) { console.log("stage start", r.status, text.slice(0, 200)); fail(502, "The upload couldn't start right now. Try again in a moment."); }
    await r2put(env, wsStageKey(who.playerId, id), { id, key, uploadId, fileName, size, at: Date.now(), parts: [], h: sha256Start(), done: false });
    return reply({ ok: true, stageId: id, partSize: WS_PART });
  }
  // how far a staged file got (the game carries on from there after a dropped connection, or a restart)
  m = path.match(/^\/api\/upload\/stage\/([a-z0-9]{20})$/);
  if (m && request.method === "GET") {
    const who = await signedIn(request, env);
    const rec = await r2json(env, wsStageKey(who.playerId, m[1]), null);
    if (!rec) fail(404, "That upload was too long ago. Start it again.");
    return reply({ ok: true, fileName: rec.fileName, size: rec.size, partSize: WS_PART, received: Math.min(rec.size, rec.parts.length * WS_PART), done: !!rec.done });
  }
  m = path.match(/^\/api\/upload\/stage\/([a-z0-9]{20})\/([0-9]{1,3})$/);
  if (m && request.method === "PUT") {
    const who = await signedIn(request, env);
    const rk = wsStageKey(who.playerId, m[1]);
    const rec = await r2json(env, rk, null);
    if (!rec) fail(404, "That upload was too long ago. Start it again.");
    const n = Number(m[2]);
    const received = () => Math.min(rec.size, rec.parts.length * WS_PART);
    if (n >= 1 && n <= rec.parts.length) return reply({ ok: true, received: received(), done: !!rec.done }); // sent already (a retry)
    if (n !== rec.parts.length + 1) fail(409, "The parts came out of order. Start the upload again.");
    const offset = (n - 1) * WS_PART, expect = Math.min(WS_PART, rec.size - offset);
    if (expect <= 0) fail(400, "The file doesn't have that many parts.");
    const cl = Number(request.headers.get("Content-Length") || 0);
    if (cl && cl !== expect) fail(400, `That part should be ${expect} bytes.`);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length !== expect) fail(400, `That part should be ${expect} bytes.`);
    const last = offset + expect >= rec.size;
    const r = await b2S3(env, "PUT", rec.key, { partNumber: String(n), uploadId: rec.uploadId }, bytes);
    const etag = r.headers.get("ETag");
    if (!r.ok || !etag) { console.log("stage part", r.status, (await r.text().catch(() => "")).slice(0, 200)); fail(502, "That part couldn't be stored right now. Try again in a moment."); }
    rec.parts.push({ n, etag });
    if (last) {
      rec.hash = sha256Finish(rec.h, bytes, rec.size); rec.h = null;
      const xml = `<CompleteMultipartUpload>${rec.parts.map((x) => `<Part><PartNumber>${x.n}</PartNumber><ETag>${x.etag.replace(/[<>&]/g, "")}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const c = await b2S3(env, "POST", rec.key, { uploadId: rec.uploadId }, new TextEncoder().encode(xml), "application/xml");
      const ct = await c.text().catch(() => "");
      if (!c.ok || /<Error>/.test(ct)) { console.log("stage complete", c.status, ct.slice(0, 200)); fail(502, "The file couldn't be put together right now. Start the upload again."); }
      rec.done = true;
    } else sha256Blocks(rec.h, bytes);
    await r2put(env, rk, rec);
    return reply({ ok: true, received: received(), done: !!rec.done });
  }

  if (path === "/api/upload" && request.method === "POST") {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) fail(503, "Uploads aren't set up on the server.");
    // OCTIVE's own content can also be published by the developer's tools as the official account (with a key
    // only the server's owner can make); it can only publish OCTIVE content (builtin), nothing else
    const importer = await officialImporter(request, env);
    const who = importer || await signedIn(request, env);
    const cfg = config(env);
    await loadModeration(cfg);
    if (moderation.bans[who.playerId]) fail(403, "This account is banned.");
    // a few uploads a day per player
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `workshop/rate/${who.playerId}.json`;
    const rate = await r2json(env, rateKey, { day, n: 0 });
    if (rate.day !== day) { rate.day = day; rate.n = 0; }
    const limit = await wsDailyLimit(env, who.playerId);
    if (rate.n >= limit) fail(429, limit === 3 ? "You've shared 3 uploads today (supporters can share 10). Try again tomorrow, or update one you already shared." : `You've shared ${limit} uploads today. Try again tomorrow.`);

    const max = await wsMaxBytes(env);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > WS_SINGLE_MAX + 200_000) fail(413, len > max + 200_000 ? `That's too big: uploads can be up to ${Math.floor(max / 1048576)} MB.` : `Files over ${Math.floor(WS_SINGLE_MAX / 1048576)} MB need the newest OCTIVE: update the game to share it.`);
    let form;
    try { form = await request.formData(); } catch { fail(400, "The upload wasn't readable (multipart/form-data expected)."); }
    if (importer && form.get("builtin") !== "1") fail(403, "The import key only publishes OCTIVE's own content.");
    // one file, or (charts) the songs of one entry: a pack or speed copies, up to 20 songs in one item
    // ((2.0.2) big ones sent before in parts)
    const files = await wsInputs(env, form, who.playerId);
    if (!files.length) fail(400, "No file was attached.");
    const parts = [];
    let type = null, total = 0;
    for (const file of files) {
      const fileName = String(file.name || "item").replace(/[^A-Za-z0-9 ._()\[\]'&+,-]/g, "_").slice(0, 100);
      const ext = (fileName.match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase();
      const t = WS_TYPES[ext];
      if (!t) fail(400, "Only .oct (charts), .octskin (skins), .octtheme (themes) and .octstyle (styles) files can be shared.");
      if (type && t !== type) fail(400, "Share one kind of thing at a time.");
      type = t;
      total += file.size;
      if (total > max) fail(413, `That's too big: uploads can be up to ${Math.floor(max / 1048576)} MB in all.`);
      const bytes = await file.read();
      const hash = file.hash || await bytesHash(bytes);
      if (parts.some((x) => x.hash === hash)) continue; // the same file twice: once is enough
      const { preview } = await wsInspect(t, bytes);
      const meta1 = await wsMeta(t, bytes);
      // the same song twice in one pack (another copy of it): once is enough
      if (meta1 && meta1.songId && parts.some((x) => x.meta && x.meta.songId === meta1.songId)) continue;
      parts.push({ fileName, bytes, preview, hash, meta: meta1, staged: file.staged });
    }
    if (parts.length > 1 && type !== "charts") fail(400, "Only songs can be shared several at a time.");
    if (parts.length > 20) fail(400, "Share at most 20 songs in one post.");
    const fileName = parts[0].fileName, bytes = parts[0].bytes;
    let preview = (parts.find((x) => x.preview) || {}).preview || null;
    // a picture the game drew (themes: their main menu), when the file has none
    if (!preview) {
      const pf = form.get("preview");
      if (pf && typeof pf !== "string" && pf.size > 0 && pf.size <= 3 * 1048576) { const pb = new Uint8Array(await pf.arrayBuffer()); if (imageType(pb)) preview = pb; }
    }
    const hashes = parts.map((x) => x.hash);
    const songIds = parts.map((x) => x.meta && x.meta.songId).filter(Boolean);
    const meta = type === "charts" ? { songs: parts.map((x) => x.meta).filter(Boolean) } : (parts[0].meta || null);
    if (meta && type !== "charts") meta.songs = undefined;
    if (type === "charts" && meta) meta.locked = false;
    if (type !== "charts" && parts[0].meta) meta.locked = !!parts[0].meta.locked;

    // the same file, or the same song, is only in the Workshop once
    const dbNow = await r2json(env, WS_DB, { items: [] });
    // OCTIVE's own items from the import key: a new copy replaces the old one (below), so no duplicate check
    const dup = importer && form.get("builtin") === "1" ? null : wsDuplicate(dbNow.items || [], hashes, songIds, null);
    if (dup) {
      // your own: the game asks whether this is an update of it
      const mine = dup.creatorId === who.playerId;
      return reply({ error: `That's already in the Workshop: "${dup.title}" by ${dup.creator}.`, code: "duplicate", duplicateId: dup.id, mine, item: wsPublic(dup) }, 409);
    }
    // the same map again (a fresh osu! import of it, or a changed copy of an upload): get the one that's there.
    // Developers, moderators and the official account can still post their own copies.
    if (type === "charts" && !(importer && form.get("builtin") === "1")) {
      const staffUp = badgesOf(who.playerId).some((b) => b === "DEV" || b === "MOD") || who.playerId === OWNER || isOfficial(who.playerId);
      const same = staffUp ? null : wsSameCharts(dbNow.items || [], meta && meta.songs, null);
      if (same) {
        const mine = same.creatorId === who.playerId;
        return reply({
          error: mine ? `You've shared this map already: "${same.title}". Update that upload instead.` : `This map is already in the Workshop: "${same.title}" by ${same.creator}. Get it there instead of uploading it again.`,
          code: "duplicate", duplicateId: same.id, mine, item: wsPublic(same),
        }, 409);
      }
    }

    const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@\u200b$1").trim().slice(0, n);
    const card = (await publicItems(cfg, who.playerId, ["card"]).catch(() => ({}))).card || {};
    const creator = clean(moderation.overrides[who.playerId]?.name || card.name || form.get("creator") || who.username || "Player", 40);
    const title = clean(form.get("title"), 80) || fileName.replace(/\.[^.]+$/, "");
    const description = clean(form.get("description"), 1000);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    let creatorDiscord = null;
    try { const rec = await record(env, who.playerId); creatorDiscord = rec.discord?.id || null; } catch { /* not linked */ }

    if (!b2Ready(env)) fail(503, "Uploads aren't set up on the server.");
    const channels = await wsChannelIds(env);
    const channelId = channels[type];
    if (!channelId) fail(503, `The #${WS_CHANNEL[type]} channel wasn't found on the OCTIVE Discord.`);
    const pType = imageType(preview);
    // the files: Backblaze B2 (the Discord post is a card with a Download button)
    const b2Files = await wsStoreFiles(env, id, 1, parts);
    if (pType) await env.RELEASES.put(`workshop/previews/${id}`, preview, { httpMetadata: { contentType: pType === "png" ? "image/png" : "image/jpeg" } });
    const item = {
      id, type, title, description, creator, creatorId: who.playerId, fileName, fileNames: parts.map((x) => x.fileName), size: total,
      channelId, messageId: null, guildId: env.DISCORD_GUILD_ID, at: Date.now(), downloads: 0, preview: !!pType,
      hashes, songIds, meta, verified: isOfficial(who.playerId), // the official account's uploads are OCTIVE's own: verified
      // (a song that's verified already: its new uploads are verified as well, below)
      tags: type === "charts" ? wsTags(form.get("tags")) : undefined,
      // OCTIVE's own songs, skins and themes (once built into the game): every player gets them
      builtin: isOfficial(who.playerId) && form.get("builtin") === "1" ? true : undefined,
      originalId: isOfficial(who.playerId) && /^octive[.-][a-z0-9.-]{1,60}$/.test(String(form.get("originalId") || "")) ? String(form.get("originalId")) : undefined,
      b2Files, post: 2,
    };
    if (!item.verified && type === "charts") { try { if (wsOfVerifiedSong(item, (await verifiedSongs(env)).songs)) { item.verified = true; verIdx = null; danIdx = null; } } catch { /* stays unverified */ } }
    try { item.messageId = (await discordApi(env, "POST", `/channels/${channelId}/messages`, wsPostBody(item, creatorDiscord))).id; }
    catch (e) { console.log("workshop post", e && e.message); }
    // OCTIVE's own items: one each (a newer export replaces the older copy)
    const replaced = [];
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      d.items = d.items || [];
      if (item.builtin && item.originalId)
        for (const x of d.items) if (!x.removed && x.builtin && x.originalId === item.originalId) { x.removed = true; replaced.push(x); }
      d.items.push(item);
    });
    await wsStagesUsed(env, who.playerId, parts);
    for (const x of replaced) { if (x.messageId) { try { await discordApi(env, "DELETE", `/channels/${x.channelId}/messages/${x.messageId}`); } catch { /* gone */ } } await wsDeleteFiles(env, x); wsUrls.delete(x.id); }
    rate.n += 1;
    await r2put(env, rateKey, rate);
    // friends see the upload
    if (!importer) await addFeed(env, who.playerId, { kind: "upload", itemId: item.id, title: String(item.title || "").slice(0, 80), type }).catch((e) => console.log("feed", e && e.message));
    // followers get a notice (in the background: there can be many)
    if (!importer) { const p = wsNotifyFollowers(env, who.playerId, item).catch((e) => console.log("followers", e && e.message)); if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p; }
    return reply({ ok: true, item: wsPublic(item) });
  }

  // ---- a score shared from the results screen: the picture goes to #octive-scores
  // Nothing in the post comes from the request as it is: the play is the one saved to the player's account (found
  // by its chart and score, and checked like the ranking checks plays), the words are plain text (no links,
  // headings or mentions), and the picture must be the game's own 1920×1080 drawing whose score and name or
  // accuracy (read back from it) match the play. A picture that doesn't match or can't be read is left out; one
  // that isn't a results screen at all stops the share and the player is flagged for moderators.
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
    let info = {};
    try { info = JSON.parse(String(form.get("info") || "{}")) || {}; } catch { /* none */ }

    // the play, as it's saved to the account
    const songId = String(info.songId || ""), chartId = String(info.chartId || "");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(songId) || !/^[A-Za-z0-9._-]{1,100}$/.test(chartId)) fail(400, "Update OCTIVE to share scores.");
    const want = Math.round(Number(info.score));
    const saved = ((await privateItems(env, who.playerId, ["scores"]).catch(() => ({}))).scores || {});
    const c = (saved.charts && typeof saved.charts === "object" ? saved.charts : {})[`${songId}/${chartId}`];
    const top = c && Array.isArray(c.top) ? c.top.filter((x) => x && typeof x === "object") : [];
    const play = Number.isFinite(want) ? top.find((x) => Math.round(Number(x.score)) === want && !x.failed) : null;
    if (!play) fail(409, "That play isn't saved to your account yet (only your 10 best plays of a chart are). Try again in a moment.");
    const n = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const score = n(play.score, 0, SCORE_MAX), acc = n(play.accuracy, 0, 100), stars = n(play.stars ?? c.stars, 0, V.maxStars);
    const combo = n(play.maxCombo, 0, V.maxCombo), notes = n(play.notes, 0, V.maxCombo);
    const counts = Array.isArray(play.counts) ? play.counts.slice(0, 6).map((x) => n(x, 0, V.maxCombo) ?? -1) : [];
    let pr = n(play.pp, 0, playPRMax(V.maxStars));
    // checked like the ranking checks plays: anything impossible and the play isn't shared
    const odd =
      score === null ? "score" : acc === null ? "accuracy" :
      notes !== null && combo !== null && notes > 0 && combo > notes ? "combo past the notes" :
      counts.some((x) => x < 0) ? "judgements" :
      notes && counts.length === 6 && counts.reduce((a, b) => a + b, 0) > notes * 2 + 10 ? "judgements past the notes" :
      pr !== null && pr > (stars !== null ? playPRMax(stars, acc) * 1.05 + 1 : playPRMax(V.maxStars)) ? "PR past the chart's stars" : null;
    if (odd) {
      await flagPlayer(env, who.playerId, `score share refused (${odd}) on ${songId}/${chartId}`).catch(() => {});
      fail(400, "That play doesn't add up, so it can't be shared.");
    }
    if (pr !== null && pr <= 0) pr = null;

    // plain words: no links, invites, headings, quotes, masked links, mentions or markdown
    const plain = (v, max) => String(v ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, " ")
      .replace(/(?:https?:\/\/|www\.)\S+/gi, "").replace(/\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/gi, "")
      .replace(/<[@#:][^>]*>/g, "").replace(/@(everyone|here)/gi, "$1").replace(/[\[\]<>*_~`|#\\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
    const title = plain(c.title || play.title, 100) || "A song";
    const diff = plain(c.difficulty || play.difficulty, 60);
    const keys = n(c.keyCount || play.keyCount, 1, 20);
    const mods = String(play.mods || "").replace(/[^A-Za-z0-9. ]/g, "").slice(0, 40);
    // its labels, worked out here from the play
    const fc = counts.length === 6 ? counts[5] === 0 : play.fullCombo === true;
    const tagsOut = [];
    if (counts.length === 6 && counts[1] + counts[2] + counts[3] + counts[4] + counts[5] === 0 && counts[0] > 0) tagsOut.push("ALL MARVELOUS");
    else if (counts.length === 6 && counts[2] + counts[3] + counts[4] + counts[5] === 0 && counts[0] + counts[1] > 0) tagsOut.push("PERFECT PLAY");
    else if (fc) tagsOut.push("FULL COMBO");
    const best = top.reduce((a, x) => Math.max(a, Number(x.score) || 0), 0);
    if (score >= best && top.length > 1) tagsOut.push("PERSONAL BEST");
    const grade = String(play.grade || "").replace(/[^A-Z+]/g, "").slice(0, 3);

    const card = (await publicItems(cfg, who.playerId, ["card"]).catch(() => ({}))).card || {};
    const name = plain(moderation.overrides[who.playerId]?.name || card.name || who.username || "Player", 40) || "Player";

    // the picture: the game's own drawing, read back and matched against the play
    let bytes = null, kind = null, picNote = null;
    const file = form.get("image");
    if (file && typeof file !== "string" && file.size <= 8_000_000) {
      const b = new Uint8Array(await file.arrayBuffer());
      const im = chatImageInfo(b);
      if (!im || (im.type !== "jpeg" && im.type !== "png") || im.w !== 1920 || im.h !== 1080) fail(400, "That picture isn't one OCTIVE drew, so the score wasn't shared.");
      const pc = await sharePictureCheck(env, b, { name, score, acc, title });
      const check = pc.check;
      // the last checks, to look into pictures that were left out:
      // npx wrangler r2 object get octive-releases/scores/picture-checks.json --remote --pipe
      try {
        const log = await r2json(env, "scores/picture-checks.json", []);
        const list = Array.isArray(log) ? log : [];
        list.unshift({ at: new Date().toISOString(), player: who.playerId, play: `${songId}/${chartId}`, check, why: pc.why, read: pc.read, want: { name, score, acc, title } });
        await r2put(env, "scores/picture-checks.json", list.slice(0, 40));
      } catch { /* only a log */ }
      if (check === "fake") {
        await flagPlayer(env, who.playerId, `score share refused (the picture isn't a results screen) on ${songId}/${chartId}`).catch(() => {});
        fail(400, "That picture isn't a results screen from OCTIVE, so the score wasn't shared.");
      }
      // a picture that shows this play goes with it; anything else (a different play, unreadable) is left out
      if (check === "ok") { bytes = b; kind = im.type === "png" ? "png" : "jpg"; }
      else picNote = "picture left out: " + check;
    }

    let discordId = null;
    try { const rec = await record(env, who.playerId); discordId = rec.discord?.id || null; } catch { /* not linked */ }
    const channelId = await scoresChannelId(env);
    if (!channelId) fail(503, "The #octive-scores channel wasn't found on the OCTIVE Discord.");
    const avatarHash = moderation.overrides[who.playerId]?.avatar ? "mod-" + Date.parse(moderation.overrides[who.playerId].at) : (card.avatar || "");
    const gradeColor = { X: 0x7FF5FF, SS: 0x7FF5FF, S: 0xF2C14E, A: 0x3DDC84, B: 0x5DA9FF, C: 0xB69BFF, D: 0xFF6F6F }[grade] || C_ACCENT;
    const fmt = (x) => Math.round(x).toLocaleString("en-US");
    const fields = [
      { name: "Score", value: fmt(score), inline: true },
      { name: "Accuracy", value: `${acc.toFixed(2)}%${grade ? ` · ${grade}` : ""}`, inline: true },
      ...(pr !== null ? [{ name: "Performance", value: `${fmt(pr)} PR${stars !== null ? ` · ★${stars.toFixed(2)}` : ""}`, inline: true }] : []),
      ...(combo !== null ? [{ name: "Max combo", value: `${fmt(combo)}x${notes ? ` / ${fmt(notes)}` : ""}`, inline: true }] : []),
      ...(counts.length === 6 ? [{ name: "Judgements", value: counts.map(fmt).join(" · "), inline: true }] : []),
      ...(tagsOut.length ? [{ name: "​", value: tagsOut.map((t) => `**${t}**`).join(" · "), inline: true }] : []),
    ];
    const footer = [diff, keys ? `${keys}K` : "", mods, "Shared from OCTIVE"].filter(Boolean).join("  ·  ");
    const embed = {
      color: gradeColor,
      author: { name, url: `${SITE}#/u/${encodeURIComponent(who.playerId)}`, ...(avatarHash ? { icon_url: `${WORKER_BASE}/avatar/${encodeURIComponent(who.playerId)}?v=${encodeURIComponent(avatarHash)}` } : {}) },
      title: title.slice(0, 256), fields,
      ...(bytes ? { image: { url: `attachment://score.${kind}` } } : {}),
      footer: { text: footer.slice(0, 2000) }, timestamp: new Date().toISOString(),
    };
    const payload = { content: discordId ? `<@${discordId}> shared a score` : undefined, embeds: [embed], allowed_mentions: { parse: [], users: discordId ? [discordId] : [] } };
    let posted;
    if (bytes) {
      const fd = new FormData();
      payload.attachments = [{ id: 0, filename: `score.${kind}` }];
      fd.append("payload_json", JSON.stringify(payload));
      fd.append("files[0]", new Blob([bytes], { type: kind === "png" ? "image/png" : "image/jpeg" }), `score.${kind}`);
      posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, fd, true);
    } else posted = await discordApi(env, "POST", `/channels/${channelId}/messages`, payload);
    if (picNote) console.log("score share", who.playerId, picNote);
    scoreShareAt.set(who.playerId, now);
    if (scoreShareAt.size > 5000) scoreShareAt.delete(scoreShareAt.keys().next().value);
    rate.n += 1;
    await r2put(env, rateKey, rate);
    return reply({ ok: true, url: `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${channelId}/${posted.id}`, picture: !!bytes });
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
    const staff = badgesOf(who.playerId).some((b) => b === "DEV" || b === "MOD") || who.playerId === OWNER || isOfficial(who.playerId);
    if (it.creatorId !== who.playerId && !staff) fail(403, "Only the person who shared it can update it.");
    const max = await wsMaxBytes(env);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > WS_SINGLE_MAX + 200_000) fail(413, len > max + 200_000 ? `That's too big: uploads can be up to ${Math.floor(max / 1048576)} MB.` : `Files over ${Math.floor(WS_SINGLE_MAX / 1048576)} MB need the newest OCTIVE: update the game to share it.`);
    let form;
    try { form = await request.formData(); } catch { fail(400, "The update wasn't readable (multipart/form-data expected)."); }
    const clean = (v, n) => String(v || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/@(everyone|here)/gi, "@\u200b$1").trim().slice(0, n);
    const title = form.get("title") != null ? clean(form.get("title"), 80) || it.title : it.title;
    const description = form.get("description") != null ? clean(form.get("description"), 1000) : it.description;
    // the developer and the official account can change who it's credited to
    const canCredit = who.playerId === OWNER || isOfficial(who.playerId);
    const creator = canCredit && form.get("creator") != null ? clean(form.get("creator"), 40) || it.creator : it.creator;
    const newCreatorId = canCredit && /^[A-Za-z0-9_-]{8,64}$/.test(String(form.get("creatorId") || "")) ? String(form.get("creatorId")) : it.creatorId;
    // a new version: one file, or (a pack) all its songs again
    const upFiles = await wsInputs(env, form, who.playerId);
    const upParts = [];
    let upTotal = 0;
    for (const file of upFiles.slice(0, 20)) {
      const fn = String(file.name || it.fileName).replace(/[^A-Za-z0-9 ._()\[\]'&+,-]/g, "_").slice(0, 100);
      const ext = (fn.match(/\.[A-Za-z]+$/) || [""])[0].toLowerCase();
      if (WS_TYPES[ext] !== it.type) fail(400, `An update must be the same kind of file (${WS_LABEL[it.type].toLowerCase()}).`);
      upTotal += file.size;
      if (upTotal > max) fail(413, `That's too big: uploads can be up to ${Math.floor(max / 1048576)} MB.`);
      const b8 = await file.read();
      const h = file.hash || await bytesHash(b8);
      if (upParts.some((x) => x.hash === h)) continue;
      const pv = (await wsInspect(it.type, b8)).preview;
      const mt = await wsMeta(it.type, b8);
      if (mt && mt.songId && upParts.some((x) => x.meta && x.meta.songId === mt.songId)) continue;
      upParts.push({ fileName: fn, bytes: b8, preview: pv, hash: h, meta: mt, staged: file.staged });
    }
    let bytes = upParts.length ? upParts[0].bytes : null, fileName = upParts.length ? upParts[0].fileName : it.fileName, preview = (upParts.find((x) => x.preview) || {}).preview || null;
    if (!preview && upParts.length) {
      const pf = form.get("preview");
      if (pf && typeof pf !== "string" && pf.size > 0 && pf.size <= 3 * 1048576) { const pb = new Uint8Array(await pf.arrayBuffer()); if (imageType(pb)) preview = pb; }
    }
    let newHash = null, newMeta = null;
    if (upParts.length) {
      newHash = upParts[0].hash;
      newMeta = upParts[0].meta;
      // it mustn't be someone else's upload
      const sids = it.type === "charts" ? upParts.map((x) => x.meta && x.meta.songId).filter(Boolean) : [];
      const dup = wsDuplicate(db.items || [], upParts.map((x) => x.hash), sids, it.id);
      if (dup) fail(409, `That file is already in the Workshop: "${dup.title}" by ${dup.creator}.`);
      // nor someone else's map again (their uploads only: a new version of your own map is fine)
      if (it.type === "charts" && !staff) {
        const same = wsSameCharts(db.items || [], upParts.map((x) => x.meta).filter(Boolean), (x) => x.id !== it.id && x.creatorId !== it.creatorId);
        if (same) fail(409, `This map is already in the Workshop: "${same.title}" by ${same.creator}.`);
      }
    }
    // a few updates a day per player (they count with uploads)
    const day = new Date().toISOString().slice(0, 10);
    const rateKey = `workshop/rate/${who.playerId}.json`;
    const rate = await r2json(env, rateKey, { day, n: 0 });
    if (rate.day !== day) { rate.day = day; rate.n = 0; }
    rate.u = rate.u || 0;
    if (rate.u >= 30 && !staff) fail(429, "You've updated a lot today. Try again tomorrow.");

    const size = upParts.length ? upTotal : it.size;
    const version = (it.version || 1) + (bytes ? 1 : 0);
    const pType = preview ? imageType(preview) : null;
    if (!b2Ready(env)) fail(503, "Uploads aren't set up on the server.");
    // an upload still on Discord: its files come over to B2 first (its old post is replaced below)
    let oldFiles = it.b2Files || null;
    if (!oldFiles && !bytes) { try { oldFiles = await wsMoveFiles(env, it); } catch (e) { fail(e.lost ? 404 : 502, e.lost ? "That item's file is missing on Discord." : "Couldn't update it right now. Try again in a moment."); } }
    // a new version's files (the old ones are removed once it's saved)
    const newFiles = bytes ? await wsStoreFiles(env, it.id, version, upParts) : null;
    if (pType) await env.RELEASES.put(`workshop/previews/${it.id}`, preview, { httpMetadata: { contentType: pType === "png" ? "image/png" : "image/jpeg" } });
    wsUrls.delete(it.id);
    let out = null;
    const verifiedNow = it.type === "charts" ? ((await verifiedSongs(env).catch(() => null)) || {}).songs : null;
    await r2update(env, WS_DB, () => ({ items: [] }), (d) => {
      const x = (d.items || []).find((y) => y.id === it.id);
      if (!x) return false;
      x.title = title; x.description = description; x.fileName = fileName; x.size = size; x.updatedAt = Date.now(); x.version = version;
      x.creator = creator; x.creatorId = newCreatorId;
      if (newHash) {
        x.hashes = upParts.map((y) => y.hash); x.fileNames = upParts.map((y) => y.fileName);
        x.meta = it.type === "charts" ? { songs: upParts.map((y) => y.meta).filter(Boolean), locked: false } : (newMeta || { locked: false });
        x.songIds = it.type === "charts" ? upParts.map((y) => y.meta && y.meta.songId).filter(Boolean) : [];
        applyRemovedTags(x);
      }
      x.b2Files = newFiles || oldFiles;
      if (!x.verified && verifiedNow && wsOfVerifiedSong(x, verifiedNow)) { x.verified = true; verIdx = null; danIdx = null; }
      if (form.get("tags") != null && it.type === "charts") x.tags = wsTags(form.get("tags"));
      if (pType) x.preview = true;
      out = x;
    });
    if (newFiles && it.b2Files) await wsDeleteFiles(env, it);
    if (newFiles) await wsStagesUsed(env, who.playerId, upParts);
    // the Discord card: edited in place (same link), or an older post replaced by a card
    let patched = false;
    const after = out || it;
    try {
      if (after.post === 2 && after.channelId && after.messageId) {
        await discordApi(env, "PATCH", `/channels/${after.channelId}/messages/${after.messageId}`, wsPostBody(after, await wsCreatorDiscord(env, after.creatorId)));
        patched = true;
      } else {
        const where = await wsRepost(env, after);
        await r2update(env, WS_DB, () => ({ items: [] }), (d) => { const x = (d.items || []).find((y) => y.id === it.id); if (!x) return false; Object.assign(x, where, { post: 2 }); out = x; });
        patched = true;
      }
    } catch (e) { console.log("workshop post", e && e.message); }
    rate.u += 1;
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
    if (gone.messageId) ctx.waitUntil(discordApi(env, "DELETE", `/channels/${gone.channelId}/messages/${gone.messageId}`).catch(() => {}));
    ctx.waitUntil(env.RELEASES.delete(`workshop/previews/${gone.id}`).catch(() => {}));
    ctx.waitUntil(wsDeleteFiles(env, gone));
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
  // they're on OCTIVE right now (the game or the website): they see it there, no DM needed
  try {
    const pub = await publicItems(config(env), to, ["seen"]);
    const seen = pub.seen ? Date.parse(pub.seen) : 0;
    if (seen > 0 && Date.now() - seen < ONLINE_MS) return;
    const web = await env.RELEASES.head(`webseen/${to}`);
    if (web && Date.now() - web.uploaded.getTime() < WEB_MS) return;
  } catch { /* unknown: alert as usual */ }
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

/**
 * Daily at 21:00 UTC (wrangler.toml cron): a Discord DM to every linked player whose daily streak ends at midnight
 * because they haven't played today (unless a streak freeze covers it, said so). Once a day each; "streak" option off = none.
 */
async function streakReminders(env) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const today = todayUtc();
  const ids = [];
  let cursor;
  do {
    const list = await env.RELEASES.list({ prefix: "points/", cursor });
    for (const o of list.objects) ids.push(o.key.slice("points/".length).replace(/\.json$/, ""));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  let sent = 0;
  for (const id of ids) {
    try {
      const w = await walletOf(env, id);
      if (!(w.streak >= 1) || !w.lastDay || w.lastDay === today) continue;
      const gap = dayDiff(w.lastDay, today);
      if (gap < 1 || gap - 1 > (w.freezes || 0)) continue; // already broken: nothing to save
      const rec = await record(env, id);
      if (!rec.discord?.id || rec.discordPrefs?.streak === false) continue;
      const key = `discord-streak/${id}.txt`;
      const last = await env.RELEASES.get(key).then((o) => (o ? o.text() : null)).catch(() => null);
      if (last === today) continue;
      await env.RELEASES.put(key, today);
      const covered = (w.freezes || 0) >= gap;
      const ch = await discordApi(env, "POST", "/users/@me/channels", { recipient_id: rec.discord.id });
      await discordApi(env, "POST", `/channels/${ch.id}/messages`, {
        embeds: [{
          color: 0xffb84f,
          title: covered ? `🔥 Your ${w.streak}-day streak` : `🔥 Your ${w.streak}-day streak ends in 3 hours`,
          description: covered
            ? "Today's daily charts end at midnight UTC. A streak freeze will cover you if you miss them, but playing keeps the freeze."
            : "Play one of today's daily charts in OCTIVE before midnight UTC to keep it going.",
          footer: { text: "Turn these off in OCTIVE: Settings → Profile → Discord" },
        }],
        allowed_mentions: { parse: [] },
      });
      sent++;
    } catch (e) { console.log("streak reminder", e && e.message); }
  }
  console.log("streak reminders sent:", sent);
}

async function dmRoutes(request, env, url, ctx) {
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
      box.unfriend = (box.unfriend || []).filter((x) => !done.has(x) && x !== OFFICIAL_ID);
      const pending = new Set(box.unfriend);
      box.friends = friends.filter((f) => !pending.has(f.id)); box.blocked = blocked; box.synced = Date.now();
      if (b.name) box.name = dmName(b.name);
    });
    // OCTIVE is everyone's friend: an older game that removed it gets the friendship back
    if (!isOfficial(me) && !friends.some((f) => f.id === OFFICIAL_ID) && (await env.RELEASES.head(`official-friends/${me}`).catch(() => null)))
      await refriendOfficial(env, me).catch((e) => console.log("refriend", e && e.message));
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
    // Discord replies reach the public chat (and their pop-ups) even while nobody has it open
    if (ctx) ctx.waitUntil(Promise.resolve(chatPull(env)).catch(() => {}));
    const box = await r2json(env, dmInboxKey(me), dmEmptyInbox());
    const threads = Object.entries(box.threads || {}).map(([id, t]) => ({ with: id, ...t })).sort((a, b) => (b.last || 0) - (a.last || 0));
    const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);
    // answers and @names in the public chat since the last look (each shown once; a day at most)
    let chat = [];
    try {
      await r2update(env, `chat/pings/${me}.json`, () => ({ items: [] }), (p) => {
        chat = (p.items || []).filter((x) => Date.now() - (x.at || 0) < 24 * 3600_000);
        if (!(p.items || []).length) return false;
        p.items = [];
      });
    } catch { chat = []; }
    return reply({ me, name: box.name || who.username || "", friends: box.friends || [], synced: !!box.synced, threads, unread, unfriend: box.unfriend || [], chat, now: Date.now() });
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
    if (isOfficial(other) || isOfficial(me)) fail(400, "The official OCTIVE account is everyone's friend: it can't be removed.");
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
  } catch (e) { return reply({ error: e.expose ? e.message : "Sign in first.", code: e.code || undefined }, e.status || 401); }
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
  } catch (e) { return reply({ error: e.expose ? e.message : "Sign in first.", code: e.code || undefined }, e.status || 401); }
  const res = await release(env, key, request);
  const h = new Headers(res.headers);
  h.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  // every 6 hours: who still boosts the Discord server (wrangler.toml [triggers] crons)
  async scheduled(event, env, ctx) {
    // 21:00 UTC: streak reminders (3 hours before the daily charts change)
    if (event.cron === "0 21 * * *") { ctx.waitUntil(streakReminders(env).catch((e) => console.log("streak reminders", e && e.message))); return; }
    // :15 every hour: the 2.0 ranking move, a few ranking entries at a time (does nothing once it's through), and more
    // chart shapes (Ranked's ban screen shows them; verified uploads go first; nothing to do once they're all in)
    if (event.cron === "15 * * * *") {
      ctx.waitUntil(Promise.all([recomputeRanking(env, 6).catch((e) => console.log("ranking recompute", e && e.message)),
        fillChartShapes(env, 20).catch((e) => console.log("chart shapes", e && e.message)),
        fillModchartFlags(env, 15).catch((e) => console.log("modchart flags", e && e.message)),
        rkDiscordTick(env).catch((e) => console.log("ranked discord", e && e.message)),
        // a tournament moves on even when nobody looks (sign-ups closing, missed matches, the end)
        r2json(env, TOUR_KEY, null).then(async (t) => { if (t && await tourTick(env, t)) await r2put(env, TOUR_KEY, t); }).catch((e) => console.log("tournament", e && e.message)),
        // crew wars: last week's is settled (prizes, trophies)
        warTick(env).catch((e) => console.log("crew war", e && e.message)),
        // (2.0.1) achievements that can't be real come off cards not checked since
        achSweep(env, 80).catch((e) => console.log("achievement sweep", e && e.message)),
        // (2.0.2) big files sent in parts that no upload used
        wsStageSweep(env).catch((e) => console.log("stage sweep", e && e.message))]));
      return;
    }
    ctx.waitUntil(Promise.all([refreshBoosters(env).catch((e) => console.log("boosters", e && e.message)), cleanDmFiles(env).catch((e) => console.log("dm files", e && e.message)),
      r2json(env, WS_DB, { items: [] }).then((db) => wsBackfillSome(env, (db.items || []).filter((it) => !it.removed && !it.meta && it.type !== "themes").slice(0, 25))).catch((e) => console.log("workshop details", e && e.message)),
      // older uploads' chart shapes (length, long notes, patterns), a batch each time
      fillChartShapes(env, 20).catch((e) => console.log("chart shapes", e && e.message))]));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/discord" && request.method === "POST") {
      try { return await discordInteraction(request, env, ctx); }
      catch (e) { return new Response("error: " + e.message, { status: 500 }); }
    }
    // playing inside Discord (2.0): the Activity's page (Discord opens the root with ?frame_id=…) and its sign-in
    if (request.method === "GET" && (url.pathname === "/activity" || url.pathname === "/activity/" || (url.pathname === "/" && url.searchParams.has("frame_id"))))
      return new Response(ACTIVITY_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    if (url.pathname === "/activity/token" && request.method === "POST") {
      try { return await activityToken(request, env); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (/^\/(support\/|stripe\/webhook$|looks\/|social\/|follow$|twitch\/callback$)/.test(url.pathname)) {
      try { const r = await supportRoutes(request, env, url, ctx); if (r) return r; }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/play/")) {
      try { return await playRoutes(request, env, url); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await workshopRoutes(request, env, url, ctx); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/chat/")) {
      try { return await chatRoutes(request, env, url, ctx); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/dm/")) {
      try { return await dmRoutes(request, env, url, ctx); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/scores/")) {
      try { return await chartScores(request, env, url); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
    }
    if (url.pathname.startsWith("/account/")) {
      try { return await account(request, env, url.pathname.slice(9)); }
      catch (e) { return reply({ error: e.expose ? e.message : "Something went wrong on the server: " + e.message, code: e.code || undefined, itemId: e.itemId || undefined }, e.status >= 400 && e.status < 600 ? e.status : 500); }
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
      if (url.pathname === "/verified") { const v = await verifiedSongs(env); return json({ songs: v.songs }, 60); }
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
