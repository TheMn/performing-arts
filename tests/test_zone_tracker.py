"""Tests for td/scripts/zone_tracker.py. Run:  python -m unittest discover tests"""

import math
import os
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'td', 'scripts'))
import zone_tracker as zt  # noqa: E402

W, H = 1280, 720


def camera_project(x, y, z=0.0):
    """A fake camera mounted above the painting: 2.6 m high at the wall, tilted 48 deg down, wide lens,
    facing the room. Floor (x, y, 0) in metres -> normalised image (u, v), top-left origin."""
    cam = np.array([0.0, -0.2, 2.6])
    tilt = math.radians(48)
    f = 0.55 * W
    p = np.array([x, y, z]) - cam
    # camera axes: right = +x, forward = (0, cos, -sin), down = (0, -sin, -cos)
    forward = np.array([0.0, math.cos(tilt), -math.sin(tilt)])
    down = np.array([0.0, -math.sin(tilt), -math.cos(tilt)])
    # the camera faces the visitors, so the visitor's right (+x) is the image's LEFT
    right_img = np.array([-1.0, 0.0, 0.0])
    zc = p @ forward
    u = (f * (p @ right_img) / zc + W / 2) / W
    v = (f * (p @ down) / zc + H / 2) / H
    return u, v


FLOOR_MARKERS = [(-1.5, 1.0), (1.5, 1.0), (1.5, 3.5), (-1.5, 3.5)]


def calibrated_config():
    cfg = zt.merge_config(zt.DEFAULT_CONFIG, {})
    cfg['calibration']['floor_points_m'] = [list(p) for p in FLOOR_MARKERS]
    cfg['calibration']['image_points'] = [list(camera_project(*p)) for p in FLOOR_MARKERS]
    return cfg


def fake_pose(foot_uv, visible=True):
    """33 landmarks; feet at foot_uv, body drawn above it."""
    lms = []
    for i in range(33):
        u, v = foot_uv
        lift = 0.0 if i in zt.FEET_LANDMARKS else 0.3
        lms.append(SimpleNamespace(x=u, y=v - lift, visibility=(1.0 if (visible or i not in zt.FEET_LANDMARKS) else 0.1)))
    return lms


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.cfg = calibrated_config()
        cal = self.cfg['calibration']
        self.fm = zt.FloorMap(cal['image_points'], cal['floor_points_m'])

    def test_roundtrip_floor_image(self):
        self.assertTrue(self.fm.ok)
        for x, y in [(0, 2), (-1.2, 0.8), (2.0, 3.0), (0.3, 1.7)]:
            u, v = camera_project(x, y)
            fx, fy = self.fm.image_to_floor(u, v)
            self.assertAlmostEqual(fx, x, places=6)
            self.assertAlmostEqual(fy, y, places=6)
            bu, bv = self.fm.floor_to_image(x, y)
            self.assertAlmostEqual(bu, u, places=6)
            self.assertAlmostEqual(bv, v, places=6)

    def test_sectors_left_to_right_for_visitor(self):
        z = self.cfg['zones']
        self.assertEqual(zt.classify(z, -1.5, 1.0)[0], 0)      # far left (-56 deg)
        self.assertEqual(zt.classify(z, -0.4, 1.5)[0], 1)
        self.assertEqual(zt.classify(z, 0.4, 1.5)[0], 2)
        self.assertEqual(zt.classify(z, 1.5, 1.0)[0], 3)       # far right

    def test_rings_and_outside(self):
        z = self.cfg['zones']
        self.assertEqual(zt.classify(z, 0.1, 1.0)[1], 0)
        self.assertEqual(zt.classify(z, 0.1, 2.0)[1], 1)
        self.assertEqual(zt.classify(z, 0.1, 3.0)[1], 2)
        self.assertEqual(zt.classify(z, 0.1, 0.2)[:2], (None, None))   # too close to the painting
        self.assertEqual(zt.classify(z, 0.1, 4.0)[:2], (None, None))   # beyond the last ring
        self.assertEqual(zt.classify(z, -3.0, 0.6)[:2], (None, None))  # outside the fan

    def test_volume_closer_is_louder(self):
        v, z = self.cfg['volume'], self.cfg['zones']
        self.assertAlmostEqual(zt.volume_for(v, z, 0.5, 0), 1.0)
        self.assertAlmostEqual(zt.volume_for(v, z, 3.5, 2), 0.25)
        self.assertGreater(zt.volume_for(v, z, 1.0, 0), zt.volume_for(v, z, 3.0, 2))
        v = dict(v, mode='rings')
        self.assertEqual(zt.volume_for(v, z, 2.0, 1), 0.6)

    def test_degenerate_calibration(self):
        fm = zt.FloorMap([[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.2]], FLOOR_MARKERS)
        self.assertFalse(fm.ok)
        self.assertFalse(zt.FloorMap([], []).ok)

    def test_foot_point_uses_feet_not_hips(self):
        pose = fake_pose((0.4, 0.8))
        self.assertEqual(zt.foot_point(pose, 0.5), (0.4, 0.8))
        self.assertIsNone(zt.foot_point(fake_pose((0.4, 0.8), visible=False), 0.5))

    def test_process_poses_picks_nearest_in_sector(self):
        far = fake_pose(camera_project(0.5, 3.0))
        near = fake_pose(camera_project(0.4, 1.0))
        det, people = zt.process_poses([far, near], self.cfg, self.fm)
        self.assertEqual(list(det.keys()), [2])
        self.assertAlmostEqual(det[2][2], math.hypot(0.4, 1.0), places=4)
        self.assertEqual(len(people), 2)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.t = zt.DEFAULT_CONFIG['timing']

    def run_for(self, s, det, seconds, dt=1 / 30):
        for _ in range(int(round(seconds / dt))):
            s.update(det, dt, self.t)

    def test_enter_and_leave_debounce(self):
        s = zt.ZoneState(4)
        self.run_for(s, {1: (0.8, 0, 1.0)}, 0.2)
        self.assertFalse(s.on[1])
        self.run_for(s, {1: (0.8, 0, 1.0)}, 0.2)
        self.assertTrue(s.on[1])
        self.run_for(s, {}, 0.5)                 # short tracking drop-out: stays on
        self.assertTrue(s.on[1])
        self.run_for(s, {}, 0.6)
        self.assertFalse(s.on[1])

    def test_volume_glides_and_complete_fade(self):
        s = zt.ZoneState(4)
        all4 = {i: (1.0, 0, 1.0) for i in range(4)}
        self.run_for(s, all4, 2.0)
        self.assertTrue(all(s.on))
        self.assertAlmostEqual(s.vol[0], 1.0, places=2)
        rows = dict(s.rows(4, True))
        self.assertEqual(rows['complete'], 1)
        self.assertEqual(rows['zones_on'], 4)
        self.assertGreater(rows['complete_fade'], 0.4)
        self.run_for(s, all4, 2.0)
        self.assertEqual(dict(s.rows(4, True))['complete_fade'], 1.0)
        self.run_for(s, {0: (1.0, 0, 1.0), 1: (1.0, 0, 1.0), 2: (1.0, 0, 1.0)}, 1.5)
        rows = dict(s.rows(3, True))
        self.assertEqual(rows['complete'], 0)
        self.assertLess(rows['complete_fade'], 1.0)
        self.assertEqual(rows['zone4_vol'] < 0.5, True)


