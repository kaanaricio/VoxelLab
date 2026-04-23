"""
Reproducible image-math biomarkers for the brain MR series:

  1. SWI microbleed candidates    — Difference-of-Gaussians blob detector
                                    on the brain-stripped SWI volume
  2. FLAIR white-matter hyperintensity burden (WMH)
                                  — percentile + size-filtered threshold
                                    within the HD-BET brain mask
  3. DWI ADC physical units       — read DICOM RescaleSlope/Intercept so
                                    the viewer can show real mm²/s values

None of this is "AI" or novel. These are classical thresholding techniques
with explicit parameters so every result is reproducible. Output lands in
per-series JSON sidecars that the viewer already knows how to read.

NOT A DIAGNOSTIC TOOL. The microbleed detector reports *candidates*, not
confirmed microbleeds — a lot of them will be normal vessels, sulci, and
air-tissue interfaces. Same for WMH: any focal bright voxel in white matter
above the threshold gets counted, including normal perivascular spaces.
Useful for "look at these slices" triage, not for reporting.

Usage:
    python3 biomarkers.py              # run all three
    python3 biomarkers.py microbleeds  # SWI only
    python3 biomarkers.py wmh          # FLAIR only
    python3 biomarkers.py adc          # DWI ADC rescale lookup
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from scipy import ndimage

from geometry import series_effective_slice_spacing, sort_datasets_spatially
from pipeline_paths import ENV_DICOM_ROOT, resolve_dicom_root, slug_source_map

DATA = Path(__file__).parent / "data"


# helpers

def load_brain_stack(slug: str) -> np.ndarray:
    """(D, H, W) uint8 brain-stripped PNG stack from data/<slug>_brain/.

    These are the HD-BET accurate-mode outputs, already skull-stripped,
    intensity-renormalized into 0..255. Outside brain = 0.
    """
    folder = DATA / f"{slug}_brain"
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no brain PNGs in {folder}")
    return np.stack([np.array(Image.open(f).convert("L")) for f in files])


def read_dicom_series(source: Path, src_folder: str) -> list:
    """Return a list of pydicom Datasets for the MR brain files in a source
    folder, sorted by patient-space geometry. Same filter convention as convert.py
    (Modality=MR, body part = BRAIN/HEAD/empty)."""
    folder = source / src_folder
    mr = []
    # Glob all files, not just *.dcm — Siemens DICOMs often lack the extension.
    # Filter by is_file() and skip obvious non-DICOM names.
    skip_names = {".DS_Store", "Thumbs.db", "DICOMDIR"}
    candidates = sorted(f for f in folder.iterdir()
                        if f.is_file() and f.name not in skip_names
                        and not f.name.startswith("._")
                        and f.suffix.lower() not in (".png", ".jpg", ".txt", ".json"))
    for f in candidates:
        d = pydicom.dcmread(f, stop_before_pixels=True)
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        if str(getattr(d, "BodyPartExamined", "")).upper() not in ("", "BRAIN", "HEAD"):
            continue
        mr.append(d)
    return sort_datasets_spatially(mr)


def merge_stats(slug: str, extra: dict) -> None:
    """Merge `extra` into data/<slug>_stats.json, preserving existing keys.
    The viewer already reads this file for symmetry + ventricle data."""
    p = DATA / f"{slug}_stats.json"
    if p.exists():
        cur = json.loads(p.read_text())
    else:
        cur = {"slug": slug}
    _ = cur.update(extra)
    _ = p.write_text(json.dumps(cur, indent=2))


# 1. SWI microbleed candidates

def detect_microbleeds() -> None:
    """Difference-of-Gaussians blob detector on the SWI brain volume.

    Microbleeds on SWI appear as small, round, dark focal spots (strong
    negative contrast due to blooming from iron/hemosiderin). The detector:

      1. Inverts the volume so microbleeds become bright
      2. Computes DoG = small_sigma − large_sigma Gaussian-blurred version
         of the inverted volume. This highlights objects in the size range
         [small_sigma, large_sigma]
      3. Finds local maxima above a threshold
      4. Filters by size (discards anything larger than ~5 mm)
      5. Masks against the HD-BET brain mask to drop scalp/air false hits

    Parameters below are explicit and tuned for clinical microbleed size
    (1–5 mm). Candidates go into data/swi_3d_stats.json + a compact array
    the viewer can use to place scrubber ticks.
    """
    slug = "swi_3d"
    print(f"\n=== {slug} microbleeds ===", flush=True)

    try:
        brain = load_brain_stack(slug)
    except FileNotFoundError as e:
        print(f"  skip: {e}", flush=True)
        return

    D, H, W = brain.shape
    mask = brain > 5
    print(f"  volume: {brain.shape}, brain voxels: {mask.sum():,}", flush=True)

    # Invert so dark = bright. Only inside the brain mask — outside is 0.
    inv = np.zeros_like(brain, dtype=np.float32)
    inv[mask] = 255.0 - brain[mask].astype(np.float32)

    # DoG filter. sigma_small ≈ half the microbleed radius, sigma_large
    # ≈ 2–3× that. Mixed voxel size: SWI is 0.918 × 0.918 × 3 mm so we
    # use different sigmas in the slice direction.
    sigma_small = (0.4, 1.2, 1.2)   # (z, y, x)
    sigma_large = (0.8, 2.4, 2.4)
    dog = ndimage.gaussian_filter(inv, sigma_small) - ndimage.gaussian_filter(inv, sigma_large)
    dog[~mask] = 0

    # Threshold: keep voxels above a robust percentile of in-brain DoG.
    # 99.7th percentile catches ~0.3% of brain volume — for a 67k-voxel
    # brain that's ~200 voxels scattered across candidate blobs.
    inbrain_dog = dog[mask]
    if inbrain_dog.size == 0:
        return
    threshold = np.percentile(inbrain_dog, 99.7)
    hot = dog > threshold

    # Connected-component filter: drop tiny (noise) and large (vessels) blobs
    lbl, n = ndimage.label(hot)
    if n == 0:
        merge_stats(slug, {"microbleeds": {"candidates": [], "count": 0}})
        print(f"  no candidates", flush=True)
        return

    sizes = ndimage.sum(hot, lbl, range(1, n + 1))
    candidates = []
    # Size filter: 2..50 voxels → roughly 2..50 mm³ at 1 mm³/voxel.
    # SWI voxel volume is 0.918 * 0.918 * 3 = 2.53 mm³, so 2..50 voxels
    # = 5..126 mm³ which is ~0.5..3 mm radius. That's the clinical range.
    for i, sz in enumerate(sizes):
        if sz < 2 or sz > 50:
            continue
        coords = np.where(lbl == (i + 1))
        cz = float(coords[0].mean())
        cy = float(coords[1].mean())
        cx = float(coords[2].mean())
        # Score = peak DoG value in the blob
        peak = float(dog[lbl == (i + 1)].max())
        candidates.append({
            "z": int(round(cz)),
            "y": int(round(cy)),
            "x": int(round(cx)),
            "voxels": int(sz),
            "score": round(peak, 2),
        })

    # Sort by score descending and keep the top 40 — anything more is noise
    candidates.sort(key=lambda c: c["score"], reverse=True)
    candidates = candidates[:40]

    # Count per slice for scrubber tick display
    per_slice = [0] * D
    for c in candidates:
        per_slice[c["z"]] += 1

    merge_stats(slug, {
        "microbleeds": {
            "candidates": candidates,
            "count": len(candidates),
            "per_slice": per_slice,
            "method": "DoG sigma=(0.4,1.2,1.2)/(0.8,2.4,2.4), threshold=p99.7 in-brain, size 2..50 voxels",
            "disclaimer": "Unverified candidates. Includes normal vessels, perivascular spaces, and air-tissue interfaces. Not a diagnosis.",
        }
    })
    print(f"  {len(candidates)} candidates (top score={candidates[0]['score'] if candidates else '-'})", flush=True)
    print(f"  slices with candidates: {sum(1 for n in per_slice if n > 0)}", flush=True)


# 2. FLAIR white-matter hyperintensity burden

def compute_wmh_burden() -> None:
    """Approximate WMH burden on FLAIR by thresholding bright voxels
    within the HD-BET brain mask, above a robust percentile, with a
    small-component filter.

    This is NOT a real WMH segmentation (Fazekas score or LST would be).
    It's a reproducible burden estimate for longitudinal tracking."""
    slug = "flair"
    print(f"\n=== {slug} WMH burden ===", flush=True)

    try:
        brain = load_brain_stack(slug)
    except FileNotFoundError as e:
        print(f"  skip: {e}", flush=True)
        return

    D, H, W = brain.shape
    mask = brain > 5
    inbrain = brain[mask]
    if inbrain.size == 0:
        return

    # p98 in-brain threshold — clinical FLAIR hyperintense tissue is in the
    # top few percent of in-brain intensity. WM is mid-range on FLAIR; the
    # very bright voxels are fluid-like or WM hyperintensities.
    # CSF at brain edges can also be bright; the brain mask helps.
    threshold = np.percentile(inbrain, 98)
    hot = (brain >= threshold) & mask

    # Drop single-voxel specks
    lbl, n = ndimage.label(hot)
    if n == 0:
        merge_stats(slug, {"wmh": {"volume_ml": 0.0, "voxels": 0}})
        print(f"  no hot voxels", flush=True)
        return

    sizes = ndimage.sum(hot, lbl, range(1, n + 1))
    kept_labels = np.where(sizes >= 3)[0] + 1
    kept_mask = np.isin(lbl, kept_labels)

    # Voxel volume from the manifest
    m = json.loads((DATA / "manifest.json").read_text())
    s = next(s for s in m["series"] if s["slug"] == slug)
    voxel_ml = (s["pixelSpacing"][0] * s["pixelSpacing"][1] * series_effective_slice_spacing(s)) / 1000.0

    voxels = int(kept_mask.sum())
    ml = round(voxels * voxel_ml, 2)

    # Per-slice count for sparkline / ticks
    per_slice = [int(kept_mask[z].sum() * voxel_ml * 100) / 100 for z in range(D)]

    merge_stats(slug, {
        "wmh": {
            "volume_ml": ml,
            "voxels": voxels,
            "per_slice_ml": per_slice,
            "threshold_percentile": 98,
            "method": "in-brain voxels above p98, min component size 3",
            "disclaimer": "Approximate WMH burden, not a diagnostic Fazekas score.",
        }
    })
    print(f"  WMH burden: {ml} mL ({voxels} voxels)", flush=True)


