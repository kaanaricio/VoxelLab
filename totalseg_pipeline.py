"""
Run TotalSegmentator on the user's chest CT (and brain MR) volumes,
then write per-slice label PNGs + a legend JSON in the same shape that
the existing viewer expects (same as regions.py output).

Replaces the heuristic regions.py output for these series with REAL
nnU-Net based anatomical labels.
"""

from __future__ import annotations

import argparse
import colorsys
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
from PIL import Image
from scipy import ndimage

from geometry import affine_lps_from_series, geometry_from_slices, series_effective_slice_spacing, sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, resolve_dicom_root, slug_source_map, series_by_modality

ROOT = Path(__file__).parent
DATA = ROOT / "data"

# A clinically useful subset of the 104 TS classes that are likely present
# in a chest CT. We pass this with --roi_subset so the run is much faster
# than the full model. The names must match TotalSegmentator's class names
# exactly.
CT_ROI_SUBSET = [
    "lung_upper_lobe_left", "lung_lower_lobe_left",
    "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right",
    "heart", "aorta", "inferior_vena_cava", "pulmonary_vein",
    "trachea", "esophagus",
    "liver", "spleen", "stomach", "gallbladder",
    "kidney_left", "kidney_right",
    "adrenal_gland_left", "adrenal_gland_right",
    "thyroid_gland",
    "vertebrae_T1", "vertebrae_T2", "vertebrae_T3", "vertebrae_T4",
    "vertebrae_T5", "vertebrae_T6", "vertebrae_T7", "vertebrae_T8",
    "vertebrae_T9", "vertebrae_T10", "vertebrae_T11", "vertebrae_T12",
    "vertebrae_L1", "vertebrae_L2",
    "rib_left_1", "rib_left_2", "rib_left_3", "rib_left_4", "rib_left_5",
    "rib_left_6", "rib_left_7", "rib_left_8", "rib_left_9", "rib_left_10",
    "rib_left_11", "rib_left_12",
    "rib_right_1", "rib_right_2", "rib_right_3", "rib_right_4", "rib_right_5",
    "rib_right_6", "rib_right_7", "rib_right_8", "rib_right_9", "rib_right_10",
    "rib_right_11", "rib_right_12",
    "scapula_left", "scapula_right",
    "clavicula_left", "clavicula_right",
    "humerus_left", "humerus_right",
    "sternum",
    "autochthon_left", "autochthon_right",
]

SKIP_NAMES = {".DS_Store", "Thumbs.db", "DICOMDIR"}


def is_candidate(path: Path) -> bool:
    if path.name in SKIP_NAMES:
        return False
    if path.name.startswith("._"):
        return False
    if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".txt", ".json"):
        return False
    return path.is_file()


def read_series_slices(folder: Path, modality: str | None = None,
                       body_parts: set[str] | None = None):
    """Read every DICOM in folder. Optionally filter by Modality and
    BodyPartExamined. Returns slices sorted by patient-space geometry.

    body_parts filter: if given, keeps slices whose BodyPartExamined is in
    the set (case-insensitive). Empty BodyPartExamined is always kept.
    """
    entries = []
    for f in sorted(folder.iterdir()):
        if not is_candidate(f):
            continue
        try:
            ds = pydicom.dcmread(f, force=True)
        except Exception:
            continue
        if modality and str(getattr(ds, "Modality", "")) != modality:
            continue
        if body_parts is not None:
            bp = str(getattr(ds, "BodyPartExamined", "")).upper()
            if bp and bp not in body_parts:
                continue
        if not hasattr(ds, "PixelData"):
            continue
        try:
            _ = ds.pixel_array.shape
        except Exception:
            continue
        entries.append(ds)
    return sort_datasets_spatially(entries)


def stack_to_hu(slices) -> np.ndarray:
    """(D, H, W) float32 in HU for CT."""
    arrs = []
    for ds in slices:
        pix = ds.pixel_array.astype(np.float32)
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        inter = float(getattr(ds, "RescaleIntercept", 0) or 0)
        arrs.append(pix * slope + inter)
    return np.stack(arrs)


def stack_raw(slices) -> np.ndarray:
    """(D, H, W) float32 of pixel data without HU rescaling (for MR)."""
    arrs = [ds.pixel_array.astype(np.float32) for ds in slices]
    return np.stack(arrs)


