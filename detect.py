"""
Auto-detection pipeline — cheap, cached, visually obvious features that a
non-radiologist can actually parse.

NOT A DIAGNOSTIC TOOL. These are image-math heuristics, not medical AI. They
point out "hey, this area looks different from its mirror image on the other
side" or "this is where most of your CSF lives" — useful as a starting point
for a conversation with a real radiologist, that's it.

For each series that has an HD-BET brain mask (hasBrain) and, optionally, a
GMM tissue segmentation (hasSeg), this computes:

  1. Symmetry heatmap                 data/<slug>_sym/NNNN.png
     Each slice is flipped left/right around its brain's center of mass and
     differenced against itself. Bright pixels = "this spot looks different
     from its mirror". Overlaid in red in the viewer.

  2. Symmetry score per slice         stats.symmetryScores[z]
     Mean absolute asymmetry within the brain mask per slice. Scrubber plots
     this as a sparkline so the user can see which slice is "most unusual".

  3. CSF / ventricle volume estimates
     Total CSF in the brain mask + an approximate lateral-ventricle volume
     via 2D morphological opening (breaks thin sulcal bridges before
     connected-components). Shown in the Volumes panel.

  4. Per-slice tissue counts          stats.perSliceTissue[z] = {csf, gm, wm}

Writes:
    data/<slug>_sym/*.png
    data/<slug>_stats.json
    + sets hasSym / hasStats on each series in manifest.json
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from geometry import series_effective_slice_spacing

DATA = Path(__file__).parent / "data"


def load_stack(folder: Path) -> np.ndarray:
    """Read a folder of NNNN.png slices into a (D, H, W) uint8 array."""
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no PNGs in {folder}")
    imgs = [np.array(Image.open(f).convert("L")) for f in files]
    return np.stack(imgs, axis=0)


def compute_symmetry(brain: np.ndarray, outdir: Path) -> list[float]:
    """Per-slice left/right asymmetry map + a scalar score per slice.

    We mirror around the brain's per-slice horizontal center of mass instead
    of the image center, because the brain isn't perfectly centered in the
    scan field. Without this the skull edge dominates the signal.
    """
    D, H, W = brain.shape
    outdir.mkdir(exist_ok=True)
    scores: list[float] = []
    for z in range(D):
        sl = brain[z].astype(np.float32)
        mask = sl > 5  # non-background brain voxels
        if mask.sum() < 200:
            # Too little tissue on this slice — e.g. skull-base edges
            Image.fromarray(np.zeros((H, W), dtype=np.uint8)).save(outdir / f"{z:04d}.png")
            scores.append(0.0)
            continue

        # Horizontal center of mass of the brain mask on this slice
        xs = np.where(mask)[1]
        cx = int(round(float(xs.mean())))

        # Mirror around cx. For each brain voxel (y, x), compare to (y, 2*cx - x).
        # Shift the image so cx lands at the image center, flip, shift back.
        shift = W // 2 - cx
        sl_shifted = np.roll(sl, shift, axis=1)
        mask_shifted = np.roll(mask, shift, axis=1)
        mirror = sl_shifted[:, ::-1]
        mask_mirror = mask_shifted[:, ::-1]
        both = mask_shifted & mask_mirror

        diff = np.abs(sl_shifted - mirror)
        diff[~both] = 0.0

        # Gentle blur so single-pixel noise doesn't paint the screen
        diff = ndimage.gaussian_filter(diff, sigma=1.0)

        # Shift the map back into original image coordinates
        diff = np.roll(diff, -shift, axis=1)

        # Normalize the heatmap for display (per-series max would be better,
        # but per-slice lets each image pop regardless of global variance)
        m = float(diff.max())
        disp = np.zeros_like(diff, dtype=np.uint8)
        if m > 1:
            disp = np.clip(diff / m * 255.0, 0, 255).astype(np.uint8)
        Image.fromarray(disp).save(outdir / f"{z:04d}.png")

        # Score = mean asymmetry within brain, in raw intensity units
        scores.append(float(diff[both].mean()) if both.any() else 0.0)

    return scores


def compute_csf_stats(seg: np.ndarray, px: float, py: float, sz: float) -> dict:
    """CSF bulk volume + a ventricle-ish estimate via 2D morphological opening.

    GMM CSF class = all low-intensity voxels in the brain mask, which includes
    sulcal CSF + subarachnoid space + perivascular space + ventricles, all
    often fused into one giant connected component at 5 mm slice thickness.
    So "top-2 connected components" is a lie — it's just "all CSF".

    To extract something closer to ventricles, we erode each slice with a
    small structuring element (breaks the thin sulcal bridges), do 2D
    connected components per slice, keep the top two blobs per slice, and
    sum across slices. This still isn't real lateral-ventricle segmentation
    (that needs SynthSeg / FreeSurfer), so we report both numbers and label
    the opening-based one as an estimate.
    """
    voxel_ml = (px * py * sz) / 1000.0
    csf = seg == 1
    total_voxels = int(csf.sum())

    opened_voxels = 0
    struct = np.ones((3, 3), dtype=bool)
    for z in range(csf.shape[0]):
        sl = csf[z]
        if sl.sum() < 20:
            continue
        eroded = ndimage.binary_erosion(sl, structure=struct, iterations=2)
        if eroded.sum() == 0:
            continue
        lbl, n = ndimage.label(eroded)
        if n == 0:
            continue
        sizes = ndimage.sum(eroded, lbl, range(1, n + 1))
        top = np.sort(sizes)[::-1][:2]
        opened_voxels += int(top.sum())

    return {
        "csfTotalMl":         round(total_voxels * voxel_ml, 1),
        "csfTotalVoxels":     total_voxels,
        "ventricleEstimateMl": round(opened_voxels * voxel_ml, 1),
        "ventricleNote":      "Approx: 2D-opened CSF top blobs per slice. Not a true ventricular segmentation.",
    }


def per_slice_tissue(seg: np.ndarray) -> list[dict]:
    return [
        {
            "csf": int((seg[z] == 1).sum()),
            "gm": int((seg[z] == 2).sum()),
            "wm": int((seg[z] == 3).sum()),
        }
        for z in range(seg.shape[0])
    ]


def process_series(series: dict) -> dict:
    slug = series["slug"]
    print(f"\n=== {slug} ===", flush=True)

    brain_dir = DATA / f"{slug}_brain"
    seg_dir = DATA / f"{slug}_seg"
    if not brain_dir.exists():
        print(f"  skip: no brain folder at {brain_dir}", flush=True)
        return {}

    brain = load_stack(brain_dir)
    print(f"  brain stack: {brain.shape}", flush=True)

    # Symmetry
    sym_dir = DATA / f"{slug}_sym"
    scores = compute_symmetry(brain, sym_dir)
    print(f"  symmetry: min={min(scores):.2f} max={max(scores):.2f} mean={np.mean(scores):.2f}", flush=True)
    series["hasSym"] = True

    stats = {
        "slug": slug,
        "symmetryScores": [round(s, 3) for s in scores],
    }

    # Segmentation-derived stats
    if seg_dir.exists():
        seg = load_stack(seg_dir)
        vv = compute_csf_stats(
            seg,
            series["pixelSpacing"][0],
            series["pixelSpacing"][1],
            series_effective_slice_spacing(series),
        )
        stats.update(vv)
        stats["perSliceTissue"] = per_slice_tissue(seg)
        print(f"  CSF total: {vv['csfTotalMl']} mL   ventricle estimate: {vv['ventricleEstimateMl']} mL", flush=True)

    stats_path = DATA / f"{slug}_stats.json"
    _ = stats_path.write_text(json.dumps(stats))
    print(f"  wrote {stats_path.name}", flush=True)
    series["hasStats"] = True
    return stats


def main() -> bool:
    ap = argparse.ArgumentParser(description="Symmetry heatmaps + CSF/ventricle stats.")
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
            _ = process_series(s)
        except Exception as e:
            print(f"  ERROR on {s['slug']}: {e}", file=sys.stderr, flush=True)
            ok = False
    _ = path.write_text(json.dumps(m, indent=2))
    print("\nDone. Refresh the viewer.", flush=True)
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
