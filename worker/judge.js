// OCTIVE's judge, for the server: a play is judged again from its replay, exactly as the game judges it, so the
// numbers a game sends (judgement counts, score, accuracy, combo) are never taken on trust.
//
// Ported line by line from the game's C# (Assets/OCTIVE/Scripts/Engine):
//   Judgement/Judge.cs           the judge (windows, presses, releases, misses, holds)
//   Notes/CompiledChart.cs       notes -> judged targets (with Notes/Behaviors.cs: bounce and repeat add hits)
//   Timing/TimingMap.cs          beats <-> microseconds (behaviour times given in beats)
//   Lanes/LaneTimeline.cs        InputMapTimeline (which lane a key plays)
//   Charts/Chart.cs, ChartJson   the chart file, read the way Newtonsoft reads it
//   Replays/Replay.cs            input packing and Simulate
//   Scoring/Scoring.cs, Mods.cs  score, accuracy, combo, grade; the hit windows of a play's mods
// A change to any of those must be made here too. Tools/judge_parity.mjs runs both on the same plays and charts.
// Nothing here needs Node or a Worker: plain JavaScript (DecompressionStream for gzip, in both).

export const JUDGE_VERSION = 1; // bump when judging or the compiled form changes: cached judge charts are rebuilt

export const MARVELOUS = 0, PERFECT = 1, GREAT = 2, GOOD = 3, BAD = 4, MISS = 5;
export const TAP = 0, HOLD_HEAD = 1, HOLD_TAIL = 2, HOLD_END = 3;
export const JUDGEMENT_NAMES = ["marvelous", "perfect", "great", "good", "bad", "miss"];

/** Something in a chart or replay that can't be judged (the message is for players). */
export class JudgeDataError extends Error {
  constructor(message) { super(message); this.name = "JudgeDataError"; }
}
const bad = (message) => { throw new JudgeDataError(message); };

// ---------------------------------------------------------------- C# number behaviour

const LONG_MIN = -9223372036854775808; // -2^63 (exact as a double)
const TIME_LIMIT = 2 ** 50;            // any time beyond this (35 years) can't be judged exactly here: refused
const own = (o, k) => (o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Math.Round(double): to the nearest whole number, a half to the even one (banker's rounding). */
export function roundEven(x) {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
/** (long) of a double, as on x64: toward zero; NaN and out of range give long.MinValue. */
export function toLong(x) { return x >= -9223372036854775808 && x < 9223372036854775808 ? Math.trunc(x) : LONG_MIN; }
/** (int) of a long (unchecked: the low 32 bits). */
const toInt32 = (x) => x | 0;
const checkTime = (t, what) => { if (!(Math.abs(t) <= TIME_LIMIT)) bad(`${what} is out of range.`); return t; };

// ---------------------------------------------------------------- hit windows, mods, scoring rules

/** JudgementWindows.Default: milliseconds either side of a note. */
export const defaultWindows = () => ({ marvelous: 30, perfect: 55, great: 85, good: 120, bad: 150, miss: 170, releaseScale: 1.5, nearest: true, earlyMiss: false });

/** JudgementWindows.Sanitized: every window positive and not smaller than the one before. */
export function sanitizeWindows(w) {
  const o = { ...defaultWindows(), ...(w || {}) };
  const fix = (v, min, def) => (typeof v !== "number" || !Number.isFinite(v) || v <= 0 ? Math.max(def, min) : Math.max(v, min));
  o.marvelous = fix(o.marvelous, 1, 16);
  o.perfect = fix(o.perfect, o.marvelous, 40);
  o.great = fix(o.great, o.perfect, 73);
  o.good = fix(o.good, o.great, 103);
  o.bad = fix(o.bad, o.good, 127);
  o.miss = fix(o.miss, o.bad, 164);
  o.releaseScale = typeof o.releaseScale !== "number" || Number.isNaN(o.releaseScale) || o.releaseScale < 1 ? 1 : Math.min(4, o.releaseScale);
  o.nearest = o.nearest !== false;
  o.earlyMiss = o.earlyMiss === true;
  return o;
}

export const MOD = { EZ: 1, HT: 2, DT: 4, HR: 8, HD: 16, FI: 32, MR: 64, FL: 128, OT: 256 };
// Mods.All, in its order (it decides which of two conflicting mods stays): code, mod, the mods it rules out
const MOD_LIST = [["EZ", 1, 8], ["HT", 2, 4], ["HR", 8, 1], ["DT", 4, 2], ["HD", 16, 32], ["FI", 32, 16], ["FL", 128, 0], ["MR", 64, 0], ["OT", 256, 0]];
const modParts = (codes) => String(codes || "").split(/[ ,+]+/).filter(Boolean);

/** Mods.Parse: "DT HD" -> flags (unknown codes and rate tokens are ignored; conflicts settled like the game). */
export function parseMods(codes) {
  let m = 0;
  for (const part of modParts(codes)) {
    const i = MOD_LIST.find((x) => x[0] === part.toUpperCase());
    if (i) m |= i[1];
  }
  for (const [, mod, conflicts] of MOD_LIST) if (m & mod) m &= ~conflicts;
  return m;
}
const NUM_RE = /^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?$/;
/** Mods.RateOf: the song speed of a mod list ("1.25x", else DT 1.5 / HT 0.75, else 1). */
export function rateOf(codes) {
  for (const part of modParts(codes)) {
    const last = part[part.length - 1];
    if (part.length < 2 || (last !== "x" && last !== "X" && last !== "×")) continue;
    const s = part.slice(0, -1);
    const r = NUM_RE.test(s) ? Number(s) : NaN;
    if (r > 0) return roundEven(Math.max(0.2, Math.min(4, r)) * 20) / 20;
  }
  const m = parseMods(codes);
  return m & MOD.DT ? 1.5 : m & MOD.HT ? 0.75 : 1;
}
/**
 * The windows a play is judged with on the server: OCTIVE's, wider with Easy and tighter with Hard Rock
 * (Mods.WindowsFor without osu! Timing: the game records an osu!-timing play's OCTIVE result the same way).
 */
export function windowsFor(mods) {
  const f = mods & MOD.EZ ? 1.4 : mods & MOD.HR ? 1 / 1.4 : 1.0;
  const w = defaultWindows();
  if (f !== 1) for (const k of ["marvelous", "perfect", "great", "good", "bad", "miss"]) w[k] *= f;
  return w;
}

// OCTIVE Standard (the only scoring rule): accuracy and score weight per judgement, misses and bads break combo
const ACC_W = [100, 98, 70, 40, 10, 0];
// 2.1.1: no score cap, points per judgement (Marvelous 350, Perfect 300, Great 250, Good 200, Bad 100, Miss 0)
export const SCORE_POINTS = [350, 300, 250, 200, 100, 0];
/** (2.2.0) ScorePoints.WithRate: a score at a song speed is the points times the rate (1.2x = 1.2 times, 0.8x = 0.8 times). */
export function scoreWithRate(points, rate) {
  if (!(rate > 0) || Math.abs(rate - 1) < 1e-9) return points;
  return toLong(roundEven(points * rate));
}
const SCORE_W = SCORE_POINTS;
// the old score out of 1,000,000 (games before 2.1.1 still send it)
const OLD_SCORE_W = [1.0, 0.98, 0.70, 0.40, 0.10, 0];
export const MAX_SCORE = 1_000_000;

/** Grades.Of: by accuracy rounded to two decimals. */
export function gradeOf(accuracy) {
  const acc = roundEven(accuracy * 100) / 100;
  return acc >= 100 ? "SS" : acc >= 95 ? "S" : acc >= 90 ? "A" : acc >= 80 ? "B" : acc >= 70 ? "C" : acc >= 60 ? "D" : "F";
}

// ---------------------------------------------------------------- reading a chart file (as Newtonsoft does)

// Newtonsoft matches a JSON property to a field by its exact name, else ignoring case; a later one wins, and a
// null leaves the field as it was (NullValueHandling.Ignore). Readers treat a null field as missing (== null).
const fieldSpec = (names) => ({ names, set: new Set(names), lower: new Map(names.map((n) => [n.toLowerCase(), n])) });
const F_ROOT = fieldSpec(["format", "minReaderVersion", "meta", "timing", "notes", "inputMaps", "presets"]);
const F_META = fieldSpec(["keyCount"]);
const F_TIMING = fieldSpec(["timeUs", "bpm", "meter"]);
const F_NOTE = fieldSpec(["id", "lane", "timeUs", "type", "endUs", "release", "windowScale", "style", "hitsound", "behaviors"]);
const F_INPUTMAP = fieldSpec(["id", "timeUs", "durationUs", "easing", "enabled", "map"]);
const F_PRESET = fieldSpec(["name", "behaviors"]);
const F_SPEC = fieldSpec(["type"]);
function fieldsOf(o, spec) {
  // the usual case (every chart the game writes): only exact names, so the object is its own field list
  let exact = true;
  for (const key in o) if (!spec.set.has(key)) { exact = false; break; }
  if (exact) return o;
  const out = Object.create(null);
  for (const key of Object.keys(o)) {
    const name = spec.set.has(key) ? key : spec.lower.get(key.toLowerCase());
    if (name && o[key] !== null) out[name] = o[key];
  }
  return out;
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function cvInteger(v, what, lo, hi) {
  let n;
  if (typeof v === "number") n = Number.isInteger(v) ? v : roundEven(v);
  else if (typeof v === "string" && /^[ ]*[+-]?[0-9]+[ ]*$/.test(v)) n = Number(v.trim());
  else bad(`The chart's ${what} isn't a whole number.`);
  if (!(n >= lo && n <= hi)) bad(`The chart's ${what} is out of range.`);
  return n;
}
const cvLong = (v, what) => cvInteger(v, what, -TIME_LIMIT, TIME_LIMIT);
const cvInt = (v, what) => cvInteger(v, what, -2147483648, 2147483647);
function cvDouble(v, what) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && NUM_RE.test(v.trim())) return Number(v.trim());
  return bad(`The chart's ${what} isn't a number.`);
}
function cvBool(v, what) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" && /^[ ]*(true|false)[ ]*$/i.test(v)) return v.trim().toLowerCase() === "true";
  return bad(`The chart's ${what} isn't true or false.`);
}
function cvString(v, what) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return bad(`The chart's ${what} isn't text.`);
}
/** An enum read by StringEnumConverter: its name (any case) or its number. */
const NOTE_TYPES = ["tap", "hold"], RELEASES = ["timed", "untimed"];
function cvEnum(v, names, what) {
  const exact = names.indexOf(v); // the name as the game writes it (the usual case)
  if (exact >= 0) return exact;
  if (typeof v === "number") { if (!Number.isInteger(v)) bad(`The chart's ${what} isn't valid.`); return v; }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?[0-9]+$/.test(s)) return Number(s);
    const i = names.indexOf(s.toLowerCase());
    if (i >= 0) return i;
  }
  return bad(`The chart's ${what} isn't valid.`);
}
function cvList(v, what) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad(`The chart's ${what} isn't a list.`);
  return v;
}

