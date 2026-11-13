// people.js — raw poses (webcam OR simulation) → stable people with slots + features (spec §5, §6).
// Pure logic only: no DOM, no Tone.js, no MediaPipe. tests.html imports this file directly.
//
// A "detection" is { landmarks: [{x, y, visibility}, … 33 MediaPipe pose landmarks, unmirrored],
//                    preferredSlot?: 1..5, tag?: any }
// `preferredSlot` and `tag` are optional extras used only by Simulation mode.

import { CONFIG } from "./config.js";

// MediaPipe pose landmark indices
export const LM = {
  NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16, L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26,
};
const MOTION_JOINTS = [15, 16, 13, 14, 23, 24, 25, 26]; // wrists, elbows, hips, knees

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => clamp(v, 0, 1);
const vis = (l) => (l && l.visibility !== undefined ? l.visibility : 1);

// ---- pure functions -------------------------------------------------------------------------

/** Distance between the shoulders in normalised image-width units (landmarks 11 / 12). */
export function shoulderWidth(lm, aspect = CONFIG.ASPECT) {
  const a = lm[LM.L_SHOULDER], b = lm[LM.R_SHOULDER];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, (a.y - b.y) / aspect);
}

/** Mean landmark visibility of a pose. */
export function averageVisibility(lm) {
  if (!lm.length) return 0;
  let s = 0;
  for (const l of lm) s += vis(l);
  return s / lm.length;
}

/**
 * Greedy nearest-neighbour matching of detections to existing people on (x, closeness).
 * existing / detections: arrays of { x, closeness }.
 * Returns { pairs: [[existingIndex, detectionIndex], …], unmatchedExisting: [i…], unmatchedDetections: [i…] }
 */
export function matchPeople(existing, detections, maxJump = CONFIG.MAX_JUMP) {
  const cands = [];
  for (let e = 0; e < existing.length; e++) {
    for (let d = 0; d < detections.length; d++) {
      const dist = Math.hypot(existing[e].x - detections[d].x, existing[e].closeness - detections[d].closeness);
      if (dist <= maxJump) cands.push({ e, d, dist });
    }
  }
  cands.sort((a, b) => a.dist - b.dist);
  const usedE = new Set(), usedD = new Set(), pairs = [];
  for (const c of cands) {
    if (usedE.has(c.e) || usedD.has(c.d)) continue;
    usedE.add(c.e); usedD.add(c.d); pairs.push([c.e, c.d]);
  }
  return {
    pairs,
    unmatchedExisting: existing.map((_, i) => i).filter((i) => !usedE.has(i)),
    unmatchedDetections: detections.map((_, i) => i).filter((i) => !usedD.has(i)),
  };
}

/**
 * Raw motion energy between two frames: mean displacement of wrists, elbows, hips and knees,
 * divided by shoulder width (so near and far people compare), per second.
 * Result is in "shoulder widths per second"; normalise with normalizeMotion().
 */
export function computeMotion(prev, curr, dt, sw, aspect = CONFIG.ASPECT) {
  if (!prev || !curr || !(dt > 0) || !(sw > 0)) return 0;
  let sum = 0, n = 0;
  for (const j of MOTION_JOINTS) {
    const a = prev[j], b = curr[j];
    if (!a || !b) continue;
    sum += Math.hypot(b.x - a.x, (b.y - a.y) / aspect);
    n++;
  }
  if (!n) return 0;
  return sum / n / sw / dt;
}

/** raw shoulder-widths/s → 0..1 (dead-zone removes tracker jitter). */
export function normalizeMotion(raw, cfg = CONFIG) {
  return clamp01((raw - (cfg.MOTION_DEADZONE || 0)) / cfg.MOTION_MAX);
}

/** closeness 0..1 → volume band 25 / 50 / 75 / 100 (percent). Optional hysteresis around edges. */
export function closenessToBand(closeness, bands = CONFIG.BANDS, prevBand = null, hysteresis = 0) {
  const n = bands.length;
  const pct = bands.map((b) => Math.round(b * 100));
  let idx = clamp(Math.floor(clamp01(closeness) * n), 0, n - 1);
  if (prevBand != null && hysteresis > 0) {
    const pi = pct.indexOf(prevBand);
    if (pi >= 0 && Math.abs(pi - idx) === 1) {
      const edge = pi < idx ? pi + 1 : pi;          // boundary between the two bands
      if (Math.abs(clamp01(closeness) * n - edge) < hysteresis * n) idx = pi;
    }
  }
  return pct[idx];
}

