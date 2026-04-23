"""
Convert CT DICOM series into PNG stacks + 16-bit raw volumes + manifest
updates for the viewer.

Auto-discovers CT series from subdirectories under the DICOM root.  For each:
  1. Read every non-sidecar file with pydicom.dcmread(force=True).
  2. Keep only Modality == 'CT' slices with PixelData.
  3. Sort by patient-space geometry (IPP/IOP), not InstanceNumber.
  4. Apply RescaleSlope/Intercept to get Hounsfield units
        HU = pixel * slope + intercept
  5. Write 8-bit PNGs using a soft-tissue window (L=40, W=400 → [-160, 240])
     so a non-radiologist can scan the whole stack at a glance.
  6. Write a 16-bit raw volume using a fixed HU window [-1024, +2048] →
     [0, 1] — this is what the 3D renderer reads.
  7. Append / replace an entry in data/manifest.json.

CT has huge dynamic range (air -1000 HU → bone +1000 HU), so two output
products:
  • PNGs  = soft-tissue windowed preview, 8-bit, what 2D mode shows.
  • .raw  = fixed-window uint16 of the full HU volume, what 3D mode shows.
            The 3D preset in viewer.js then picks a window over that
            normalized [0,1] range.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image

from geometry import geometry_from_slices, sort_datasets_spatially
from convert import CONVERTER_OWNED_FIELDS, upsert_series
from pipeline_paths import (
    ENV_DICOM_ROOT,
    candidate_dicom_files,
    load_manifest,
    resolve_dicom_root,
    slugify,
)
from series_contract import normalize_series_entry

OUT = Path(__file__).parent / "data"

# Soft tissue window for the PNG preview: L=40 W=400 → [-160, 240] HU.
# Anything outside clamps. Bone will saturate, lung will be black, but
# mediastinum/soft tissue is where the eye usually wants to land.
SOFT_L = 40.0
SOFT_W = 400.0
SOFT_LO = SOFT_L - SOFT_W / 2   # -160
SOFT_HI = SOFT_L + SOFT_W / 2   #  240


def discover_ct_folders(source: Path) -> list[tuple[str, str]]:
    """Auto-discover CT DICOM folders under *source*.

    Returns list of (folder_name, slug).
    """
    found: list[tuple[str, str]] = []
    seen_slugs: set[str] = set()

    for subdir in sorted(source.iterdir()):
        if not subdir.is_dir():
            continue
        files = candidate_dicom_files(subdir)
        if not files:
            continue
        # Peek at first readable CT DICOM to get series metadata
        for f in files[:5]:
            try:
                ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
            except Exception:
                continue
            if str(getattr(ds, "Modality", "")) != "CT":
                continue
            series_desc = str(getattr(ds, "SeriesDescription", "") or "").strip()
            label = series_desc or subdir.name
            slug = slugify(label)
            if not slug.startswith("ct"):
                slug = f"ct_{slug}"
            # Deduplicate
            base = slug
            n = 2
            while slug in seen_slugs:
                slug = f"{base}_{n}"
                n += 1
            seen_slugs.add(slug)
            found.append((subdir.name, slug))
            break

    return found


def read_ct_slices(folder: Path):
    """Read every DICOM in the folder, return the sorted list of CT datasets
    that actually have pixel data. Broken / non-CT files are silently dropped.
    """
    entries = []
    skipped_nonct = 0
    skipped_broken = 0
    for f in candidate_dicom_files(folder):
        try:
            ds = pydicom.dcmread(f, force=True)
        except Exception:
            skipped_broken += 1
            continue
        if str(getattr(ds, "Modality", "")) != "CT":
            skipped_nonct += 1
            continue
        if not hasattr(ds, "PixelData"):
            skipped_broken += 1
            continue
        # Touching pixel_array validates the transfer syntax / compression
        # support. Pydicom will raise here if the file is unreadable.
        try:
            _ = ds.pixel_array.shape
        except Exception:
            skipped_broken += 1
            continue
        entries.append(ds)
    entries = sort_datasets_spatially(entries)
    if skipped_nonct or skipped_broken:
        print(f"    skipped: {skipped_nonct} non-CT, {skipped_broken} broken")
    return entries


def stack_to_hu(slices) -> np.ndarray:
    """Stack sorted CT datasets into (D, H, W) float32 HU volume."""
    arrs = []
    for ds in slices:
        pix = ds.pixel_array.astype(np.float32)
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        inter = float(getattr(ds, "RescaleIntercept", 0) or 0)
        arrs.append(pix * slope + inter)
    return np.stack(arrs)


def hu_to_png_soft_tissue(vol: np.ndarray) -> np.ndarray:
    """Soft tissue window → uint8 (D, H, W)."""
    out = np.clip((vol - SOFT_LO) / (SOFT_HI - SOFT_LO), 0.0, 1.0)
    return (out * 255).astype(np.uint8)


def hu_to_raw_uint16(vol: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Fixed-HU rescale to uint16. Maps HU [-1024, +2048] → [0, 65535].
    Unlike the brain MR pipeline (rehires.py) we can NOT use a percentile
    clip on positive HU only — that was the original approach here, and it
    crushed every soft-tissue voxel into the bottom ~4% of the normalized
    range (because bone dominates the upper percentiles), while clipping
    every lung / fat / air voxel to exactly 0. The viewer's window presets
    then couldn't distinguish lung from air or muscle from fat, and the
    default "Soft tissue" preset rendered a handful of bone fragments
    instead of organs.
    A fixed HU window fixes all of that at once. The clinical HU range is
    effectively [-1024, ~2000], so the mapping is:
      air      (HU -1000) → 0.007
      lung     (HU  -800) → 0.073
      fat      (HU  -100) → 0.301
      water    (HU     0) → 0.334
      soft     (HU    40) → 0.346
      muscle   (HU    80) → 0.359
      bone     (HU  +400) → 0.464
      cortical (HU +1500) → 0.821
    CT_WINDOWS in js/constants.js is the inverse of this mapping.
    Returns (u16, lo, hi) so the metadata records which HU window was
    used — important for the hover-readout to display physical HU values."""
    LO_HU, HI_HU = -1024.0, 2048.0
    scaled = np.clip((vol.astype(np.float32) - LO_HU) / (HI_HU - LO_HU), 0, 1)
    return (scaled * 65535).astype(np.uint16), LO_HU, HI_HU


