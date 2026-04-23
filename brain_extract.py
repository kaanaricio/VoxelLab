"""
High-accuracy skull stripping using HD-BET (MIC-DKFZ), a deep-learning
brain extraction tool trained on thousands of MRIs.

For each series this script:
  1. Reads the original 16-bit DICOMs (NOT the 8-bit PNG stacks) so HD-BET
     sees full intensity precision
  2. Writes a temporary NIfTI file with correct voxel spacing
  3. Runs HD-BET in **accurate mode** (test-time augmentation + 5-fold
     ensemble) for significantly cleaner masks
  4. Writes re-normalized 8-bit PNGs to data/<slug>_brain/ for the viewer
  5. Also writes the raw brain mask to data/<slug>_mask.raw for the 3D
     shader to gate voxels without having to rely on PNG zero-checking
  6. Marks hasBrain: true in manifest.json

Uses Apple Silicon MPS if available, falls back to CPU.
"""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
import torch
from PIL import Image

from HD_BET.hd_bet_prediction import get_hdbet_predictor, hdbet_predict

from geometry import affine_lps_from_series, geometry_from_slices, sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, candidate_dicom_files, resolve_dicom_root, slug_source_map

DATA = Path(__file__).parent / "data"


def scaled_pixel_array(dataset: pydicom.dataset.FileDataset) -> np.ndarray:
    slope = float(getattr(dataset, "RescaleSlope", 1) or 1)
    intercept = float(getattr(dataset, "RescaleIntercept", 0) or 0)
    return dataset.pixel_array.astype(np.float32) * slope + intercept


def pick_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_dicom_series(source: Path, src_folder: str) -> list:
    """Read DICOMs from source/<src_folder> and return sorted MR datasets.

    Preserves full intensity precision — no 8-bit quantization in this path.
    """
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
    return sort_datasets_spatially(mr)


def stack_to_nifti(stack: np.ndarray, series_entry: dict, out: Path):
    """Save a float32 stack as NIfTI with correct voxel spacing."""
    vol = np.transpose(stack, (2, 1, 0))                # (W, H, D)
    affine_lps = np.asarray(affine_lps_from_series(series_entry), dtype=np.float32)
    affine = np.diag([-1.0, -1.0, 1.0, 1.0]).astype(np.float32) @ affine_lps
    nib.save(nib.Nifti1Image(vol.astype(np.float32), affine), str(out))


def nifti_to_stack(path: Path) -> np.ndarray:
    vol = nib.load(str(path)).get_fdata()               # (W, H, D)
    return np.transpose(vol, (2, 1, 0))                 # (D, H, W)


