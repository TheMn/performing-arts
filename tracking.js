// tracking.js — webcam + MediaPipe Pose Landmarker → raw poses (spec §6, §13).
// Output is a list of detections { landmarks: [{x, y, z, visibility} × 33] } in normalised,
// UNMIRRORED image coordinates. people.js does everything after that.

import { CONFIG, CDN } from "./config.js";
import { loadMediaPipe } from "./vendor.js";

export class PoseTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.ready = false;
    this.delegate = null;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.skipOther = false;     // set by main.js when FPS < 20
    this._skipToggle = 0;
    this.detections = [];
    this.inferenceMs = 0;
  }

  /** Load MediaPipe + the model. GPU delegate first, CPU as fallback. */
  async initModel() {
    if (this.landmarker) return;
    const mp = await loadMediaPipe();
    const fileset = await mp.FilesetResolver.forVisionTasks(CDN.mediapipeWasm);
    const make = (delegate) => mp.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: CDN.poseModel, delegate },
      runningMode: "VIDEO",
      numPoses: CONFIG.MAX_PEOPLE,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await make("GPU");
      this.delegate = "GPU";
    } catch (e) {
      console.warn("[tracking] GPU delegate failed, falling back to CPU", e);
      this.landmarker = await make("CPU");
      this.delegate = "CPU";
    }
  }

  async initCamera() {
    if (this.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("No camera API in this browser");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (this.video.videoWidth && this.video.videoHeight) CONFIG.ASPECT = this.video.videoWidth / this.video.videoHeight;
  }

  /** Camera + model. Throws if either is unavailable. */
  async start() {
    await this.initCamera();
    await this.initModel();
    this.ready = true;
  }

  stop() {
    this.ready = false;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.lastVideoTime = -1;
  }

  /**
   * Returns the detections for a NEW video frame, or null when there is no new frame (or this frame
   * is skipped to save time). detectForVideo runs at most once per video frame.
   */
  detect() {
    const v = this.video;
    if (!this.ready || !this.landmarker || v.readyState < 2) return null;
    if (v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;
    if (this.skipOther) { this._skipToggle ^= 1; if (this._skipToggle) return null; }
    if (v.videoWidth && v.videoHeight) CONFIG.ASPECT = v.videoWidth / v.videoHeight;

    let ts = performance.now();
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;   // MediaPipe needs strictly increasing timestamps
    this.lastTimestamp = ts;
    const t0 = performance.now();
    let result;
    try { result = this.landmarker.detectForVideo(v, ts); }
    catch (e) { console.warn("[tracking] detectForVideo failed", e); return null; }
    this.inferenceMs += (performance.now() - t0 - this.inferenceMs) * 0.1;
    this.detections = (result.landmarks || []).map((lm) => ({ landmarks: lm }));
    return this.detections;
  }
}