def safe_list(val, n=None):
    """Cast DICOM MultiValue / None / scalar → plain Python list of floats."""
    if val is None:
        return []
    try:
        out = [float(x) for x in val]
    except TypeError:
        out = [float(val)]
    if n is not None:
        out = out[:n] + [0.0] * max(0, n - len(out))
    return out


def process_folder(source: Path, src_name: str, slug: str) -> dict | None:
    folder = source / src_name
    print(f"\n[{slug}] reading {src_name}")
    slices = read_ct_slices(folder)
    if not slices:
        print(f"  no CT slices — skipping")
        return None

    vol_hu = stack_to_hu(slices)       # (D, H, W) float32 HU
    D, H, W = vol_hu.shape
    hu_min, hu_max = float(vol_hu.min()), float(vol_hu.max())
    print(f"  slices={D}  dims={W}x{H}  HU=[{hu_min:.0f}, {hu_max:.0f}]")
    if D <= 3:
        print(f"  WARNING: very few slices ({D}) — likely a scout or preview")

    # 8-bit soft-tissue PNGs for 2D
    png_stack = hu_to_png_soft_tissue(vol_hu)
    out_dir = OUT / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    # Wipe any stale slices in case slice count changed on a rerun.
    for old in out_dir.glob("*.png"):
        old.unlink()
    for i, img in enumerate(png_stack):
        Image.fromarray(img, mode="L").save(out_dir / f"{i:04d}.png", optimize=True)

    # 16-bit raw volume for 3D
    u16, lo, hi = hu_to_raw_uint16(vol_hu)
    raw_path = OUT / f"{slug}.raw"
    _ = raw_path.write_bytes(u16.tobytes())
    raw_mb = raw_path.stat().st_size / 1024 / 1024

    # Manifest fields
    first = slices[0]
    geometry = geometry_from_slices(slices)
    pixel_spacing = geometry["pixelSpacing"]
    thickness = float(geometry["sliceThickness"])
    first_ipp = geometry["firstIPP"]
    last_ipp = geometry["lastIPP"]
    orientation = geometry["orientation"]
    series_desc = str(getattr(first, "SeriesDescription", "") or "").strip()
    kernel_raw = getattr(first, "ConvolutionKernel", "")
    if isinstance(kernel_raw, (list, tuple, pydicom.multival.MultiValue)):
        kernel = ", ".join(str(k) for k in kernel_raw)
    else:
        kernel = str(kernel_raw or "")

    display_name = series_desc or slug
    description = f"{series_desc} · {D} slices" if series_desc else f"{D} slices"

    entry = normalize_series_entry({
        "slug": slug,
        "name": display_name,
        "description": description,
        "modality": "CT",
        "sourceFolder": src_name,
        "slices": D,
        "width": int(W),
        "height": int(H),
        "pixelSpacing": [float(pixel_spacing[0]), float(pixel_spacing[1])],
        "sliceThickness": thickness,
        "sliceSpacing": float(geometry["sliceSpacing"]),
        "sliceSpacingRegular": bool(geometry["sliceSpacingRegular"]),
        "tr": 0,
        "te": 0,
        "sequence": kernel or series_desc,
        "firstIPP": first_ipp,
        "lastIPP": last_ipp,
        "orientation": orientation,
        "frameOfReferenceUID": geometry["frameOfReferenceUID"],
        "group": None,
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": True,
    })

    print(
        f"  wrote {len(png_stack)} PNGs + {raw_path.name} ({raw_mb:.1f} MB)  "
        + f"raw window=[{lo:.0f}, {hi:.0f}] HU"
    )
    return entry




