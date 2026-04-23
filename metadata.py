"""
Enriches manifest.json with DICOM spatial metadata so the viewer can:
  1. Sync scrubbing across co-registered series (Compare mode)
  2. Report physical (mm) coordinates under the cursor
  3. Compute tissue volumes in mL from segmentation

Reads the original DICOMs from a configurable root directory and pulls:
  - ImagePositionPatient of the first and last slice  (origin + Z span)
  - ImageOrientationPatient                           (row/col direction vectors)
  - FrameOfReferenceUID and slice-spacing regularity

Then it assigns compare groups from canonical patient-space identity so
co-registered series can share the same scrubber without relying on
origin-only heuristics.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from geometry import compare_group_key, geometry_from_slices, sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, candidate_dicom_files, resolve_dicom_root, slug_source_map

DATA = Path(__file__).parent / "data"

def read_spatial(source: Path, src_folder: str) -> dict:
    import pydicom

    folder = source / src_folder
    files = candidate_dicom_files(folder)
    mr = []
    for f in files:
        try:
            d = pydicom.dcmread(f, stop_before_pixels=True)
        except Exception:
            continue
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        if str(getattr(d, "BodyPartExamined", "")).upper() not in ("", "BRAIN", "HEAD"):
            continue
        mr.append(d)
    if not mr:
        return {}
    mr = sort_datasets_spatially(mr)
    geometry = geometry_from_slices(mr)
    return {
        "firstIPP": geometry["firstIPP"],
        "lastIPP": geometry["lastIPP"],
        "orientation": geometry["orientation"],
        "sliceSpacing": geometry["sliceSpacing"],
        "sliceSpacingRegular": geometry["sliceSpacingRegular"],
        "frameOfReferenceUID": geometry["frameOfReferenceUID"],
    }


def cluster_by_origin(series_list: list, tol: float = 2.0) -> None:
    """Tag each series with the canonical compare-group key."""
    for s in series_list:
        key = compare_group_key(s)
        if key is None:
            continue
        s["group"] = key


def main() -> bool:
    ap = argparse.ArgumentParser(description="Add spatial metadata to manifest.json.")
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
        help="Limit to these series slugs (default: all with sourceFolder in manifest)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    wanted = set(args.slugs) if args.slugs else None

    path = DATA / "manifest.json"
    m = json.loads(path.read_text())
    sources = slug_source_map()
    for s in m["series"]:
        if wanted is not None and s["slug"] not in wanted:
            continue
        src = sources.get(s["slug"])
        if not src:
            continue
        spatial = read_spatial(source, src)
        s.update(spatial)
        print(f"[{s['slug']:8s}] firstIPP={spatial.get('firstIPP')}")

    cluster_by_origin(m["series"])
    for s in m["series"]:
        print(f"  {s['slug']:8s} group={s.get('group')}")

    _ = path.write_text(json.dumps(m, indent=2))
    print(f"\nWrote {path}")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
