// visuals.js — the painting / ring, the people overlays and the debug panel (spec §10).
// Reads only the `people` + `group` objects from people.js (plus a few extras passed by main.js).

import { CONFIG } from "./config.js";
import { simArea, simToScreen } from "./simulate.js";

const TAU = Math.PI * 2;
const STEP = TAU / 5;
const GAP_ANGLE = (-150 * Math.PI) / 180;      // the gap between dancer 5 and dancer 1 (top left)

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (h1, h2, t) => {
  const a = hex(h1), b = hex(h2);
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
};
const rgba = (h, a) => { const c = hex(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

export class Visuals {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.w = 0; this.h = 0; this.dpr = 1;
    this.bg = null;
    this.ringLevel = 0;             // visual ring amount 0..1 (eased)
    this.linkJoin = [0, 0, 0, 0, 0];
    this.linkRaise = [0, 0, 0, 0, 0];
    this.pairAlpha = new Map();
    this.closedText = 0;            // seconds of "The circle is closed" still to show
    this.closedShown = false;
    this.wasClosed = false;
    this.sat = typeof this.ctx.filter === "string";
    const img = new Image();
    img.onload = () => { this.bg = img; };
    img.src = "assets/dance.jpg";   // optional; silently ignored if missing
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px"; this.canvas.style.height = h + "px";
    this.dpr = dpr; this.w = w; this.h = h;
  }

  // ---- main entry --------------------------------------------------------------------------------
  draw(people, group, ex) {
    const ctx = this.ctx, w = this.w, h = this.h, dt = Math.min(0.1, ex.dt || 0.016);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // ring amount (eases in over ~1 s, out over ~2 s) and the one-time text
    const target = group.ringClosed ? 1 : 0;
    this.ringLevel += (target - this.ringLevel) * Math.min(1, dt * (target > this.ringLevel ? 2.5 : 1.4));
    if (this.ringLevel < 0.002) this.ringLevel = 0;
    if (group.ringClosed && !this.wasClosed && !this.closedShown) { this.closedShown = true; this.closedText = 3.4; }
    this.wasClosed = group.ringClosed;
    this.closedText = Math.max(0, this.closedText - dt);

    this._background(w, h);
    const L = this._layout(w, h);
    this._ring(people, group, ex, L, dt);
    if (ex.mode === "webcam") this._preview(people, ex, w, h);
    else this._simOverlay(people, ex, w, h);
    this._closedText(L);
  }

  // ---- background ---------------------------------------------------------------------------------
  _background(w, h) {
    const ctx = this.ctx, r = this.ringLevel;
    if (this.bg) {
      if (this.sat) ctx.filter = `saturate(${(1 + 0.8 * r).toFixed(2)}) brightness(${(1 + 0.08 * r).toFixed(2)})`;
      const iw = this.bg.naturalWidth, ih = this.bg.naturalHeight;
      const s = Math.max(w / iw, h / ih);
      ctx.drawImage(this.bg, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
      if (this.sat) ctx.filter = "none";
    } else {
      const split = h * 0.55;
      let g = ctx.createLinearGradient(0, 0, 0, split);
      g.addColorStop(0, mix("#1c2f73", "#0a2fd0", r));
      g.addColorStop(1, mix("#27479a", "#1f5cf0", r));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, split + 1);
      g = ctx.createLinearGradient(0, split, 0, h);
      g.addColorStop(0, mix("#2d7a4d", "#08b052", r));
      g.addColorStop(1, mix("#1b5a37", "#03823a", r));
      ctx.fillStyle = g; ctx.fillRect(0, split, w, h - split);
    }
    if (r > 0) {
      const g = ctx.createRadialGradient(w / 2, h * 0.40, 0, w / 2, h * 0.40, Math.max(w, h) * 0.6);
      g.addColorStop(0, `rgba(255,236,170,${0.38 * r})`);
      g.addColorStop(1, "rgba(255,236,170,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
  }

  // ---- geometry --------------------------------------------------------------------------------------
  _layout(w, h) {
    const cx = w * 0.5, cy = h * 0.40, rx = Math.min(w * 0.30, h * 0.60), ry = h * 0.13, u = h * 0.028;
    const at = (theta) => {
      const depth = (Math.sin(theta) + 1) / 2;
      return { x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta), depth, k: 0.78 + 0.34 * depth, theta };
    };
    const dancers = [];
    for (let i = 0; i < 5; i++) dancers.push({ i, ...at(GAP_ANGLE + (i + 0.5) * STEP) });
    const links = [];
    for (let i = 0; i < 5; i++) links.push(at(GAP_ANGLE + (i + 0.5) * STEP + STEP / 2));
    return { cx, cy, rx, ry, u, at, dancers, links };
  }

  // ---- the ring of dancers ---------------------------------------------------------------------------
  _ring(people, group, ex, L, dt) {
    const ctx = this.ctx, u = L.u, r = this.ringLevel;
    const bySlot = (s) => people.find((p) => p.slot === s) || null;
    const present = [0, 1, 2, 3, 4].map((i) => bySlot(i + 1));
    const beat = ex.beat || 0, beatFrac = beat - Math.floor(beat);
    const pulse = Math.pow(1 - beatFrac, 2);

    // link state (hands between neighbouring dancers); the 5→1 gap only closes with the ring
    for (let i = 0; i < 5; i++) {
      const a = present[i], b = present[(i + 1) % 5];
      const base = i < 4 && a && b ? 1 : 0;
      const t = Math.max(base, r);
      this.linkJoin[i] += (t - this.linkJoin[i]) * Math.min(1, dt * 6);
      const raise = (a && a.armsUp) || (b && b.armsUp) ? 1 : 0;
      this.linkRaise[i] += (raise - this.linkRaise[i]) * Math.min(1, dt * 7);
    }

    // hand pairs of people standing next to each other
    const keys = new Set(group.handPairs.map(([a, b]) => `${a}-${b}`));
    for (const k of keys) if (!this.pairAlpha.has(k)) this.pairAlpha.set(k, 0);
    for (const [k, a] of this.pairAlpha) {
      const na = a + ((keys.has(k) ? 1 : 0) - a) * Math.min(1, dt * 5);
      if (na < 0.01 && !keys.has(k)) this.pairAlpha.delete(k); else this.pairAlpha.set(k, na);
    }

    // glow halos behind everything (ring closed)
    if (r > 0.01) {
      ctx.save();
      ctx.strokeStyle = `rgba(255,244,200,${0.35 * r})`;
      ctx.lineWidth = u * 2.2;
      ctx.beginPath();
      ctx.ellipse(L.cx, L.cy, L.rx, L.ry, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    const order = [...L.dancers].sort((a, b) => a.y - b.y);
    for (const d of order) this._dancer(d, present[d.i], L, ex, group, pulse, beat);
    this._pairArcs(group, L, u);
  }

  _dancer(d, person, L, ex, group, pulse, beat) {
    const ctx = this.ctx, u = L.u, r = this.ringLevel, i = d.i;
    const cfg = CONFIG.SLOTS[i];
    const now = ex.now || 0;
    const motion = person && person.moving ? Math.max(0.35, person.motion) : 0;
    const gain = person ? (ex.gains ? ex.gains[i] : 0.7) : 0;
    const ghost = !person && r > 0.01;
    const alpha = person ? 1 : ghost ? 0.55 * r : 1;

    // scale pulses with the slot's gain on every beat; sway when moving
    const ph = now * TAU * 1.6 + i * 1.7;
    const k = d.k * (1 + 0.13 * gain * pulse);
    const U = u * k;
    const sway = Math.sin(ph) * 0.45 * U * motion;
    const bounce = -Math.abs(Math.sin(ph)) * 0.3 * U * motion;
    const ax = d.x + sway, ay = d.y + bounce;               // torso centre
    const swing = Math.sin(ph) * 0.55 * motion;

    const colour = cfg.colour;
    const fill = person ? colour : ghost ? colour : null;
    const outline = person || ghost ? "rgba(18,18,40,0.75)" : "rgba(220,225,235,0.38)";

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (!person && !ghost) ctx.setLineDash([U * 0.5, U * 0.4]);
    if (r > 0.01 && (person || ghost)) { ctx.shadowColor = colour; ctx.shadowBlur = 28 * r * k; }

    // legs
    ctx.strokeStyle = fill || outline; ctx.lineWidth = fill ? U * 0.95 : U * 0.16;
    for (const s of [-1, 1]) {
      const kneeX = ax + s * 0.5 * U + s * swing * U * 0.5;
      ctx.beginPath();
      ctx.moveTo(ax + s * 0.45 * U, ay + 2.0 * U);
      ctx.lineTo(kneeX, ay + 3.7 * U);
      ctx.lineTo(kneeX - s * 0.2 * U + swing * U * s, ay + 5.4 * U);
      ctx.stroke();
    }
    // arms (towards the neighbours; joined where hands meet)
    this._arms(d, person, L, ax, ay, U, fill, outline, swing, ex);
    // body
    ctx.beginPath();
    ctx.roundRect(ax - 0.95 * U, ay - 1.9 * U, 1.9 * U, 4.2 * U, 0.95 * U);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.lineWidth = U * 0.16; ctx.strokeStyle = outline; ctx.stroke();
    // head
    ctx.beginPath();
    ctx.arc(ax + sway * 0.3, ay - 3.1 * U, 1.0 * U, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.stroke();
    ctx.restore();

    // instrument name above the head
    ctx.save();
    ctx.globalAlpha = person ? 0.95 : 0.4 + 0.3 * r;
    ctx.font = `600 ${Math.max(11, U * 0.85)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 4;
    ctx.fillText(cfg.name, ax, ay - 4.4 * U - (person && person.armsUp ? 1.2 * U : 0));
    ctx.restore();
  }

  _arms(d, person, L, ax, ay, U, fill, outline, swing, ex) {
    const ctx = this.ctx, i = d.i;
    const showArms = !!person || this.ringLevel > 0.01;
    if (!showArms) return;
    const nextSide = -Math.sin(d.theta) >= 0 ? 1 : -1;
    const sides = [
      { link: i, side: nextSide },                       // towards the next dancer
      { link: (i + 4) % 5, side: -nextSide },            // towards the previous dancer
    ];
    ctx.strokeStyle = fill || outline;
    for (const s of sides) {
      const j = this.linkJoin[s.link], raise = this.linkRaise[s.link];
      const lm = L.links[s.link];
      const Ul = L.u * lm.k;
      const M = { x: lm.x, y: lm.y - 0.6 * Ul - raise * 1.7 * Ul };
      const S = { x: ax + s.side * 0.85 * U, y: ay - 1.4 * U };
      let dang;
      if (person && person.armsUp) dang = { x: S.x + s.side * 0.7 * U, y: S.y - 2.2 * U };
      else dang = { x: S.x + (M.x - S.x) * 0.42, y: S.y + (M.y - S.y) * 0.42 + 1.4 * U + swing * U * 0.4 };
      const hand = { x: lerp(dang.x, M.x, j), y: lerp(dang.y, M.y, j) };
      const elbow = { x: lerp(S.x, hand.x, 0.5) + s.side * 0.15 * U, y: lerp(S.y, hand.y, 0.5) + 0.45 * U };
      ctx.lineWidth = U * 0.8;
      ctx.beginPath(); ctx.moveTo(S.x, S.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
      if (j > 0.92 && (person || this.ringLevel > 0.3)) {           // the clasp
        ctx.save();
        ctx.fillStyle = "rgba(255,250,225,0.95)";
        ctx.beginPath(); ctx.arc(hand.x, hand.y, U * 0.42, 0, TAU); ctx.fill();
        ctx.restore();
      }
    }
  }

  _pairArcs(group, L, u) {
    const ctx = this.ctx;
    for (const [key, alpha] of this.pairAlpha) {
      const [a, b] = key.split("-").map(Number);
      const da = L.dancers[a - 1], db = L.dancers[b - 1];
      const ca = CONFIG.SLOTS[a - 1].colour, cb = CONFIG.SLOTS[b - 1].colour;
      const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 260);
      ctx.save();
      ctx.globalAlpha = alpha * pulse;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      const grad = ctx.createLinearGradient(da.x, da.y, db.x, db.y);
      grad.addColorStop(0, ca); grad.addColorStop(1, cb);
      ctx.strokeStyle = grad;
      ctx.shadowColor = "rgba(255,255,255,0.9)"; ctx.shadowBlur = 14;
      ctx.lineWidth = u * 0.55;
      ctx.beginPath();
      if (b - a <= 2) {                         // along the ring, never across the gap
        const t0 = GAP_ANGLE + (a - 0.5) * STEP, t1 = GAP_ANGLE + (b - 0.5) * STEP;
        const n = 24;
        for (let s = 0; s <= n; s++) {
          const p = L.at(lerp(t0, t1, s / n));
          const x = p.x, y = p.y - 0.55 * u * p.k - 1.1 * u * p.k * Math.sin(Math.PI * s / n);
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {                                  // far apart in the ring: a curve through the middle
        ctx.moveTo(da.x, da.y - 1.6 * u * da.k);
        ctx.quadraticCurveTo(L.cx, L.cy - 4 * u, db.x, db.y - 1.6 * u * db.k);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  _closedText(L) {
    if (this.closedText <= 0) return;
    const ctx = this.ctx, t = this.closedText;
    const a = Math.min(1, t / 0.8, (3.4 - t) / 0.5);
    ctx.save();
    ctx.globalAlpha = clamp01(a);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `italic 600 ${Math.max(26, this.h * 0.06)}px Georgia, 'Times New Roman', serif`;
    ctx.shadowColor = "rgba(255,200,80,0.9)"; ctx.shadowBlur = 24;
    ctx.fillStyle = "#fff8e0";
    ctx.fillText("The circle is closed", L.cx, this.h * 0.105);
    ctx.restore();
  }

  // ---- Webcam overlay ------------------------------------------------------------------------------
  _preview(people, ex, w, h) {
    const video = ex.video;
    if (!video || !video.videoWidth) return;
    const ctx = this.ctx;
    const pw = Math.min(380, w * 0.3), ph = pw / (video.videoWidth / video.videoHeight);
    const px = w - pw - 16, py = 16;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8);
    ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
    ctx.translate(px + pw, py); ctx.scale(-1, 1);            // mirrored, like a mirror
    ctx.globalAlpha = 0.85;
    ctx.drawImage(video, 0, 0, pw, ph);
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
    for (const p of people) {
      const lm = p.landmarks;
      if (!lm) continue;
      const c = CONFIG.SLOTS[p.slot - 1];
      ctx.fillStyle = c.colour;
      ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1;
      for (let i = 0; i < lm.length; i++) {
        if (i > 0 && i < 11) continue;                        // face dots clutter the picture
        const x = px + (1 - lm[i].x) * pw, y = py + lm[i].y * ph;
        ctx.beginPath(); ctx.arc(x, y, i === 0 ? 5 : 3.2, 0, TAU); ctx.fill(); ctx.stroke();
      }
      const nose = lm[0];
      const nx = px + (1 - nose.x) * pw, ny = py + nose.y * ph;
      ctx.font = "600 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      const label = c.name + (p.seen ? "" : " …");
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(nx - tw / 2, ny - 34, tw, 18);
      ctx.fillStyle = c.colour; ctx.fillText(label, nx, ny - 20);
    }
    ctx.restore();
    if (!people.length) {
      ctx.save();
      ctx.font = "13px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.textAlign = "center";
      ctx.fillText("Step in front of the camera", px + pw / 2, py + ph + 22);
      ctx.restore();
    }
  }

  // ---- Simulation overlay ---------------------------------------------------------------------------
  _simOverlay(people, ex, w, h) {
    const ctx = this.ctx, a = simArea(w, h);
    ctx.save();
    ctx.fillStyle = "rgba(8,10,24,0.38)";
    ctx.beginPath(); ctx.roundRect(a.left - 10, a.top - 26, a.right - a.left + 20, a.bottom - a.top + 36, 14); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
    // closeness band guide lines
    for (let b = 1; b < 4; b++) {
      const y = a.bottom - (b / 4) * (a.bottom - a.top);
      ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.textAlign = "left";
    ctx.fillText("SIMULATION — drag people: ← → pan, ↑ closer (volume) · Space = all dance", a.left, a.top - 10);
    ctx.textAlign = "right";
    ctx.fillText("near 100%", a.right, a.top + 12);
    ctx.fillText("far 25%", a.right, a.bottom - 6);
    ctx.restore();

    const now = (ex.now || 0);
    for (const sp of ex.simView || []) {
      const person = people.find((p) => p.tag === sp.id);
      const cfg = person ? CONFIG.SLOTS[person.slot - 1] : { colour: "#888", name: "…" };
      const s = simToScreen(sp, w, h);
      ctx.save();
      // shadow on the floor
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(s.x, s.y + s.r * 0.95, s.r * 0.9, s.r * 0.25, 0, 0, TAU); ctx.fill();
      // arms up
      if (sp.armsUp) {
        ctx.strokeStyle = cfg.colour; ctx.lineWidth = Math.max(3, s.r * 0.22); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(s.x - s.r * 0.7, s.y - s.r * 0.2); ctx.lineTo(s.x - s.r * 1.0, s.y - s.r * 1.5);
        ctx.moveTo(s.x + s.r * 0.7, s.y - s.r * 0.2); ctx.lineTo(s.x + s.r * 1.0, s.y - s.r * 1.5); ctx.stroke();
      }
      const bob = sp.dancing ? Math.sin(now * 10 + sp.id) * s.r * 0.08 : 0;
      ctx.beginPath(); ctx.arc(s.x, s.y + bob, s.r, 0, TAU);
      ctx.fillStyle = cfg.colour; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = sp.dragging ? 4 : 2; ctx.strokeStyle = sp.dragging ? "#fff" : "rgba(10,10,30,0.7)"; ctx.stroke();
      if (sp.dancing) {
        ctx.setLineDash([5, 5]); ctx.lineDashOffset = -now * 30; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y + bob, s.r + 6, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.fillStyle = "#101020"; ctx.font = `700 ${Math.max(12, s.r * 0.7)}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(sp.id), s.x, s.y + bob);
      ctx.font = "600 12px system-ui, sans-serif"; ctx.textBaseline = "bottom";
      ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 4;
      ctx.fillText(`${cfg.name}${person ? " · " + person.band + "%" : ""}`, s.x, s.y - s.r - (sp.armsUp ? s.r * 1.4 : 6));
      ctx.restore();
    }
  }
}

// ------------------------------------------------------------------------------------------------------
// Debug panel (toggle with D). DOM based, refreshed ~5×/s.

export class DebugPanel {
  constructor(el) { this.el = el; this.visible = false; this.last = 0; this.fps = 60; }
  toggle() { this.visible = !this.visible; this.el.hidden = !this.visible; return this.visible; }

  update(people, group, ex, nowMs) {
    this.fps += ((1 / Math.max(0.001, ex.dt || 0.016)) - this.fps) * 0.05;
    if (!this.visible || nowMs - this.last < 200) return;
    this.last = nowMs;
    const m = ex.music;
    const ring = group.ringClosed ? "<b style='color:#ffd35a'>CLOSED</b>" : group.ringProgress > 0 ? `charging ${(group.ringProgress * 100) | 0}%` : "open";
    let html = `<div class="dbg-head">FPS <b>${this.fps.toFixed(0)}</b> · people <b>${group.count}</b> · mode <b>${ex.mode}</b> · BPM <b>${CONFIG.BPM}</b> · ring: ${ring}</div>`;
    html += `<div class="dbg-sub">avg motion ${group.avgMotion.toFixed(2)} · all moving ${group.allMoving} · hand pairs ${group.handPairs.map((p) => p.join("+")).join(", ") || "–"}</div>`;
    html += `<div class="dbg-sub">MIDI: ${ex.midiStatus || "–"}</div>`;
    if (ex.mode === "webcam") html += `<div class="dbg-sub">tracker: ${ex.trackerInfo || "–"} · aspect ${CONFIG.ASPECT.toFixed(2)}</div>`;
    if (m) html += `<div class="dbg-sub">audio ${m.contextState} · reverb wet ${m.reverbWet.toFixed(2)} · pad ${m.padLevel.toFixed(2)} · chimes ${m.chimes}</div>`;
    html += `<table><tr><th>slot</th><th>instrument</th><th>x</th><th>shoulder</th><th>close</th><th>band</th><th>motion</th><th>mov</th><th>arms</th><th>still</th><th>gain</th></tr>`;
    for (const p of people) {
      const c = CONFIG.SLOTS[p.slot - 1];
      const s = m ? m.slots[p.slot - 1] : null;
      html += `<tr><td style="color:${c.colour}">●${p.slot}</td><td>${c.name}</td><td>${p.x.toFixed(2)}</td><td>${(p.shoulderWidth || 0).toFixed(3)}</td>`
        + `<td>${p.closeness.toFixed(2)}</td><td>${p.band}%</td>`
        + `<td><span class="bar"><i style="width:${(p.motion * 100).toFixed(0)}%"></i></span> ${p.motion.toFixed(2)}</td>`
        + `<td>${p.moving ? "yes" : "no"}</td><td>${p.armsUp ? "UP" : "–"}</td><td>${p.stillFor.toFixed(1)}s</td>`
        + `<td>${s ? s.target.toFixed(2) : "–"}</td></tr>`;
    }
    if (!people.length) html += `<tr><td colspan="11" style="opacity:.6">nobody tracked</td></tr>`;
    html += `</table>`;
    this.el.innerHTML = html;
  }
}
