// music.js — instruments, the shared transport, per-slot control and the ring-close bloom (spec §7).
//
// Design rule: at start-up EVERY part of EVERY slot is scheduled on Tone.Transport (looped) and the
// slot's gain is 0. People only change gain, pan, filter and octave — never which notes come next —
// so the ensemble can never drift out of time.

import { loadTone } from "./vendor.js";
import { CONFIG } from "./config.js";

export const Tone = await loadTone();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  constructor() {
    this.ready = false;
    this.running = false;
    this.slots = [];          // index 0..4
    this.parts = [];
    this.arr = null;
    this.ringFade = 0;        // 0..1, smoothed "bloom" amount
    this.groupAvg = 0;
    this.lastChime = -99;
    this.pairKeys = new Set();
    this.chimes = 0;          // counter (debug / tests)
    this.applied = new Map(); // throttled parameter writes
    this.debugLog = null;     // set to [] to record callback timings (tests)
  }

  // ---- set-up ------------------------------------------------------------------------------------
  async init() {
    await Tone.start();                         // must follow a user gesture
    const T = Tone.getTransport();
    T.bpm.value = CONFIG.BPM;

    // master chain: master gain → reverb → limiter → speakers
    this.master = new Tone.Gain(CONFIG.MASTER_VOLUME);
    this.reverb = new Tone.Reverb({ decay: 3.5, preDelay: 0.02, wet: CONFIG.REVERB_WET });
    if (this.reverb.ready) await this.reverb.ready; else if (this.reverb.generate) await this.reverb.generate();
    this.limiter = new Tone.Limiter(-1);
    this.master.chain(this.reverb, this.limiter, Tone.getDestination());

    CONFIG.SLOTS.forEach((cfg, i) => this.slots.push(this._buildSlot(cfg, i)));

    // shared pulse (soft downbeat for everybody)
    this.pulseSynth = new Tone.Synth({
      oscillator: { type: "sine" }, volume: -14,
      envelope: { attack: 0.02, decay: 0.4, sustain: 0, release: 0.2 },
    });
    this.pulseGain = new Tone.Gain(0);
    this.pulseSynth.chain(this.pulseGain, this.master);

    // hand chime: soft sine pair D6 + A6
    this.chime = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" }, volume: -12,
      envelope: { attack: 0.005, decay: 0.5, sustain: 0, release: 1.0 },
    });
    this.chime.connect(this.master);

    // ring pad: slow-attack sawtooth chord (root + fifth of the bar's bass note)
    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 3, spread: 22 }, volume: -16,
      envelope: { attack: 1.5, decay: 0.6, sustain: 0.85, release: 2.0 },
    });
    this.padFilter = new Tone.Filter({ type: "lowpass", frequency: 1500, rolloff: -12 });
    this.padGain = new Tone.Gain(0);
    this.pad.chain(this.padFilter, this.padGain, this.master);

    this.ready = true;
  }

  _buildSlot(cfg, index) {
    const Ctor = Tone[cfg.synth.type];
    const inst = new Ctor(cfg.synth.options);
    inst.volume.value = cfg.volumeDb;
    const filter = new Tone.Filter({ type: "lowpass", frequency: cfg.filter.base, Q: cfg.filter.q, rolloff: -12 });
    const panner = new Tone.Panner(0);
    const gain = new Tone.Gain(0);
    const s = {
      cfg, index, slot: cfg.slot, inst, filter, panner, gain,
      noise: null, vibrato: null,
      octaveShift: 0, motion: 0, present: false,
      lastTime: -1, lastTimeNoise: -1,
      target: 0, visGain: 0, panValue: 0, cutoff: cfg.filter.base,
    };
    if (cfg.drum) {
      s.noise = new Tone.NoiseSynth(cfg.noise.options);
      s.noise.volume.value = cfg.volumeDb - 8;
      inst.connect(filter);
      s.noise.connect(filter);
      filter.chain(panner, gain, this.master);
    } else if (cfg.vibrato) {
      s.vibrato = new Tone.Vibrato({ frequency: cfg.vibrato.frequency, depth: cfg.vibrato.depth });
      inst.chain(s.vibrato, filter, panner, gain, this.master);
    } else {
      inst.chain(filter, panner, gain, this.master);
    }
    return s;
  }

  // ---- scheduling -----------------------------------------------------------------------------
  /** (Re)schedule every part from an arrangement (see melody.js buildArrangement). */
  setArrangement(arr) {
    const T = Tone.getTransport();
    const wasRunning = this.running;
    if (wasRunning) T.stop();
    for (const p of this.parts) { try { p.stop(0); p.dispose(); } catch (e) { /* ignore */ } }
    this.parts = [];
    for (const s of this.slots) {
      try { s.inst.triggerRelease && s.inst.triggerRelease(); } catch (e) { /* ignore */ }
      s.lastTime = s.lastTimeNoise = -1;
    }
    try { this.pad.releaseAll(); } catch (e) { /* ignore */ }

    this.arr = arr;
    const ppq = T.PPQ;
    const ticks = (beats) => Math.max(0, Math.round(beats * ppq)) + "i";
    const loopEnd = ticks(arr.loopBeats);
    const addPart = (cb, events, tag) => {
      const part = new Tone.Part(cb, events);
      part.loop = true; part.loopStart = 0; part.loopEnd = loopEnd;
      part.start(0);
      part._tag = tag;
      this.parts.push(part);
    };

    // melodic slots 1, 3, 4, 5
    for (const slotNo of [1, 3, 4, 5]) {
      const slot = this.slots[slotNo - 1];
      const events = (arr.parts[slotNo] || []).map((e) => ({ time: ticks(e.t), n: e.n, d: e.d, v: e.v, tick: Math.round(e.t * ppq) }));
      addPart((time, ev) => this._playMelodic(slot, time, ev), events, `slot${slotNo}`);
    }

    // drum (slot 2): generated from the bar structure
    const drum = this.slots[1];
    const dEvents = [];
    const bpb = arr.beatsPerBar;
    for (let bar = 0; bar < arr.bars; bar++) {
      const base = bar * bpb;
      for (let b = 0; b < Math.floor(bpb + 1e-6); b++) {
        const t = base + b;
        dEvents.push({ time: ticks(t), kind: b === 0 ? "low" : "light", tick: Math.round(t * ppq) });
        dEvents.push({ time: ticks(t + 0.5), kind: "off", tick: Math.round((t + 0.5) * ppq) });
        dEvents.push({ time: ticks(t + 0.25), kind: "fill", tick: Math.round((t + 0.25) * ppq) });
        dEvents.push({ time: ticks(t + 0.75), kind: b === Math.floor(bpb + 1e-6) - 1 ? "tom" : "fill", tick: Math.round((t + 0.75) * ppq) });
      }
    }
    addPart((time, ev) => this._playDrum(drum, time, ev), dEvents, "drum");

    // shared pulse on every downbeat
    const pEvents = [];
    for (let bar = 0; bar < arr.bars; bar++) pEvents.push({ time: ticks(bar * bpb), tick: Math.round(bar * bpb * ppq) });
    addPart((time) => {
      try { this.pulseSynth.triggerAttackRelease("D3", 0.5, time, 0.7); } catch (e) { /* time clash */ }
    }, pEvents, "pulse");

    // pad chords: merge consecutive bars that share a root
    const chords = [];
    arr.roots.forEach((root, bar) => {
      const last = chords[chords.length - 1];
      if (last && last.root % 12 === root % 12) last.bars++;
      else chords.push({ root, bar, bars: 1 });
    });
    const padEvents = chords.map((c) => ({
      time: ticks(c.bar * bpb), root: c.root, d: c.bars * bpb, tick: Math.round(c.bar * bpb * ppq),
    }));
    addPart((time, ev) => this._playPad(time, ev), padEvents, "pad");

    if (wasRunning) T.start("+0.1");
  }

  start() {
    if (!this.ready) return;
    this.running = true;
    Tone.getTransport().start("+0.1");
  }

  // ---- note callbacks ---------------------------------------------------------------------------
  _log(tag, time, ev) {
    if (this.debugLog) {
      const T = Tone.getTransport();
      this.debugLog.push({ tag, time, tick: T.getTicksAtTime(time), expected: ev.tick });
    }
  }

  _beatsToSeconds(beats) { return (beats * 60) / Tone.getTransport().bpm.value; }

  _playMelodic(slot, time, ev) {
    if (time <= slot.lastTime) return;
    slot.lastTime = time;
    this._log(`slot${slot.slot}`, time, ev);
    const midi = ev.n + slot.octaveShift;
    const dur = Math.max(0.06, this._beatsToSeconds(ev.d) * 0.96);
    const vel = clamp((ev.v || 0.8) * (0.55 + 0.45 * slot.motion), 0.05, 1);
    try { slot.inst.triggerAttackRelease(midiToHz(midi), dur, time, vel); } catch (e) { /* ignore */ }
  }

  _playDrum(slot, time, ev) {
    this._log("drum", time, ev);
    const m = slot.motion;
    const fillOn = m > CONFIG.FILL_THRESHOLD;
    if ((ev.kind === "fill" || ev.kind === "tom") && !fillOn) return;
    const energy = Math.max(m, 0.6 * this.groupAvg);       // group energy lifts the drum even for a still drummer
    const k = 0.5 + 0.5 * energy;
    try {
      if (ev.kind === "low" || ev.kind === "light" || ev.kind === "tom") {
        if (time <= slot.lastTime) return;
        slot.lastTime = time;
        const note = ev.kind === "low" ? "D2" : ev.kind === "tom" ? "A2" : "D3";
        const vel = clamp((ev.kind === "low" ? 1.0 : ev.kind === "tom" ? 0.7 : 0.5) * k, 0.05, 1);
        slot.inst.triggerAttackRelease(note, "16n", time, vel);
      } else {
        if (time <= slot.lastTimeNoise) return;
        slot.lastTimeNoise = time;
        const vel = clamp((ev.kind === "off" ? 0.55 : 0.4) * k, 0.05, 1);
        slot.noise.triggerAttackRelease("32n", time, vel);
      }
    } catch (e) { /* ignore */ }
  }

  _playPad(time, ev) {
    this._log("pad", time, ev);
    const root = 48 + (((ev.root % 12) + 12) % 12);          // fold the bass note into C3..B3
    const dur = this._beatsToSeconds(ev.d);
    try { this.pad.triggerAttackRelease([midiToHz(root), midiToHz(root + 7)], dur, time); } catch (e) { /* ignore */ }
  }

  // ---- live control -------------------------------------------------------------------------------
  /** Write an audio parameter only when it changed meaningfully (keeps the Web Audio timeline light). */
  _set(key, param, value, ramp, eps) {
    const prev = this.applied.get(key);
    if (prev === undefined || Math.abs(prev - value) > eps) {
      this.applied.set(key, value);
      param.rampTo(value, ramp);
    }
  }

  setBpm(v) { Tone.getTransport().bpm.value = v; }
  setMasterVolume(v) { if (this.master) this.master.gain.rampTo(v, 0.1); }

  /** Called every animation frame with the people + group from people.js. */
  update(people, group, dt) {
    if (!this.ready) return;
    const ramp = CONFIG.RAMP_SECONDS;
    this.groupAvg = group.avgMotion;

    // bloom amount: fades in over RING_FADE_IN, out over RING_FADE_OUT
    const dir = group.ringClosed ? 1 : -1;
    const period = group.ringClosed ? CONFIG.RING_FADE_IN : CONFIG.RING_FADE_OUT;
    this.ringFade = clamp(this.ringFade + (dir * dt) / period, 0, 1);

    for (const s of this.slots) {
      const person = people.find((p) => p.slot === s.slot) || null;
      s.present = !!person;
      s.motion = person ? person.motion : 0;

      // final gain = presence × activity × band (§7), ring override: at least 75 % while the bloom is on
      const presence = person ? 1 : 0;
      let activity = 0, band = 0;
      if (person) {
        activity = person.moving || person.stillFor <= CONFIG.STILL_TIMEOUT ? 1 : CONFIG.IDLE_LEVEL;
        if (s.cfg.drum) activity = Math.max(activity, Math.min(1, CONFIG.IDLE_LEVEL + 0.5 * group.avgMotion));
        band = person.band / 100;
      }
      let gain = presence * activity * band;
      if (person) gain = Math.max(gain, CONFIG.RING_MIN_GAIN * this.ringFade);
      s.target = gain;
      s.visGain += (gain - s.visGain) * Math.min(1, dt / ramp);

      const rising = gain > (this.applied.get(`g${s.slot}`) ?? 0);
      this._set(`g${s.slot}`, s.gain.gain, gain, rising && person && person.moving ? 0.2 : ramp, 0.004);

      // pan from x (mirrored 0..1 → -0.8 … +0.8)
      if (person) {
        s.panValue = clamp((person.x * 2 - 1) * 0.8, -0.8, 0.8);
        this._set(`p${s.slot}`, s.panner.pan, s.panValue, ramp, 0.01);
      }

      // arms up: brighter + octave jump (slots that allow it)
      const up = !!(person && person.armsUp);
      s.octaveShift = up && s.cfg.octaveShift ? 12 : 0;
      s.cutoff = up ? s.cfg.filter.bright : s.cfg.filter.base;
      this._set(`f${s.slot}`, s.filter.frequency, s.cutoff, ramp, s.cutoff * 0.02);
    }

    // shared pulse while ≥ 1 person is present
    this._set("pulse", this.pulseGain.gain, group.count >= 1 ? 0.55 : 0, 0.5, 0.01);

    // ring bloom: pad fades in, reverb grows
    this.padLevel = this.ringFade * (0.65 + 0.35 * group.avgMotion);
    this._set("pad", this.padGain.gain, this.padLevel, 0.3, 0.005);
    this._set("wet", this.reverb.wet, CONFIG.REVERB_WET + (CONFIG.REVERB_WET_RING - CONFIG.REVERB_WET) * this.ringFade, 0.3, 0.005);

    // hand chime: once per NEW pair, at most every CHIME_MIN_INTERVAL seconds
    const keys = new Set(group.handPairs.map(([a, b]) => `${a}-${b}`));
    let fresh = false;
    for (const k of keys) if (!this.pairKeys.has(k)) fresh = true;
    this.pairKeys = keys;
    const nowS = Tone.now();
    if (fresh && nowS - this.lastChime >= CONFIG.CHIME_MIN_INTERVAL) {
      this.lastChime = nowS;
      this.chimes++;
      try { this.chime.triggerAttackRelease(["D6", "A6"], "8n", nowS + 0.02, 0.8); } catch (e) { /* ignore */ }
    }
  }

  /** Current position in the loop in quarter-note beats (for the visuals' pulse). */
  beat() {
    if (!this.running) return 0;
    const T = Tone.getTransport();
    return T.ticks / T.PPQ;
  }

  /** Snapshot for the debug panel and for tests. */
  snapshot() {
    return {
      ready: this.ready, running: this.running, contextState: Tone.getContext().state,
      bpm: Tone.getTransport().bpm.value, ringFade: this.ringFade, padLevel: this.padLevel || 0,
      reverbWet: this.reverb ? this.reverb.wet.value : 0, chimes: this.chimes,
      loopBeats: this.arr ? this.arr.loopBeats : 0,
      slots: this.slots.map((s) => ({
        slot: s.slot, name: s.cfg.name, present: s.present, target: s.target,
        gain: s.gain.gain.value, pan: s.panner.pan.value, cutoff: s.filter.frequency.value,
        octaveShift: s.octaveShift, motion: s.motion,
      })),
    };
  }
}
