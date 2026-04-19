"""
One-shot re-normalization of CT .raw volumes.

The original convert_ct.py wrote .raw files with a percentile clip on
positive HU only, which crushed soft tissue into the bottom ~4% of the
normalized range and made lung/air indistinguishable (both clipped to 0).

This script rebuilds JUST the .raw files (not the PNGs, not the manifest
entries, not the regions/seg overlays) using the new fixed HU window
[-1024, +2048] → [0, 1] that convert_ct.py was switched to. Run it once
after pulling the convert_ct.py change; the PNGs / TotalSegmentator
regions stay in place.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from convert_ct import OUT, hu_to_raw_uint16, read_ct_slices, stack_to_hu
from pipeline_paths import ENV_DICOM_ROOT, resolve_dicom_root, series_by_modality, slug_source_map


def main() -> bool:
    ap = argparse.ArgumentParser(description="Re-normalize CT .raw volumes in data/.")
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root (default: {ENV_DICOM_ROOT})",
    )
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="CT slugs to rebuild (default: all CT series in manifest)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    sources = slug_source_map()
    ct_slugs = series_by_modality("CT")
    requested = set(args.slugs) if args.slugs else set()

    for slug in ct_slugs:
        if requested and slug not in requested:
            continue
        src_name = sources.get(slug)
        if not src_name:
            print(f"[{slug}] no sourceFolder in manifest — skipping", file=sys.stderr)
            continue
        folder = source / src_name
        if not folder.is_dir():
            print(f"[{slug}] source {folder} missing — skipping", file=sys.stderr)
            continue
        print(f"\n[{slug}] reading {src_name}")
        slices = read_ct_slices(folder)
        if not slices:
            print("  no CT slices — skipping", file=sys.stderr)
            continue
        vol = stack_to_hu(slices)
        D, H, W = vol.shape
        print(f"  shape={W}x{H}x{D}  HU=[{vol.min():.0f}, {vol.max():.0f}]")
        u16, lo, hi = hu_to_raw_uint16(vol)
        raw_path = OUT / f"{slug}.raw"
        _ = raw_path.write_bytes(u16.tobytes())
        print(f"  wrote {raw_path.name} ({raw_path.stat().st_size / 1024 / 1024:.1f} MB)")
        print(f"  normalization: HU [{lo:.0f}, {hi:.0f}] → [0, 1]")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
