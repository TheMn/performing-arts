// simulate.js — Simulation mode (spec §9). No webcam needed.
// It fabricates full 33-point MediaPipe-style poses for the simulated people, so the SAME
// people.js code path (matching, closeness, motion, arms-up, ring…) runs as with the webcam.

import { CONFIG } from "./config.js";
import { clamp, clamp01 } from "./people.js";

const ASPECT = 16 / 9;
const DANCE_HZ = 1.6;

/** Bottom strip of the canvas where simulated people stand. */
export function simArea(w, h) {
  return { left: w * 0.04, right: w * 0.96, top: h * 0.76, bottom: h * 0.965 };
}
/** Screen position + radius of a simulated person. */
export function simToScreen(p, w, h) {
  const a = simArea(w, h);
  return { x: a.left + p.x * (a.right - a.left), y: a.bottom - p.closeness * (a.bottom - a.top), r: Math.max(14, h * (0.022 + 0.03 * p.closeness)) };
}

export class Simulation {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.people = new Map();     // id (1..5) → state
    this.spaceDown = false;
    this.dragId = null;
    this.hoverId = null;
    this.pointer = { x: -1, y: -1 };
    this.t = 0;
  }

  has(id) { return this.people.has(id); }

  /** Key 1–5: add or remove simulated person `id`. */
  toggle(id) {
    if (this.people.has(id)) { this.people.delete(id); if (this.dragId === id) this.dragId = null; return false; }
    const x = 0.1 + 0.8 * (id - 1) / 4;
    this.people.set(id, {
      id, x, closeness: 0.62, tx: x, tc: 0.62, sticky: false, amp: 0, armsT: 0, armsOn: false, phase: id * 1.3,
    });
    return true;
  }

  toggleSticky(id) { const p = this.people.get(id); if (p) p.sticky = !p.sticky; return p ? p.sticky : null; }
  toggleArms(id) { const p = this.people.get(id); if (p) p.armsOn = !p.armsOn; return p ? p.armsOn : null; }
  setSpace(down) { this.spaceDown = down; }
  isDancing(p) { return this.spaceDown || p.sticky; }

  // ---- pointer interaction (coordinates in CSS pixels of the canvas) -------------------------
  _hit(px, py, w, h) {
    let best = null, bestD = Infinity;
    for (const p of this.people.values()) {
      const s = simToScreen(p, w, h);
      const d = Math.hypot(px - s.x, py - s.y);
      if (d <= s.r * 1.25 && d < bestD) { best = p.id; bestD = d; }
    }
    return best;
  }
  pointerDown(px, py, w, h) {
    this.pointer = { x: px, y: py };
    const id = this._hit(px, py, w, h);
    this.dragId = id;
    return id !== null;
  }
  pointerMove(px, py, w, h) {
    this.pointer = { x: px, y: py };
    this.hoverId = this._hit(px, py, w, h);
    if (this.dragId !== null) {
      const p = this.people.get(this.dragId);
      if (p) {
        const a = simArea(w, h);
        p.tx = clamp01((px - a.left) / (a.right - a.left));
        p.tc = clamp01((a.bottom - py) / (a.bottom - a.top));
      }
    }
  }
  pointerUp() { this.dragId = null; }
  hovered() { return this.hoverId !== null && this.people.has(this.hoverId) ? this.hoverId : null; }

  // ---- per-frame ---------------------------------------------------------------------------------
  /** Advance the simulation and return raw detections (one pose per simulated person). */
  step(dt) {
    this.t += dt;
    const out = [];
    for (const p of this.people.values()) {
      // dragging eases toward the pointer; the per-frame jump is capped so identity matching
      // (MAX_JUMP) is never fooled by a fast drag
      const cap = this.cfg.MAX_JUMP * 0.6;
      const k = 1 - Math.exp(-dt * 14);
      p.x += clamp((p.tx - p.x) * k, -cap, cap);
      p.closeness += clamp((p.tc - p.closeness) * k, -cap, cap);
      p.amp += ((this.isDancing(p) ? 1 : 0) - p.amp) * (1 - Math.exp(-dt * 12));
      p.armsT += clamp((p.armsOn ? 1 : 0) - p.armsT, -dt / 0.5, dt / 0.5);   // arms take 0.5 s to rise
      out.push({ landmarks: this._landmarks(p), preferredSlot: p.id, tag: p.id });
    }
    return out;
  }

  /** Light-weight description for the overlay. */
  view() {
    return [...this.people.values()].map((p) => ({
      id: p.id, x: p.x, closeness: p.closeness, dancing: this.isDancing(p), sticky: p.sticky,
      armsUp: p.armsOn, dragging: this.dragId === p.id,
    }));
  }

  _landmarks(p) {
    const cfg = this.cfg;
    const sw = cfg.CLOSE_MIN + p.closeness * (cfg.CLOSE_MAX - cfg.CLOSE_MIN);  // inverse of the closeness mapping
    const uy = sw * ASPECT;                       // one shoulder width, in normalised-y units
    const cx = 1 - p.x;                           // raw (unmirrored) image x
    const sy = 0.26 + 0.10 * (1 - p.closeness);   // shoulder line
    const lm = Array.from({ length: 33 }, () => ({ x: cx, y: sy, z: 0, visibility: 1 }));
    const set = (i, dx, dy) => { lm[i] = { x: cx + dx * sw, y: sy + dy * uy, z: 0, visibility: 1 }; };

    const w = 2 * Math.PI * DANCE_HZ * this.t + p.phase;
    const a = p.amp;
    const r = { wrist: 0.27, elbow: 0.16, hip: 0.056, knee: 0.08 };
    const dance = (i, rad, ph) => [a * rad * Math.sin(w + ph), a * rad * Math.cos(w * 1.0 + ph)];
    const up = p.armsT;
    const lerp = (x, y, t) => x + (y - x) * t;

    // head
    set(0, 0, -0.6); set(1, -0.1, -0.7); set(2, -0.2, -0.7); set(3, -0.3, -0.7);
    set(4, 0.1, -0.7); set(5, 0.2, -0.7); set(6, 0.3, -0.7); set(7, -0.4, -0.6); set(8, 0.4, -0.6);
    set(9, -0.12, -0.35); set(10, 0.12, -0.35);
    // shoulders
    set(11, -0.5, 0); set(12, 0.5, 0);
    // elbows (down → raised)
    for (const [i, side, ph] of [[13, -1, 0], [14, 1, Math.PI]]) {
      const [dx, dy] = dance(i, r.elbow, ph);
      set(i, lerp(side * 0.65, side * 0.8, up) + dx, lerp(0.7, -0.35, up) + dy);
    }
    // wrists
    for (const [i, side, ph] of [[15, -1, 0.5], [16, 1, Math.PI + 0.5]]) {
      const [dx, dy] = dance(i, r.wrist, ph);
      set(i, lerp(side * 0.7, side * 0.9, up) + dx, lerp(1.35, -1.1, up) + dy);
    }
    // hands (fingers etc.) follow the wrists
    for (const [i, from] of [[17, 15], [19, 15], [21, 15], [18, 16], [20, 16], [22, 16]]) lm[i] = { ...lm[from] };
    // hips, knees, ankles, feet
    for (const [i, side, ph] of [[23, -1, 1], [24, 1, 1 + Math.PI]]) {
      const [dx, dy] = dance(i, r.hip, ph);
      set(i, side * 0.3 + dx, 1.5 + dy);
    }
    for (const [i, side, ph] of [[25, -1, 2], [26, 1, 2 + Math.PI]]) {
      const [dx, dy] = dance(i, r.knee, ph);
      set(i, side * 0.35 + dx, 2.8 + dy);
    }
    set(27, -0.4, 4.1); set(28, 0.4, 4.1); set(29, -0.42, 4.2); set(30, 0.42, 4.2); set(31, -0.38, 4.3); set(32, 0.38, 4.3);
    return lm;
  }
}
