#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["ccl-segb @ git+https://github.com/cclgroupltd/ccl-segb"]
# ///
"""Generate the SEGB v2 test fixture for the TS parser.

Synthesizes a small SEGB v2 file with SYNTHETIC App.InFocus-shaped payloads
(fake bundle ids, fixed 2026-01-05 timestamps - never real usage data; this
repo is public), covering the format's edge cases:

  - written records (state 1), incl. non-4-aligned data lengths (padding)
  - a deleted record (state 3) - still carries readable data
  - a state-4 empty record
  - a zeroed/unused trailer slot (state 0)
  - two trailer entries sharing one end offset (write-then-delete)

The file is then parsed with ccl-segb (the Python reference implementation)
and the records it yields are written as expected.json - the TS parser test
asserts byte-identical agreement, which breaks the write-your-own-bug
circularity of testing a parser against a file you also wrote.

Output: src/lib/data/fixtures/infocus.segb + expected.json. Deterministic -
rerunning produces identical bytes.
"""

import base64
import json
import pathlib
import struct
import zlib
from datetime import datetime, timezone

from ccl_segb import read_segb_file

OUT_DIR = pathlib.Path(__file__).parent.parent / "src/lib/data/fixtures"
COCOA_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


def cocoa(dt: datetime) -> float:
    return (dt - COCOA_EPOCH).total_seconds()


def ts(hour: int, minute: int, second: float) -> datetime:
    whole = int(second)
    micro = round((second - whole) * 1e6)
    return datetime(2026, 1, 5, hour, minute, whole, micro, tzinfo=timezone.utc)


# --- minimal protobuf writer (only what App.InFocus payloads use) ---


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field_varint(num: int, val: int) -> bytes:
    return varint(num << 3 | 0) + varint(val)


def field_fixed64_double(num: int, val: float) -> bytes:
    return varint(num << 3 | 1) + struct.pack("<d", val)


def field_str(num: int, val: str) -> bytes:
    raw = val.encode()
    return varint(num << 3 | 2) + varint(len(raw)) + raw


def infocus_payload(bundle: str, focus: int, event_time: datetime, extra: bytes = b"") -> bytes:
    """Mirror of the real payload shape: 2=type, 3=focus gained/lost,
    4=timestamp (double as fixed64), 6=bundle id, 9=version, 13=flag."""
    return (
        field_varint(2, 1)
        + field_varint(3, focus)
        + field_fixed64_double(4, cocoa(event_time))
        + field_str(6, bundle)
        + field_str(9, "26.0")
        + extra
        + field_varint(13, 1)
    )


# --- SEGB v2 writer ---


def write_segb2(records: list[tuple[float, int, bytes | None]], creation: float) -> bytes:
    """records: (trailer_timestamp_cocoa, state, data|None). None data with
    state 0/4 emits a trailer-only slot pinned to the current end offset.
    A (ts, 3, b\"SAME\") sentinel after a written record dups its end offset."""
    body = bytearray()
    trailer = bytearray()
    end_offset = 0  # relative to end of 32-byte header (post-padding)
    last_entry_end = 0  # last written record's recorded (pre-padding) end
    for t, state, data in records:
        if data == b"SAME":
            trailer += struct.pack("<2id", last_entry_end, state, t)
            continue
        if data is not None:
            entry = struct.pack("<Ii", zlib.crc32(data), 0) + data
            body += entry
            end_offset += len(entry)
            last_entry_end = end_offset
            trailer += struct.pack("<2id", end_offset, state, t)
            if end_offset % 4:
                pad = 4 - end_offset % 4
                body += b"\x00" * pad
                end_offset += pad
        else:
            trailer += struct.pack("<2id", end_offset, state, t)
    n = len(records)
    header = struct.pack("<4sid16s", b"SEGB", n, creation, b"\x00" * 16)
    return bytes(header + body + trailer)


APP1, APP2, SYS = "com.example.appone", "com.example.apptwo", "com.example.springboard.home"

records = [
    (cocoa(ts(9, 0, 0.25)), 1, infocus_payload(APP1, 1, ts(9, 0, 0.25))),
    (cocoa(ts(9, 0, 30.75)), 1, infocus_payload(APP1, 0, ts(9, 0, 30.75))),
    # odd-length payload -> exercises 4-byte alignment padding
    (cocoa(ts(9, 1, 0)), 1, infocus_payload(APP2, 1, ts(9, 1, 0), extra=field_str(10, "1.2.3"))),
    (cocoa(ts(9, 2, 0)), 1, infocus_payload(APP2, 0, ts(9, 2, 0))),
    # deleted record - data still present and readable
    (cocoa(ts(9, 3, 0)), 3, infocus_payload(SYS, 1, ts(9, 3, 0))),
    # zeroed/unused trailer slot
    (0.0, 0, None),
    # state-4 empty record
    (cocoa(ts(9, 4, 0)), 4, None),
    # written record whose end offset is shared by a later deleted-marker
    (cocoa(ts(9, 5, 0)), 1, infocus_payload(APP1, 1, ts(9, 5, 0))),
    (cocoa(ts(9, 6, 0)), 3, b"SAME"),
]

blob = write_segb2(records, creation=cocoa(ts(8, 0, 0)))
OUT_DIR.mkdir(parents=True, exist_ok=True)
(OUT_DIR / "infocus.segb").write_bytes(blob)

# A biome-streams-shaped tar.gz (built with Python's tarfile - the reference
# implementation the TS untar is tested against). Deterministic: fixed mtimes,
# gzip mtime=0.
import gzip
import io
import tarfile

tar_buf = io.BytesIO()
with tarfile.open(fileobj=tar_buf, mode="w", format=tarfile.USTAR_FORMAT) as tf:
    DEV = "AAAAAAAA-1111-2222-3333-444444444444"
    for name, data in [
        (f"App.InFocus/remote/{DEV}/800000000000001", blob),
        (f"App.InFocus/remote/{DEV}/tombstone/800000000000000", blob),
        ("App.InFocus/local/800000000000002", b"not-a-segb-file"),
    ]:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mtime = int(ts(8, 0, 0).timestamp())
        tf.addfile(info, io.BytesIO(data))
    d = tarfile.TarInfo(f"App.InFocus/remote/{DEV}")
    d.type = tarfile.DIRTYPE
    d.mtime = int(ts(8, 0, 0).timestamp())
    tf.addfile(d)
(OUT_DIR / "streams.tar.gz").write_bytes(gzip.compress(tar_buf.getvalue(), mtime=0))

expected = [
    {
        "timestamp": r.timestamp1.replace(tzinfo=timezone.utc).isoformat(),
        "state": int(r.state),
        "crcPassed": r.crc_passed,
        "dataBase64": base64.b64encode(r.data).decode(),
    }
    for r in read_segb_file(OUT_DIR / "infocus.segb")
]
(OUT_DIR / "expected.json").write_text(json.dumps(expected, indent=1) + "\n")
print(f"wrote {len(blob)} bytes, ccl-segb yields {len(expected)} records")
for e in expected:
    print(f"  state={e['state']} ts={e['timestamp']} bytes={len(base64.b64decode(e['dataBase64']))}")
