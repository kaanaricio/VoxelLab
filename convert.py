"""
Convert MRI DICOM series into PNG stacks + manifest.json for the viewer.

Auto-discovers MR series from subdirectories under the DICOM root (set via
MRI_VIEWER_DICOM_ROOT or --source).  Sorts slices by patient-space geometry,
applies percentile window/level normalization, and writes one PNG per slice
plus a manifest describing each series.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from geometry import geometry_from_slices, sort_datasets_spatially
from pipeline_paths import (
    ENV_DICOM_ROOT,
    candidate_dicom_files,
    load_manifest,
    resolve_dicom_root,
    slugify,
)
from series_contract import normalize_series_entry

OUT = Path(__file__).parent / "data"

CONVERTER_OWNED_FIELDS = {
    "slug",
    "name",
    "description",
    "modality",
    "sourceFolder",
    "slices",
    "width",
    "height",
    "pixelSpacing",
    "sliceThickness",
    "tr",
    "te",
    "sequence",
    "firstIPP",
    "lastIPP",
    "orientation",
    "sliceSpacing",
    "sliceSpacingRegular",
    "frameOfReferenceUID",
    "group",
}


def discover_mr_series(source: Path) -> list[tuple[str, str, str, str]]:
    """Auto-discover MR DICOM series from subdirectories of *source*.

    Returns list of (folder_name, slug, display_name, description).
    """
    import pydicom

    found: list[tuple[str, str, str, str]] = []
    seen_slugs: set[str] = set()

    for subdir in sorted(source.iterdir()):
        if not subdir.is_dir():
            continue
        files = candidate_dicom_files(subdir)
        if not files:
            continue
        # Peek at first readable MR DICOM to get series metadata
        for f in files[:5]:
            try:
                ds = pydicom.dcmread(f, stop_before_pixels=True)
            except Exception:
                continue
            if str(getattr(ds, "Modality", "")) != "MR":
                continue
            series_desc = str(getattr(ds, "SeriesDescription", "") or "").strip()
            protocol = str(getattr(ds, "ProtocolName", "") or "").strip()
            label = series_desc or protocol or subdir.name
            slug = slugify(label)
            # Deduplicate
            base = slug
            n = 2
            while slug in seen_slugs:
                slug = f"{base}_{n}"
                n += 1
            seen_slugs.add(slug)
            found.append((subdir.name, slug, label, series_desc or label))
            break

    return found


def load_slice(path: Path):
    import numpy as np
    import pydicom

    ds = pydicom.dcmread(path)
    arr = ds.pixel_array.astype(np.float32)
    # Apply modality rescale if present
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    inter = float(getattr(ds, "RescaleIntercept", 0) or 0)
    arr = arr * slope + inter
    return ds, arr


def normalize_stack(stack: np.ndarray) -> np.ndarray:
    """Percentile window/level across whole volume → uint8."""
    lo, hi = np.percentile(stack, [0.5, 99.5])
    if hi <= lo:
        hi = lo + 1
    out = np.clip((stack - lo) / (hi - lo), 0, 1)
    return (out * 255).astype(np.uint8)


def process_series(
    source: Path,
    src_folder: str,
    slug: str,
    name: str,
    description: str,
):
    import numpy as np
    import pydicom
    from PIL import Image

    folder = source / src_folder
    if not folder.is_dir():
        print(f"[{slug}] missing DICOM folder: {folder}", file=sys.stderr)
        return None

    files = candidate_dicom_files(folder)
    print(f"\n[{slug}] {name}  ({len(files)} files)")

    # Read headers, keep only MR slices, sort in patient space.
    entries = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, stop_before_pixels=True)
        except Exception:
            continue
        if str(getattr(ds, "Modality", "")) != "MR":
            continue
        entries.append((ds, f))
    entries = sort_datasets_spatially(entries, get_dataset=lambda item: item[0])
    print(f"  kept {len(entries)} MR slices")

    if not entries:
        print(f"[{slug}] no MR slices after filtering", file=sys.stderr)
        return None

    # Load pixel data
    arrs, loaded = [], []
    for _header, f in entries:
        ds, arr = load_slice(f)
        arrs.append(arr)
        loaded.append(ds)

    stack = np.stack(arrs)  # (N, H, W)

    # Normalize whole volume together so contrast is consistent across slices
    norm = normalize_stack(stack)

    # Write PNGs
    out_dir = OUT / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    for i, img in enumerate(norm):
        Image.fromarray(img, mode="L").save(out_dir / f"{i:04d}.png", optimize=True)

    # Collect metadata
    meta_first = loaded[0]
    geometry = geometry_from_slices(loaded)
    rows = int(meta_first.Rows)
    cols = int(meta_first.Columns)
    pixel_spacing = geometry["pixelSpacing"]
    thickness = float(geometry["sliceThickness"])

    info = normalize_series_entry({
        "slug": slug,
        "name": name,
        "description": description,
        "modality": "MR",
        "sourceFolder": src_folder,
        "slices": len(norm),
        "width": cols,
        "height": rows,
        "pixelSpacing": [float(pixel_spacing[0]), float(pixel_spacing[1])],
        "sliceThickness": thickness,
        "sliceSpacing": float(geometry["sliceSpacing"]),
        "sliceSpacingRegular": bool(geometry["sliceSpacingRegular"]),
        "tr": float(getattr(meta_first, "RepetitionTime", 0) or 0),
        "te": float(getattr(meta_first, "EchoTime", 0) or 0),
        "sequence": str(getattr(meta_first, "SequenceName", "")),
        "firstIPP": geometry["firstIPP"],
        "lastIPP": geometry["lastIPP"],
        "orientation": geometry["orientation"],
        "frameOfReferenceUID": geometry["frameOfReferenceUID"],
        "group": None,
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": False,
        "studyDate": str(getattr(meta_first, "StudyDate", "") or ""),
    })
    print(f"  → {info['slices']} slices, {cols}×{rows}, spacing={info['pixelSpacing']}, thickness={thickness}mm")
    return info


def upsert_series(manifest: dict, entries: list[dict], study_date: str) -> dict:
    series = list(manifest.get("series", []))
    by_slug = {entry.get("slug"): index for index, entry in enumerate(series) if isinstance(entry, dict)}
    for entry in entries:
        item = dict(entry)
        item.pop("studyDate", None)
        slug = item["slug"]
        if slug in by_slug:
            merged = dict(series[by_slug[slug]])
            for key in CONVERTER_OWNED_FIELDS:
                if key in item:
                    merged[key] = item[key]
            series[by_slug[slug]] = merged
        else:
            series.append(item)
    manifest["series"] = series
    manifest.setdefault("patient", "anonymous")
    if not manifest.get("studyDate") and study_date:
        manifest["studyDate"] = study_date
    return manifest


def main() -> bool:
    ap = argparse.ArgumentParser(
        description="Convert MRI DICOMs to PNG stacks + manifest.json",
    )
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root directory (default: {ENV_DICOM_ROOT} env var)",
    )
    _ = ap.add_argument(
        "--list",
        action="store_true",
        help="List discovered MR series without converting",
    )
    _ = ap.add_argument(
        "filters",
        nargs="*",
        metavar="SLUG_OR_FOLDER",
        help="Folder names or slugs to process (default: all discovered MR series)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    series = discover_mr_series(source)
    if not series:
        print("No MR DICOM series found in subdirectories.", file=sys.stderr)
        return False

    if args.list:
        print(f"Discovered {len(series)} MR series:")
        for folder, slug, name, desc in series:
            print(f"  {folder:15s} → {slug:20s}  {name}")
        return True

    wanted = set(args.filters) if args.filters else None
    OUT.mkdir(exist_ok=True)
    manifest = load_manifest(OUT)
    converted = []
    discovered_study_date = ""
    for folder, slug, name, desc in series:
        if wanted is not None and slug not in wanted and folder not in wanted:
            continue
        info = process_series(source, folder, slug, name, desc)
        if info is None:
            continue
        discovered_study_date = discovered_study_date or info.get("studyDate", "")
        converted.append(info)

    manifest = upsert_series(manifest, converted, discovered_study_date)

    manifest_path = OUT / "manifest.json"
    _ = manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {manifest_path}")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
