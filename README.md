# sonificARTE

Visitors move in front of Matisse's *Dance*. A camera finds where each person stands on the floor, and each of the 4 floor sectors plays one layer of our Farandole-inspired composition: the closer to the painting, the louder. When all 4 sectors are full, the circle is complete and the painting turns from its pale version to the vivid red one.

| Folder | What | Owner |
|---|---|---|
| `td/scripts/zone_tracker.py` | Script TOP code for TouchDesigner: camera → people → floor zones → `zone_data` table | Amir |
| `td/zones_config.json` | floor calibration and zone sizes, reloaded live by TouchDesigner | Amir |
| `td/pose_landmarker_lite.task` | MediaPipe pose model (goes next to the `.toe`) | |
| `tools/calibrate_zones.py` | click the 4 floor markers on a camera frame → calibrated `zones_config.json` | Amir |
| `tests/` | tests for the zone logic, no TouchDesigner needed: `python -m unittest discover tests` | Amir |
| `docs/WORKFLOW.md` | who does what, sequence diagram, data contract, calibration steps | both |
| TouchDesigner project (`.toe` / `.tox`) | music layers, painting, projection | Gaz |

Start with [docs/WORKFLOW.md](docs/WORKFLOW.md).

`DEMO_PLAN.md` is the earlier browser-only prototype spec (Tone.js, 5 people). It is kept for reference and is not the current plan.