def write_nifti(vol_dhw: np.ndarray, slices, out_path: Path) -> tuple[float, float, float]:
    """Convert (D, H, W) numpy volume into a NIfTI file at out_path with a
    correctly oriented affine built via the shared geometry contract.

    Without the LPS→RAS conversion, TotalSegmentator will misinterpret
    left/right and label the wrong lungs/kidneys/etc.
    """
    # Use shared geometry contract for affine — no local derivation.
    geo = geometry_from_slices(slices)
    series_dict = {
        "pixelSpacing": geo["pixelSpacing"],
        "sliceSpacing": geo["sliceSpacing"],
        "slices": len(slices),
        "firstIPP": geo["firstIPP"],
        "lastIPP": geo["lastIPP"],
        "orientation": geo["orientation"],
    }
    affine_lps_mat = np.array(affine_lps_from_series(series_dict), dtype=np.float64)
    col_spacing = float(geo["pixelSpacing"][1])
    row_spacing = float(geo["pixelSpacing"][0])
    slice_mm = float(geo["sliceSpacing"])

    # Convert LPS → RAS by negating X and Y rows
    lps_to_ras = np.diag([-1.0, -1.0, 1.0, 1.0])
    affine = lps_to_ras @ affine_lps_mat

    vol_xyz = np.transpose(vol_dhw, (2, 1, 0))  # (W=col, H=row, D=slice)
    img = nib.Nifti1Image(vol_xyz.astype(np.float32), affine)
    nib.save(img, str(out_path))
    return col_spacing, row_spacing, slice_mm


def humanize(name: str) -> str:
    """lung_upper_lobe_left → Lung upper lobe left"""
    return name.replace("_", " ").capitalize()


def golden_color(i: int) -> list[int]:
    """Muted, earthy color via HSV golden-angle spread."""
    h = (i * 0.6180339887) % 1.0
    # Vary value/saturation a bit so consecutive labels feel distinct
    s = 0.40 + 0.10 * ((i * 0.37) % 1.0)
    v = 0.62 + 0.16 * ((i * 0.71) % 1.0)
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]


def combine_ts_outputs(
    ts_dir: Path,
    target_shape_dhw: tuple[int, int, int],
    reference_nii_path: Path,
) -> tuple[np.ndarray, dict[int, str]]:
    """Read every NIfTI mask in ts_dir, combine into a single uint8 (D, H, W)
    label volume, and return (volume, {label_id: structure_name}).

    Orientation: TotalSegmentator internally canonicalizes
    its input to a specific axis orientation before running nnU-Net, then writes
    outputs in that canonical orientation. When the input DICOM series is not
    a standard axial stack (this project has sagittal CT acquisitions), the TS
    output storage order does NOT match the storage order of the NIfTI we sent
    in, and a blind transpose(2, 1, 0) produces labels where lung_left ends up
    on the anatomical right, etc.

    The fix: reorient each TS output to match our reference NIfTI's storage
    orientation using nibabel's `ornt_transform` + `apply_orientation`. After
    reorientation the mask is stored as (W, H, D) — same as the reference —
    and the transpose back to (D, H, W) matches the source DICOM stack layout.
    """
    from nibabel.orientations import (
        io_orientation, ornt_transform, apply_orientation,
    )

    nii_files = sorted([p for p in ts_dir.glob("*.nii.gz")])
    if not nii_files:
        return np.zeros(target_shape_dhw, dtype=np.uint8), {}

    ref_img = nib.load(str(reference_nii_path))
    ref_ornt = io_orientation(ref_img.affine)

    label_vol = np.zeros(target_shape_dhw, dtype=np.uint16)
    legend: dict[int, str] = {}
    next_id = 1

    for nii_path in nii_files:
        name = nii_path.name.replace(".nii.gz", "")
        try:
            mask_img = nib.load(str(nii_path))
            mask_data = np.asarray(mask_img.dataobj)
        except Exception as e:
            print(f"    skip {name}: {e}", flush=True)
            continue

        # Reorient the TS output into the same voxel storage as our input
        # NIfTI. After this call mask_data is in (W, H, D) order, matching
        # the reference.
        mask_ornt = io_orientation(mask_img.affine)
        transform = ornt_transform(mask_ornt, ref_ornt)
        mask_data = apply_orientation(mask_data, transform)

        # (W, H, D) → (D, H, W)
        mask_dhw = np.transpose(mask_data, (2, 1, 0))

        if mask_dhw.shape != target_shape_dhw:
            # Resample with nearest neighbor — typical when --fast was used
            zoom = (
                target_shape_dhw[0] / mask_dhw.shape[0],
                target_shape_dhw[1] / mask_dhw.shape[1],
                target_shape_dhw[2] / mask_dhw.shape[2],
            )
            mask_dhw = ndimage.zoom(mask_dhw, zoom, order=0)
        positive = mask_dhw > 0
        if positive.sum() == 0:
            continue
        legend[next_id] = name
        # Last-write-wins where structures collide (TS structures don't
        # actually overlap, but resampling can introduce single-voxel overlaps).
        label_vol[positive] = next_id
        next_id += 1

    return label_vol.astype(np.uint8) if next_id < 256 else label_vol, legend