function readSpecs(list, what) {
  return cvList(list, what).map((s) => {
    if (s === null) return null;
    if (!isObj(s)) bad(`The chart has a broken ${what} entry.`);
    const f = fieldsOf(s, F_SPEC);
    return { type: f.type == null ? null : cvString(f.type, "behaviour type"), p: s };
  });
}

/**
 * Reads a chart file (its JSON text, or the parsed object) into what judging needs: key count, timing points,
 * notes (lane, times, kind, release, window scale, behaviours), input maps and behaviour presets. Throws
 * JudgeDataError for a chart the game can't load either.
 */
export function loadChart(json) {
  let root = json;
  if (typeof json === "string") {
    const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
    if (!text.trim()) bad("The chart file is empty.");
    try { root = JSON.parse(text); } catch { bad("The chart file is not valid JSON."); }
  }
  if (!isObj(root)) bad("The chart file contains no chart.");
  const top = fieldsOf(root, F_ROOT);
  if (top.format != null && cvString(top.format, "format") !== "octive.chart") bad("This is not an OCTIVE chart.");
  if (top.minReaderVersion != null && cvInt(top.minReaderVersion, "reader version") > 1) bad("This chart needs a newer version of OCTIVE.");

  let keyCount = 4;
  if (top.meta != null) {
    if (!isObj(top.meta)) bad("The chart's details are broken.");
    const m = fieldsOf(top.meta, F_META);
    if (m.keyCount != null) keyCount = cvInt(m.keyCount, "key count");
  }

  const timing = cvList(top.timing ?? undefined, "timing").map((p) => {
    if (p === null) return null;
    if (!isObj(p)) bad("The chart has a broken timing point.");
    const f = fieldsOf(p, F_TIMING);
    return { timeUs: f.timeUs == null ? 0 : cvLong(f.timeUs, "timing time"), bpm: f.bpm == null ? 120 : cvDouble(f.bpm, "bpm"), meter: f.meter == null ? 4 : cvInt(f.meter, "meter") };
  });

  const notes = cvList(top.notes ?? undefined, "notes").map((n) => {
    // Chart.EnsureLists touches every note: a null one stops the chart loading in the game
    if (!isObj(n)) bad("The chart has a broken note.");
    const f = fieldsOf(n, F_NOTE);
    if (f.id != null && typeof f.id !== "string") cvString(f.id, "note id");
    if (f.style != null && typeof f.style !== "string") cvString(f.style, "note style");
    if (f.hitsound != null && typeof f.hitsound !== "string") cvString(f.hitsound, "note hitsound");
    return {
      lane: f.lane == null ? 0 : cvInt(f.lane, "note lane"),
      timeUs: f.timeUs == null ? 0 : cvLong(f.timeUs, "note time"),
      type: f.type == null ? 0 : cvEnum(f.type, NOTE_TYPES, "note type"),
      endUs: f.endUs == null ? 0 : cvLong(f.endUs, "hold end"),
      release: f.release == null ? 0 : cvEnum(f.release, RELEASES, "hold release"),
      windowScale: f.windowScale == null ? 1.0 : cvDouble(f.windowScale, "window scale"),
      behaviors: f.behaviors == null || (Array.isArray(f.behaviors) && !f.behaviors.length) ? [] : readSpecs(f.behaviors, "behaviour"),
    };
  });

  const inputMaps = cvList(top.inputMaps ?? undefined, "input maps").map((e) => {
    if (e === null) return null;
    if (!isObj(e)) bad("The chart has a broken input map.");
    const f = fieldsOf(e, F_INPUTMAP);
    if (f.durationUs != null) cvLong(f.durationUs, "input map duration");
    let map = null;
    if (f.map != null) { if (!Array.isArray(f.map)) bad("The chart's input map isn't a list."); map = f.map.map((x) => (x === null ? bad("The chart's input map has an empty entry.") : cvInt(x, "input map"))); }
    return { timeUs: f.timeUs == null ? 0 : cvLong(f.timeUs, "input map time"), enabled: f.enabled == null ? true : cvBool(f.enabled, "input map switch"), map };
  });

  const presets = cvList(top.presets ?? undefined, "presets").map((p) => {
    if (p === null) return null;
    if (!isObj(p)) bad("The chart has a broken behaviour preset.");
    const f = fieldsOf(p, F_PRESET);
    return { name: f.name == null ? "Preset" : cvString(f.name, "preset name"), behaviors: f.behaviors == null ? [] : readSpecs(f.behaviors, "preset behaviour") };
  });

  return { keyCount, timing, notes, inputMaps, presets };
}

// ---------------------------------------------------------------- timing map (beats <-> microseconds)

class TimingMap {
  constructor(points) {
    let list = points.filter((p) => p && Number.isFinite(p.bpm) && p.bpm >= 1 && p.bpm <= 10000);
    list = list.map((p, i) => [p, i]).sort((a, b) => cmp(a[0].timeUs, b[0].timeUs) || a[1] - b[1]).map((x) => x[0]);
    // a later point at the same time replaces the earlier one
    for (let i = list.length - 2; i >= 0; i--) if (list[i].timeUs === list[i + 1].timeUs) list.splice(i, 1);
    if (!list.length) list = [{ timeUs: 0, bpm: 120, meter: 4 }];
    this.seg = [];
    let beat = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (i > 0) {
        const prev = this.seg[i - 1];
        beat = prev.startBeat + (p.timeUs - prev.timeUs) / prev.usPerBeat;
      }
      this.seg.push({ timeUs: p.timeUs, startBeat: beat, usPerBeat: 60_000_000.0 / p.bpm });
    }
  }
  segmentAt(t) {
    const s = this.seg;
    if (t < s[0].timeUs) return s[0];
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].timeUs <= t) lo = mid; else hi = mid - 1; }
    return s[lo];
  }
  segmentAtBeat(beat) {
    const s = this.seg;
    if (beat < s[0].startBeat) return s[0];
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].startBeat <= beat + 1e-9) lo = mid; else hi = mid - 1; }
    return s[lo];
  }
  beatAt(t) { const s = this.segmentAt(t); return s.startBeat + (t - s.timeUs) / s.usPerBeat; }
  timeAtBeat(beat) { const s = this.segmentAtBeat(beat); return s.timeUs + toLong(roundEven((beat - s.startBeat) * s.usPerBeat)); }
}

// ---------------------------------------------------------------- behaviours that add judged hits (bounce, repeat)

const specLong = (p, k, fallback) => { const v = own(p, k); return typeof v === "number" ? toLong(roundEven(v)) : fallback; };
const specInt = (p, k, fallback) => toInt32(specLong(p, k, fallback));
const specDouble = (p, k, fallback) => { const v = own(p, k); return typeof v === "number" && Number.isFinite(v) ? v : fallback; };
const specString = (p, k, fallback) => { const v = own(p, k); return typeof v === "string" ? v : fallback; };

/** BehaviorBuildContext.Duration: "<key>Us" (microseconds) or "<key>Beats" (beats from that time). */
function specDuration(p, key, fallback, atUs, timing) {
  if (has(p, key + "Us")) return specLong(p, key + "Us", fallback);
  if (has(p, key + "Beats")) {
    const b = specDouble(p, key + "Beats", 0);
    return timing.timeAtBeat(timing.beatAt(atUs) + b) - atUs;
  }
  return fallback;
}

/** BounceBehavior: lands again "count" times (each landing a judged hit, in its own lane). Null: the game leaves it out. */
function bounceTargets(p, note, timing, keyCount) {
  const count = Math.max(1, Math.min(64, specInt(p, "count", 1)));
  const usTok = own(p, "intervalsUs");
  const arr = Array.isArray(usTok) ? usTok : Array.isArray(own(p, "intervalsBeats")) ? own(p, "intervalsBeats") : null;
  const beats = !has(p, "intervalsUs") && has(p, "intervalsBeats");
  const baseInterval = specDuration(p, "interval", 500_000, note.timeUs, timing);
  let t = note.timeUs;
  const landings = [];
  for (let i = 0; i < count; i++) {
    let iv = baseInterval;
    if (arr && i < arr.length && typeof arr[i] === "number") {
      const v = arr[i];
      iv = beats ? timing.timeAtBeat(timing.beatAt(t) + v) - t : toLong(roundEven(v));
    }
    if (iv < 30_000) iv = 30_000;
    t += iv;
    landings.push(checkTime(t, "A bounce landing"));
  }
  const lanesTok = own(p, "lanes");
  const lanes = Array.isArray(lanesTok) ? lanesTok : null;
  const out = [];
  for (let i = 1; i <= count; i++) {
    let lane = note.lane;
    // only whole numbers count (a JSON integer); one too big for an int makes the game's constructor throw
    if (lanes && i - 1 < lanes.length && typeof lanes[i - 1] === "number" && Number.isInteger(lanes[i - 1])) {
      const v = lanes[i - 1];
      if (v < -2147483648 || v > 2147483647) return null;
      lane = v < 0 || v >= keyCount ? Math.max(0, Math.min(keyCount - 1, v)) : v;
    }
    out.push([landings[i - 1], lane, TAP]);
  }
  return out;
}

