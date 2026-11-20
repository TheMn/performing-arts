"""
sonificARTE - zone tracker (Script TOP callbacks for TouchDesigner)
===================================================================

Owner: Amir (software). Used by: Gaz (TouchDesigner).

What it does, every frame:
    camera image -> MediaPipe Pose -> each person's FEET position in the image
    -> real floor position in metres (using the 4 taped calibration markers)
    -> which of the 4 sectors (zones) and which distance ring they stand in
    -> writes the results into a Table DAT called `zone_data`
    -> outputs the camera image with the floor zones and people drawn on top.

How Gaz installs it (replaces the previous Script TOP code):
    1. Paste this whole file into the Script TOP's callbacks DAT
       (or point the callbacks DAT's "File" parameter at this file).
    2. Wire the camera TOP into the Script TOP's first input
       (or set CAMERA_TOP below to the camera TOP's name).
    3. Put `pose_landmarker_lite.task` and `zones_config.json` next to the .toe file.
    4. Press "Setup Parameters" on the Script TOP to get the sonificARTE page.
    5. Use `zone_data` (DAT to CHOP: "Channel per Row", first column = names)
       to drive the music layers and the painting.

Output contract (`zone_data` table, name | value), i = 1..4:
    zone{i}_on      0/1   someone is standing in sector i (debounced)
    zone{i}_vol     0..1  layer volume for sector i (closer = louder, smoothed, 0 when empty)
    zone{i}_ring    int   ring of the nearest person in sector i (1 = nearest the painting), 0 = empty
    zone{i}_dist    m     distance of that person from the apex point, 0 = empty
    zones_on        int   how many sectors are occupied (0..4)
    people          int   how many people the camera currently sees (inside or outside the zones)
    complete        0/1   every sector is occupied ("the circle is complete")
    complete_fade   0..1  ramps up while complete, down when not: use it to fade pale -> vivid painting
    calibrated      0/1   zones_config.json was loaded and has valid calibration points

Floor coordinates (metres), used in zones_config.json:
    origin = the apex point on the floor (the "spider" in the sketch, in front of the painting)
    +x     = to the RIGHT of a visitor who faces the painting
    +y     = away from the painting, into the room
Sector 1 is the visitor's far left, sector 4 the far right.

Everything that needs tuning lives in zones_config.json, which this script reloads
automatically when the file changes. Amir edits it; Gaz never has to touch this code.
"""

import json
import math
import os
import sys

sys.path.append(os.path.expanduser('~/td_python_libs'))

import cv2
import numpy as np

# ----------------------------------------------------------------------------
# Settings that depend on Gaz's network (the only lines Gaz may need to edit)
# ----------------------------------------------------------------------------
CAMERA_TOP = 'null17'               # used only if nothing is wired into the Script TOP's input
OUTPUT_TABLE = 'zone_data'          # Table DAT created next to the Script TOP
MODEL_FILE = 'pose_landmarker_lite.task'
CONFIG_FILE = 'zones_config.json'
CALIBRATION_FRAME_FILE = 'calibration_frame.png'

# ----------------------------------------------------------------------------
# Defaults (zones_config.json overrides any of these)
# ----------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "calibration": {
        # 4+ points in the camera image, normalised 0..1, origin top-left
        "image_points": [],
        # the same points measured on the floor, in metres (see coordinate system above)
        "floor_points_m": [],
    },
    "zones": {
        "sector_edges_deg": [-60, -30, 0, 30, 60],   # 5 edges = 4 sectors, 0 = straight out from the painting
        "ring_edges_m": [0.5, 1.5, 2.5, 3.5],        # 4 edges = 3 rings, measured from the apex
    },
    "volume": {
        "mode": "continuous",       # "continuous" (smooth with distance) or "rings" (one level per ring)
        "near": 1.0,                # volume at the inner edge
        "far": 0.25,                # volume at the outer edge
        "ring_levels": [1.0, 0.6, 0.3],
    },
    "timing": {
        "enter_s": 0.3,             # must stand in a sector this long before it switches on
        "leave_s": 1.0,             # sector stays on this long after the person leaves (hides tracking drop-outs)
        "volume_smooth_s": 0.3,     # volume glide time
        "complete_fade_s": 3.0,     # time for complete_fade to go 0 -> 1
    },
    "tracking": {
        "num_poses": 4,
        "min_detection_confidence": 0.5,
        "min_tracking_confidence": 0.5,
        "min_visibility": 0.5,
    },
}

