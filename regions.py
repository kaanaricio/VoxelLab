"""
Approximate anatomical regions from the HD-BET brain mask + GMM tissue
classes + simple geometry.

NOT REAL ANATOMICAL SEGMENTATION. A proper job would use SynthSeg,
FastSurfer, or FreeSurfer — deep-learning models trained on thousands of
labeled brains. Installing those is heavy and fragile. What we do instead:
divide the brain into rough regions based on where each voxel sits inside
the brain bounding box, then refine using the tissue class (CSF/GM/WM)
we already computed. Good enough for a non-radiologist to see *roughly*
which cortical lobe they're clicking on, which is the point of this
viewer. Don't use it clinically.

Labels (1..10):
    1  Frontal cortex
    2  Parietal cortex
    3  Temporal cortex
    4  Occipital cortex
    5  Cerebellum
    6  Brainstem
    7  White matter
    8  Deep gray matter
    9  Lateral ventricles
    10 Sulcal CSF

Per series this writes:
    data/<slug>_regions/NNNN.png       label image (uint8 0..10)
    data/<slug>_regions.json           name + color + mL volume per label
    + hasRegions: true in manifest.json
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from geometry import series_effective_slice_spacing
from scipy import ndimage

DATA = Path(__file__).parent / "data"

REGION_NAMES = {
    1:  "Frontal cortex",
    2:  "Parietal cortex",
    3:  "Temporal cortex",
    4:  "Occipital cortex",
    5:  "Cerebellum",
    6:  "Brainstem",
    7:  "White matter",
    8:  "Deep gray matter",
    9:  "Lateral ventricles",
    10: "Sulcal CSF",
}

# Muted, earthy palette that reads as distinguishable regions without
# looking like a kids' toy. Overlay blends at ~40% alpha in the viewer so
# the underlying grayscale still shows through.
REGION_COLORS = {
    1:  [178, 128, 122],   # frontal       — muted terracotta
    2:  [145, 127, 164],   # parietal      — muted violet
    3:  [176, 133, 150],   # temporal      — muted rose
    4:  [128, 160, 135],   # occipital     — muted sage
    5:  [188, 158, 116],   # cerebellum    — muted amber
    6:  [188, 138, 108],   # brainstem     — muted orange
    7:  [185, 180, 170],   # white matter  — warm off-white
    8:  [150, 136, 175],   # deep gray     — muted purple
    9:  [120, 144, 165],   # ventricles    — slate (matches tissue CSF)
    10: [131, 158, 163],   # sulcal CSF    — dusty cyan
}


def load_stack(folder: Path) -> np.ndarray:
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no PNGs in {folder}")
    imgs = [np.array(Image.open(f).convert("L")) for f in files]
    return np.stack(imgs, axis=0)


def classify_regions(brain: np.ndarray, seg: np.ndarray) -> np.ndarray:
    """Heuristic region labeling. Returns (D, H, W) uint8 label volume.

    The geometry assumes standard axial brain scans: slice 0 inferior,
    slice D-1 superior; row 0 anterior, row H-1 posterior; col 0 patient
    right (for the radiology convention). This matches how convert.py
    wrote the PNG stacks from the DICOMs.
    """
    D, H, W = brain.shape
    regions = np.zeros_like(brain, dtype=np.uint8)

    mask = brain > 5
    if mask.sum() < 1000:
        return regions

    # Brain bounding box — we normalize coordinates inside this box so the
    # heuristics are scale-invariant across series.
    nz = np.where(mask)
    z_min, z_max = int(nz[0].min()), int(nz[0].max())
    y_min, y_max = int(nz[1].min()), int(nz[1].max())
    x_min, x_max = int(nz[2].min()), int(nz[2].max())

    # Midline column (horizontal center of mass of the brain)
    cx = float(nz[2].mean())

    Z, Y, X = np.mgrid[0:D, 0:H, 0:W].astype(np.float32)
    zf = np.clip((Z - z_min) / max(1, z_max - z_min), 0, 1)   # 0=inferior, 1=superior
    yf = np.clip((Y - y_min) / max(1, y_max - y_min), 0, 1)   # 0=anterior, 1=posterior
    dist_mid = np.abs(X - cx) / max(1, x_max - x_min)         # 0=midline, ~0.5=edge

    # Pass 1: coarse regions from geometry

    # Cerebellum: bottom-back of the brain
    cerebellum = mask & (zf < 0.30) & (yf > 0.38)
    regions[cerebellum] = 5

    # Brainstem: bottom-center of the brain, midline, mid-Y
    brainstem = mask & (zf < 0.38) & (dist_mid < 0.11) & (yf > 0.30) & (yf < 0.68)
    regions[brainstem] = 6

    # Occipital: very posterior, mid-to-upper axial
    occipital = mask & (regions == 0) & (yf > 0.68) & (zf > 0.28)
    regions[occipital] = 4

    # Frontal: very anterior
    frontal = mask & (regions == 0) & (yf < 0.38)
    regions[frontal] = 1

    # Temporal: lateral (far from midline) and relatively low in the brain
    temporal = mask & (regions == 0) & (dist_mid > 0.32) & (zf < 0.60)
    regions[temporal] = 3

    # Parietal: everything remaining (mostly mid-Y, upper-axial)
    parietal = mask & (regions == 0)
    regions[parietal] = 2

    # Pass 2: tissue-class refinement

    # 2a. Lateral ventricles. Take the CSF class (seg == 1), erode to break
    # thin sulcal bridges, do 3D connected components, keep the two biggest
    # blobs. Those are the lateral ventricles (third ventricle often merges
    # at 5 mm thickness — close enough).
    csf = (seg == 1)
    eroded = ndimage.binary_erosion(csf, iterations=2)
    lbl, n = ndimage.label(eroded)
    if n > 0:
        sizes = ndimage.sum(eroded, lbl, range(1, n + 1))
        # Sort descending and keep top two
        order = np.argsort(sizes)[::-1]
        keep = set()
        for idx in order[:2]:
            if sizes[idx] > 50:  # minimum size to count
                keep.add(int(idx + 1))
        if keep:
            vent = np.isin(lbl, list(keep))
            # Dilate back a little so we recapture the edge voxels the erosion
            # nibbled off. Intersect with the original CSF so we don't spill
            # into non-CSF tissue.
            vent = ndimage.binary_dilation(vent, iterations=2) & csf
            regions[vent] = 9

    # 2b. Sulcal CSF = remaining CSF that wasn't assigned to ventricles
    sulcal = mask & (seg == 1) & (regions != 9)
    regions[sulcal] = 10

    # 2c. White matter from the GMM class. Overrides cortex labels only if
    # the region is NOT cerebellum or brainstem (those are better as a unit).
    wm = mask & (seg == 3) & (regions != 5) & (regions != 6) & (regions != 9) & (regions != 10)
    regions[wm] = 7

    # 2d. Deep gray matter: GM class near midline, mid-axial — basal ganglia,
    # thalamus, etc. They're central and between the lateral ventricles.
    deep_gray = (mask & (seg == 2) & (dist_mid < 0.22)
                 & (zf > 0.42) & (zf < 0.78)
                 & (yf > 0.30) & (yf < 0.72)
                 & (regions != 5) & (regions != 6) & (regions != 9))
    regions[deep_gray] = 8

    return regions


def compute_volumes(regions: np.ndarray, px: float, py: float, sz: float) -> dict:
    voxel_ml = (px * py * sz) / 1000.0
    out = {}
    for rid, name in REGION_NAMES.items():
        count = int((regions == rid).sum())
        out[str(rid)] = {
            "name":   name,
            "color":  REGION_COLORS[rid],
            "mL":     round(count * voxel_ml, 1),
            "voxels": count,
        }
    return out


def process_series(series: dict) -> None:
    slug = series["slug"]
    print(f"\n=== {slug} ===", flush=True)

    brain_dir = DATA / f"{slug}_brain"
    seg_dir   = DATA / f"{slug}_seg"
    if not brain_dir.exists():
        print(f"  skip: no brain folder", flush=True)
        return
    if not seg_dir.exists():
        print(f"  skip: no seg folder — run segment.py first", flush=True)
        return

    brain = load_stack(brain_dir)
    seg   = load_stack(seg_dir)
    if brain.shape != seg.shape:
        print(f"  skip: shape mismatch brain {brain.shape} vs seg {seg.shape}", flush=True)
        return

    regions = classify_regions(brain, seg)

    out_dir = DATA / f"{slug}_regions"
    out_dir.mkdir(exist_ok=True)
    for z in range(regions.shape[0]):
        Image.fromarray(regions[z]).save(out_dir / f"{z:04d}.png")

    vols = compute_volumes(
        regions,
        series["pixelSpacing"][0],
        series["pixelSpacing"][1],
        series_effective_slice_spacing(series),
    )
    stats_path = DATA / f"{slug}_regions.json"
    _ = stats_path.write_text(json.dumps({
        "legend":  REGION_NAMES,
        "colors":  REGION_COLORS,
        "regions": vols,
    }, indent=2))
    series["hasRegions"] = True

    print(f"  wrote {out_dir.name}/ ({regions.shape[0]} slices) + {stats_path.name}", flush=True)
    for rid, info in vols.items():
        if info["mL"] >= 0.5:
            print(f"    {info['name']:22s} {info['mL']:7.1f} mL", flush=True)


def main() -> bool:
    ap = argparse.ArgumentParser(description="Heuristic anatomical regions (geometry + tissue classes).")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series slugs (default: all in manifest)",
    )
    args = ap.parse_args()

    path = DATA / "manifest.json"
    m = json.loads(path.read_text())
    requested = set(args.slugs) if args.slugs else set()
    ok = True
    for s in m["series"]:
        if requested and s["slug"] not in requested:
            continue
        try:
            process_series(s)
        except Exception as e:
            print(f"  ERROR on {s['slug']}: {e}", file=sys.stderr, flush=True)
            ok = False
    _ = path.write_text(json.dumps(m, indent=2))
    print("\nDone. Refresh the viewer.", flush=True)
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
