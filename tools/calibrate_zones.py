"""
sonificARTE - floor calibration tool (runs on Amir's laptop, not in TouchDesigner)

Input : calibration_frame.png  (saved by Gaz with the "Save calibration frame" button)
Output: zones_config.json      (Gaz puts it next to the .toe; TD reloads it automatically)

The floor markers' real positions (metres) are read from the config file's
"calibration.floor_points_m". Measure them with a tape measure; see docs/WORKFLOW.md.

Interactive (needs `pip install opencv-python numpy`):
    python tools/calibrate_zones.py calibration_frame.png --config td/zones_config.json
    Click the markers M1, M2, M3, M4 ... in the same order as floor_points_m.
    Keys:  u = undo last click   s = save   q / Esc = quit without saving

Without a window (e.g. pixel positions read from an image viewer):
    python tools/calibrate_zones.py calibration_frame.png --config td/zones_config.json \
        --points "412,655 1510,640 1330,330 590,338" --preview preview.png
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'td', 'scripts'))
import zone_tracker as zt  # noqa: E402


def render(image_rgb, cfg, clicked_norm):
    frame = image_rgb.copy()
    floor_pts = cfg['calibration']['floor_points_m']
    fm = None
    if len(clicked_norm) >= 4 and len(clicked_norm) == len(floor_pts):
        fm = zt.FloorMap(clicked_norm, floor_pts)
        zt.draw_zones(frame, fm, cfg['zones'])
    zt.draw_markers(frame, clicked_norm)
    if len(clicked_norm) < len(floor_pts):
        x, y = floor_pts[len(clicked_norm)]
        zt.put_status(frame, ['Click marker M%d  (floor %.2f, %.2f m)' % (len(clicked_norm) + 1, x, y),
                              'u = undo   s = save   q = quit'])
    elif fm is not None and fm.ok:
        zt.put_status(frame, ['Check the yellow lines match the tape.', 's = save   u = undo   q = quit'])
    else:
        zt.put_status(frame, ['Invalid: ' + (fm.error if fm else 'point count mismatch'), 'u = undo'],
                      color=(255, 80, 80))
    return frame, fm


def save(cfg, clicked_norm, image_shape, path):
    cfg = json.loads(json.dumps(cfg))
    cfg['calibration']['image_points'] = [[round(u, 5), round(v, 5)] for u, v in clicked_norm]
    cfg['calibration']['image_size'] = [int(image_shape[1]), int(image_shape[0])]
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    print('saved', path)


def parse_points(text, w, h):
    pts = []
    for pair in text.replace(';', ' ').split():
        x, y = (float(v) for v in pair.split(','))
        # pixel values if > 1, otherwise already normalised
        pts.append((x / w, y / h) if (x > 1 or y > 1) else (x, y))
    return pts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('image', help='calibration_frame.png from TouchDesigner')
    ap.add_argument('--config', default=os.path.join('td', 'zones_config.json'),
                    help='config to read floor_points_m from and save into (default: td/zones_config.json)')
    ap.add_argument('--out', help='where to save (default: same as --config)')
    ap.add_argument('--points', help='marker positions "x,y x,y ..." in pixels or 0..1; skips the window')
    ap.add_argument('--preview', help='also write a PNG with the zones drawn on the frame')
    args = ap.parse_args()

    bgr = cv2.imread(args.image)
    if bgr is None:
        sys.exit('cannot read image: %s' % args.image)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    cfg, err = zt.load_config(args.config)
    if err:
        print('note:', err, '- using defaults')
    if len(cfg['calibration']['floor_points_m']) < 4:
        sys.exit('config needs at least 4 calibration.floor_points_m (measured marker positions in metres)')
    out_path = args.out or args.config

    if args.points:
        clicked = parse_points(args.points, w, h)
        frame, fm = render(rgb, cfg, clicked)
        if args.preview:
            cv2.imwrite(args.preview, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
            print('preview', args.preview)
        if fm is None or not fm.ok:
            sys.exit('calibration invalid: ' + (fm.error if fm else 'need one point per floor marker'))
        save(cfg, clicked, rgb.shape, out_path)
        return

    clicked = [tuple(p) for p in cfg['calibration'].get('image_points', [])][:len(cfg['calibration']['floor_points_m'])]
    win = 'sonificARTE calibration'
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)

    def on_mouse(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN and len(clicked) < len(cfg['calibration']['floor_points_m']):
            clicked.append((x / w, y / h))

    cv2.setMouseCallback(win, on_mouse)
    while True:
        frame, fm = render(rgb, cfg, clicked)
        cv2.imshow(win, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        key = cv2.waitKey(30) & 0xFF
        if key in (ord('q'), 27):
            break
        if key == ord('u') and clicked:
            clicked.pop()
        if key == ord('s'):
            if fm is not None and fm.ok:
                save(cfg, clicked, rgb.shape, out_path)
                if args.preview:
                    cv2.imwrite(args.preview, cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
                break
            print('not saved: click all markers first')
    cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