class FakeTable:
    def __init__(self):
        self.cells = {}
        self.numRows = 0
        self.numCols = 0
        self.nodeX = self.nodeY = 0

    def setSize(self, r, c):
        self.numRows, self.numCols = r, c

    def __setitem__(self, key, value):
        self.cells[key] = value

    def as_dict(self):
        return {self.cells[(r, 0)]: self.cells[(r, 1)] for r in range(self.numRows)}


class FakeComp:
    def __init__(self):
        self.children = {}

    def op(self, name):
        return self.children.get(name)

    def create(self, kind, name):
        self.children[name] = FakeTable()
        return self.children[name]


class TouchDesignerRunTests(unittest.TestCase):
    """Runs onCook() with fake TD globals and a fake MediaPipe result."""

    def test_on_cook_writes_table_and_image(self):
        import json
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, zt.CONFIG_FILE), 'w') as f:
            json.dump(calibrated_config(), f)

        # four people, one in each sector, plus the camera image TD would hand us (bottom-up RGBA float)
        spots = [(-1.3, 1.2), (-0.4, 2.0), (0.5, 1.4), (1.6, 2.6)]
        poses = [fake_pose(camera_project(x, y)) for x, y in spots]
        img = np.zeros((H, W, 4), np.float32)

        clock = SimpleNamespace(seconds=0.0)
        comp = FakeComp()
        stored = {}
        script_op = SimpleNamespace(
            inputs=[SimpleNamespace(numpyArray=lambda delayed=True: img)],
            parent=lambda: comp, nodeX=0, nodeY=0, par=SimpleNamespace(),
            store=lambda k, v: stored.__setitem__(k, v),
            copyNumpyArray=lambda a: stored.__setitem__('image', a))

        zt.project = SimpleNamespace(folder=tmp)
        zt.absTime = clock
        zt.tableDAT = object()
        zt._cfg = None
        zt._state = None
        zt._landmarker = SimpleNamespace(
            detect_for_video=lambda image, ts: SimpleNamespace(pose_landmarks=poses), close=lambda: None)
        zt._landmarker_key = (4, 0.5, 0.5)
        fake_mp = types.ModuleType('mediapipe')
        fake_mp.Image = lambda image_format, data: data
        fake_mp.ImageFormat = SimpleNamespace(SRGB=1)
        sys.modules['mediapipe'] = fake_mp
        try:
            for _ in range(60):          # 2 seconds at 30 fps
                clock.seconds += 1 / 30
                zt.onCook(script_op)
        finally:
            del sys.modules['mediapipe']

        out = comp.op(zt.OUTPUT_TABLE).as_dict()
        self.assertEqual(out['calibrated'], 1)
        self.assertEqual(out['people'], 4)
        self.assertEqual(out['zones_on'], 4)
        self.assertEqual(out['complete'], 1)
        self.assertEqual([out['zone%d_on' % i] for i in range(1, 5)], [1, 1, 1, 1])
        self.assertGreater(out['zone1_vol'], out['zone4_vol'])     # zone 1 person is nearer
        self.assertEqual(stored['zones'], [True, True, True, True])
        self.assertEqual(stored['image'].shape, (H, W, 4))
        self.assertGreater(stored['image'][:, :, :3].max(), 0.5)  # overlay was drawn


if __name__ == '__main__':
    unittest.main()