/** RepeatBehavior: hit again "count" times in its lane at a fixed interval. */
function repeatTargets(p, note, timing) {
  const count = Math.max(1, Math.min(256, specInt(p, "count", 3)));
  let iv = specDuration(p, "interval", 250_000, note.timeUs, timing);
  if (iv < 30_000) iv = 30_000;
  const out = [];
  for (let i = 1; i <= count; i++) out.push([checkTime(note.timeUs + iv * i, "A repeat hit"), note.lane, TAP]);
  return out;
}

function expandPresets(input, chart, output, depth, budget) {
  for (const s of input) {
    if (s === null || !s.type) continue;
    if (s.type !== "preset") { output.push(s); if (output.length > budget) bad("The chart's behaviour presets are too large."); continue; }
    const name = specString(s.p, "name", "");
    let preset = null;
    for (const pr of chart.presets) {
      if (pr === null) bad("The chart has an empty behaviour preset."); // List.Find hits it: the game can't compile the chart
      if (pr.name === name) { preset = pr; break; }
    }
    if (!preset || depth > 4) continue;
    expandPresets(preset.behaviors, chart, output, depth + 1, budget);
  }
}

/**
 * The extra judged hits of a note (CompiledChart.BuildBehaviors): its first bounce or repeat that the game builds
 * (never on holds; a second one is ignored). Other behaviours only change how a note looks.
 */