/** Either wrist above the average shoulder height by more than `margin` (normalised y, y grows downward). */
export function isArmsUp(lm, margin = CONFIG.ARMS_UP_MARGIN) {
  const ls = lm[LM.L_SHOULDER], rs = lm[LM.R_SHOULDER];
  if (!ls || !rs) return false;
  const shoulderY = (ls.y + rs.y) / 2;
  for (const w of [lm[LM.L_WRIST], lm[LM.R_WRIST]]) {
    if (w && vis(w) >= 0.3 && w.y < shoulderY - margin) return true;
  }
  return false;
}

/**
 * The ring state machine. state = { hold, closed, lost }.
 * The ring closes after everybody (≥ RING_MIN_PEOPLE people) has moved for RING_HOLD seconds, and
 * opens again once that has not been true for RING_GRACE seconds.
 */
export function checkRing(state, people, dt, cfg = CONFIG) {
  let { hold = 0, closed = false, lost = 0 } = state || {};
  const all = people.length >= cfg.RING_MIN_PEOPLE && people.every((p) => p.moving);
  if (all) {
    lost = 0;
    hold += dt;
    if (hold >= cfg.RING_HOLD) closed = true;
  } else if (closed) {
    lost += dt;
    if (lost > (cfg.RING_GRACE || 0)) { closed = false; hold = 0; lost = 0; }
  } else {
    hold = 0; lost = 0;
  }
  return { hold, closed, lost };
}

/**
 * Pairs of people standing next to each other (neighbours in left→right order, horizontal gap small).
 * prevPairs (array of [a, b]) gives hysteresis: an existing pair only breaks above dist * release.
 * Returns an array of [slotA, slotB] with slotA < slotB.
 */
export function computeHandPairs(people, prevPairs = [], dist = CONFIG.HAND_DISTANCE, release = CONFIG.HAND_RELEASE) {
  const sorted = [...people].sort((a, b) => a.x - b.x);
  const had = new Set(prevPairs.map(([a, b]) => `${a}-${b}`));
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const lo = Math.min(a.slot, b.slot), hi = Math.max(a.slot, b.slot);
    const limit = had.has(`${lo}-${hi}`) ? dist * release : dist;
    if (Math.abs(b.x - a.x) < limit) out.push([lo, hi]);
  }
  return out;
}

/** Position + closeness (+ shoulder width) of one raw pose. Mirrors x like a mirror. */
export function poseFeatures(lm, cfg = CONFIG) {
  const lh = lm[LM.L_HIP], rh = lm[LM.R_HIP], ls = lm[LM.L_SHOULDER], rs = lm[LM.R_SHOULDER];
  let xRaw;
  if (lh && rh && vis(lh) >= 0.3 && vis(rh) >= 0.3) xRaw = (lh.x + rh.x) / 2;
  else xRaw = (ls.x + rs.x) / 2;
  const sw = shoulderWidth(lm, cfg.ASPECT);
  const closeness = clamp01((sw - cfg.CLOSE_MIN) / (cfg.CLOSE_MAX - cfg.CLOSE_MIN));
  return { x: clamp01(1 - xRaw), closeness, sw };
}

// ---- the tracker (stateful wrapper around the pure functions) ------------------------------

const emptyGroup = () => ({
  count: 0, avgMotion: 0, allMoving: false, ringClosed: false, ringProgress: 0, handPairs: [],
});

