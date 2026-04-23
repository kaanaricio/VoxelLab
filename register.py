"""
Verifies rigid co-registration between brain MR series that the viewer's
"Compare" mode currently assumes are aligned.

For each non-reference brain series we run an ANTsPy rigid registration to
t1_se (the cleanest, highest-resolution series) and compute four alignment
metrics:

  - normalized MSE within the intersection of the nonzero extents
  - mutual information
  - dice overlap of binary tissue masks
  - rigid transform magnitude (translation + rotation pulled from the affine)

The result is written to data/registration.json so the viewer can decide
whether to flash a "registration mismatch" warning in Compare mode.

Run from a Python env with ANTsPy installed. This script only writes
data/registration.json.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import ants
import numpy as np
import pydicom

from geometry import geometry_from_slices, sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, candidate_dicom_files, resolve_dicom_root, slug_source_map

DATA = Path(__file__).parent / "data"

REFERENCE = "t1_se"
MOVING_SLUGS = ["t2_tse", "flair", "dwi_adc", "swi_3d"]

# Approximate adult brain radius for converting an angular rotation into a
# linear displacement at the surface of the brain — used as a sanity number
# in the report so a viewer dev can reason about "how far did pixels move".
BRAIN_RADIUS_MM = 80.0


def scaled_pixel_array(dataset: pydicom.dataset.FileDataset) -> np.ndarray:
    """Return pixel data with DICOM rescale applied as float32."""
    slope = float(getattr(dataset, "RescaleSlope", 1) or 1)
    intercept = float(getattr(dataset, "RescaleIntercept", 0) or 0)
    return dataset.pixel_array.astype(np.float32) * slope + intercept


def load_series(source: Path, slug: str, sources: dict[str, str]):
    """Load a brain MR DICOM series as an ants image.

    Reads DICOMs, keeps MR brain/head slices, sorts by patient-space geometry.
    Volume axis order is (D, H, W) which we transpose to (W, H, D) for ANTs
    (it expects x, y, z fastest-first). Returns None on failure.
    """
    src = sources.get(slug)
    if not src:
        print(f"  [{slug}] no sourceFolder in manifest", file=sys.stderr)
        return None
    folder = source / src
    files = candidate_dicom_files(folder)

    mr = []
    for f in files:
        try:
            d = pydicom.dcmread(f)
        except Exception:
            continue
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        mr.append(d)
    mr = sort_datasets_spatially(mr)

    if not mr:
        print(f"no MR slices found for {slug} in {folder}", file=sys.stderr)
        return None

    arrs = [scaled_pixel_array(d) for d in mr]
    vol_dhw = np.stack(arrs)                            # (D, H, W)
    vol_xyz = np.transpose(vol_dhw, (2, 1, 0))          # (W, H, D) → (x, y, z)

    geometry = geometry_from_slices(mr)
    spacing = (
        float(geometry["pixelSpacing"][1]),
        float(geometry["pixelSpacing"][0]),
        float(geometry["sliceSpacing"]),
    )
    origin = tuple(float(x) for x in geometry["firstIPP"])
    direction = np.array([
        [geometry["orientation"][0], geometry["orientation"][3], 0.0],
        [geometry["orientation"][1], geometry["orientation"][4], 0.0],
        [geometry["orientation"][2], geometry["orientation"][5], 0.0],
    ], dtype=np.float64)
    direction[:, 2] = np.cross(direction[:, 0], direction[:, 1])
    last = geometry["lastIPP"]
    first = geometry["firstIPP"]
    if len(last) >= 3 and len(first) >= 3 and len(mr) > 1:
        slice_dir = np.array([
            (last[0] - first[0]) / max(1, len(mr) - 1),
            (last[1] - first[1]) / max(1, len(mr) - 1),
            (last[2] - first[2]) / max(1, len(mr) - 1),
        ], dtype=np.float64)
        slice_norm = np.linalg.norm(slice_dir)
        if slice_norm > 1e-6:
            direction[:, 2] = slice_dir / slice_norm

    img = ants.from_numpy(
        vol_xyz,
        origin=origin,
        spacing=spacing,
        direction=direction,
    )
    print(
        f"  [{slug:8s}] shape={vol_xyz.shape}  spacing={spacing}  "
        + f"origin={tuple(round(o, 2) for o in origin)}",
        flush=True,
    )
    return img


def alignment_metrics(fixed: ants.core.ants_image.ANTsImage,
                      warped: ants.core.ants_image.ANTsImage) -> dict:
    """Compute MSE (intersection-masked, intensity-normalized), MI, and Dice."""
    f = fixed.numpy()
    w = warped.numpy()

    if f.shape != w.shape:
        # ANTs resamples warped into fixed space, so this shouldn't happen,
        # but if it does we bail loudly rather than silently mis-comparing.
        raise RuntimeError(f"shape mismatch: fixed={f.shape} warped={w.shape}")

    fmax = float(f.max()) if f.size else 1.0
    wmax = float(w.max()) if w.size else 1.0
    if fmax <= 0:
        fmax = 1.0
    if wmax <= 0:
        wmax = 1.0

    # Intersection of nonzero extents — only score where *both* volumes
    # have signal, so background-vs-background doesn't drag MSE to zero
    # and crop-edges don't drag dice down.
    f_mask = f > 0
    w_mask = w > 0
    inter = f_mask & w_mask

    if inter.any():
        f_in = f[inter] / fmax
        w_in = w[inter] / wmax
        mse_norm = float(np.mean((f_in - w_in) ** 2))
    else:
        mse_norm = float("nan")

    try:
        mi = float(ants.image_mutual_information(fixed, warped))
    except Exception as e:
        print(f"    (mutual_information failed: {e})", flush=True)
        mi = float("nan")

    # Dice on tissue masks. 5% of max is a conservative noise floor that
    # works across MR contrasts (T1, T2, FLAIR, ADC, SWI all have black
    # background and bright-ish tissue at >5%).
    f_bin = f > (0.05 * fmax)
    w_bin = w > (0.05 * wmax)
    denom = f_bin.sum() + w_bin.sum()
    if denom > 0:
        dice = float(2.0 * (f_bin & w_bin).sum() / denom)
    else:
        dice = float("nan")

    return {
        "mse_normalized":     mse_norm,
        "mutual_information": mi,
        "dice":               dice,
    }


def transform_magnitude(tform_paths: list) -> dict:
    """Pull translation + rotation out of the rigid transform file ANTs wrote.

    ANTs writes its rigid transform as an ITK affine .mat with 12 parameters:
    9 for the 3x3 matrix (row-major) + 3 for the translation. The fixed
    parameters store the rotation center, which we ignore for *magnitude*
    purposes (rotation is invariant under center choice; translation as
    reported here is the raw translation parameter, not center-corrected).
    """
    rigid_path = None
    for p in tform_paths:
        # ants returns mat for affine/rigid, nii.gz for warps
        if p.endswith(".mat"):
            rigid_path = p
            break
    if rigid_path is None and tform_paths:
        rigid_path = tform_paths[0]

    tx, ty, tz = 0.0, 0.0, 0.0
    rot_deg = 0.0

    if rigid_path is not None:
        tf = ants.read_transform(rigid_path)
        params = np.array(tf.parameters, dtype=np.float64)
        if params.size >= 12:
            R = params[:9].reshape(3, 3)
            t = params[9:12]
            tx, ty, tz = float(t[0]), float(t[1]), float(t[2])
            trace = float(np.trace(R))
            cos_theta = (trace - 1.0) / 2.0
            cos_theta = max(-1.0, min(1.0, cos_theta))
            rot_deg = float(math.degrees(math.acos(cos_theta)))
        elif params.size == 6:
            # Some ITK rigid encodings use (rx, ry, rz, tx, ty, tz) Euler angles.
            tx, ty, tz = float(params[3]), float(params[4]), float(params[5])
            rx, ry, rz = float(params[0]), float(params[1]), float(params[2])
            rot_deg = float(math.degrees(math.sqrt(rx * rx + ry * ry + rz * rz)))

    translation_mag = math.sqrt(tx * tx + ty * ty + tz * tz)
    rot_displacement = BRAIN_RADIUS_MM * math.radians(rot_deg)

    return {
        "translation_mm":           [tx, ty, tz],
        "translation_magnitude_mm": translation_mag,
        "rotation_deg":             rot_deg,
        "rotation_magnitude_mm":    rot_displacement,
    }


def verdict_for(translation_mag: float, rotation_deg: float, dice: float) -> str:
    if (translation_mag < 2.0 and rotation_deg < 2.0 and dice > 0.9):
        return "aligned"
    if (translation_mag < 5.0 and rotation_deg < 5.0 and dice > 0.8):
        return "slightly off"
    return "misregistered"


def main() -> bool:
    ap = argparse.ArgumentParser(description="Rigid registration metrics for Compare mode.")
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
        help="Series to include (default: t1_se + all moving); reference is added if any moving is listed",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    if args.slugs:
        slugs = set(args.slugs)
        if any(m in slugs for m in MOVING_SLUGS):
            slugs.add(REFERENCE)
        to_load = [s for s in [REFERENCE] + MOVING_SLUGS if s in slugs]
    else:
        to_load = [REFERENCE] + MOVING_SLUGS

    print("Loading brain MR series", flush=True)
    sources = slug_source_map()
    imgs = {}
    for slug in to_load:
        img = load_series(source, slug, sources)
        if img is not None:
            imgs[slug] = img
        else:
            print(f"  [{slug}] FAILED to load", file=sys.stderr, flush=True)

    if REFERENCE not in imgs:
        print(
            f"reference {REFERENCE} failed to load — aborting",
            file=sys.stderr,
        )
        return False

    fixed = imgs[REFERENCE]

    pairs = {}
    runtimes = {}
    print("\nRegistering each moving series to t1_se", flush=True)
    for slug in MOVING_SLUGS:
        if slug not in imgs:
            print(f"  [{slug}] skipped (not loaded)", flush=True)
            pairs[slug] = {"error": "failed to load"}
            continue
        moving = imgs[slug]

        t0 = time.time()
        try:
            reg = ants.registration(
                fixed=fixed,
                moving=moving,
                type_of_transform="Rigid",
                verbose=False,
            )
        except Exception as e:
            print(f"  [{slug}] registration FAILED: {e}", flush=True)
            pairs[slug] = {"error": f"registration failed: {e}"}
            continue
        elapsed = time.time() - t0
        runtimes[slug] = elapsed

        warped = reg["warpedmovout"]
        tform_paths = reg["fwdtransforms"]

        metrics = alignment_metrics(fixed, warped)
        magnitude = transform_magnitude(tform_paths)

        v = verdict_for(
            magnitude["translation_magnitude_mm"],
            magnitude["rotation_deg"],
            metrics["dice"],
        )

        pairs[slug] = {
            "translation_mm":          magnitude["translation_mm"],
            "translation_magnitude_mm": magnitude["translation_magnitude_mm"],
            "rotation_deg":            magnitude["rotation_deg"],
            "rotation_magnitude_mm":   magnitude["rotation_magnitude_mm"],
            "mse_normalized":          metrics["mse_normalized"],
            "mutual_information":      metrics["mutual_information"],
            "dice":                    metrics["dice"],
            "verdict":                 v,
            "runtime_seconds":         elapsed,
        }
        print(f"  [{slug:8s}] done in {elapsed:.1f}s  verdict={v}", flush=True)

    out = {
        "reference": REFERENCE,
        "pairs":     pairs,
        "method":    "ANTsPy ants.registration type_of_transform='Rigid' to t1_se",
        "ants_version": ants.__version__,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    out_path = DATA / "registration.json"
    _ = out_path.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {out_path}  ({out_path.stat().st_size} bytes)", flush=True)

    print("\nPer-pair summary:")
    for slug in MOVING_SLUGS:
        if slug not in imgs:
            continue
        p = pairs.get(slug, {})
        if "error" in p:
            print(f"  {slug:8s}  ERROR: {p['error']}")
            continue
        print(
            f"  {slug:8s}  "
            + f"translation={p['translation_magnitude_mm']:.2f} mm   "
            + f"rotation={p['rotation_deg']:.2f} deg   "
            + f"dice={p['dice']:.3f}   "
            + f"verdict={p['verdict']}"
        )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