function extraTargets(cn, src, chart, timing, keyCount) {
  if (!src.behaviors.length) return null;
  const specs = [];
  expandPresets(src.behaviors, chart, specs, 0, 100_000);
  for (const spec of specs) {
    if (spec.type !== "bounce" && spec.type !== "repeat") continue;
    if (cn.isHold) continue; // not allowed on hold notes
    const t = spec.type === "bounce" ? bounceTargets(spec.p, cn, timing, keyCount) : repeatTargets(spec.p, cn, timing);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------- compiling: notes -> judged targets

/**
 * CompiledChart.Compile, for judging: every judged moment (tap, hold head, hold end, bounce/repeat hit) sorted by
 * time, lane, note; plus the input maps. Returns { keyCount, notes, time, lane, kind, ws, note, imTimes, imMaps }.
 */
export function compileChart(chart) {
  let k = chart.keyCount;
  if (k < 1 || k > 20) k = Math.max(1, Math.min(20, k));
  const timing = new TimingMap(chart.timing);
  const order = chart.notes.map((n, i) => [n, i]).sort((a, b) => cmp(a[0].timeUs, b[0].timeUs) || cmp(a[0].lane, b[0].lane) || a[1] - b[1]).map((x) => x[0]);
  const targets = [];
  let noteCount = 0;
  for (const src of order) {
    if (src.lane < 0 || src.lane >= k) continue; // a lane the chart doesn't have: skipped
    let hold = src.type === 1;
    if (hold && src.endUs <= src.timeUs) hold = false; // ends before it starts: played as a tap
    const cn = { index: noteCount, lane: src.lane, timeUs: src.timeUs, isHold: hold };
    const defs = [[src.timeUs, src.lane, hold ? HOLD_HEAD : TAP]];
    if (hold) defs.push([src.endUs, src.lane, src.release === 0 ? HOLD_TAIL : HOLD_END]);
    const extra = extraTargets(cn, src, chart, timing, k);
    if (extra) defs.push(...extra);
    defs.sort((a, b) => cmp(a[0], b[0]));
    const w = src.windowScale;
    const ws = Number.isNaN(w) || w <= 0 ? 1 : Math.max(0.25, Math.min(4, w));
    for (let d = 0; d < defs.length; d++) targets.push({ note: cn.index, order: d, time: defs[d][0], lane: defs[d][1], kind: defs[d][2], ws });
    noteCount++;
  }
  targets.sort((a, b) => cmp(a.time, b.time) || a.lane - b.lane || a.note - b.note || a.order - b.order);
  // input maps: valid ones (a lane for every key), enabled, in time order
  const maps = chart.inputMaps
    .map((e, i) => [e, i])
    .filter(([e]) => e && e.enabled && Array.isArray(e.map) && e.map.length === k && e.map.every((v) => v >= 0 && v < k))
    .sort((a, b) => cmp(a[0].timeUs, b[0].timeUs) || a[1] - b[1])
    .map((x) => x[0]);
  const n = targets.length;
  const c = {
    v: JUDGE_VERSION, keyCount: k, notes: noteCount,
    time: new Float64Array(n), lane: new Int32Array(n), kind: new Uint8Array(n), ws: new Float64Array(n), note: new Int32Array(n),
    imTimes: maps.map((e) => e.timeUs), imMaps: maps.map((e) => e.map.slice()),
  };
  for (let i = 0; i < n; i++) { const t = targets[i]; c.time[i] = t.time; c.lane[i] = t.lane; c.kind[i] = t.kind; c.ws[i] = t.ws; c.note[i] = t.note; }
  return c;
}

// ---------------------------------------------------------------- a chart's shape (Workshop details, Ranked's ban screen)

/**
 * A compiled chart's shape: how long it runs (to its last note, seconds), how much of it is long notes (0-1), how dense
 * it is (notes a second while it plays) and tags for its main patterns. The tags are a rough read for filters and
 * Ranked's ban screen: "ln" / "hybrid" (long notes), "chordjack", "jacks", "handstream", "jumpstream", "stream" (any key
 * count, read like 4K), "speed" (very dense) and "stamina" (long and dense).
 */
export function chartStats(c) {
  const n = c.time.length;
  let last = 0, heads = 0;
  const presses = [];
  for (let i = 0; i < n; i++) {
    if (c.time[i] > last) last = c.time[i];
    const k = c.kind[i];
    if (k === TAP || k === HOLD_HEAD) { presses.push(i); if (k === HOLD_HEAD) heads++; }
  }
  const len = Math.round(last / 1e5) / 10;
  const notes = presses.length;
  if (!notes) return { len, ln: 0, nps: 0, tags: [] };
  presses.sort((a, b) => c.time[a] - c.time[b] || c.lane[a] - c.lane[b]);
  const span = Math.max(1, (c.time[presses[notes - 1]] - c.time[presses[0]]) / 1e6);
  // rows: presses within 3 ms of each other are one row (a chord)
  const rows = [];
  for (const i of presses) {
    const t = c.time[i], r = rows[rows.length - 1];
    if (r && t - r.t <= 3000) r.lanes.push(c.lane[i]); else rows.push({ t, lanes: [c.lane[i]] });
  }
  // only rows in runs of notes count (closer than 180 ms to the row before)
  let dense = 0, streamRows = 0, jumps = 0, hands = 0, chords = 0, jackRows = 0, chordJacks = 0, fastJacks = 0, varied = 0;
  let prevGap = 0;
  for (let r = 1; r < rows.length; r++) {
    const a = rows[r - 1], b = rows[r], gap = b.t - a.t;
    if (gap > 180_000) { prevGap = 0; continue; }
    dense++;
    // (2.0.2) the rhythm changing from one row to the next (technical charts mix snaps)
    if (prevGap > 0 && (gap / prevGap < 0.8 || gap / prevGap > 1.25)) varied++;
    prevGap = gap;
    const size = b.lanes.length;
    if (size >= 2) chords++;
    if (size === 2) jumps++; else if (size >= 3) hands++;
    const again = b.lanes.some((l) => a.lanes.includes(l)); // a lane hit again straight away: a jack
    if (again) { jackRows++; if (size >= 2 && a.lanes.length >= 2) chordJacks++; if (gap <= 105_000) fastJacks++; }
    else if (size === 1 && a.lanes.length === 1 && gap <= 150_000) streamRows++;
  }
  const sh = (x) => (dense ? x / dense : 0);
  const ln = heads / notes, nps = notes / span;
  const tags = [];
  if (ln >= 0.4) tags.push("ln"); else if (ln >= 0.15) tags.push("hybrid");
  const patterns = [
    ["chordjack", sh(chordJacks) >= 0.25 && sh(chords) >= 0.4 ? sh(chordJacks) + sh(chords) : 0],
    ["jacks", sh(jackRows) >= 0.3 ? sh(jackRows) : 0],
    ["handstream", sh(hands) >= 0.12 && sh(jackRows) < 0.3 ? sh(hands) * 2 : 0],
    ["jumpstream", sh(jumps) >= 0.2 && sh(hands) < 0.12 && sh(jackRows) < 0.3 ? sh(jumps) * 1.5 : 0],
    ["stream", sh(streamRows) >= 0.45 && sh(chords) < 0.2 ? sh(streamRows) : 0],
  ].filter((p) => p[1] > 0).sort((p, q) => q[1] - p[1]);
  for (const [name] of patterns) {
    if (tags.length >= 3) break;
    if (name === "jacks" && tags.includes("chordjack")) continue;
    tags.push(name);
  }
  // (2.0.2) fast jacks (a lane hit again within 105 ms: 1/4s at 143 BPM and up), and rhythms that keep changing
  if (sh(fastJacks) >= 0.15) tags.push("speedjack");
  if (dense >= 50 && sh(varied) >= 0.35) tags.push("technical");
  if (nps >= 16) tags.push("speed");
  if (span >= 180 && nps >= 8) tags.push("stamina");
  return { len, ln: Math.round(ln * 100) / 100, nps: Math.round(nps * 10) / 10, tags: tags.slice(0, 6) };
}

/** A compiled chart as compact JSON (kept by the server so a chart is read and compiled once). */
export function packCompiled(c) {
  const dt = new Array(c.time.length);
  let prev = 0;
  for (let i = 0; i < c.time.length; i++) { dt[i] = c.time[i] - prev; prev = c.time[i]; }
  const anyWs = c.ws.some((x) => x !== 1);
  return {
    v: c.v, keys: c.keyCount, notes: c.notes, dt, lane: Array.from(c.lane), kind: Array.from(c.kind), note: Array.from(c.note),
    ws: anyWs ? Array.from(c.ws) : undefined, im: c.imTimes.map((t, i) => [t, c.imMaps[i]]),
  };
}
export function unpackCompiled(o) {
  if (!o || o.v !== JUDGE_VERSION || !Array.isArray(o.dt)) return null;
  const n = o.dt.length;
  const c = {
    v: o.v, keyCount: o.keys, notes: o.notes,
    time: new Float64Array(n), lane: Int32Array.from(o.lane), kind: Uint8Array.from(o.kind), ws: o.ws ? Float64Array.from(o.ws) : new Float64Array(n).fill(1),
    note: Int32Array.from(o.note), imTimes: o.im.map((x) => x[0]), imMaps: o.im.map((x) => x[1]),
  };
  let t = 0;
  for (let i = 0; i < n; i++) { t += o.dt[i]; c.time[i] = t; }
  return c;
}

// ---------------------------------------------------------------- the judge

/** Judge.cs: timestamped key input -> judgements. Feed inputs in time order; Finish() at the end. */
export class Judge {
  constructor(c, windows) {
    this.c = c;
    this.w = sanitizeWindows(windows || defaultWindows());
    const n = c.time.length, K = c.keyCount;
    this.K = K;
    this.judged = new Uint8Array(n);
    this.tailOf = new Int32Array(n).fill(-1);
    this.expiry = new Float64Array(n);
    this.results = [];
    this.lastProcessed = -Infinity; // long.MinValue
    this.judgedCount = 0;
    const lanes = Array.from({ length: K }, () => []);
    const headOf = new Map(), tailOfNote = new Map();
    for (let i = 0; i < n; i++) {
      const kind = c.kind[i];
      if (kind === TAP || kind === HOLD_HEAD) lanes[c.lane[i]].push(i);
      this.expiry[i] = this.expiryOf(i);
      if (kind === HOLD_HEAD) headOf.set(c.note[i], i);
      else if (kind === HOLD_TAIL || kind === HOLD_END) tailOfNote.set(c.note[i], i);
    }
    for (const [note, head] of headOf) if (tailOfNote.has(note)) this.tailOf[head] = tailOfNote.get(note);
    this.laneQueue = lanes.map((l) => Int32Array.from(l));
    this.laneNext = new Int32Array(K);
    this.activeHoldTail = new Int32Array(K).fill(-1);
    this.keyDown = new Uint8Array(K);
    const e = this.expiry;
    this.byExpiry = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => (e[a] !== e[b] ? cmp(e[a], e[b]) : a - b));
    this.expiryNext = 0;
  }

  windowMs(j) { const w = this.w; return j === 0 ? w.marvelous : j === 1 ? w.perfect : j === 2 ? w.great : j === 3 ? w.good : j === 4 ? w.bad : w.miss; }
  windowUs(j, scale) { return toLong(roundEven(this.windowMs(j) * 1000.0 * scale)); }

  expiryOf(i) {
    const c = this.c, t = c.time[i];
    switch (c.kind[i]) {
      case HOLD_END: return t;
      case HOLD_TAIL: return t + this.windowUs(BAD, c.ws[i] * this.w.releaseScale);
      default: return t + this.windowUs(BAD, c.ws[i]);
    }
  }

  laneForKey(key, t) {
    if (key < 0 || key >= this.K) return -1;
    const times = this.c.imTimes;
    let lo = 0, hi = times.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found < 0 ? key : this.c.imMaps[found][key];
  }

  clampInputTime(t) { return this.lastProcessed === -Infinity ? t : Math.max(t, this.lastProcessed); }

  process(t, key, down) { if (down) this.press(t, key); else this.release(t, key); }

  press(t, key) {
    if (key < 0 || key >= this.K) return;
    t = this.clampInputTime(t);
    this.update(t);
    if (this.keyDown[key]) return; // key repeat / duplicate
    this.keyDown[key] = 1;
    const lane = this.laneForKey(key, t);
    if (lane < 0) return;
    const c = this.c, queue = this.laneQueue[lane], judged = this.judged;
    let i = this.laneNext[lane];
    while (i < queue.length && judged[queue[i]]) i++;
    this.laneNext[lane] = i;
    // the press target it hits: the nearest in time among the open ones (or, old rule, the oldest open one)
    let pick = -1, pickAbs = Infinity;
    for (; i < queue.length; i++) {
      const ti = queue[i];
      if (judged[ti]) continue;
      const dev0 = t - c.time[ti];
      // this one and the rest: too early (a ghost tap); before 2.0 the Miss window counted, now the Bad window
      if (dev0 < -this.windowUs(this.w.earlyMiss ? MISS : BAD, c.ws[ti])) break;
      if (!this.w.nearest) { pick = ti; break; }
      const a = Math.abs(dev0);
      if (a < pickAbs) { pick = ti; pickAbs = a; } else break;
    }
    if (pick < 0) return;
    const dev = t - c.time[pick];
    const j = this.classify(Math.abs(dev), c.ws[pick]);
    this.emit(pick, j, dev, t, false);
    if (c.kind[pick] === HOLD_HEAD) {
      const tail = this.tailOf[pick];
      if (tail >= 0 && !judged[tail]) {
        if (j === MISS) this.emit(tail, MISS, 0, t, true);
        else this.activeHoldTail[key] = tail;
      }
    }
  }

  release(t, key) {
    if (key < 0 || key >= this.K) return;
    t = this.clampInputTime(t);
    this.update(t);
    if (!this.keyDown[key]) return;
    this.keyDown[key] = 0;
    const tail = this.activeHoldTail[key];
    this.activeHoldTail[key] = -1;
    if (tail < 0 || this.judged[tail]) return;
    const c = this.c;
    const dev = t - c.time[tail];
    if (c.kind[tail] === HOLD_END) {
      // untimed: letting go before the end (minus the good window) breaks the hold
      const tol = this.windowUs(GOOD, c.ws[tail]);
      this.emit(tail, dev >= -tol ? MARVELOUS : MISS, dev, t, false);
      return;
    }
    const scale = c.ws[tail] * this.w.releaseScale;
    if (dev < -this.windowUs(MISS, scale)) { this.emit(tail, MISS, dev, t, false); return; }
    this.emit(tail, this.classify(Math.abs(dev), scale), dev, t, false);
  }

  classify(absDev, scale) {
    if (absDev <= this.windowUs(MARVELOUS, scale)) return MARVELOUS;
    if (absDev <= this.windowUs(PERFECT, scale)) return PERFECT;
    if (absDev <= this.windowUs(GREAT, scale)) return GREAT;
    if (absDev <= this.windowUs(GOOD, scale)) return GOOD;
    if (absDev <= this.windowUs(BAD, scale)) return BAD;
    return MISS;
  }

  /** Resolves everything whose window closed before t, in (expiry, index) order however the calls are split. */
  update(t) {
    if (t < this.lastProcessed) return;
    this.lastProcessed = t;
    const c = this.c, order = this.byExpiry, expiry = this.expiry;
    while (this.expiryNext < order.length) {
      const ti = order[this.expiryNext];
      const e = expiry[ti];
      if (e >= t) break;
      this.expiryNext++;
      if (this.judged[ti]) continue;
      switch (c.kind[ti]) {
        case TAP:
          this.emit(ti, MISS, 0, e, true);
          break;
        case HOLD_HEAD: {
          this.emit(ti, MISS, 0, e, true);
          const tail = this.tailOf[ti];
          if (tail >= 0 && !this.judged[tail]) this.emit(tail, MISS, 0, e, true);
          break;
        }
        default: { // hold tail / hold end
          const key = this.keyHolding(ti);
          if (key >= 0) {
            this.activeHoldTail[key] = -1;
            this.emit(ti, c.kind[ti] === HOLD_END ? MARVELOUS : BAD, e - c.time[ti], e, true);
          } else this.emit(ti, MISS, 0, e, true);
        }
      }
    }
  }

  keyHolding(tail) { for (let k = 0; k < this.K; k++) if (this.activeHoldTail[k] === tail) return k; return -1; }

  emit(target, j, dev, time, automatic) {
    if (this.judged[target]) return;
    this.judged[target] = 1;
    this.judgedCount++;
    this.results.push({ target, j, dev: j === MISS && automatic ? 0 : dev, time, automatic });
  }

  /** Resolves every remaining target (end of song). */
  finish() { this.update(Infinity); }
}

// ---------------------------------------------------------------- scoring

/** ScoreState: the running score of a play, fed with judge results in order. */
export class ScoreState {
  constructor(totalTargets) {
    this.total = Math.max(0, totalTargets);
    this.counts = [0, 0, 0, 0, 0, 0];
    this.combo = 0; this.maxCombo = 0; this.judged = 0; this.early = 0; this.late = 0;
    this.accSum = 0; this.scoreSum = 0;
    this.devSum = 0; this.devCount = 0;
    this.devs = []; // hit deviations in ms (player inputs only), as the game keeps them (single precision)
  }
  apply(r) {
    const j = r.j;
    this.counts[j]++;
    this.judged++;
    this.accSum += ACC_W[j];
    this.scoreSum += SCORE_W[j];
    if (j === MISS || j === BAD) this.combo = 0;
    else { this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo; }
    if (!r.automatic && j !== MISS) {
      this.devs.push(Math.fround(r.dev / 1000.0));
      if (j !== MARVELOUS) { if (r.dev < 0) this.early++; else if (r.dev > 0) this.late++; }
    }
  }
  get accuracy() { return this.judged === 0 ? 100 : this.accSum / this.judged; }
  get score() { return toLong(roundEven(this.scoreSum)); }
  /** The score as games before 2.1.1 worked it out (out of 1,000,000). */
  get oldScore() {
    if (this.total === 0) return 0;
    let s = 0; for (let j = 0; j < 6; j++) s += OLD_SCORE_W[j] * this.counts[j];
    return toLong(roundEven(MAX_SCORE * s / this.total));
  }
  get fullCombo() { return this.judged > 0 && this.counts[MISS] === 0 && this.counts[BAD] === 0; }
  get perfectPlay() { return this.fullCombo && this.counts[GREAT] === 0 && this.counts[GOOD] === 0; }
  get grade() { return this.judged === 0 ? "D" : gradeOf(this.accuracy); }
  get meanDeviationMs() { if (!this.devs.length) return 0; let s = 0; for (const d of this.devs) s += d; return s / this.devs.length; }
  get deviationStdMs() {
    if (this.devs.length < 2) return 0;
    const m = this.meanDeviationMs; let s = 0;
    for (const d of this.devs) s += (d - m) * (d - m);
    return Math.sqrt(s / (this.devs.length - 1));
  }
  /** What the game shows and keeps (ReplayResult.From). */
  result() {
    return {
      score: this.score, oldScore: this.oldScore, accuracy: this.accuracy, maxCombo: this.maxCombo, counts: this.counts.slice(), grade: this.grade,
      fullCombo: this.fullCombo, perfectPlay: this.perfectPlay, early: this.early, late: this.late, judged: this.judged, targets: this.total,
    };
  }
}

/** Replay.Simulate: the inputs through a fresh judge, every result into the score. Same chart + same inputs = same score. */
export function simulate(c, inputs, windows) {
  const judge = new Judge(c, windows);
  const score = new ScoreState(c.time.length);
  let applied = 0;
  const n = inputs.time.length;
  for (let i = 0; i < n; i++) {
    judge.process(inputs.time[i], inputs.key[i], inputs.down[i] === 1);
    for (; applied < judge.results.length; applied++) score.apply(judge.results[applied]);
  }
  judge.finish();
  for (; applied < judge.results.length; applied++) score.apply(judge.results[applied]);
  return { score, judge };
}

// ---------------------------------------------------------------- replays (.octreplay: gzip JSON)

export const REPLAY_FORMAT = "octive.replay";
// 3 (2.0): a press earlier than the Bad window is a ghost tap; 2 and older keep early misses (judged as they were played)
export const REPLAY_VERSION = 3;

/** Replay.GetInputs: [deltaUs, key, down] triples -> inputs in time order (as typed arrays). */
export function unpackInputs(packed, maxInputs = 2_000_000) {
  if (!Array.isArray(packed) || packed.length % 3 !== 0) bad("The replay's input data is damaged.");
  const n = packed.length / 3;
  if (n > maxInputs) bad("The replay has too many inputs.");
  const time = new Float64Array(n), key = new Int32Array(n), down = new Uint8Array(n);
  let t = 0;
  for (let i = 0, j = 0; j < n; i += 3, j++) {
    const d = packed[i], k = packed[i + 1], dn = packed[i + 2];
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(k) || !Number.isSafeInteger(dn)) bad("The replay's input data is damaged.");
    t += d;
    checkTime(t, "A replay input");
    time[j] = t; key[j] = toInt32(k); down[j] = dn !== 0 ? 1 : 0;
  }
  return { time, key, down };
}

