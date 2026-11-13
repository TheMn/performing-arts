// melody.js — MIDI loading, track extraction, placeholder melodies and the "arrangement" that
// music.js schedules (spec §8). No Tone.js here; the MIDI library is loaded lazily, so this file
// can be imported by tests.html without network access.
//
// All times are in QUARTER-NOTE BEATS relative to the start of the loop region.
// An event is { t, d, n, v } = start, duration, MIDI note number, velocity 0..1.

import { loadMidiLib } from "./vendor.js";

const SELECTION_KEY = "farandole.midi.selection";
const FILE_KEY = "farandole.midi.file";

export const ROLES = [
  { slot: 1, label: "Theme B (Flute)", mode: "high" },
  { slot: 3, label: "Bass (Cello)", mode: "low" },
  { slot: 4, label: "Theme A (Oboe)", mode: "high" },
  { slot: 5, label: "Counter-melody (Violin)", mode: "high" },
];

export function defaultSelection() {
  return { file: null, tracks: { 1: "auto", 3: "auto", 4: "auto", 5: "auto" }, startBar: 1, endBar: 0 /* 0 = auto */ };
}

// ---- melody extraction (pure) ---------------------------------------------------------------

/** Keep only the highest (mode "high") or lowest ("low") sounding note at any moment. */
export function extractLine(notes, mode = "high") {
  const EPS = 1e-6;
  const sorted = [...notes].sort((a, b) => a.t - b.t || (mode === "high" ? b.n - a.n : a.n - b.n));
  const pts = new Set();
  for (const n of sorted) { pts.add(n.t); pts.add(n.t + n.d); }
  const bounds = [...pts].sort((a, b) => a - b);
  const out = [];
  let active = [], idx = 0, cur = null;
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b - a < EPS) continue;
    while (idx < sorted.length && sorted[idx].t <= a + EPS) active.push(sorted[idx++]);
    active = active.filter((n) => n.t + n.d > a + EPS);
    if (!active.length) { cur = null; continue; }
    let best = active[0];
    for (const n of active) if (mode === "high" ? n.n > best.n : n.n < best.n) best = n;
    if (cur && cur.src === best) cur.ev.d = b - cur.ev.t;
    else {
      const ev = { t: a, d: b - a, n: best.n, v: best.v };
      out.push(ev);
      cur = { src: best, ev };
    }
  }
  return out;
}

// ---- placeholder melodies (original, NOT Bizet) ----------------------------------------------
// Simple loops in D so the demo works without the MIDI file. 8 bars of 4/4 = 32 beats.

function degreesToEvents(bars, scaleSemis, root, noteLen) {
  // bars: array (one per bar) of arrays of scale degrees (null = rest); every slot is `noteLen` beats
  const out = [];
  bars.forEach((bar, b) => {
    bar.forEach((deg, i) => {
      if (deg === null) return;
      const oct = Math.floor(deg / 7), step = ((deg % 7) + 7) % 7;
      out.push({ t: b * 4 + i * noteLen, d: noteLen * 0.9, n: root + oct * 12 + scaleSemis[step], v: 0.8 });
    });
  });
  return out;
}

const D_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const D_MINOR = [0, 2, 3, 5, 7, 8, 10];

export function placeholderParts() {
  // Theme B — lively stepwise D-major line (eighth notes), D4 = 62
  const themeB = degreesToEvents([
    [0, 1, 2, 1, 0, 1, 2, 3],
    [4, 3, 2, 1, 2, 3, 4, 5],
    [4, 3, 4, 5, 6, 5, 4, 3],
    [2, 3, 4, 3, 2, 1, 0, -1],
    [0, 2, 1, 3, 2, 4, 3, 5],
    [4, 6, 5, 7, 6, 5, 4, 3],
    [4, 3, 2, 3, 4, 2, 1, 2],
    [0, 1, 2, 1, 0, null, 0, null],
  ], D_MAJOR, 62, 0.5);
  // Theme A — slower D-minor march (quarter notes), D4 = 62
  const themeA = degreesToEvents([
    [0, 0, 2, 4], [3, 2, 1, 0], [2, 2, 4, 7], [6, 4, 3, 2],
    [4, 4, 7, 9], [8, 7, 6, 4], [3, 3, 2, 1], [0, null, 0, null],
  ], D_MINOR, 62, 1);
  // Bass — D–A, one half note each
  const bass = [];
  for (let b = 0; b < 8; b++) {
    bass.push({ t: b * 4, d: 1.9, n: 38, v: 0.85 });       // D2
    bass.push({ t: b * 4 + 2, d: 1.9, n: 45, v: 0.8 });    // A2
  }
  // Counter-melody — long notes (whole notes)
  const counter = [69, 67, 69, 64, 69, 67, 64, 62].map((n, b) => ({ t: b * 4, d: 3.9, n, v: 0.7 }));
  return { 1: themeB, 3: bass, 4: themeA, 5: counter, loopBeats: 32, beatsPerBar: 4 };
}