COLORS_RGB = [(230, 60, 50), (240, 150, 40), (240, 210, 50), (70, 120, 230)]   # sector 1..4
YELLOW = (255, 255, 0)
GREY = (150, 150, 150)

POSE_CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (24, 26), (26, 28),
    (27, 31), (28, 32), (0, 11), (0, 12),
]
FEET_LANDMARKS = (27, 28, 29, 30, 31, 32)      # ankles, heels, toes
HIP_LANDMARKS = (23, 24)


# ============================================================================
# Pure logic (no TouchDesigner needed: tested in tests/test_zone_tracker.py)
# ============================================================================

def merge_config(base, override):
    out = {}
    for key, value in base.items():
        if isinstance(value, dict):
            out[key] = merge_config(value, override.get(key, {}) if isinstance(override.get(key), dict) else {})
        else:
            out[key] = override.get(key, value)
    for key, value in override.items():
        if key not in out:
            out[key] = value
    return out


def load_config(path):
    """Returns (config, error message or None). Missing or broken file -> defaults."""
    if not os.path.exists(path):
        return merge_config(DEFAULT_CONFIG, {}), 'no %s found' % os.path.basename(path)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return merge_config(DEFAULT_CONFIG, {}), 'cannot read %s: %s' % (os.path.basename(path), e)
    return merge_config(DEFAULT_CONFIG, data), None


class FloorMap:
    """Maps normalised camera-image points to floor metres and back (a homography)."""

    def __init__(self, image_points, floor_points):
        self.ok = False
        self.error = None
        self.H = None
        self.H_inv = None
        src = np.asarray(image_points, dtype=np.float64).reshape(-1, 2)
        dst = np.asarray(floor_points, dtype=np.float64).reshape(-1, 2)
        if len(src) < 4 or len(src) != len(dst):
            self.error = 'need at least 4 matching image/floor calibration points'
            return
        H, _ = cv2.findHomography(src, dst, 0)
        if H is None or abs(np.linalg.det(H)) < 1e-12:
            self.error = 'calibration points are degenerate (3 of them on one line?)'
            return
        self.H = H
        self.H_inv = np.linalg.inv(H)
        # the calibration markers are in front of the camera: remember their projective sign
        cx, cy = dst.mean(axis=0)
        self._front_sign = np.sign((self.H_inv @ np.array([cx, cy, 1.0]))[2]) or 1.0
        self.ok = True

    @staticmethod
    def _apply(M, x, y):
        v = M @ np.array([x, y, 1.0])
        if abs(v[2]) < 1e-12:
            return None
        return v[0] / v[2], v[1] / v[2], v[2]

    def image_to_floor(self, u, v):
        r = self._apply(self.H, u, v)
        return None if r is None else (r[0], r[1])

    def floor_to_image(self, x, y):
        """None for floor points that would land behind the camera."""
        r = self._apply(self.H_inv, x, y)
        if r is None:
            return None
        # a point in front of the camera has the same projective sign as the calibration points
        if r[2] * self._front_sign <= 0:
            return None
        return r[0], r[1]


def classify(zones_cfg, x, y):
    """Floor point (m) -> (sector index 0..n-1 or None, ring index 0..m-1 or None, distance m, angle deg)."""
    dist = math.hypot(x, y)
    angle = math.degrees(math.atan2(x, y))      # 0 = straight out, negative = visitor's left
    edges = zones_cfg['sector_edges_deg']
    rings = zones_cfg['ring_edges_m']
    sector = None
    for i in range(len(edges) - 1):
        if edges[i] <= angle < edges[i + 1]:
            sector = i
            break
    ring = None
    for j in range(len(rings) - 1):
        if rings[j] <= dist < rings[j + 1]:
            ring = j
            break
    if sector is None or ring is None:
        return None, None, dist, angle
    return sector, ring, dist, angle