export class PeopleTracker {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.tracked = [];
    this.ringState = { hold: 0, closed: false, lost: 0 };
    this.pairs = [];
    this.lastNow = null;
    this.group = emptyGroup();
  }

  get people() { return [...this.tracked].sort((a, b) => a.slot - b.slot); }

  /**
   * detections: array of detections for a NEW video frame, or null if there is nothing new
   * (timers keep running). now: seconds, monotonic.
   */
  update(detections, now) {
    const dt = this.lastNow == null ? 0 : clamp(now - this.lastNow, 0, 0.1);
    this.lastNow = now;
    if (detections) this._ingest(detections, now);
    this.tracked = this.tracked.filter((p) => now - p.lastSeen <= this.cfg.LEAVE_TIMEOUT);
    this._derive(now, dt);
    return { people: this.people, group: this.group };
  }

  _freeSlot(preferred) {
    const used = new Set(this.tracked.map((p) => p.slot));
    if (preferred >= 1 && preferred <= this.cfg.MAX_PEOPLE && !used.has(preferred)) return preferred;
    for (let s = 1; s <= this.cfg.MAX_PEOPLE; s++) if (!used.has(s)) return s;
    return 0;
  }

  _ingest(detections, now) {
    const cfg = this.cfg;
    const feats = [];
    for (const det of detections) {
      const lm = det.landmarks;
      if (!lm || lm.length < 29) continue;
      if (averageVisibility(lm) < cfg.MIN_VISIBILITY) continue;
      feats.push({ ...poseFeatures(lm, cfg), det, lm });
    }
    const m = matchPeople(this.tracked, feats, cfg.MAX_JUMP);

    for (const p of this.tracked) p.seen = false;

    for (const [ei, di] of m.pairs) {
      const p = this.tracked[ei], f = feats[di];
      const dtm = now - p._prevT;
      const a = frameAlpha(cfg.POS_SMOOTHING, dtm);
      p.x += (f.x - p.x) * a;
      p.closeness += (f.closeness - p.closeness) * a;
      if (dtm > 0 && dtm < 0.5) {
        const raw = computeMotion(p._prev, f.lm, dtm, f.sw, cfg.ASPECT);
        const inst = normalizeMotion(Math.min(raw, cfg.MOTION_MAX * 3), cfg);
        p.motion += (inst - p.motion) * frameAlpha(cfg.MOTION_SMOOTHING, dtm);
      }
      p.armsUp = p.armsUp ? isArmsUp(f.lm, -cfg.ARMS_UP_MARGIN * 0.5) : isArmsUp(f.lm, cfg.ARMS_UP_MARGIN);
      p.shoulderWidth = f.sw;
      p.landmarks = f.lm;
      p.tag = f.det.tag;
      p.lastSeen = now;
      p.seen = true;
      p._prev = f.lm;
      p._prevT = now;
    }

    for (const di of m.unmatchedDetections) {
      const f = feats[di];
      const slot = this._freeSlot(f.det.preferredSlot);
      if (!slot) continue;
      this.tracked.push({
        slot, x: f.x, closeness: f.closeness,
        band: closenessToBand(f.closeness, cfg.BANDS),
        motion: 0, moving: false, stillFor: 0,
        armsUp: isArmsUp(f.lm, cfg.ARMS_UP_MARGIN),
        lastSeen: now,
        // extras
        shoulderWidth: f.sw, landmarks: f.lm, tag: f.det.tag, seen: true, joinedAt: now,
        _prev: f.lm, _prevT: now, _lastMoving: now,
      });
    }
  }

  _derive(now, dt) {
    const cfg = this.cfg;
    for (const p of this.tracked) {
      if (!p.moving && p.motion > cfg.MOVE_THRESHOLD) p.moving = true;
      else if (p.moving && p.motion < cfg.MOVE_THRESHOLD * 0.6) p.moving = false;
      if (p.moving) p._lastMoving = now;
      p.stillFor = p.moving ? 0 : now - p._lastMoving;
      p.band = closenessToBand(p.closeness, cfg.BANDS, p.band, cfg.BAND_HYSTERESIS);
    }
    const people = this.tracked;
    const count = people.length;
    this.ringState = checkRing(this.ringState, people, dt, cfg);
    this.pairs = computeHandPairs(people, this.pairs, cfg.HAND_DISTANCE, cfg.HAND_RELEASE);
    this.group = {
      count,
      avgMotion: count ? people.reduce((s, p) => s + p.motion, 0) / count : 0,
      allMoving: count > 0 && people.every((p) => p.moving),
      ringClosed: this.ringState.closed,
      ringProgress: this.ringState.closed ? 1 : clamp01(this.ringState.hold / cfg.RING_HOLD),
      handPairs: this.pairs,
    };
  }
}

/** Convert a per-1/60-second smoothing factor to the factor for an arbitrary time step. */
function frameAlpha(perFrame, dt) {
  const frames = clamp((dt || 0) * 60, 0.25, 30);
  return 1 - Math.pow(1 - clamp(perFrame, 0, 1), frames);
}