/** Gunzips a .octreplay (plain JSON is read as it is), up to maxBytes of JSON. */
export async function replayText(u8, maxBytes = 24 * 1048576) {
  if (!u8 || u8.length < 2) bad("The replay file is empty.");
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return new TextDecoder().decode(u8);
  const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { reader.cancel().catch(() => {}); bad("The replay file is too large."); }
      parts.push(value);
    }
  } catch (e) { if (e instanceof JudgeDataError) throw e; bad("The replay file is damaged."); }
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new TextDecoder().decode(all);
}

/**
 * Reads a replay: its details (who, which chart, mods, the result the game showed) and its inputs. Throws
 * JudgeDataError when it isn't an OCTIVE replay or is damaged.
 */
export async function readReplay(u8, opts = {}) {
  let o;
  try { o = JSON.parse(await replayText(u8, opts.maxBytes)); } catch (e) { if (e instanceof JudgeDataError) throw e; bad("The replay file is not valid."); }
  if (!isObj(o) || o.format !== REPLAY_FORMAT) bad("This is not an OCTIVE replay.");
  const version = Number.isInteger(o.version) ? o.version : 1;
  if (version > REPLAY_VERSION) bad("This replay needs a newer version of OCTIVE.");
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const res = isObj(o.result) ? o.result : {};
  return {
    version,
    octiveVersion: str(o.octiveVersion, 20),
    playerId: str(o.playerId, 80),
    player: str(o.player, 80),
    songId: str(o.songId, 120),
    chartId: str(o.chartId, 120),
    chartHash: str(o.chartHash, 80),
    title: str(o.title, 200),
    difficulty: str(o.difficulty, 120),
    keyCount: Number.isInteger(o.keyCount) ? o.keyCount : 0,
    autoplay: o.autoplay === true,
    mods: str(o.mods, 80) || "",
    scoring: str(o.scoring, 60) || "octive.standard",
    windows: isObj(o.windows) ? o.windows : null,
    playedAt: str(o.playedAt, 60),
    result: {
      score: Number(res.score) || 0, accuracy: Number(res.accuracy) || 0, maxCombo: Number(res.maxCombo) || 0,
      counts: Array.isArray(res.counts) ? res.counts.slice(0, 6).map((x) => Number(x) || 0) : [],
      fullCombo: res.fullCombo === true, failed: res.failed === true,
    },
    inputs: unpackInputs(o.inputs === undefined ? [] : o.inputs, opts.maxInputs),
  };
}

/**
 * A play judged again: the chart (compiled), the replay's inputs, the windows its mods give. The result has the
 * game's numbers plus the hit timing spread (to spot input that's too perfect for a person).
 */
export function judgeReplay(c, replay, opts = {}) {
  const mods = parseMods(replay.mods);
  const w = windowsFor(mods);
  if (opts.nearest === false) w.nearest = false; // a replay from before 1.5.2, judged by the rule it was played with
  // a replay from before 2.0 (version 2 and older) was played with early misses: judged by that rule
  if (opts.earlyMiss === true || (opts.earlyMiss === undefined && Number(replay.version) < 3)) w.earlyMiss = true;
  const { score } = simulate(c, replay.inputs, w);
  const r = score.result();
  r.mods = mods;
  r.rate = rateOf(replay.mods);
  // (2.2.0) the score is the points times the song speed (ScorePoints.WithRate); baseScore is the plain points
  r.baseScore = r.score;
  r.score = scoreWithRate(r.score, r.rate);
  r.hits = score.devs.length;
  r.meanMs = score.meanDeviationMs;
  r.stdMs = score.deviationStdMs;
  r.signature = timingSignature(score.devs);
  Object.assign(r, inputSigns(score.devs, replay.inputs));
  return r;
}

/**
 * What the anti-cheat reads from a play's input (2.0): the share of hits within 1 ms of their note (exactShare); how
 * alike the taps' hold lengths are (sameHold: the share in the most common 0.5 ms step, holdMs: that length, over
 * presses: taps shorter than 150 ms); and how many chords were pressed at the very same instant (sameChord, out of
 * chords: groups of keys pressed within 15 ms of each other). A person's numbers spread out; a bot's don't.
 */
export function inputSigns(devs, inputs) {
  const out = { exactShare: 0, sameHold: 0, holdMs: 0, presses: 0, sameChord: 0, chords: 0 };
  if (devs.length) { let e = 0; for (const d of devs) if (Math.abs(d) < 1) e++; out.exactShare = Math.round((e / devs.length) * 1000) / 1000; }
  if (!inputs || !inputs.time) return out;
  const n = inputs.time.length, downAt = new Map(), steps = new Map(), downs = [];
  for (let i = 0; i < n; i++) {
    const k = inputs.key[i], t = inputs.time[i];
    if (inputs.down[i]) { downAt.set(k, t); downs.push([t, k]); continue; }
    const t0 = downAt.get(k);
    if (t0 === undefined) continue;
    downAt.delete(k);
    const held = t - t0;
    if (held <= 0 || held >= 150_000) continue; // long notes and long presses aren't taps
    out.presses++;
    const step = Math.round(held / 500); // half-millisecond steps
    steps.set(step, (steps.get(step) || 0) + 1);
  }
  if (out.presses) {
    let best = 0, bestStep = 0;
    for (const [s, c] of steps) if (c > best) { best = c; bestStep = s; }
    out.sameHold = Math.round((best / out.presses) * 1000) / 1000;
    out.holdMs = bestStep / 2;
  }
  downs.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < downs.length;) {
    let j = i + 1;
    while (j < downs.length && downs[j][0] - downs[j - 1][0] <= 15_000 && downs[j][1] !== downs[j - 1][1]) j++;
    if (j - i >= 2) { out.chords++; if (downs[j - 1][0] - downs[i][0] < 50) out.sameChord++; }
    i = j;
  }
  if (out.chords) out.sameChord = Math.round((out.sameChord / out.chords) * 1000) / 1000;
  return out;
}

