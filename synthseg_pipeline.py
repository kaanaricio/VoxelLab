"""
SynthSeg brain parcellation pipeline.

Replaces the heuristic regions.py for brain MR series with real deep-learning
segmentation using SynthSeg (BBillot et al., Medical Image Analysis 2023).

SynthSeg produces 33 whole-brain labels (+ optional cortical parcellation)
with smooth, anatomically correct boundaries from ANY MRI contrast.

Backends (tried in order):
  1. FreeSurfer's mri_synthseg command (FreeSurfer >= 7.3.2)
  2. SynthSeg repo clone with Python/TF (cloned from GitHub)

Output format is identical to regions.py / totalseg_pipeline.py:
  - data/<slug>_regions/NNNN.png    uint8 label PNGs per slice
  - data/<slug>_regions.json        legend + colors + volumes
  - manifest.json updated with hasRegions=true, anatomySource="synthseg"
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

from geometry import affine_lps_from_series, series_effective_slice_spacing
from pipeline_paths import series_by_modality
from synthseg_integration import find_mri_synthseg, synthseg_runtime

ROOT = Path(__file__).parent
DATA = ROOT / "data"

# SynthSeg label table (FreeSurfer convention)
# These are the 33 segmentation labels output by SynthSeg 2.0.
# When --parc is used, cortical parcellation labels (1001-1035, 2001-2035)
# are added, but we use the base segmentation for the viewer overlay.

SYNTHSEG_LABELS = {
    0:  "Background",
    2:  "L cerebral WM",
    3:  "L cerebral cortex",
    4:  "L lateral ventricle",
    5:  "L inf lat ventricle",
    7:  "L cerebellum WM",
    8:  "L cerebellum cortex",
    10: "L thalamus",
    11: "L caudate",
    12: "L putamen",
    13: "L pallidum",
    14: "3rd ventricle",
    15: "4th ventricle",
    16: "Brainstem",
    17: "L hippocampus",
    18: "L amygdala",
    24: "CSF",
    26: "L accumbens",
    28: "L ventral DC",
    41: "R cerebral WM",
    42: "R cerebral cortex",
    43: "R lateral ventricle",
    44: "R inf lat ventricle",
    46: "R cerebellum WM",
    47: "R cerebellum cortex",
    49: "R thalamus",
    50: "R caudate",
    51: "R putamen",
    52: "R pallidum",
    53: "R hippocampus",
    54: "R amygdala",
    58: "R accumbens",
    60: "R ventral DC",
}

# We remap SynthSeg's sparse FreeSurfer labels (0-60) to dense uint8 (1-33)
# so the viewer's 256-entry LUT texture can be used efficiently.
# Label 0 stays 0 (background / transparent).

def _build_remap():
    """Build forward and reverse label maps."""
    sorted_labels = sorted(k for k in SYNTHSEG_LABELS if k != 0)
    fwd = {0: 0}       # synthseg_label -> dense_label
    rev = {0: 0}        # dense_label -> synthseg_label
    names = {}           # dense_label -> name
    for i, sl in enumerate(sorted_labels, start=1):
        fwd[sl] = i
        rev[i] = sl
        names[i] = SYNTHSEG_LABELS[sl]
    return fwd, rev, names

REMAP_FWD, REMAP_REV, DENSE_NAMES = _build_remap()

# Colors: muted, earthy palette grouped by tissue type so the overlay
# looks coherent. Same style as regions.py and totalseg_pipeline.py.

def _build_colors():
    """Assign a muted color per dense label, grouped by category."""
    colors = {}

    # Cortex: warm tones (left slightly different hue from right)
    cortex_l = [178, 128, 122]   # muted terracotta
    cortex_r = [176, 133, 150]   # muted rose

    # White matter: neutral warm
    wm_l = [185, 180, 170]
    wm_r = [180, 175, 165]

    # Cerebellum: amber tones
    cbl_cortex_l = [188, 158, 116]
    cbl_cortex_r = [183, 153, 111]
    cbl_wm_l = [175, 165, 130]
    cbl_wm_r = [170, 160, 125]

    # Deep gray: purple tones
    thal_l = [150, 136, 175]
    thal_r = [145, 131, 170]
    caud_l = [160, 140, 180]
    caud_r = [155, 135, 175]
    put_l  = [140, 125, 165]
    put_r  = [135, 120, 160]
    pall_l = [130, 115, 155]
    pall_r = [125, 110, 150]
    hipp_l = [165, 145, 185]
    hipp_r = [160, 140, 180]
    amyg_l = [170, 150, 190]
    amyg_r = [165, 145, 185]
    acc_l  = [145, 130, 168]
    acc_r  = [140, 125, 163]
    vdc_l  = [138, 122, 158]
    vdc_r  = [133, 117, 153]

    # Ventricles / CSF: slate-blue tones
    lat_vent_l  = [120, 144, 165]
    lat_vent_r  = [115, 139, 160]
    inf_vent_l  = [125, 149, 170]
    inf_vent_r  = [120, 144, 165]
    vent3       = [110, 134, 155]
    vent4       = [105, 129, 150]
    csf         = [131, 158, 163]

    # Brainstem: warm orange
    brainstem   = [188, 138, 108]

    # Map by SynthSeg label number
    _c = {
        2: wm_l, 3: cortex_l, 4: lat_vent_l, 5: inf_vent_l,
        7: cbl_wm_l, 8: cbl_cortex_l,
        10: thal_l, 11: caud_l, 12: put_l, 13: pall_l,
        14: vent3, 15: vent4, 16: brainstem,
        17: hipp_l, 18: amyg_l, 24: csf,
        26: acc_l, 28: vdc_l,
        41: wm_r, 42: cortex_r, 43: lat_vent_r, 44: inf_vent_r,
        46: cbl_wm_r, 47: cbl_cortex_r,
        49: thal_r, 50: caud_r, 51: put_r, 52: pall_r,
        53: hipp_r, 54: amyg_r, 58: acc_r, 60: vdc_r,
    }

    for dense_id in DENSE_NAMES:
        ss_label = REMAP_REV[dense_id]
        colors[dense_id] = _c.get(ss_label, [160, 160, 160])
    return colors

DENSE_COLORS = _build_colors()

# Utility: load PNG stack

def load_stack(folder: Path) -> np.ndarray:
    """Load a folder of numbered PNGs into (D, H, W) uint8 array."""
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no PNGs in {folder}")
    imgs = [np.array(Image.open(f).convert("L")) for f in files]
    return np.stack(imgs, axis=0)


# NIfTI writing (reused pattern from totalseg_pipeline.py)

def write_nifti(vol_dhw: np.ndarray, series_entry: dict, out_path: Path):
    """Convert (D, H, W) numpy volume into NIfTI with an approximate affine
    built from manifest metadata via the shared geometry contract.
    Returns (col_spacing, row_spacing, slice_thickness).
    """
    import nibabel as nib

    px = series_entry["pixelSpacing"]
    row_spacing = float(px[0])
    col_spacing = float(px[1])
    slice_mm = float(series_effective_slice_spacing(series_entry))

    # Use shared geometry contract for affine — no local derivation.
    affine_lps_mat = np.array(affine_lps_from_series(series_entry), dtype=np.float64)

    # LPS -> RAS
    lps_to_ras = np.diag([-1.0, -1.0, 1.0, 1.0])
    affine = lps_to_ras @ affine_lps_mat

    vol_xyz = np.transpose(vol_dhw, (2, 1, 0))  # (W=col, H=row, D=slice)
    img = nib.Nifti1Image(vol_xyz.astype(np.float32), affine)
    nib.save(img, str(out_path))
    return col_spacing, row_spacing, slice_mm


# Backend 1: FreeSurfer mri_synthseg
def run_freesurfer_synthseg(input_nii: Path, output_nii: Path,
                            vol_csv: Path | None = None) -> bool:
    """Run mri_synthseg from FreeSurfer."""
    exe = find_mri_synthseg()
    if not exe:
        return False
    cmd = [exe, "--i", str(input_nii), "--o", str(output_nii), "--robust"]
    if vol_csv:
        cmd.extend(["--vol", str(vol_csv)])
    print(f"  running: {' '.join(cmd)}", flush=True)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except FileNotFoundError:
        print("  mri_synthseg not found in PATH", flush=True)
        return False
    except subprocess.TimeoutExpired:
        print("  mri_synthseg timed out (10 min)", flush=True)
        return False
    if result.returncode != 0:
        print(f"  mri_synthseg failed (rc={result.returncode})", flush=True)
        if result.stderr:
            print(f"  stderr: {result.stderr[-1000:]}", flush=True)
        return False
    print("  mri_synthseg OK", flush=True)
    return True


# Backend 2: SynthSeg from GitHub repo
def _patch_synthseg_repo():
    """Patch SynthSeg repo code for numpy >= 1.24 compatibility."""
    runtime = synthseg_runtime(ROOT)
    utils_path = runtime["utils_path"]
    if not utils_path.exists():
        return
    text = utils_path.read_text()
    # Fix deprecated np.int / np.float aliases removed in numpy 1.24+
    if "np.int," in text:
        text = text.replace(
            "np.int, np.int32, np.int64, np.float, np.float32, np.float64",
            "np.int32, np.int64, np.float32, np.float64",
        )
        _ = utils_path.write_text(text)
        print("  patched SynthSeg for numpy compat", flush=True)


def setup_synthseg_repo() -> bool:
    """Clone the SynthSeg repo and set up a venv with dependencies."""
    runtime = synthseg_runtime(ROOT)
    repo_dir = runtime["repo_dir"]
    venv_dir = runtime["venv_dir"]
    venv_python = runtime["venv_python"]
    python = sys.executable if sys.version_info[:2] == (3, 11) else ""
    if not python or not os.path.isfile(python):
        python = shutil.which("python3.11") or ""
    if not python or not os.path.isfile(python):
        print("  ERROR: Python 3.11 not found. SynthSeg requires TensorFlow.", flush=True)
        return False

    # Clone repo if needed
    if not (repo_dir / "SynthSeg" / "predict.py").exists():
        print("  cloning SynthSeg repo...", flush=True)
        if repo_dir.exists():
            shutil.rmtree(repo_dir)
        result = subprocess.run(
            ["git", "clone", "--depth", "1", str(runtime["repo_url"]), str(repo_dir)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            print(f"  git clone failed: {result.stderr[:500]}", flush=True)
            return False
        print("  cloned SynthSeg repo", flush=True)

    # Patch numpy compat issues
    _patch_synthseg_repo()

    # Create venv if needed
    if not venv_python.exists():
        print("  creating SynthSeg venv...", flush=True)
        result = subprocess.run(
            [python, "-m", "venv", str(venv_dir)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            print(f"  venv creation failed: {result.stderr[:500]}", flush=True)
            return False

        # Use TF 2.15 which ships with Keras 2 (compatible with SynthSeg's
        # keras 2.3.1-era code). Modern TF 2.16+ uses Keras 3 which has
        # incompatible API changes.
        pip = str(venv_dir / "bin" / "pip")
        deps = [
            "tensorflow==2.15.1",
            "nibabel>=5.0",
            "numpy>=1.23,<2.0",
            "scipy>=1.10",
            "h5py>=3.0",
            "Pillow>=9.0",
            "matplotlib>=3.6",
        ]
        print(f"  installing TF 2.15 + deps into venv...", flush=True)
        result = subprocess.run(
            [pip, "install", "--quiet"] + deps,
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            print(f"  pip install failed: {result.stderr[:1000]}", flush=True)
            return False
        print("  venv ready", flush=True)

    return True


def run_synthseg_repo(input_nii: Path, output_nii: Path) -> bool:
    """Run SynthSeg prediction via the cloned repo."""
    if not setup_synthseg_repo():
        return False

    runtime = synthseg_runtime(ROOT)
    venv_python = str(runtime["venv_python"])
    predict_script = runtime["predict_script"]
    if not predict_script.exists():
        print(f"  ERROR: predict script not found at {predict_script}", flush=True)
        return False

    # Check which models are available. The repo ships with synthseg_1.0.h5
    # by default. The 2.0 and robust models must be downloaded separately from
    # the UCL SharePoint link in the README.
    model_dir = runtime["models_dir"]
    has_2_0 = (model_dir / "synthseg_2.0.h5").exists()
    has_robust = (model_dir / "synthseg_robust_2.0.h5").exists()
    has_1_0 = (model_dir / "synthseg_1.0.h5").exists()

    if has_robust:
        extra_flags = ["--robust"]
        print("  using SynthSeg-robust 2.0 model", flush=True)
    elif has_2_0:
        extra_flags = []
        print("  using SynthSeg 2.0 model", flush=True)
    elif has_1_0:
        extra_flags = ["--v1"]
        print("  using SynthSeg 1.0 model (2.0 models not downloaded)", flush=True)
    else:
        print("  ERROR: no SynthSeg model files found in models/", flush=True)
        return False

    # The predict script derives synthseg_home from its own path (3 dirs up)
    # so it should find models/ and data/ relative to the repo root.
    cmd = [
        venv_python,
        str(predict_script),
        "--i", str(input_nii),
        "--o", str(output_nii),
        "--cpu",
        "--threads", "4",
    ] + extra_flags
    env = os.environ.copy()
    env["PYTHONPATH"] = str(runtime["repo_dir"])

    print(f"  running SynthSeg from repo: {predict_script.name}", flush=True)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=900,
            env=env, cwd=str(runtime["repo_dir"]),
        )
    except subprocess.TimeoutExpired:
        print("  SynthSeg timed out (15 min)", flush=True)
        return False

    if result.returncode != 0:
        print(f"  SynthSeg failed (rc={result.returncode})", flush=True)
        if result.stdout:
            print(f"  stdout: {result.stdout[-1000:]}", flush=True)
        if result.stderr:
            print(f"  stderr: {result.stderr[-1000:]}", flush=True)
        return False

    print("  SynthSeg repo prediction OK", flush=True)
    return True


# Read SynthSeg output and remap to dense labels

def read_synthseg_output(seg_nii_path: Path, ref_nii_path: Path,
                         target_shape_dhw: tuple[int, int, int]) -> np.ndarray:
    """Read SynthSeg's output NIfTI, reorient to match our reference NIfTI,
    remap sparse FreeSurfer labels to dense uint8, and return (D, H, W)."""
    import nibabel as nib
    from nibabel.orientations import io_orientation, ornt_transform, apply_orientation
    from scipy import ndimage

    seg_img = nib.load(str(seg_nii_path))
    seg_data = np.asarray(seg_img.dataobj).astype(np.int32)

    ref_img = nib.load(str(ref_nii_path))
    ref_ornt = io_orientation(ref_img.affine)
    seg_ornt = io_orientation(seg_img.affine)

    transform = ornt_transform(seg_ornt, ref_ornt)
    seg_data = apply_orientation(seg_data, transform)

    # (W, H, D) -> (D, H, W) to match our PNG stack convention
    seg_dhw = np.transpose(seg_data, (2, 1, 0))

    # Resample if needed (SynthSeg outputs at 1mm iso, our data may differ)
    if seg_dhw.shape != target_shape_dhw:
        print(f"    resampling {seg_dhw.shape} -> {target_shape_dhw}", flush=True)
        zoom = tuple(t / s for t, s in zip(target_shape_dhw, seg_dhw.shape))
        seg_dhw = ndimage.zoom(seg_dhw, zoom, order=0)

    # Remap sparse labels to dense
    dense = np.zeros(seg_dhw.shape, dtype=np.uint8)
    for ss_label, dense_label in REMAP_FWD.items():
        if ss_label == 0:
            continue
        mask = seg_dhw == ss_label
        if mask.any():
            dense[mask] = dense_label

    return dense


# Write outputs (same format as regions.py / totalseg_pipeline.py)

def write_outputs(slug: str, label_vol: np.ndarray, px_x: float,
                  px_y: float, slice_mm: float):
    """Write per-slice label PNGs + legend JSON."""
    out_dir = DATA / f"{slug}_regions"
    if out_dir.exists():
        for old in out_dir.glob("*.png"):
            old.unlink()
    out_dir.mkdir(exist_ok=True)

    D = label_vol.shape[0]
    for z in range(D):
        Image.fromarray(label_vol[z], mode="L").save(out_dir / f"{z:04d}.png")

    # Build legend, colors, regions dicts keyed by string label id
    legend = {str(k): v for k, v in DENSE_NAMES.items()}
    colors = {str(k): v for k, v in DENSE_COLORS.items()}

    voxel_ml = (px_x * px_y * slice_mm) / 1000.0
    regions = {}
    for rid, name in DENSE_NAMES.items():
        count = int((label_vol == rid).sum())
        regions[str(rid)] = {
            "name": name,
            "color": DENSE_COLORS[rid],
            "mL": round(count * voxel_ml, 1),
            "voxels": count,
        }

    stats_path = DATA / f"{slug}_regions.json"
    _ = stats_path.write_text(json.dumps({
        "legend": legend,
        "colors": colors,
        "regions": regions,
    }, indent=2))

    n_labeled = int((label_vol > 0).sum())
    n_labels_present = sum(1 for r in regions.values() if r["voxels"] > 0)
    print(
        f"  wrote {out_dir.name}/ ({D} slices, {n_labels_present} labels, "
        + f"{n_labeled} labeled voxels) + {stats_path.name}",
        flush=True,
    )

    # Top 5 by volume
    top = sorted(regions.values(), key=lambda r: -r["mL"])[:5]
    for t in top:
        if t["mL"] >= 0.1:
            print(f"    {t['name']:24s} {t['mL']:8.1f} mL", flush=True)

    return out_dir, stats_path


# Process one brain MR series

def process_series(slug: str, manifest: dict) -> bool:
    """Run SynthSeg on one brain MR series."""
    print(f"\n=== {slug} (SynthSeg) ===", flush=True)

    series_entry = next((s for s in manifest["series"] if s["slug"] == slug), None)
    if series_entry is None:
        print(f"  ERROR: {slug} not in manifest", flush=True)
        return False

    brain_dir = DATA / f"{slug}_brain"
    if not brain_dir.exists():
        print(f"  skip: no brain folder at {brain_dir}", flush=True)
        return False

    # Load brain PNG stack
    brain = load_stack(brain_dir)
    D, H, W = brain.shape
    print(f"  loaded {D} slices, {W}x{H}", flush=True)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        input_nii = td / f"{slug}.nii.gz"
        seg_nii = td / f"{slug}_synthseg.nii.gz"

        # Write NIfTI from brain PNGs + manifest metadata
        px_x, px_y, slice_mm = write_nifti(brain.astype(np.float32), series_entry, input_nii)
        print(
            f"  wrote NIfTI ({input_nii.stat().st_size / 1e6:.1f} MB) "
            + f"spacing=({px_x:.2f}, {px_y:.2f}, {slice_mm:.2f}) mm",
            flush=True,
        )

        # Try backends in order
        success = False

        # Backend 1: FreeSurfer mri_synthseg
        if find_mri_synthseg():
            print("  trying FreeSurfer mri_synthseg...", flush=True)
            success = run_freesurfer_synthseg(input_nii, seg_nii)
        else:
            print("  FreeSurfer mri_synthseg not found", flush=True)

        # Backend 2: SynthSeg repo
        if not success:
            print("  trying SynthSeg from GitHub repo...", flush=True)
            success = run_synthseg_repo(input_nii, seg_nii)

        if not success:
            print(f"  ERROR: all SynthSeg backends failed for {slug}", flush=True)
            print("", flush=True)
            print("  === Installation instructions ===", flush=True)
            print("  Option 1 (recommended): Install FreeSurfer 8.1+", flush=True)
            print("    Download from: https://surfer.nmr.mgh.harvard.edu/fswiki/rel7downloads", flush=True)
            print("    macOS arm64: freesurfer-macOS-darwin_arm64-8.1.0.pkg", flush=True)
            print("    Then: export FREESURFER_HOME=/Applications/freesurfer/8.1.0", flush=True)
            print("    Then: source $FREESURFER_HOME/SetUpFreeSurfer.sh", flush=True)
            print("", flush=True)
            print("  Option 2: Clone the SynthSeg repo manually", flush=True)
            print("    git clone https://github.com/BBillot/SynthSeg.git synthseg_repo", flush=True)
            print("    Requires Python 3.8 + TensorFlow 2.2 + Keras 2.3.1", flush=True)
            print("    Download 2.0 models from the repo's README links", flush=True)
            return False

        # Read and remap the SynthSeg output
        if not seg_nii.exists():
            print(f"  ERROR: SynthSeg output not found at {seg_nii}", flush=True)
            return False

        dense_labels = read_synthseg_output(seg_nii, input_nii, (D, H, W))

    # Write outputs
    m_px = series_entry["pixelSpacing"]
    _ = write_outputs(slug, dense_labels, m_px[0], m_px[1], series_effective_slice_spacing(series_entry))

    # Update manifest
    series_entry["hasRegions"] = True
    series_entry["anatomySource"] = "synthseg"
    return True


# Main

def main() -> bool:
    mr_series = series_by_modality("MR")

    ap = argparse.ArgumentParser(
        description="SynthSeg brain parcellation (reads brain PNGs under data/).",
    )
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help=f"Series to process (default: {', '.join(mr_series) or 'all MR in manifest'})",
    )
    args = ap.parse_args()

    manifest_path = DATA / "manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: manifest not found at {manifest_path}", file=sys.stderr, flush=True)
        return False

    manifest = json.loads(manifest_path.read_text())

    requested = set(args.slugs) if args.slugs else set(mr_series)

    successes = []
    failures = []

    for slug in mr_series:
        if slug not in requested:
            continue
        try:
            if process_series(slug, manifest):
                successes.append(slug)
            else:
                failures.append(slug)
        except Exception as e:
            import traceback

            print(f"  ERROR on {slug}: {e}", flush=True)
            traceback.print_exc(file=sys.stderr)
            failures.append(slug)

    # Save manifest
    _ = manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"\n=== SynthSeg pipeline summary ===", flush=True)
    print(f"  successes: {successes}", flush=True)
    print(f"  failures:  {failures}", flush=True)

    if failures:
        print(
            f"\n  NOTE: For failed series, run 'python3 regions.py' as a fallback.",
            flush=True,
        )
        return False

    print("\nDone. Refresh the viewer.", flush=True)
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
