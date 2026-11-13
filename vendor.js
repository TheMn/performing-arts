// vendor.js — loads the CDN libraries (spec §3). Each library has a list of URLs that are tried in
// order, so one flaky CDN does not stop the demo. Nothing is installed or bundled.

import { CDN } from "./config.js";

async function loadFirst(name, urls, check) {
  let lastError;
  for (const url of urls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      const lib = check(mod) ? mod : mod && mod.default && check(mod.default) ? mod.default : null;
      if (lib) return lib;
      lastError = new Error(`${url} did not export ${name}`);
    } catch (e) {
      lastError = e;
      console.warn(`[vendor] could not load ${name} from ${url}`, e);
    }
  }
  throw new Error(`Could not load ${name} from the CDN (${lastError ? lastError.message : "unknown error"}). Are you online?`);
}

let tonePromise, midiPromise, mediaPipePromise;

export const loadTone = () =>
  (tonePromise ||= loadFirst("Tone.js", CDN.tone, (m) => typeof m.Synth === "function"));

export const loadMidiLib = () =>
  (midiPromise ||= loadFirst("@tonejs/midi", CDN.midi, (m) => typeof m.Midi === "function"));

export const loadMediaPipe = () =>
  (mediaPipePromise ||= loadFirst("MediaPipe Tasks Vision", CDN.mediapipe,
    (m) => m.PoseLandmarker && m.FilesetResolver));
