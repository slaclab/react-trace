#!/usr/bin/env python3
"""Synthetic ORM frame, seeded: Correlation's statistics oracle and its goldens.

X is one corrector setpoint stepping 0, +8, -8, +4, -4, 0 A, 15 rows per step,
one row a second; four BPM X columns are each ``Y = slope * X + offset + noise``.
Null cells are scattered over X and the Ys, and one row is null in every
column, so the pairwise-non-null rule is exercised.

Outputs (deterministic: a fixed RNG seed, no timestamps):

* ``orm-frame.json``: ``{columnPvs, table}`` where ``table`` has the shape of
  a Fox ``table`` result (``tsNs``, ``columns``, ``inputs``, ``totalRows``).
* ``golden.json``: per column, over pairwise non-null rows: ``n``, ``mean``,
  ``std`` (sample, ddof = 1), and for each Y ``r`` (clipped to [-1, 1]), ``r2``,
  and ``slope`` / ``intercept`` from ``numpy.polyfit(x, y, 1)``.

Re-running reproduces both files byte for byte and prints their sha256.

Usage::

    uv run --with numpy scripts/make_orm_fixture.py [--out DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

DEFAULT_OUT = (
    Path(__file__).resolve().parent.parent
    / "src"
    / "tools"
    / "correlation"
    / "__fixtures__"
)

SEED = 20261002
T0_NS = 1_790_000_000_000_000_000
"""First row's timestamp; every row is a whole second later, exact as a float64."""
NS_PER_S = 1_000_000_000
STEPS_A = (0.0, 8.0, -8.0, 4.0, -4.0, 0.0)
DWELL_ROWS = 15
NOISE_M = 2.0e-8

X_PV = "SR:MAG:HCM:01:CURRENT:SP"
# (column, PV, slope m/A, offset m)
YS = (
    ("y1", "SR:DIAG:BPM:01:POSITION:X", 4.456e-6, 1.2e-5),
    ("y2", "SR:DIAG:BPM:12:POSITION:X", -5.793e-6, -3.4e-6),
    ("y3", "SR:DIAG:BPM:17:POSITION:X", -2.550e-6, 7.0e-6),
    ("y4", "SR:DIAG:BPM:19:POSITION:X", 5.458e-6, -1.1e-5),
)

# Row indices (0-based) left null, per column. Row ALL_NULL_ROW is null everywhere.
ALL_NULL_ROW = 47
NULLS = {
    "x": (3, 31, 62),
    "y1": (5, 20, 77),
    "y2": (8, 31, 59, 88),
    "y3": (12,),
    "y4": (0, 1, 66),
}


def build_frame() -> dict:
    rng = np.random.default_rng(SEED)
    x = np.repeat(np.array(STEPS_A), DWELL_ROWS)
    rows = x.size
    columns: dict[str, list[float | None]] = {"x": [float(v) for v in x]}
    for name, _pv, slope, offset in YS:
        y = slope * x + offset + rng.normal(0.0, NOISE_M, rows)
        columns[name] = [float(v) for v in y]
    for name, indices in NULLS.items():
        for i in indices:
            columns[name][i] = None
    for name in columns:
        columns[name][ALL_NULL_ROW] = None

    inputs = {
        name: {"history": "seeded", "status": "ok", "lateAfterFinal": False}
        for name in columns
    }
    column_pvs = {"x": X_PV, **{name: pv for name, pv, _s, _o in YS}}
    return {
        "columnPvs": column_pvs,
        "table": {
            "tsNs": [T0_NS + i * NS_PER_S for i in range(rows)],
            "columns": columns,
            "inputs": inputs,
            "totalRows": rows,
        },
    }


def _pairs(
    xs: list[float | None], ys: list[float | None]
) -> tuple[np.ndarray, np.ndarray]:
    keep = [
        (a, b) for a, b in zip(xs, ys, strict=True) if a is not None and b is not None
    ]
    return np.array([a for a, _ in keep]), np.array([b for _, b in keep])


def build_golden(frame: dict) -> dict:
    columns = frame["table"]["columns"]
    xs_all = np.array([v for v in columns["x"] if v is not None])
    golden: dict = {
        "x": {
            "pv": frame["columnPvs"]["x"],
            "n": int(xs_all.size),
            "mean": float(np.mean(xs_all)),
            "std": float(np.std(xs_all, ddof=1)),
        },
        "ys": {},
    }
    for name, pv, _slope, _offset in YS:
        x, y = _pairs(columns["x"], columns[name])
        slope, intercept = np.polyfit(x, y, 1)
        r = float(np.clip(np.corrcoef(x, y)[0, 1], -1.0, 1.0))
        golden["ys"][name] = {
            "pv": pv,
            "n": int(x.size),
            "mean": float(np.mean(y)),
            "std": float(np.std(y, ddof=1)),
            "r": r,
            "r2": r * r,
            "slope": float(slope),
            "intercept": float(intercept),
        }
    return golden


def _dump(obj: dict) -> bytes:
    return (json.dumps(obj, indent=2) + "\n").encode()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help="output directory"
    )
    args = parser.parse_args()

    frame = build_frame()
    golden = build_golden(frame)
    args.out.mkdir(parents=True, exist_ok=True)
    frame_bytes = _dump(frame)
    golden_bytes = _dump(golden)
    (args.out / "orm-frame.json").write_bytes(frame_bytes)
    (args.out / "golden.json").write_bytes(golden_bytes)
    print(f"orm-frame.json sha256 {hashlib.sha256(frame_bytes).hexdigest()}")
    print(f"golden.json    sha256 {hashlib.sha256(golden_bytes).hexdigest()}")


if __name__ == "__main__":
    main()