/** The first hits' timing (whole ms), to recognise the same play sent again by someone else. */
export function timingSignature(devs, n = 120) { return devs.slice(0, n).map((d) => Math.round(d)).join(","); }

/** How alike two timing signatures are: the share of hits within 1 ms of each other (0 when too short to say). */
export function signatureMatch(a, b) {
  if (!a || !b) return 0;
  const x = a.split(",").map(Number), y = b.split(",").map(Number);
  const n = Math.min(x.length, y.length);
  if (n < 30) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (Math.abs(x[i] - y[i]) <= 1) same++;
  return same / n;
}

// ---------------------------------------------------------------- Ranked's AI opponents (2.0)

/** A small seeded random number generator (mulberry32): the same seed always gives the same numbers. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The key that plays a lane at a time: the chart's input maps turned around (the lane itself when it has none). */
function keyForLane(c, lane, t) {
  const times = c.imTimes;
  if (!times || !times.length) return lane;
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found < 0) return lane;
  const k = c.imMaps[found].indexOf(lane);
  return k >= 0 ? k : lane;
}

/**
 * An AI opponent's play of a compiled chart, near a target accuracy and played like a person: every note pressed with a
 * timing spread around a slight lean early or late, taps held 40-110 ms, long notes held to about their end. The spread is
 * searched for (a few tries, the same random numbers each time) so the judged accuracy lands close to the target.
 * Gives the inputs packed like a replay's ([delta us, key, down] from 0) and the judged result. Same seed, same play.
 */
export function botPlay(c, targetAcc, seed) {
  const presses = [];
  for (let i = 0; i < c.time.length; i++) if (c.kind[i] === TAP || c.kind[i] === HOLD_HEAD) presses.push(i);
  presses.sort((a, b) => c.time[a] - c.time[b] || c.lane[a] - c.lane[b]);
  const endOf = new Map(); // a long note's end, by note
  for (let i = 0; i < c.time.length; i++) if (c.kind[i] === HOLD_TAIL || c.kind[i] === HOLD_END) endOf.set(c.note[i], c.time[i]);
  const w = windowsFor(0);
  const make = (spreadMs) => {
    const rnd = seededRandom(seed);
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const lean = (rnd() - 0.5) * 8;
    const perKey = new Map();
    for (const i of presses) {
      const t = c.time[i] + (lean + gauss() * spreadMs) * 1000;
      const key = keyForLane(c, c.lane[i], c.time[i]);
      const up = c.kind[i] === HOLD_HEAD && endOf.has(c.note[i]) ? endOf.get(c.note[i]) + (gauss() * spreadMs * 1.2 - 10) * 1000 : t + (40 + rnd() * 70) * 1000;
      if (!perKey.has(key)) perKey.set(key, []);
      perKey.get(key).push([t, up]);
    }
    // one key: a press only after that key's last release
    const ev = [];
    for (const [key, list] of perKey) {
      list.sort((a, b) => a[0] - b[0]);
      let prevUp = -Infinity;
      for (const p of list) {
        let t = Math.max(0, p[0]), up = p[1];
        if (t <= prevUp + 1000) t = prevUp + 1000;
        if (up <= t + 15000) up = t + 15000;
        ev.push([Math.round(t), key, 1], [Math.round(up), key, 0]);
        prevUp = up;
      }
    }
    ev.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const inputs = { time: Float64Array.from(ev.map((e) => e[0])), key: Int32Array.from(ev.map((e) => e[1])), down: Uint8Array.from(ev.map((e) => e[2])) };
    return { ev, r: simulate(c, inputs, w).score.result() };
  };
  let lo = 2, hi = 90, best = null;
  for (let it = 0; it < 8; it++) {
    const mid = (lo + hi) / 2, p = make(mid);
    if (!best || Math.abs(p.r.accuracy - targetAcc) < Math.abs(best.r.accuracy - targetAcc)) best = p;
    if (p.r.accuracy > targetAcc) lo = mid; else hi = mid;
  }
  const packed = [];
  let prev = 0;
  for (const e of best.ev) { packed.push(e[0] - prev, e[1], e[2]); prev = e[0]; }
  return { inputs: packed, result: best.r };
}

// ---------------------------------------------------------------- star rating and PR (2.0.1)
// The game's StarRating.Calculate (v3, Engine/Scoring/Performance.cs) and Performance.PlayPP worked out here from the
// chart itself, with the reading multiplier's pieces (Core/Easing.cs, Core/CurveDef.cs, Core/KeyframeChannel.cs, the
// playfield and lane channels of Lanes/LaneTimeline.cs, the scroll speeds of Scrolling/SvTimeline.cs). A play on a chart
// that isn't verified counts from the server's own reading of the chart (its stars) and of the play (its judged hits):
// never from numbers the game or an uploader sent. Checked against the game's code on whole libraries (star parity).

const EASE_C1 = 1.70158, EASE_C2 = EASE_C1 * 1.525, EASE_C3 = EASE_C1 + 1;
function easeOutBounce(t) {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1; return n1 * t * t + 0.984375;
}
const EASE_FNS = {
  linear: (t) => t, step: (t) => (t < 1 ? 0 : 1),
  inQuad: (t) => t * t, outQuad: (t) => 1 - (1 - t) * (1 - t), inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t, outCubic: (t) => 1 - Math.pow(1 - t, 3), inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t, outQuart: (t) => 1 - Math.pow(1 - t, 4), inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2), outSine: (t) => Math.sin((t * Math.PI) / 2), inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inExpo: (t) => Math.pow(2, 10 * t - 10), outExpo: (t) => 1 - Math.pow(2, -10 * t),
  inOutExpo: (t) => (t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inCirc: (t) => 1 - Math.sqrt(1 - t * t), outCirc: (t) => Math.sqrt(1 - (t - 1) * (t - 1)),
  inOutCirc: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - 4 * t * t)) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2),
  inBack: (t) => EASE_C3 * t * t * t - EASE_C1 * t * t, outBack: (t) => 1 + EASE_C3 * Math.pow(t - 1, 3) + EASE_C1 * Math.pow(t - 1, 2),
  inOutBack: (t) => (t < 0.5 ? (Math.pow(2 * t, 2) * ((EASE_C2 + 1) * 2 * t - EASE_C2)) / 2 : (Math.pow(2 * t - 2, 2) * ((EASE_C2 + 1) * (t * 2 - 2) + EASE_C2) + 2) / 2),
  outBounce: easeOutBounce, outElastic: (t) => Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  smoothstep: (t) => t * t * (3 - 2 * t), smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};
const EASE_BY_NAME = new Map(Object.entries(EASE_FNS).map(([k, f]) => [k.toLowerCase(), f]));
EASE_BY_NAME.set("easein", EASE_FNS.inQuad); EASE_BY_NAME.set("easeout", EASE_FNS.outQuad); EASE_BY_NAME.set("easeinout", EASE_FNS.inOutQuad);

/** CurveDef: a creator's easing curve (points in 0..1 on x; monotone cubic Hermite, or straight lines). */
function curveOf(def) {
  const raw = Array.isArray(def && def.points) ? def.points : [];
  let pts = raw.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  pts.sort((a, b) => a.x - b.x);
  pts = pts.map((p) => ({ x: Math.max(0, Math.min(1, p.x)), y: p.y }));
  if (!pts.length || pts[0].x > 0) pts.unshift({ x: 0, y: 0 });
  if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: 1 });
  for (let i = pts.length - 2; i >= 0; i--) if (pts[i + 1].x - pts[i].x < 1e-9) pts.splice(i, 1);
  const n = pts.length, xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), ms = new Array(n).fill(0);
  const smooth = def && def.smooth === false ? false : true;
  if (n >= 2) {
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    ms[0] = d[0]; ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(d[i]) < 1e-12) { ms[i] = 0; ms[i + 1] = 0; continue; }
      const a = ms[i] / d[i], b = ms[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); ms[i] = t * a * d[i]; ms[i + 1] = t * b * d[i]; }
    }
  }
  return (x) => {
    if (n === 1) return ys[0];
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const h = xs[hi] - xs[lo], t = (x - xs[lo]) / h;
    if (!smooth) return ys[lo] + (ys[hi] - ys[lo]) * t;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * ms[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * ms[hi];
  };
}

/** Ease.Parse + Ease.Evaluate: a chart's easing name (or "custom:<curve>") as a function of 0..1. */
function easeOf(name, curves) {
  if (typeof name !== "string" || !name) return EASE_FNS.linear;
  if (name.toLowerCase().startsWith("custom:")) {
    const c = curves && Object.prototype.hasOwnProperty.call(curves, name.slice(7)) ? curves[name.slice(7)] : null;
    if (!c) return EASE_FNS.linear;
    const f = curveOf(c);
    return (t) => (t <= 0 ? f(0) : t >= 1 ? f(1) : f(t));
  }
  const f = EASE_BY_NAME.get(name.toLowerCase()) || EASE_FNS.linear;
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : f(t));
}

