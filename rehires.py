"""
High-precision volume exporter for the 3D renderer.

The PNG-based pipeline in convert.py quantizes to 8 bits per voxel after a
global window/level. That's fine for the 2D slice viewer (Canvas2D is 8-bit
anyway), but it looks *banded* in the 3D volume render — you can see the
quantization steps as soft contour lines on smooth intensity gradients.

This script re-reads the original DICOMs at full precision and writes a
binary little-endian uint16 volume file per series to data/<slug>.raw.
The viewer loads it as an ArrayBuffer → THREE.Data3DTexture with
UnsignedShortType, giving ~65k intensity levels instead of 256. The
difference in 3D is obvious: gradients are smooth, lighting is cleaner,
edges are sharper.

Also writes data/<slug>_hr.json with:
  - dims (W, H, D)
  - voxel range (min, max)
  - suggested window/level for 3D rendering (sequence-aware)

Size: ~30 MB per 768x768x27 series. Acceptable.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pydicom

from geometry import sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, candidate_dicom_files, resolve_dicom_root, slug_source_map

DATA = Path(__file__).parent / "data"


def load_dicom_volume(source: Path, src_folder: str) -> np.ndarray:
    folder = source / src_folder
    files = candidate_dicom_files(folder)
    mr = []
    for f in files:
        d = pydicom.dcmread(f)
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        if str(getattr(d, "BodyPartExamined", "")).upper() not in ("", "BRAIN", "HEAD"):
            continue
        mr.append(d)
    mr = sort_datasets_spatially(mr)
    arrs = [d.pixel_array for d in mr]
    return np.stack(arrs)  # (D, H, W)


def process(series: dict, source: Path, sources: dict[str, str]) -> bool:
    slug = series["slug"]
    src = sources.get(slug)
    if not src:
        print(f"[{slug}] no sourceFolder in manifest — skipping", flush=True)
        return False

    print(f"\n=== {slug} (from {src}) ===", flush=True)
    try:
        vol = load_dicom_volume(source, src)   # (D, H, W)
    except Exception as e:
        print(f"[{slug}] ERROR: {e}", file=sys.stderr)
        return False
    D, H, W = vol.shape
    print(
        f"  shape: {vol.shape}   dtype: {vol.dtype}   "
        + f"range: {vol.min()}..{vol.max()}",
        flush=True,
    )

    # Clip to a robust percentile range to kill extreme outliers (e.g.
    # a single hot pixel). Rescale to uint16 so the whole dynamic range
    # is used — the viewer scales back to [0, 1] in the shader.
    nz = vol[vol > 0]
    if nz.size:
        lo, hi = np.percentile(nz, [0.1, 99.9])
    else:
        lo, hi = 0, max(int(vol.max()), 1)
    lo = float(lo)
    hi = float(hi)
    scaled = np.clip((vol.astype(np.float32) - lo) / max(hi - lo, 1e-6), 0, 1)
    u16 = (scaled * 65535).astype(np.uint16)

    # Important: three.js Data3DTexture expects row-major with depth as the
    # slowest axis — that's (D, H, W) in row-major, which is what we have.
    raw_path = DATA / f"{slug}.raw"
    _ = raw_path.write_bytes(u16.tobytes())

    meta = {
        "slug":   slug,
        "dims":   [W, H, D],
        "bits":   16,
        "dtype":  "uint16",
        "layout": "DHW",             # slowest axis first
        "rescale": {"lo": lo, "hi": hi},
    }
    _ = (DATA / f"{slug}_hr.json").write_text(json.dumps(meta, indent=2))

    print(f"  wrote {raw_path.name} ({raw_path.stat().st_size / 1024 / 1024:.1f} MB)", flush=True)
    series["hasRaw"] = True
    return True


def main() -> bool:
    ap = argparse.ArgumentParser(description="Export uint16 .raw volumes for 3D mode.")
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
        help="Series slugs to process (default: all in manifest with mapping)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    path = DATA / "manifest.json"
    m = json.loads(path.read_text())
    sources = slug_source_map()
    requested = set(args.slugs) if args.slugs else set()
    for s in m["series"]:
        if requested and s["slug"] not in requested:
            continue
        _ = process(s, source, sources)
    _ = path.write_text(json.dumps(m, indent=2))
    print("\nDone. Refresh the viewer.", flush=True)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