def write_outputs(slug: str, label_vol: np.ndarray, legend: dict[int, str],
                  px_x: float, px_y: float, slice_mm: float):
    """Write per-slice PNGs + legend JSON to data/<slug>_regions/* and
    data/<slug>_regions.json. Same shape as regions.py."""
    out_dir = DATA / f"{slug}_regions"
    if out_dir.exists():
        for old in out_dir.glob("*.png"):
            old.unlink()
    out_dir.mkdir(exist_ok=True)

    D = label_vol.shape[0]
    max_label_id = int(label_vol.max()) if label_vol.size else 0
    if max_label_id > np.iinfo(np.uint8).max:
        raise ValueError(
            f"{slug}: label id {max_label_id} exceeds uint8 PNG capacity; "
            + "reduce the ROI set or switch the slice export format"
        )
    for z in range(D):
        Image.fromarray(label_vol[z].astype(np.uint8), mode="L").save(out_dir / f"{z:04d}.png")

    legend_str = {str(k): v for k, v in legend.items()}
    colors = {str(k): golden_color(k) for k in legend}
    voxel_ml = (px_x * px_y * slice_mm) / 1000.0
    regions = {}
    for rid, name in legend.items():
        count = int((label_vol == rid).sum())
        regions[str(rid)] = {
            "name": humanize(name),
            "color": colors[str(rid)],
            "mL": round(count * voxel_ml, 1),
            "voxels": count,
        }

    stats_path = DATA / f"{slug}_regions.json"
    _ = stats_path.write_text(json.dumps({
        "legend": legend_str,
        "colors": colors,
        "regions": regions,
    }, indent=2))

    print(f"  wrote {out_dir.name}/ ({D} slices, {len(legend)} labels) + {stats_path.name}", flush=True)
    # Top 5 by mL
    top = sorted(regions.values(), key=lambda r: -r["mL"])[:5]
    for t in top:
        print(f"    {t['name']:30s} {t['mL']:8.1f} mL", flush=True)
    return out_dir, stats_path


def run_ts(input_nii: Path, output_dir: Path, task: str = "total",
           fast: bool = True, roi_subset: list[str] | None = None) -> bool:
    cmd = ["TotalSegmentator", "-i", str(input_nii), "-o", str(output_dir), "--task", task]
    if fast:
        cmd.append("--fast")
    if roi_subset:
        cmd.append("--roi_subset")
        cmd.extend(roi_subset)
    print(f"  running: {' '.join(cmd[:7])}{' --roi_subset ...' if roi_subset else ''}", flush=True)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    except subprocess.TimeoutExpired:
        print(f"  ERROR: TotalSegmentator timed out", flush=True)
        return False
    if result.returncode != 0:
        print(f"  ERROR: TotalSegmentator failed (rc={result.returncode})", flush=True)
        print(f"  stderr: {result.stderr[-2000:]}", flush=True)
        return False
    print(f"  TotalSegmentator OK", flush=True)
    return True


def process_ct_series(source: Path, slug: str, src_folder: str, manifest: dict) -> bool:
    print(f"\n=== {slug} ({src_folder}) ===", flush=True)
    folder = source / src_folder
    slices = read_series_slices(folder, modality="CT")
    if not slices:
        print(f"  no CT slices in {folder}", flush=True)
        return False

    vol_hu = stack_to_hu(slices)
    D, H, W = vol_hu.shape
    print(f"  loaded {D} slices, {W}x{H}, HU range [{vol_hu.min():.0f}, {vol_hu.max():.0f}]", flush=True)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nii_path = td / f"{slug}.nii.gz"
        px_x, px_y, slice_mm = write_nifti(vol_hu, slices, nii_path)
        print(f"  wrote NIfTI ({nii_path.stat().st_size / 1e6:.1f} MB) spacing=({px_x:.2f}, {px_y:.2f}, {slice_mm:.2f}) mm", flush=True)

        ts_out = td / "ts_out"
        ok = run_ts(nii_path, ts_out, task="total", fast=False, roi_subset=CT_ROI_SUBSET)
        if not ok:
            return False

        label_vol, legend = combine_ts_outputs(ts_out, (D, H, W), nii_path)
        if not legend:
            print(f"  ERROR: no labels produced", flush=True)
            return False

    # Use manifest slice spacing so exported region volumes match the viewer.
    series_entry = next((s for s in manifest["series"] if s["slug"] == slug), None)
    if series_entry is None:
        print(f"  ERROR: {slug} not in manifest", flush=True)
        return False
    m_px = series_entry["pixelSpacing"]
    _ = write_outputs(slug, label_vol, legend, m_px[0], m_px[1], series_effective_slice_spacing(series_entry))

    series_entry["hasRegions"] = True
    series_entry["anatomySource"] = "totalseg"
    return True