def main() -> bool:
    ap = argparse.ArgumentParser(
        description="Convert CT DICOM series to PNG + raw volumes + manifest.",
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
        help="List discovered CT series without converting",
    )
    _ = ap.add_argument(
        "filters",
        nargs="*",
        metavar="SLUG_OR_FOLDER",
        help="Folder names or slugs to process (default: all discovered CT series)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    ct_series = discover_ct_folders(source)
    if not ct_series:
        print("No CT DICOM series found in subdirectories.", file=sys.stderr)
        return False

    if args.list:
        print(f"Discovered {len(ct_series)} CT series:")
        for folder, slug in ct_series:
            print(f"  {folder:15s} → {slug}")
        return True

    requested = set(args.filters) if args.filters else set()

    OUT.mkdir(exist_ok=True)
    results = []
    for folder, slug in ct_series:
        if requested and slug not in requested and folder not in requested:
            continue
        try:
            entry = process_folder(source, folder, slug)
            if entry is not None:
                results.append(entry)
        except Exception as e:
            print(f"  ERROR on {folder}: {e}", file=sys.stderr)
            import traceback

            traceback.print_exc(file=sys.stderr)

    if results:
        manifest = load_manifest(OUT)
        manifest = upsert_series(manifest, results, "")
        _ = (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(f"\nWrote {OUT / 'manifest.json'}")

    print("\n=== summary ===")
    for r in results:
        print(
            f"  {r['slug']:12s} {r['slices']:4d} slices  "
            + f"{r['width']}x{r['height']}"
        )
    print(f"  ({len(results)} / {len(ct_series)} series processed)")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