def process(slug: str, predictor, source: Path, sources: dict[str, str]) -> bool:
    src = sources.get(slug)
    if not src:
        print(f"[{slug}] no sourceFolder in manifest — skipping", file=sys.stderr)
        return False

    m = json.loads((DATA / "manifest.json").read_text())
    series = next(s for s in m["series"] if s["slug"] == slug)
    # Load the original DICOM volume at full precision (usually 12-16 bit)
    try:
        datasets = load_dicom_series(source, src)
        stack = np.stack([scaled_pixel_array(d) for d in datasets])
    except Exception as e:
        print(f"[{slug}] ERROR loading DICOM: {e}", file=sys.stderr)
        return False
    geometry = geometry_from_slices(datasets)
    series = {**series, **geometry}
    print(
        f"\n[{slug}] {stack.shape} from {src}, "
        + f"voxel={series['pixelSpacing'][0]:.3f}×{series['pixelSpacing'][1]:.3f}×{series['sliceSpacing']:.3f} mm, "
        + f"range={stack.min():.0f}..{stack.max():.0f}"
    )

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        in_path      = tdp / f"{slug}_0000.nii.gz"
        out_masked   = tdp / f"{slug}.nii.gz"
        out_mask     = tdp / f"{slug}_bet.nii.gz"  # HD-BET's default mask suffix

        stack_to_nifti(stack, series, in_path)
        print(f"[{slug}] running HD-BET (accurate mode with TTA)...")
        hdbet_predict(
            input_file_or_folder=str(in_path),
            output_file_or_folder=str(out_masked),
            predictor=predictor,
            keep_brain_mask=True,
            compute_brain_extracted_image=True,
        )

        masked = nifti_to_stack(out_masked).astype(np.float32)
        # HD-BET's mask output sits next to the masked volume
        mask_candidate = out_masked.parent / (out_masked.stem.replace(".nii", "") + "_bet.nii.gz")
        if not mask_candidate.exists():
            # Alternate naming: HD-BET sometimes writes <stem>_bet.nii.gz
            for cand in out_masked.parent.glob("*_bet.nii.gz"):
                mask_candidate = cand
                break
        mask = nifti_to_stack(mask_candidate).astype(np.uint8) if mask_candidate.exists() else (masked > 0).astype(np.uint8)

    # Re-normalize inside the mask using robust percentile clipping. Using
    # the original DICOM precision here (instead of pre-normalized 8-bit)
    # gives dramatically better contrast in the output — tissue boundaries
    # that were crushed by 8-bit quantization now show proper gradation.
    nz = masked[mask > 0]
    if nz.size:
        lo, hi = np.percentile(nz, [0.5, 99.5])
        masked8 = np.clip((masked - lo) / max(hi - lo, 1), 0, 1) * 255
        masked8[mask == 0] = 0
    else:
        masked8 = np.zeros_like(masked)
    masked8 = masked8.astype(np.uint8)

    kept = float(mask.sum()) / mask.size
    print(
        f"[{slug}] brain mask keeps {kept:.1%} of voxels "
        + f"(from DICOM range {nz.min() if nz.size else 0:.0f}..{nz.max() if nz.size else 0:.0f})"
    )

    out_dir = DATA / f"{slug}_brain"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir()
    for i, img in enumerate(masked8):
        Image.fromarray(img, mode="L").save(out_dir / f"{i:04d}.png", optimize=True)

    # Also write the raw binary mask for the 3D shader. Packed uint8.
    _ = (DATA / f"{slug}_mask.raw").write_bytes(mask.astype(np.uint8).tobytes())

    print(
        f"[{slug}] wrote {masked8.shape[0]} slices → {out_dir} "
        + f"+ {slug}_mask.raw ({mask.nbytes} bytes)"
    )
    return True


def update_manifest(slugs):
    path = DATA / "manifest.json"
    m = json.loads(path.read_text())
    for s in m["series"]:
        if s["slug"] in slugs:
            s["hasBrain"] = True
            s["hasMaskRaw"] = True
    _ = path.write_text(json.dumps(m, indent=2))


def main() -> bool:
    ap = argparse.ArgumentParser(description="HD-BET skull stripping → brain PNG stacks + mask.raw.")
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
        help="Series slugs to process (default: all in manifest)",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    device = pick_device()
    print(f"Device: {device}")
    print("Loading HD-BET predictor (accurate mode: TTA enabled)...")
    # use_tta=True enables test-time augmentation: HD-BET runs the model on
    # the original volume AND several axis flips, then averages. Roughly
    # 5x slower but visibly cleaner masks, especially at the brain edge.
    predictor = get_hdbet_predictor(use_tta=True, device=device, verbose=False)

    m = json.loads((DATA / "manifest.json").read_text())
    sources = slug_source_map()
    requested = args.slugs or [s["slug"] for s in m["series"]]

    ok = []
    for slug in requested:
        meta = next((s for s in m["series"] if s["slug"] == slug), None)
        if not meta:
            print(f"unknown slug: {slug}", file=sys.stderr)
            continue
        try:
            if process(slug, predictor, source, sources):
                ok.append(slug)
        except Exception as e:
            print(f"[{slug}] ERROR: {e}", file=sys.stderr)
            import traceback

            traceback.print_exc(file=sys.stderr)

    update_manifest(ok)
    print("\nDone. Refresh the viewer.")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