# 3. DWI ADC physical values

def extract_adc_physical(source: Path) -> None:
    """Bundle everything the viewer needs to show a hovered ADC voxel in
    physical ×10⁻³ mm²/s units.

    For Siemens ADC maps the stored integer pixel value is already the
    apparent diffusion coefficient expressed in 10⁻⁶ mm²/s, so a stored
    value of 1200 means ADC = 1200 × 10⁻⁶ mm²/s = 1.2 × 10⁻³ mm²/s. The
    DICOM RescaleSlope/Intercept are 1/0. We ship all of this plus the
    percentile-clip bounds from rehires.py's _hr.json so the viewer can
    recover the original value from its normalized hrVoxels:

        raw_dicom  = lo + hr_value / 65535 * (hi - lo)
        physical   = raw_dicom * slope + intercept
        display    = physical / 1000        ("×10⁻³ mm²/s")

    The _hr.json lo/hi are guaranteed to match the voxel range the viewer
    has, because the viewer reads the same .raw file.
    """
    slug = "dwi_adc"
    print(f"\n=== {slug} ADC physical units ===", flush=True)

    src = slug_source_map().get(slug)
    if not src:
        return
    try:
        mr = read_dicom_series(source, src)
    except Exception as e:
        print(f"  skip: {e}", flush=True)
        return
    if not mr:
        print(f"  no DICOMs", flush=True)
        return

    d = mr[0]
    slope = float(getattr(d, "RescaleSlope", 1.0))
    intercept = float(getattr(d, "RescaleIntercept", 0.0))
    units = str(getattr(d, "Units", "") or getattr(d, "RescaleType", "")).strip()

    # Pull the percentile-clip bounds from rehires.py's sidecar
    hr_meta_path = DATA / f"{slug}_hr.json"
    if not hr_meta_path.exists():
        print(f"  skip: {hr_meta_path} missing — run rehires.py first", flush=True)
        return
    hr_meta = json.loads(hr_meta_path.read_text())
    lo_raw = float(hr_meta["rescale"]["lo"])
    hi_raw = float(hr_meta["rescale"]["hi"])

    # Physical range after applying DICOM rescale (in the native unit)
    lo_physical = lo_raw * slope + intercept
    hi_physical = hi_raw * slope + intercept

    merge_stats(slug, {
        "adc": {
            "rescale_slope":     slope,
            "rescale_intercept": intercept,
            "units":             units or "10^-6 mm^2/s",
            # These match the hr volume (data/dwi_adc.raw) range 0..65535
            "hr_lo_raw":         lo_raw,
            "hr_hi_raw":         hi_raw,
            "raw_range":         [lo_raw, hi_raw],
            "physical_range":    [lo_physical, hi_physical],
            # Display unit conversion: physical (10^-6 mm^2/s) / 1000 → 10^-3 mm^2/s
            "display_unit":      "×10⁻³ mm²/s",
            "display_divisor":   1000.0,
        }
    })
    print(f"  slope={slope}, intercept={intercept}, units='{units or '(none)'}'", flush=True)
    print(f"  hr rescale range: {lo_raw:.0f}..{hi_raw:.0f}", flush=True)
    print(f"  displayed as: {lo_physical/1000:.2f}..{hi_physical/1000:.2f} ×10⁻³ mm²/s", flush=True)


# main

def main() -> bool:
    ap = argparse.ArgumentParser(
        description="Image-math biomarkers (microbleeds / WMH / ADC units).",
    )
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root for ADC rescale lookup (default: {ENV_DICOM_ROOT})",
    )
    _ = ap.add_argument(
        "parts",
        nargs="*",
        metavar="PART",
        help="microbleeds | wmh | adc (default: all three), or series slugs swi_3d/flair/dwi_adc",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    tokens = set(args.parts)
    slug_alias = {"swi_3d": "microbleeds", "flair": "wmh", "dwi_adc": "adc"}
    for s, alias in slug_alias.items():
        if s in tokens:
            tokens.add(alias)
    do_all = not tokens
    if do_all or "microbleeds" in tokens:
        detect_microbleeds()
    if do_all or "wmh" in tokens:
        compute_wmh_burden()
    if do_all or "adc" in tokens:
        extract_adc_physical(source)
    print("\nDone.", flush=True)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
