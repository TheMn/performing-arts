// config.js — EVERY tunable number lives here, plus the slot → instrument table (spec §2.1).
// CONFIG is a plain mutable object: the settings panel (ui.js) edits it live and every module
// reads it fresh each frame. Nothing here touches the DOM or Tone.js, so tests.html can import it.

// Where the third-party libraries come from (CDN only, no build step). Each entry is a list of
// URLs that vendor.js tries in order.
export const CDN = {
  tone: [
    "https://cdn.jsdelivr.net/npm/tone@15.0.4/+esm",
    "https://esm.sh/tone@15.0.4",
  ],
  midi: [
    "https://esm.sh/@tonejs/midi@2.0.28",
    "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm",
  ],
  mediapipe: [
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    "https://esm.sh/@mediapipe/tasks-vision@0.10.14",
  ],
  mediapipeWasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  poseModel:
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};

export const CONFIG = {
  // --- music ---------------------------------------------------------------------------------
  BPM: 120,
  MASTER_VOLUME: 0.8,
  REVERB_WET: 0.2,            // resting reverb mix
  REVERB_WET_RING: 0.45,      // reverb mix when the ring is closed

  // --- people / identity -----------------------------------------------------------------------
  MAX_PEOPLE: 5,
  LEAVE_TIMEOUT: 1.5,         // s a person may be missing before their slot is freed
  STILL_TIMEOUT: 1.5,         // s of standing still before the instrument fades to IDLE_LEVEL
  RAMP_SECONDS: 0.3,          // all gain / pan / filter changes ramp over this
  MIN_VISIBILITY: 0.5,        // ignore poses whose average landmark visibility is lower
  MAX_JUMP: 0.25,             // max (x, closeness) distance for matching a detection to a person
  POS_SMOOTHING: 0.5,         // EMA for x / closeness, per 1/60 s

  // --- closeness (shoulder width, normalised image units) --------------------------------------
  CLOSE_MIN: 0.08,            // shoulder width that counts as "far"  (closeness 0)
  CLOSE_MAX: 0.30,            // shoulder width that counts as "near" (closeness 1)
  BANDS: [0.25, 0.5, 0.75, 1.0],
  BAND_HYSTERESIS: 0.03,      // closeness margin before the volume band changes

  // --- motion ------------------------------------------------------------------------------------
  MOTION_SMOOTHING: 0.25,     // EMA factor, defined per 1/60 s frame (frame-rate independent)
  MOTION_MAX: 1.5,            // shoulder-widths per second that count as motion = 1.0
  MOTION_DEADZONE: 0.15,      // shoulder-widths per second ignored (tracker jitter)
  MOVE_THRESHOLD: 0.15,       // motion above this = "moving" (off again below 60 % of it)
  ARMS_UP_MARGIN: 0.03,       // wrist must be this much above the shoulders (normalised y)
  IDLE_LEVEL: 0.10,           // gain of a person who stands still (never fully silent)

  // --- togetherness --------------------------------------------------------------------------
  HAND_DISTANCE: 0.18,        // horizontal gap (0..1) under which two people "hold hands"
  HAND_RELEASE: 1.2,          // hands let go at HAND_DISTANCE * this (hysteresis)
  RING_MIN_PEOPLE: 4,
  RING_HOLD: 2.0,             // s everybody must move together before the ring closes
  RING_GRACE: 0.4,            // s the ring survives a momentary stop
  RING_MIN_GAIN: 0.75,        // every present instrument is at least this loud while closed
  RING_FADE_IN: 1.2,          // s for the bloom to fade in
  RING_FADE_OUT: 2.0,         // s for the bloom to fade out

  // --- misc ------------------------------------------------------------------------------------
  ASPECT: 16 / 9,             // video width / height (tracking.js updates it from the camera)
  CHIME_MIN_INTERVAL: 2.0,    // s between two hand chimes
  FILL_THRESHOLD: 0.7,        // drum plays 16th-note fills above this motion

  // --- the five slots (spec §2.1) --------------------------------------------------------------
  SLOTS: [
    {
      slot: 1, name: "Flute", colour: "#e63946", role: "Theme B",
      octaveShift: true,
      synth: { type: "Synth", options: {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.04, decay: 0.1, sustain: 0.75, release: 0.25 } } },
      vibrato: { frequency: 5.5, depth: 0.07 },
      filter: { base: 3200, bright: 9000, q: 0.7 },
      volumeDb: -3,
    },
    {
      slot: 2, name: "Tambourin", colour: "#f4a31c", role: "Rhythm",
      octaveShift: false, drum: true,
      synth: { type: "MembraneSynth", options: {
        pitchDecay: 0.05, octaves: 4,
        envelope: { attack: 0.001, decay: 0.28, sustain: 0, release: 0.1 } } },
      noise: { options: {
        noise: { type: "white" },
        envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.02 } } },
      filter: { base: 9000, bright: 12000, q: 0.5 },
      volumeDb: -2,
    },
    {
      slot: 3, name: "Cello", colour: "#f6d743", role: "Bass",
      octaveShift: false,
      synth: { type: "FMSynth", options: {
        harmonicity: 1.005, modulationIndex: 1.4,
        oscillator: { type: "sawtooth" },
        envelope: { attack: 0.08, decay: 0.2, sustain: 0.85, release: 0.4 },
        modulation: { type: "triangle" },
        modulationEnvelope: { attack: 0.2, decay: 0.3, sustain: 0.6, release: 0.4 } } },
      filter: { base: 650, bright: 2000, q: 0.7 },
      volumeDb: -7,
    },
    {
      slot: 4, name: "Oboe", colour: "#2f6fdb", role: "Theme A",
      octaveShift: true,
      synth: { type: "FMSynth", options: {
        harmonicity: 3, modulationIndex: 2.2,
        oscillator: { type: "sine" },
        envelope: { attack: 0.05, decay: 0.1, sustain: 0.8, release: 0.2 },
        modulation: { type: "square" },
        modulationEnvelope: { attack: 0.1, decay: 0.2, sustain: 0.6, release: 0.2 } } },
      filter: { base: 2800, bright: 7500, q: 0.7 },
      volumeDb: -8,
    },
    {
      slot: 5, name: "Violin", colour: "#9b59d0", role: "Counter-melody",
      octaveShift: true,
      synth: { type: "Synth", options: {
        oscillator: { type: "sawtooth" },
        envelope: { attack: 0.09, decay: 0.15, sustain: 0.8, release: 0.35 } } },
      vibrato: { frequency: 5.8, depth: 0.1 },
      filter: { base: 1800, bright: 6000, q: 0.7 },
      volumeDb: -13,
    },
  ],
};

// ---- persistence of the live-tunable numbers (settings panel) -------------------------------
const SETTINGS_KEY = "farandole.settings";
const DEFAULTS = JSON.parse(JSON.stringify(CONFIG));

export const TUNABLE_KEYS = [
  "BPM", "CLOSE_MIN", "CLOSE_MAX", "MOVE_THRESHOLD", "MOTION_MAX", "IDLE_LEVEL",
  "RING_MIN_PEOPLE", "RING_HOLD", "HAND_DISTANCE", "MASTER_VOLUME",
];

export function getDefault(key) { return DEFAULTS[key]; }

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    for (const k of TUNABLE_KEYS) {
      if (typeof saved[k] === "number" && Number.isFinite(saved[k])) CONFIG[k] = saved[k];
    }
  } catch (e) { /* storage unavailable: use defaults */ }
}

export function saveSettings() {
  try {
    const out = {};
    for (const k of TUNABLE_KEYS) out[k] = CONFIG[k];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch (e) { /* ignore */ }
}

export function resetSettings() {
  for (const k of TUNABLE_KEYS) CONFIG[k] = DEFAULTS[k];
  try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
}