def volume_for(volume_cfg, zones_cfg, dist, ring):
    rings = zones_cfg['ring_edges_m']
    if volume_cfg.get('mode') == 'rings':
        levels = volume_cfg['ring_levels']
        return float(levels[min(ring, len(levels) - 1)])
    inner, outer = rings[0], rings[-1]
    t = 0.0 if outer <= inner else min(max((dist - inner) / (outer - inner), 0.0), 1.0)
    return float(volume_cfg['near'] + (volume_cfg['far'] - volume_cfg['near']) * t)


def foot_point(landmarks, min_visibility):
    """Normalised image point where the person touches the floor, or None.

    Uses the visible ankle/heel/toe landmarks. Hips are NOT used as a fallback:
    hips are ~1 m above the floor, so with an angled camera they would put the
    person in the wrong ring. A person whose feet are hidden is simply skipped.
    """
    pts = [landmarks[i] for i in FEET_LANDMARKS
           if i < len(landmarks) and getattr(landmarks[i], 'visibility', 1.0) >= min_visibility]
    if not pts:
        return None
    # the lowest points in the image are the ones touching the floor
    pts.sort(key=lambda lm: lm.y, reverse=True)
    lowest = pts[:2]
    return (float(np.mean([p.x for p in lowest])), float(np.mean([p.y for p in lowest])))


class ZoneState:
    """Debounces occupancy, smooths volume and computes the 'complete' fade."""

    def __init__(self, n_sectors):
        self.n = n_sectors
        self.reset()

    def reset(self):
        self.on = [False] * self.n
        self.seen_for = [0.0] * self.n
        self.missing_for = [0.0] * self.n
        self.vol = [0.0] * self.n
        self.target = [0.0] * self.n
        self.ring = [0] * self.n
        self.dist = [0.0] * self.n
        self.complete_fade = 0.0

    def update(self, detections, dt, timing):
        """detections: {sector: (volume, ring, dist)} for the nearest person in each sector."""
        dt = max(0.0, min(dt, 0.5))
        for i in range(self.n):
            if i in detections:
                self.seen_for[i] += dt
                self.missing_for[i] = 0.0
                if self.seen_for[i] >= timing['enter_s']:
                    self.on[i] = True
                vol, ring, dist = detections[i]
                if self.on[i]:
                    self.target[i] = vol
                    self.ring[i] = ring + 1
                    self.dist[i] = dist
            else:
                self.missing_for[i] += dt
                self.seen_for[i] = 0.0
                if self.missing_for[i] >= timing['leave_s']:
                    self.on[i] = False
            if not self.on[i]:
                self.target[i] = 0.0
                self.ring[i] = 0
                self.dist[i] = 0.0
            tau = timing['volume_smooth_s']
            k = 1.0 if tau <= 0 else 1.0 - math.exp(-dt / tau)
            self.vol[i] += (self.target[i] - self.vol[i]) * k
            if abs(self.vol[i] - self.target[i]) < 1e-3:
                self.vol[i] = self.target[i]

        complete = self.n > 0 and all(self.on)
        fade = timing['complete_fade_s']
        step = 1.0 if fade <= 0 else dt / fade
        self.complete_fade = min(1.0, self.complete_fade + step) if complete else max(0.0, self.complete_fade - step)
        return complete

    def rows(self, people, calibrated):
        out = []
        for i in range(self.n):
            out += [
                ('zone%d_on' % (i + 1), int(self.on[i])),
                ('zone%d_vol' % (i + 1), round(self.vol[i], 4)),
                ('zone%d_ring' % (i + 1), self.ring[i]),
                ('zone%d_dist' % (i + 1), round(self.dist[i], 3)),
            ]
        out += [
            ('zones_on', sum(self.on)),
            ('people', people),
            ('complete', int(self.n > 0 and all(self.on))),
            ('complete_fade', round(self.complete_fade, 4)),
            ('calibrated', int(calibrated)),
        ]
        return out