def process_mr_brain(source: Path, slug: str, src_folder: str, manifest: dict) -> tuple[bool, str]:
    """Returns (success, task_used)."""
    print(f"\n=== {slug} (MR brain, {src_folder}) ===", flush=True)
    folder = source / src_folder
    slices = read_series_slices(folder, modality="MR", body_parts={"BRAIN", "HEAD"})
    if not slices:
        print(f"  no MR slices in {folder}", flush=True)
        return False, ""

    vol = stack_raw(slices)
    D, H, W = vol.shape
    print(f"  loaded {D} slices, {W}x{H}, intensity [{vol.min():.0f}, {vol.max():.0f}]", flush=True)

    series_entry = next((s for s in manifest["series"] if s["slug"] == slug), None)
    m_px = series_entry["pixelSpacing"]
    m_st = series_effective_slice_spacing(series_entry)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nii_path = td / f"{slug}.nii.gz"
        _ = write_nifti(vol, slices, nii_path)

        # Try tasks in order. brain_structures gives the most relevant labels for a brain MR.
        for task in ("brain_structures", "total_mr", "tissue_types_mr"):
            print(f"\n  --- trying task: {task} ---", flush=True)
            ts_out = td / f"ts_out_{task}"
            # brain_structures is small enough to run at full resolution; total_mr and
            # tissue_types_mr we run with --fast to keep runtime reasonable.
            use_fast = task != "brain_structures"
            ok = run_ts(nii_path, ts_out, task=task, fast=use_fast, roi_subset=None)
            if not ok:
                continue
            label_vol, legend = combine_ts_outputs(ts_out, (D, H, W), nii_path)
            print(f"  task {task} → {len(legend)} labels", flush=True)
            if not legend:
                continue
            _ = write_outputs(slug, label_vol, legend, m_px[0], m_px[1], m_st)
            series_entry["hasRegions"] = True
            series_entry["anatomySource"] = "totalseg"
            return True, task

    print(f"  ERROR: no MR task produced labels for {slug}", flush=True)
    return False, ""


def main() -> bool:
    ap = argparse.ArgumentParser(description="TotalSegmentator → viewer region PNGs.")
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root (default: {ENV_DICOM_ROOT})",
    )
    _ = ap.add_argument(
        "parts",
        nargs="*",
        help="ct | mr | specific slugs to limit (default: run ct + mr)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    DATA.mkdir(exist_ok=True)
    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text())

    tokens = list(args.parts)
    do_ct = not tokens or "ct" in tokens
    do_mr = not tokens or "mr" in tokens
    sources = slug_source_map()
    ct_slugs = series_by_modality("CT")
    mr_slugs = series_by_modality("MR")
    ct_slug_filter = {t for t in tokens if t not in ("ct", "mr")}

    ct_success = []
    if do_ct:
        for slug in ct_slugs:
            src = sources.get(slug)
            if not src:
                print(f"  [{slug}] no sourceFolder in manifest — skipping", flush=True)
                continue
            if ct_slug_filter and slug not in ct_slug_filter:
                continue
            try:
                if process_ct_series(source, slug, src, manifest):
                    ct_success.append(slug)
            except Exception as e:
                import traceback

                print(f"  ERROR on {slug}: {e}", flush=True)
                traceback.print_exc(file=sys.stderr)

    mr_result = (False, "")
    if do_mr:
        # Use first MR series with a T1 weight as the reference, or the first available
        mr_ref = next((s for s in mr_slugs if "t1" in s), mr_slugs[0] if mr_slugs else None)
        mr_src = sources.get(mr_ref, "") if mr_ref else ""
        if mr_ref and mr_src:
            try:
                mr_result = process_mr_brain(source, mr_ref, mr_src, manifest)
            except Exception as e:
                import traceback

                print(f"  ERROR on {mr_ref}: {e}", flush=True)
                traceback.print_exc(file=sys.stderr)
        elif mr_ref:
            print(f"  [{mr_ref}] no sourceFolder in manifest — skipping MR", flush=True)

    # Persist manifest
    _ = manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\n=== summary ===", flush=True)
    print(f"  CT successes: {ct_success}", flush=True)
    print(f"  MR success:   {mr_result}", flush=True)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