export function placeholderSong() {
  return { placeholder: true, name: "placeholder", ppq: 480, beatsPerBar: 4, totalBars: 8, tracks: [] };
}

// ---- MIDI parsing ---------------------------------------------------------------------------

export async function parseMidi(arrayBuffer, name = "file.mid") {
  const { Midi } = await loadMidiLib();
  const midi = new Midi(arrayBuffer);
  const ppq = midi.header.ppq || 480;
  const ts = midi.header.timeSignatures && midi.header.timeSignatures[0];
  const [num, den] = ts ? ts.timeSignature : [4, 4];
  const beatsPerBar = (num * 4) / den;
  let lastBeat = 0;
  const tracks = midi.tracks.map((tr, index) => {
    const notes = tr.notes.map((n) => ({ t: n.ticks / ppq, d: Math.max(0.03, n.durationTicks / ppq), n: n.midi, v: n.velocity }));
    for (const n of notes) lastBeat = Math.max(lastBeat, n.t + n.d);
    const avgPitch = notes.length ? notes.reduce((s, n) => s + n.n, 0) / notes.length : 0;
    return {
      index, name: tr.name || `Track ${index}`,
      instrument: (tr.instrument && tr.instrument.name) || "",
      percussion: !!(tr.instrument && tr.instrument.percussion),
      noteCount: notes.length, avgPitch, notes,
    };
  });
  return { placeholder: false, name, ppq, beatsPerBar, totalBars: Math.max(1, Math.ceil(lastBeat / beatsPerBar - 1e-9)), tracks };
}

// ---- track → role assignment ------------------------------------------------------------------

/** Which track feeds which role when the user has not chosen ("auto"). Highest-pitched tracks → melodies. */
export function autoAssign(song) {
  const cands = song.tracks.filter((t) => t.noteCount > 0 && !t.percussion).sort((a, b) => b.avgPitch - a.avgPitch);
  if (!cands.length) return null;
  const n = cands.length;
  const bass = cands[n - 1];
  const pool = n === 1 ? [cands[0]] : cands.slice(0, n - 1);
  return {
    1: { track: pool[0].index, transpose: 0 },
    3: { track: bass.index, transpose: 0 },
    4: pool[1] ? { track: pool[1].index, transpose: 0 } : { track: pool[0].index, transpose: 0 },
    5: pool[2] ? { track: pool[2].index, transpose: 0 }
      : { track: (pool[1] || pool[0]).index, transpose: 12 },   // Theme A an octave up
  };
}

/** Resolve the user's selection to { slot: {track, transpose} | null (= placeholder) }. */
export function resolveRoles(song, selection) {
  const auto = autoAssign(song);
  const res = {};
  for (const r of ROLES) {
    const sel = selection.tracks[r.slot];
    if (sel === "ph") res[r.slot] = null;
    else if (sel === "auto" || sel === undefined || sel === "") res[r.slot] = auto ? auto[r.slot] : null;
    else {
      const idx = Number(sel);
      res[r.slot] = song.tracks[idx] && song.tracks[idx].noteCount ? { track: idx, transpose: 0 } : null;
    }
  }
  return res;
}

export function normalizeSelection(sel, song) {
  const s = { ...defaultSelection(), ...(sel || {}), tracks: { ...defaultSelection().tracks, ...((sel && sel.tracks) || {}) } };
  const total = song.totalBars;
  s.startBar = Math.min(total, Math.max(1, Math.round(Number(s.startBar) || 1)));
  const end = Math.round(Number(s.endBar) || 0);
  s.endBar = end > 0 ? Math.min(total, Math.max(s.startBar, end)) : Math.min(total, s.startBar + 15);
  return s;
}

// ---- arrangement ------------------------------------------------------------------------------

function tile(events, srcLen, loopBeats) {
  const out = [];
  for (let off = 0; off < loopBeats; off += srcLen) {
    for (const e of events) {
      const t = e.t + off;
      if (t >= loopBeats) continue;
      out.push({ ...e, t, d: Math.min(e.d, loopBeats - t) });
    }
  }
  return out;
}