/** KeyframeChannel: one value over time (each keyframe eases from the value at its start, or "from", to its target). */
class KChannel {
  constructor(def, specs) {
    this.def = def; this.keys = [];
    if (!specs || !specs.length) return;
    const sorted = specs.slice().sort((a, b) => (a.t !== b.t ? a.t - b.t : a.order - b.order));
    for (const s of sorted) {
      if (!Number.isFinite(s.value)) continue;
      const current = this.evalLinear(s.t);
      const from = s.from != null && Number.isFinite(s.from) ? s.from : current;
      const to = s.relative ? current + s.value : s.value;
      this.keys.push({ start: s.t, end: s.t + Math.max(0, s.dur), from, to, ease: s.ease });
    }
  }
  static key(k, t) {
    if (t >= k.end) return k.to;
    if (t <= k.start) return k.from;
    return k.from + (k.to - k.from) * k.ease((t - k.start) / (k.end - k.start));
  }
  evalLinear(t) { for (let i = this.keys.length - 1; i >= 0; i--) if (this.keys[i].start <= t) return KChannel.key(this.keys[i], t); return this.def; }
  valueAt(t) {
    const k = this.keys;
    if (!k.length) return this.def;
    let lo = 0, hi = k.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (k[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found < 0 ? this.def : KChannel.key(k[found], t);
  }
}

const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const PF_PROPS = { x: "x", y: "y", rotation: "rotation", scale: "scale", spacing: "spacing", mirror: "mirror", tilt: "tilt", alpha: "alpha", opacity: "alpha" };
const PF_DEFAULT = { x: 0, y: 0, rotation: 0, scale: 1, spacing: 1, mirror: 0, tilt: 0, alpha: 1 };

/** The lane animations the reading multiplier looks at: the playfield's every property, and each lane's x and rotation. */
function readingLanes(events, k, curves) {
  const pf = {}, lane = [];
  for (let l = 0; l < k; l++) lane.push({ x: [], rotation: [] });
  let order = 0;
  for (const e of Array.isArray(events) ? events : []) {
    order++;
    if (!e || typeof e !== "object" || e.enabled === false) continue;
    const spec = { t: num(e.timeUs, 0), dur: num(e.durationUs, 0), value: num(e.value, 0), ease: easeOf(e.easing, curves), from: typeof e.from === "number" ? e.from : null, relative: e.relative === true, order };
    const prop = String(typeof e.property === "string" ? e.property : "x").toLowerCase();
    const lanes = Array.isArray(e.lanes) ? e.lanes : [];
    if (!lanes.length) { const p = PF_PROPS[prop]; if (p) (pf[p] ||= []).push(spec); continue; }
    if (prop !== "x" && prop !== "rotation") continue;
    for (const l of lanes) if (Number.isInteger(l) && l >= 0 && l < k) lane[l][prop].push(spec);
  }
  const pfCh = {};
  for (const p of Object.keys(PF_DEFAULT)) pfCh[p] = new KChannel(PF_DEFAULT[p], pf[p]);
  return { pf: pfCh, lane: lane.map((s) => ({ x: new KChannel(0, s.x), rotation: new KChannel(0, s.rotation) })) };
}

/** SvField / SvTimeline: each lane's scroll speed (the global events, plus a lane's own when it has some). */
function readingSv(events, k, curves) {
  const list = (Array.isArray(events) ? events : []);
  const timeline = (evs) => {
    const set = [], mul = [];
    let order = 0;
    for (const e of evs) {
      order++;
      if (!e || typeof e !== "object" || e.enabled === false) continue;
      const spec = { t: num(e.timeUs, 0), dur: num(e.durationUs, 0), value: num(e.value, 1), ease: easeOf(e.easing, curves), from: null, relative: false, order };
      const multiply = e.mode === 1 || (typeof e.mode === "string" && e.mode.toLowerCase() === "multiply");
      (multiply ? mul : set).push(spec);
    }
    const s = new KChannel(1, set), m = new KChannel(1, mul);
    return (t) => s.valueAt(t) * m.valueAt(t);
  };
  const isGlobal = (e) => !Array.isArray(e.lanes) || e.lanes.length === 0;
  const global = timeline(list.filter((e) => e && isGlobal(e)));
  const per = [];
  const anyLaneSpecific = list.some((e) => e && !isGlobal(e));
  for (let l = 0; l < k; l++) {
    if (!anyLaneSpecific) { per.push(global); continue; }
    const own = list.filter((e) => e && !isGlobal(e) && e.lanes.indexOf(l) >= 0);
    per.push(own.length ? timeline(list.filter((e) => e && (isGlobal(e) || e.lanes.indexOf(l) >= 0))) : global);
  }
  return per;
}

/** How much harder a behaviour makes a note to read (StarRating.BehaviorWeight). */
function behaviorWeight(b) {
  const p = b.p;
  const dbl = (k, f) => num(own(p, k), f);
  switch (b.type) {
    case "reverse": return 0.9;
    case "path": return 0.7;
    case "bezier": case "spline": case "orbit": return 0.6;
    case "pause": return 0.55;
    case "laneShift": return 0.5;
    case "merge": return 0.45;
    case "split": case "arc": return 0.4;
    case "fade": {
      const hides = has(p, "outStartBeats") || has(p, "outStartUs");
      return hides ? 0.8 * (1 - Math.max(0, Math.min(1, dbl("minAlpha", 0)))) + 0.1 : 0.3;
    }
    case "speed": return Math.min(0.6, Math.abs(dbl("factor", 1.5) - 1) * 0.6);
    case "clone": return 0.3;
    case "mirrorGhost": return 0.25;
    case "approachCurve": return 0.25;
    case "oscillate": return Math.min(0.4, 0.15 + Math.abs(dbl("amplitude", 0.6)) * 0.2);
    case "bounce": return 0.2;
    case "repeat": return 0.1;
    case "grow": return 0.08;
    case "spin": return 0.05;
    case "preset": return 0.3;
    default: return 0.15;
  }
}

const roundEven2 = (x) => roundEven(x * 100) / 100;
// (2.1.3) v5's knobs, as StarRating's defaults (Performance.cs)
const SR = { version: 5, scale: 0.013164, speedRef: 150, speedExp: 0.28, speedMax: 1.4, speedPeak: 70, speedVibro: 40, chordOverall: 0.75,
  techMax: 0.5, techMusical: 0.05, offRelease: 1.45, jackAt55: 0.65, jackAt25: 0.15, runMin: 0.6, runStep: 0.055, sectionDecay: 0.94 };
/** The star rating's version (StarRating.Version): 5 since 2.1.3. */
export const STAR_VERSION = SR.version;
const jackFactor = (dt) => (!Number.isFinite(dt) || dt >= 80 ? 1 : dt >= 55 ? 1 - ((80 - dt) / 25) * (1 - SR.jackAt55) : dt >= 25 ? SR.jackAt55 - ((55 - dt) / 30) * (SR.jackAt55 - SR.jackAt25) : SR.jackAt25);
const runFactor = (run) => (run <= 3 ? 1 : Math.max(SR.runMin, 1 - (run - 3) * SR.runStep));
/** StarRating.SpeedBoost: a finger switch on one hand counts more the faster that hand is going (not at vibro speed). */
function speedBoost(gap) {
  if (!Number.isFinite(gap) || gap >= SR.speedRef) return 1;
  const peak = Math.min(SR.speedMax, Math.pow(SR.speedRef / SR.speedPeak, SR.speedExp));
  if (gap >= SR.speedPeak) return Math.min(SR.speedMax, Math.pow(SR.speedRef / gap, SR.speedExp));
  if (gap <= SR.speedVibro) return 1;
  return 1 + (peak - 1) * (gap - SR.speedVibro) / (SR.speedPeak - SR.speedVibro);
}
/** StarRating.HandOf: left half, right half, and the middle key of odd layouts (a thumb). */
const handOf = (lane, keys) => (keys % 2 === 1 && lane === Math.floor(keys / 2) ? 2 : lane < Math.floor(keys / 2) ? 0 : 1);
/** C#'s Math.Log(x, 2). */
const log2cs = (x) => Math.log(x) / Math.log(2);
const decay = (v, dtMs, perSecond) => (!Number.isFinite(dtMs) ? 0 : v * Math.pow(perSecond, Math.max(0, dtMs) / 1000));

/**
 * A chart's stars at a song speed, as the game works them out (StarRating.Calculate, v5 since 2.1.3): from the chart file
 * (its JSON text or object). Throws JudgeDataError for a chart the game can't load.
 */
export function starRating(json, rate = 1) {
  let root = json;
  if (typeof json === "string") {
    const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
    try { root = JSON.parse(text); } catch { bad("The chart file is not valid JSON."); }
  }
  const chart = loadChart(root);
  const c = compileChart(chart);
  const k = Math.max(1, c.keyCount);
  if (!(rate > 0.01)) rate = 1;
  const n = c.time.length;
  if (!n) return 0;
  // each compiled note's own behaviours (the notes in time order, lanes the chart doesn't have left out, as compileChart)
  const order = chart.notes.map((x, i) => [x, i]).sort((a, b) => cmp(a[0].timeUs, b[0].timeUs) || cmp(a[0].lane, b[0].lane) || a[1] - b[1]).map((x) => x[0]);
  const behaviorsOf = [];
  for (const src of order) if (src.lane >= 0 && src.lane < c.keyCount) behaviorsOf.push(src.behaviors || []);
  const curves = isObj(root.curves) ? root.curves : {};
  const lanes = readingLanes(root.lanes, k, curves);
  const sv = readingSv(root.sv, k, curves);
  const reading = (note, lane, t) => {
    let behaviors = 0;
    for (const b of behaviorsOf[note] || []) if (b) behaviors += behaviorWeight(b);
    behaviors = Math.min(1.5, behaviors);
    const pf = lanes.pf;
    let motion = Math.abs(pf.rotation.valueAt(t)) / 25 + Math.abs(pf.tilt.valueAt(t)) / 35 + Math.abs(pf.x.valueAt(t)) * 0.25 + Math.abs(pf.y.valueAt(t)) * 0.2;
    motion += Math.abs(1 - pf.scale.valueAt(t)) * 0.8 + Math.abs(1 - pf.spacing.valueAt(t)) * 0.8 + Math.max(0, Math.min(1, pf.mirror.valueAt(t))) * 0.5 + (1 - Math.max(0, Math.min(1, pf.alpha.valueAt(t)))) * 0.8;
    motion += Math.abs(lanes.lane[lane].x.valueAt(t)) * 0.3 + Math.abs(lanes.lane[lane].rotation.valueAt(t)) / 30;
    motion = Math.min(0.8, motion);
    const svl = sv[lane];
    const now = svl(t), before = svl(t - 500_000);
    let speed = now <= 0.05 ? 0.6 : Math.min(0.6, Math.abs(Math.log(now)) * 0.6);
    if (now > 0.05 && before > 0.05) speed += Math.min(0.4, Math.abs(Math.log(now / before)) * 0.4);
    else if ((now > 0.05) !== (before > 0.05)) speed += 0.4;
    speed = Math.min(0.8, speed);
    return 1 + 0.5 * behaviors + 0.35 * motion + 0.35 * speed;
  };
  // holds: when each starts and ends (in ms at this speed); shorter than 150 ms they play like taps
  const holdEnd = new Map(), holdStart = new Map();
  for (let i = 0; i < n; i++) {
    const kind = c.kind[i], ms = c.time[i] / (1000 * rate), note = c.note[i];
    if (kind === HOLD_TAIL || kind === HOLD_END) holdEnd.set(note, Math.max(holdEnd.has(note) ? holdEnd.get(note) : 0, ms));
    else if (kind === HOLD_HEAD) holdStart.set(note, ms);
  }
  const realHold = (note) => holdStart.has(note) && holdEnd.has(note) && holdEnd.get(note) - holdStart.get(note) >= 150;
  // presses and timed releases of real holds, in time order (a release just after a press at the same time)
  const idx = [];
  for (let i = 0; i < n; i++) { const kind = c.kind[i]; if (kind === TAP || kind === HOLD_HEAD || (kind === HOLD_TAIL && realHold(c.note[i]))) idx.push(i); }
  idx.sort((a, b) => cmp(c.time[a], c.time[b]) || (c.kind[a] === HOLD_TAIL ? 1 : 0) - (c.kind[b] === HOLD_TAIL ? 1 : 0) || c.lane[a] - c.lane[b] || a - b);
  if (!idx.some((i) => c.kind[i] !== HOLD_TAIL)) return 0;
  // press times, for "is anything pressed when this note is let go?"
  const pressMs = idx.filter((i) => c.kind[i] !== HOLD_TAIL).map((i) => c.time[i] / (1000 * rate)).sort((a, b) => a - b);
  const pressNear = (ms, tol) => {
    let lo = 0, hi = pressMs.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pressMs[mid] === ms) return true; if (pressMs[mid] < ms) lo = mid + 1; else hi = mid - 1; }
    return (lo < pressMs.length && pressMs[lo] - ms <= tol) || (lo > 0 && ms - pressMs[lo - 1] <= tol);
  };
  const lane = new Array(k).fill(0), laneTime = new Array(k).fill(-Infinity), laneHoldUntil = new Array(k).fill(-Infinity);
  const laneTimeStrain = new Array(k).fill(-Infinity), laneGap = new Array(k).fill(Infinity), laneRun = new Array(k).fill(0);
  const handCur = [-Infinity, -Infinity, -Infinity], handPrev = [-Infinity, -Infinity, -Infinity];
  const handCurLanes = [0, 0, 0], handPrevLanes = [0, 0, 0]; // keys pressed in the hand's current / previous chord
  let overall = 0, overallTime = -Infinity;
  let groupT = -Infinity, lastGroupT = -Infinity, prevGap = Infinity, groupTech = 1, groupIdx = 0;
  const peaks = new Map();
  for (const i of idx) {
    const ms = c.time[i] / (1000 * rate);
    const l = Math.max(0, Math.min(k - 1, c.lane[i]));
    let laneAdd, overallAdd;
    if (c.kind[i] === HOLD_TAIL) {
      // a release with nothing pressed around it has to be timed on its own
      const m = pressNear(ms, 12) ? 1 : SR.offRelease;
      laneAdd = 0.8 * m; overallAdd = 0.45 * m;
    } else {
      // presses within 2 ms are one chord: the rhythm is read once per chord
      if (ms - groupT > 2) {
        const gap = ms - lastGroupT;
        groupTech = 1;
        if (gap < 400 && prevGap < 400) {
          const lr = Math.abs(log2cs(gap / prevGap));
          // a rhythm change only matters when the notes are fast; only a musical change counts (straight <-> triplet, 3:2, 4:3)
          const fastNotes = Math.max(0, Math.min(1, (300 - Math.max(gap, prevGap)) / 150));
          const frac = lr - Math.floor(lr);
          const musical = Math.min(Math.abs(frac - 0.585), Math.abs(frac - 0.415));
          groupTech = 1 + SR.techMax * fastNotes * (musical <= SR.techMusical ? 1 : 0);
        }
        prevGap = gap; lastGroupT = ms; groupT = ms; groupIdx = 0;
      } else groupIdx++;
      // how fast this hand is going (time since its previous chord); only switching fingers counts as speed
      const hand = handOf(l, k);
      if (handCur[hand] !== groupT) { handPrev[hand] = handCur[hand]; handPrevLanes[hand] = handCurLanes[hand]; handCur[hand] = groupT; handCurLanes[hand] = 0; }
      const bit = 2 ** Math.min(62, l);
      if (Math.floor(handCurLanes[hand] / bit) % 2 === 0) handCurLanes[hand] += bit;
      const hgap = ms - handPrev[hand];
      const switched = Math.floor(handPrevLanes[hand] / bit) % 2 === 0;
      const speed = switched ? speedBoost(hgap) : 1;
      let underHold = false;
      for (let j = 0; j < k; j++) if (j !== l && laneHoldUntil[j] > ms + 1) { underHold = true; break; }
      const hb = (underHold ? 1.25 : 1.0) * reading(c.note[i], l, c.time[i]) * groupTech * speed;
      const gapL = ms - laneTime[l];
      if (gapL < 130 && Number.isFinite(laneGap[l]) && Math.abs(gapL - laneGap[l]) <= 0.15 * gapL) laneRun[l]++;
      else laneRun[l] = 0;
      laneGap[l] = gapL;
      const jack = jackFactor(gapL) * runFactor(laneRun[l]);
      laneAdd = 2.0 * hb * jack;
      overallAdd = 1.0 * hb * (0.35 + 0.65 * jack) * (groupIdx > 0 ? SR.chordOverall : 1);
      laneTime[l] = ms;
      if (c.kind[i] === HOLD_HEAD && realHold(c.note[i])) laneHoldUntil[l] = holdEnd.get(c.note[i]);
    }
    lane[l] = decay(lane[l], ms - laneTimeStrain[l], 0.125) + laneAdd;
    laneTimeStrain[l] = ms;
    overall = decay(overall, ms - overallTime, 0.30) + overallAdd;
    overallTime = ms;
    const strain = lane[l] + overall;
    const section = Math.floor(ms / 400);
    if (!peaks.has(section) || strain > peaks.get(section)) peaks.set(section, strain);
  }
  let weighted = 0, w = 1;
  for (const v of [...peaks.values()].sort((a, b) => b - a)) { weighted += v * w; w *= SR.sectionDecay; }
  return roundEven2(weighted * SR.scale);
}

