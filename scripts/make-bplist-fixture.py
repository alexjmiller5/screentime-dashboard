#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Generate the binary-plist fixture for the TS bplist parser.

Builds a DeviceActivity-ActivitySegment-shaped dict (SYNTHETIC apps/domains -
this repo is public) plus edge-case values, writes it as a binary plist with
plistlib (the reference implementation), and writes the same structure as
JSON for the test to compare against. Deterministic output.
"""

import json
import pathlib
import plistlib

OUT_DIR = pathlib.Path(__file__).parent.parent / "src/lib/data/fixtures"

segment = {
    "value": {
        "totalActivityDuration": 7154.5,
        "categoryActivities": [
            {
                "identifier": "DH1009",
                "totalActivityDuration": 3560.25,
                "applicationActivities": [],
                "webDomainActivities": [
                    {"domain": "example-movies.test", "isTrusted": True, "totalActivityDuration": 3558.5},
                    {"domain": "ads.example.test", "isTrusted": False, "totalActivityDuration": 1.75},
                ],
            },
            {
                "identifier": "DH1011",
                "totalActivityDuration": 3594.25,
                "applicationActivities": [
                    {
                        "bundleIdentifier": "com.example.browser.ios",
                        "isTrusted": True,
                        "numberOfNotifications": 0,
                        "numberOfPickups": 3,
                        "totalActivityDuration": 3594.25,
                    }
                ],
                "webDomainActivities": [],
            },
        ],
    },
    # edge cases for the parser beyond what segments use
    "edge": {
        "unicode": "café 日本語",
        "negative": -42,
        "big": 2**40,
        "zero": 0,
        "false": False,
        "longString": "x" * 300,  # 2-byte length marker path
        "manyItems": list(range(20)),  # multi-byte count path
    },
}

blob = plistlib.dumps(segment, fmt=plistlib.FMT_BINARY)
(OUT_DIR / "segment.bplist").write_bytes(blob)
(OUT_DIR / "segment-expected.json").write_text(json.dumps(segment, indent=1, sort_keys=True) + "\n")

# A device-activity.tar.gz shaped like the real capture: Cloud per-device
# Daily segments (parsed), plus Hourly and Local files (ignored).
import gzip
import io
import tarfile

DEV = "BBBBBBBB-1111-2222-3333-444444444444"
tar_buf = io.BytesIO()
with tarfile.open(fileobj=tar_buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
    for name in [
        f"com.apple.DeviceActivity/Cloud/000830-08-user/{DEV}/Daily/ActivitySegments/809409600.0.plist",
        f"com.apple.DeviceActivity/Cloud/000830-08-user/{DEV}/Hourly/ActivitySegments/809409600.0.plist",
        "com.apple.DeviceActivity/Local/Daily/ActivitySegments/809409600.0.plist",
    ]:
        info = tarfile.TarInfo(name)
        info.size = len(blob)
        info.mtime = 1787400000
        tf.addfile(info, io.BytesIO(blob))
(OUT_DIR / "device-activity.tar.gz").write_bytes(gzip.compress(tar_buf.getvalue(), mtime=0))
print(f"wrote fixtures ({len(blob)} bytes bplist + device-activity.tar.gz)")