def draw_zones(frame, floor_map, zones_cfg, state=None, alpha=0.25):
    """Draws the real floor sectors and rings onto an RGB uint8 image (top-down rows)."""
    if floor_map is None or not floor_map.ok:
        return
    h, w = frame.shape[:2]
    edges = zones_cfg['sector_edges_deg']
    rings = zones_cfg['ring_edges_m']

    def to_px(x, y):
        p = floor_map.floor_to_image(x, y)
        if p is None or not (-2 < p[0] < 3 and -2 < p[1] < 3):
            return None
        return int(round(p[0] * w)), int(round(p[1] * h))

    def polar(r, a_deg):
        a = math.radians(a_deg)
        return r * math.sin(a), r * math.cos(a)

    def polyline(points):
        return [p for p in points if p is not None]

    # filled sectors for occupied zones
    if state is not None:
        overlay = frame.copy()
        for i in range(len(edges) - 1):
            if not state.on[i]:
                continue
            steps = max(2, int(abs(edges[i + 1] - edges[i])))
            outer = [to_px(*polar(rings[-1], edges[i] + (edges[i + 1] - edges[i]) * s / steps)) for s in range(steps + 1)]
            inner = [to_px(*polar(rings[0], edges[i + 1] - (edges[i + 1] - edges[i]) * s / steps)) for s in range(steps + 1)]
            poly = polyline(outer + inner)
            if len(poly) >= 3:
                cv2.fillPoly(overlay, [np.array(poly, np.int32)], COLORS_RGB[i % len(COLORS_RGB)])
        cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, dst=frame)

    # rays
    for a in edges:
        pts = polyline([to_px(*polar(rings[0] + (rings[-1] - rings[0]) * s / 20, a)) for s in range(21)])
        if len(pts) >= 2:
            cv2.polylines(frame, [np.array(pts, np.int32)], False, YELLOW, 2, cv2.LINE_AA)
    # arcs
    for r in rings:
        steps = max(2, int(abs(edges[-1] - edges[0])))
        pts = polyline([to_px(*polar(r, edges[0] + (edges[-1] - edges[0]) * s / steps)) for s in range(steps + 1)])
        if len(pts) >= 2:
            cv2.polylines(frame, [np.array(pts, np.int32)], False, YELLOW, 2, cv2.LINE_AA)
    # sector numbers and state
    for i in range(len(edges) - 1):
        mid = (edges[i] + edges[i + 1]) / 2
        p = to_px(*polar(rings[-1] + 0.25, mid))
        if p is not None:
            cv2.putText(frame, str(i + 1), (p[0] - 10, p[1]), cv2.FONT_HERSHEY_SIMPLEX, 1.1, YELLOW, 3, cv2.LINE_AA)
        if state is not None and state.on[i]:
            q = to_px(*polar((rings[0] + rings[-1]) / 2, mid))
            if q is not None:
                label = 'ON %d%%' % round(state.vol[i] * 100)
                cv2.putText(frame, label, (q[0] - 45, q[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2, cv2.LINE_AA)


def draw_markers(frame, image_points):
    h, w = frame.shape[:2]
    for k, (u, v) in enumerate(image_points):
        p = (int(round(u * w)), int(round(v * h)))
        cv2.drawMarker(frame, p, (255, 0, 255), cv2.MARKER_CROSS, 22, 2)
        cv2.putText(frame, 'M%d' % (k + 1), (p[0] + 8, p[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 255), 2)


def put_status(frame, lines, color=YELLOW):
    y = 30
    for line in lines:
        cv2.putText(frame, line, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(frame, line, (12, y), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2, cv2.LINE_AA)
        y += 28


def process_poses(pose_landmarks, cfg, floor_map):
    """MediaPipe poses -> (detections per sector, list of per-person info for drawing)."""
    people = []
    detections = {}
    for pose in pose_landmarks:
        foot = foot_point(pose, cfg['tracking']['min_visibility'])
        info = {'pose': pose, 'foot': foot, 'sector': None, 'floor': None}
        if foot is not None and floor_map is not None and floor_map.ok:
            xy = floor_map.image_to_floor(*foot)
            if xy is not None:
                sector, ring, dist, _ = classify(cfg['zones'], *xy)
                info['floor'] = xy
                if sector is not None:
                    info['sector'] = sector
                    vol = volume_for(cfg['volume'], cfg['zones'], dist, ring)
                    # several people in one sector: the nearest one decides the volume
                    if sector not in detections or dist < detections[sector][2]:
                        detections[sector] = (vol, ring, dist)
        people.append(info)
    return detections, people


def draw_people(frame, people):
    h, w = frame.shape[:2]
    for info in people:
        pose = info['pose']
        pts = [(int(lm.x * w), int(lm.y * h)) for lm in pose]
        for a, b in POSE_CONNECTIONS:
            if a < len(pts) and b < len(pts):
                cv2.line(frame, pts[a], pts[b], (0, 255, 0), 2, cv2.LINE_AA)
        if info['foot'] is None:
            continue
        fp = (int(info['foot'][0] * w), int(info['foot'][1] * h))
        color = COLORS_RGB[info['sector'] % len(COLORS_RGB)] if info['sector'] is not None else GREY
        cv2.circle(frame, fp, 11, color, -1, cv2.LINE_AA)
        cv2.circle(frame, fp, 11, (255, 255, 255), 2, cv2.LINE_AA)
        if info['floor'] is not None:
            x, y = info['floor']
            cv2.putText(frame, '%.1f, %.1f m' % (x, y), (fp[0] + 14, fp[1] + 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)


# ============================================================================
# TouchDesigner side (only runs inside TD)
# ============================================================================

_landmarker = None
_landmarker_key = None
_last_ts = 0
_last_time = None
_cfg = None
_cfg_mtime = None
_cfg_error = None
_floor_map = None
_state = None
_last_raw_frame = None
_next_cfg_check = 0.0


def _project_path(name):
    return os.path.join(project.folder, name)          # noqa: F821  (TD global)


def _get_landmarker(cfg):
    global _landmarker, _landmarker_key
    t = cfg['tracking']
    key = (t['num_poses'], t['min_detection_confidence'], t['min_tracking_confidence'])
    if _landmarker is None or key != _landmarker_key:
        import mediapipe as mp_lib                      # noqa: F401
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        if _landmarker is not None:
            _landmarker.close()
        options = vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=_project_path(MODEL_FILE)),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=int(t['num_poses']),
            min_pose_detection_confidence=float(t['min_detection_confidence']),
            min_tracking_confidence=float(t['min_tracking_confidence']),
        )
        _landmarker = vision.PoseLandmarker.create_from_options(options)
        _landmarker_key = key
    return _landmarker


def _refresh_config(now):
    """(Re)loads zones_config.json when it changes. Checked at most once per second."""
    global _cfg, _cfg_mtime, _cfg_error, _floor_map, _state, _next_cfg_check
    if _cfg is not None and now < _next_cfg_check:
        return
    _next_cfg_check = now + 1.0
    path = _project_path(CONFIG_FILE)
    mtime = os.path.getmtime(path) if os.path.exists(path) else None
    if _cfg is not None and mtime == _cfg_mtime:
        return
    _cfg_mtime = mtime
    _cfg, _cfg_error = load_config(path)
    cal = _cfg['calibration']
    _floor_map = FloorMap(cal['image_points'], cal['floor_points_m'])
    if _cfg_error is None and not _floor_map.ok:
        _cfg_error = _floor_map.error
    n = len(_cfg['zones']['sector_edges_deg']) - 1
    if _state is None or _state.n != n:
        _state = ZoneState(n)


def _write_table(scriptOp, rows):
    comp = scriptOp.parent()
    table = comp.op(OUTPUT_TABLE)
    if table is None:
        table = comp.create(tableDAT, OUTPUT_TABLE)     # noqa: F821  (TD global)
        table.nodeX = scriptOp.nodeX
        table.nodeY = scriptOp.nodeY - 150
    if table.numRows != len(rows) or table.numCols != 2:
        table.setSize(len(rows), 2)
    for r, (name, value) in enumerate(rows):
        table[r, 0] = name
        table[r, 1] = value


def save_calibration_frame():
    """Saves the last clean camera frame (no drawings) for Amir's calibration tool."""
    if _last_raw_frame is None:
        print('sonificARTE: no camera frame yet, cannot save calibration frame')
        return None
    path = _project_path(CALIBRATION_FRAME_FILE)
    cv2.imwrite(path, cv2.cvtColor(_last_raw_frame, cv2.COLOR_RGB2BGR))
    print('sonificARTE: saved', path, '-> send this file to Amir')
    return path


def onSetupParameters(scriptOp):
    page = scriptOp.appendCustomPage('sonificARTE')
    page.appendToggle('Showoverlay', label='Show zones overlay')[0].default = True
    page.appendPulse('Saveframe', label='Save calibration frame')
    page.appendPulse('Reloadconfig', label='Reload zones_config.json')
    page.appendPulse('Resetzones', label='Reset zone state')


def onPulse(par):
    global _cfg
    if par.name == 'Saveframe':
        save_calibration_frame()
    elif par.name == 'Reloadconfig':
        _cfg = None
    elif par.name == 'Resetzones' and _state is not None:
        _state.reset()


def onCook(scriptOp):
    global _last_ts, _last_time, _last_raw_frame

    src = scriptOp.inputs[0] if scriptOp.inputs else op(CAMERA_TOP)     # noqa: F821
    if src is None:
        return
    img = src.numpyArray(delayed=True)
    if img is None:
        return

    now = absTime.seconds                                                # noqa: F821
    dt = 0.0 if _last_time is None else now - _last_time
    _last_time = now
    _refresh_config(now)
    cfg = _cfg

    # TD images are bottom-up float RGBA; MediaPipe/OpenCV want top-down uint8 RGB
    frame = (np.clip(img[:, :, :3], 0, 1) * 255).astype(np.uint8)
    frame = np.ascontiguousarray(cv2.flip(frame, 0))
    _last_raw_frame = frame.copy()

    ts = int(now * 1000)
    if ts <= _last_ts:
        ts = _last_ts + 1
    _last_ts = ts

    import mediapipe as mp_lib
    result = _get_landmarker(cfg).detect_for_video(
        mp_lib.Image(image_format=mp_lib.ImageFormat.SRGB, data=frame), ts)

    calibrated = _floor_map is not None and _floor_map.ok
    detections, people = process_poses(result.pose_landmarks, cfg, _floor_map)
    _state.update(detections, dt, cfg['timing'])

    rows = _state.rows(len(people), calibrated)
    _write_table(scriptOp, rows)
    scriptOp.store('zones', list(_state.on))          # same key as the previous script
    scriptOp.store('zone_rows', rows)

    show = True
    if hasattr(scriptOp.par, 'Showoverlay'):
        show = bool(scriptOp.par.Showoverlay.eval())
    if show:
        draw_zones(frame, _floor_map, cfg['zones'], _state)
        draw_markers(frame, cfg['calibration']['image_points'])
        draw_people(frame, people)
        if calibrated:
            put_status(frame, ['zones on: %d/%d   people: %d%s' % (
                sum(_state.on), _state.n, len(people), '   CIRCLE COMPLETE' if all(_state.on) else '')])
        else:
            put_status(frame, ['NOT CALIBRATED: ' + (_cfg_error or ''),
                               'Press "Save calibration frame" and send',
                               'calibration_frame.png to Amir'], color=(255, 80, 80))

    frame = cv2.flip(frame, 0)
    out = np.dstack([frame, np.full(frame.shape[:2], 255, np.uint8)])
    scriptOp.copyNumpyArray(out.astype(np.float32) / 255.0)
    return