/** Bass note (MIDI) that sounds at / carries into the start of every bar. */
export function barRoots(bassEvents, bars, beatsPerBar) {
  const roots = [];
  let last = null;
  for (let b = 0; b < bars; b++) {
    const lo = b * beatsPerBar, hi = lo + beatsPerBar;
    const inBar = bassEvents.filter((e) => e.t >= lo - 1e-6 && e.t < hi - 1e-6);
    if (inBar.length) last = inBar[0].n;
    else {
      const carrying = bassEvents.find((e) => e.t < lo && e.t + e.d > lo);
      if (carrying) last = carrying.n;
    }
    roots.push(last);
  }
  const first = roots.find((r) => r !== null);
  return roots.map((r) => (r === null ? (first ?? 38) : r));
}

/**
 * Build everything music.js needs: per-slot note events, loop length, bar roots for the pad.
 * Returns { loopBeats, beatsPerBar, bars, parts: {1,3,4,5}, roots, sources: {slot: text}, usesPlaceholder }
 */
export function buildArrangement(song, selectionIn) {
  const ph = placeholderParts();
  if (song.placeholder) {
    return {
      loopBeats: ph.loopBeats, beatsPerBar: ph.beatsPerBar, bars: ph.loopBeats / ph.beatsPerBar,
      parts: { 1: ph[1], 3: ph[3], 4: ph[4], 5: ph[5] },
      roots: barRoots(ph[3], ph.loopBeats / ph.beatsPerBar, ph.beatsPerBar),
      sources: { 1: "placeholder", 3: "placeholder", 4: "placeholder", 5: "placeholder" },
      usesPlaceholder: true, startBar: 1, endBar: 8, totalBars: 8,
    };
  }
  const sel = normalizeSelection(selectionIn, song);
  const bpb = song.beatsPerBar;
  const bars = sel.endBar - sel.startBar + 1;
  const loopBeats = bars * bpb;
  const rs = (sel.startBar - 1) * bpb, re = sel.endBar * bpb;
  const roles = resolveRoles(song, sel);
  const parts = {}, sources = {};
  let usesPlaceholder = false;
  for (const r of ROLES) {
    const pick = roles[r.slot];
    if (!pick) {
      parts[r.slot] = tile(ph[r.slot], ph.loopBeats, loopBeats);
      sources[r.slot] = "placeholder";
      usesPlaceholder = true;
      continue;
    }
    const tr = song.tracks[pick.track];
    const clipped = [];
    for (const n of tr.notes) {
      const s = Math.max(n.t, rs), e = Math.min(n.t + n.d, re);
      if (e - s > 0.02 && n.t < re) clipped.push({ t: s - rs, d: e - s, n: n.n + pick.transpose, v: n.v });
    }
    parts[r.slot] = extractLine(clipped, r.mode);
    sources[r.slot] = `track ${tr.index}: ${tr.name}${pick.transpose ? " (+8va)" : ""}`;
  }
  return {
    loopBeats, beatsPerBar: bpb, bars, parts, roots: barRoots(parts[3], bars, bpb), sources, usesPlaceholder,
    startBar: sel.startBar, endBar: sel.endBar, totalBars: song.totalBars,
  };
}

// ---- persistence (all wrapped in try/catch: storage may be unavailable) ------------------------

export function loadSelection(song) {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || "null");
    if (saved && saved.file === song.name) return normalizeSelection(saved, song);
  } catch (e) { /* ignore */ }
  return normalizeSelection({ file: song.name }, song);
}

export function saveSelection(sel) {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify(sel)); } catch (e) { /* ignore */ }
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Remember a dropped MIDI file so it is still there after a reload. */
export function storeMidiFile(name, arrayBuffer) {
  try { localStorage.setItem(FILE_KEY, JSON.stringify({ name, b64: toBase64(new Uint8Array(arrayBuffer)) })); return true; }
  catch (e) { return false; }
}
export function clearStoredMidiFile() { try { localStorage.removeItem(FILE_KEY); } catch (e) { /* ignore */ } }
export function readStoredMidiFile() {
  try {
    const o = JSON.parse(localStorage.getItem(FILE_KEY) || "null");
    if (o && o.b64) return { name: o.name, buffer: fromBase64(o.b64) };
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Startup: a file stored from an earlier drop wins, then assets/farandole.mid, else the placeholder.
 * Never throws.
 */
export async function loadInitialSong() {
  const stored = readStoredMidiFile();
  if (stored) {
    try { return await parseMidi(stored.buffer, stored.name); } catch (e) { console.warn("[melody] stored MIDI unusable", e); }
  }
  try {
    const res = await fetch("assets/farandole.mid", { cache: "no-cache" });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      return await parseMidi(buf, "farandole.mid");
    }
  } catch (e) { /* no file: fall through */ }
  return placeholderSong();
}