const PP_WEIGHTS = [300, 300, 200, 100, 50, 0];
const MOD_PP = [[MOD.EZ, 0.5], [MOD.HR, 1.1], [MOD.HD, 1.06], [MOD.FI, 1.06], [MOD.FL, 1.12]];

/** Performance.PPAccuracy: osu!mania accuracy (percent) from the judgement counts, or -1 without any. */
export function ppAccuracy(counts) {
  if (!Array.isArray(counts) || counts.length < 6) return -1;
  let sum = 0, n = 0;
  for (let i = 0; i < 6; i++) { sum += PP_WEIGHTS[i] * counts[i]; n += counts[i]; }
  return n <= 0 ? -1 : roundEven(10000 * (100 * sum / (300 * n))) / 10000;
}

/**
 * A play's PR from what the server worked out itself (Performance.PlayPP times the mods' multiplier): the chart's stars
 * at the play's speed, the judged hits, the chart's number of judged moments and whether it was failed.
 */
export function playPR(stars, counts, targets, failed, mods) {
  if (failed || targets <= 0 || !(stars > 0)) return 0;
  const accPct = ppAccuracy(counts);
  if (accPct < 0) return 0;
  const acc = Math.max(0, Math.min(1, accPct / 100));
  const difficulty = 8.0 * Math.pow(Math.max(stars - 0.15, 0.05), 2.2);
  const accFactor = Math.max(0, 1 - 3 * (1 - acc)); // (2.1.3; before: 5 x acc - 4)
  const length = 1 + 0.1 * Math.min(1.0, targets / 1500.0);
  // (the game: Math.Round(PlayPP × Mods.PPMultiplier, 2), the multiplier a product in the mods' list order)
  const m = parseMods(mods);
  let mult = 1;
  for (const [mod, x] of MOD_PP) if (m & mod) mult *= x;
  return roundEven2(roundEven2(difficulty * accFactor * length) * mult);
}
