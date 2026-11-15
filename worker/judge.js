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
export const defaultWindows = () => ({ marvelous: 30, perfect: 55, great: 85, good: 120, bad: 150, miss: 170, releaseScale: 1.5, nearest: true });

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
const SCORE_W = [1.0, 0.98, 0.70, 0.40, 0.10, 0];
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
      if (dev0 < -this.windowUs(MISS, c.ws[ti])) break; // this one and the rest: too early (a ghost tap)
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
  get score() { return this.total === 0 ? 0 : toLong(roundEven(MAX_SCORE * this.scoreSum / this.total)); }
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
      score: this.score, accuracy: this.accuracy, maxCombo: this.maxCombo, counts: this.counts.slice(), grade: this.grade,
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
export const REPLAY_VERSION = 2;

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
  const { score } = simulate(c, replay.inputs, w);
  const r = score.result();
  r.mods = mods;
  r.rate = rateOf(replay.mods);
  r.hits = score.devs.length;
  r.meanMs = score.meanDeviationMs;
  r.stdMs = score.deviationStdMs;
  r.signature = timingSignature(score.devs);
  return r;
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
