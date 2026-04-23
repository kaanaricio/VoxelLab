#!/usr/bin/env python3
"""Build the shipped lite MRI demo pack from public OpenNeuro source files."""

from __future__ import annotations

import argparse
import hashlib
import gzip
import json
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import analyze
import context
from ai_runtime import require_provider_ready

try:
    import nibabel as nib
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover - maintainer-only build path
    nib = None
    np = None
    Image = None

PACK_DIR = ROOT / "demo_packs"
PACK_PATH = PACK_DIR / "voxellab-lite-openneuro-on01802.zip"
CATALOG_PATH = PACK_DIR / "catalog.json"
SOURCE_BASE = "https://s3.amazonaws.com/openneuro.org/ds005752/sub-ON01802/ses-01"

SERIES_SPECS = [
    {
        "slug": "demo_on01802_t1w",
        "name": "T1w",
        "description": "OpenNeuro ds005752 sub-ON01802 · T1w",
        "url": f"{SOURCE_BASE}/anat/sub-ON01802_ses-01_acq-MPRAGE_T1w.nii.gz",
        "modality": "MR",
        "sequence": "T1w",
    },
    {
        "slug": "demo_on01802_t2w",
        "name": "T2w",
        "description": "OpenNeuro ds005752 sub-ON01802 · T2w",
        "url": f"{SOURCE_BASE}/anat/sub-ON01802_ses-01_acq-CUBE_T2w.nii.gz",
        "modality": "MR",
        "sequence": "T2w",
    },
    {
        "slug": "demo_on01802_flair",
        "name": "FLAIR",
        "description": "OpenNeuro ds005752 sub-ON01802 · FLAIR",
        "url": f"{SOURCE_BASE}/anat/sub-ON01802_ses-01_acq-2dADNI2_rec-SCIC_FLAIR.nii.gz",
        "modality": "MR",
        "sequence": "FLAIR",
    },
    {
        "slug": "demo_on01802_t2starw",
        "name": "T2*",
        "description": "OpenNeuro ds005752 sub-ON01802 · T2*",
        "url": f"{SOURCE_BASE}/anat/sub-ON01802_ses-01_rec-SCIC_T2starw.nii.gz",
        "modality": "MR",
        "sequence": "T2starw",
    },
    {
        "slug": "demo_on01802_dwi",
        "name": "DWI",
        "description": "OpenNeuro ds005752 sub-ON01802 · DWI (b0 volume)",
        "url": f"{SOURCE_BASE}/dwi/sub-ON01802_ses-01_dir-unflipped_dwi.nii.gz",
        "bval_url": f"{SOURCE_BASE}/dwi/sub-ON01802_ses-01_dir-unflipped_dwi.bval",
        "modality": "MR",
        "sequence": "DWI",
    },
]


def require_build_deps() -> None:
    if nib is None or np is None or Image is None:
        raise RuntimeError("build requires pipeline deps: install `.[pipeline]`")


def download(url: str, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return target


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def b0_index(bval_path: Path) -> int:
    values = [float(item) for item in bval_path.read_text(encoding="utf-8").split()]
    return min(range(len(values)), key=lambda idx: values[idx])


def nifti_geometry(img) -> dict[str, Any]:
    affine = np.asarray(img.affine, dtype=np.float64)
    nx, ny, nz = [int(dim) for dim in img.shape[:3]]
    col0 = affine[:3, 0]
    col1 = affine[:3, 1]
    col2 = affine[:3, 2]
    len0 = float(np.linalg.norm(col0))
    len1 = float(np.linalg.norm(col1))
    len2 = float(np.linalg.norm(col2))
    row_dir = (col0 / len0).tolist() if len0 > 1e-6 else [1.0, 0.0, 0.0]
    col_dir = (col1 / len1).tolist() if len1 > 1e-6 else [0.0, 1.0, 0.0]
    first_ipp = affine[:3, 3].tolist()
    last_ipp = (affine @ np.array([0.0, 0.0, max(nz - 1, 0), 1.0]))[:3].tolist()
    return {
        "width": nx,
        "height": ny,
        "slices": nz,
        "pixelSpacing": [len1 or 1.0, len0 or 1.0],
        "sliceThickness": len2 or 1.0,
        "sliceSpacing": len2 or 1.0,
        "sliceSpacingRegular": True,
        "firstIPP": [round(value, 6) for value in first_ipp],
        "lastIPP": [round(value, 6) for value in last_ipp],
        "orientation": [round(value, 6) for value in [*row_dir, *col_dir]],
    }


def write_png_stack(volume_xyz: Any, dest_dir: Path) -> tuple[float, float]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    values = volume_xyz.astype(np.float32, copy=False)
    lo = float(np.percentile(values, 2))
    hi = float(np.percentile(values, 98))
    scale = hi - lo or 1.0
    nz = values.shape[2]
    for index in range(nz):
        slice_yx = values[:, :, index].T
        out = np.clip((slice_yx - lo) / scale * 255.0, 0, 255).astype(np.uint8)
        Image.fromarray(out, mode="L").save(dest_dir / f"{index:04d}.png")
    return lo, hi


def write_raw_u16(volume_xyz: Any, out_path: Path) -> None:
    values = volume_xyz.astype(np.float32, copy=False)
    lo = float(values.min())
    hi = float(values.max())
    scale = hi - lo or 1.0
    normalized = np.clip((values - lo) / scale, 0, 1)
    stack_zyx = np.transpose(normalized, (2, 1, 0))
    (stack_zyx * 65535.0 + 0.5).astype(np.uint16).tofile(out_path)


def load_volume(nifti_path: Path, b0_path: Path | None = None) -> tuple[Any, dict[str, Any]]:
    img = nib.load(str(nifti_path))
    data = np.asarray(img.get_fdata(dtype=np.float32))
    if data.ndim == 4:
        index = b0_index(b0_path) if b0_path and b0_path.exists() else 0
        data = data[:, :, :, index]
    if data.ndim != 3:
        raise ValueError(f"{nifti_path.name}: expected 3D or 4D image")
    return data, nifti_geometry(img)


def build_series(temp_data: Path, spec: dict[str, Any], download_dir: Path) -> dict[str, Any]:
    slug = spec["slug"]
    nii_path = download_dir / f"{slug}.nii.gz"
    _ = download(spec["url"], nii_path)
    bval_path = None
    if spec.get("bval_url"):
        bval_path = download_dir / f"{slug}.bval"
        _ = download(spec["bval_url"], bval_path)
    volume, geometry = load_volume(nii_path, b0_path=bval_path)
    _ = write_png_stack(volume, temp_data / slug)
    write_raw_u16(volume, temp_data / f"{slug}.raw")
    entry = {
        "slug": slug,
        "name": spec["name"],
        "description": spec["description"],
        "modality": spec["modality"],
        "sequence": spec["sequence"],
        "group": "demo_on01802",
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": True,
        "geometryKind": "volumeStack",
        "reconstructionCapability": "display-volume",
        "renderability": "volume",
        **geometry,
        "tr": 0,
        "te": 0,
    }
    return entry


def write_manifest(temp_data: Path, entries: list[dict[str, Any]]) -> Path:
    manifest = {
        "patient": "openneuro_ds005752_sub_ON01802",
        "studyDate": "",
        "series": entries,
    }
    path = temp_data / "manifest.json"
    _ = path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def build_pack(provider: str | None = None, model: str | None = None) -> Path:
    require_build_deps()
    with tempfile.TemporaryDirectory(prefix="voxellab-openneuro-") as tempdir:
        temp_root = Path(tempdir)
        temp_data = temp_root / "data"
        download_dir = temp_root / "downloads"
        temp_data.mkdir()
        entries = [build_series(temp_data, spec, download_dir) for spec in SERIES_SPECS]
        manifest_path = write_manifest(temp_data, entries)

        generated = set()
        for entry in entries:
            payload = context.generate_series_context(temp_data, entry)
            _ = context.write_context(temp_data, payload)
            generated.add(entry["slug"])
        context.set_has_context(manifest_path, generated)

        if provider:
            analyze.DATA = temp_data
            _ = require_provider_ready(provider)
            for entry in entries:
                _ = analyze.process(entry["slug"], entry, model=model, provider=provider, force=True)
            analyze.update_manifest([entry["slug"] for entry in entries])

        PACK_DIR.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(PACK_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            for path in sorted(temp_data.rglob("*")):
                if path.is_file():
                    bundle.write(path, path.relative_to(temp_data))
    update_catalog_checksum(PACK_PATH, CATALOG_PATH)
    return PACK_PATH


def update_catalog_checksum(pack_path: Path, catalog_path: Path) -> None:
    if not catalog_path.is_file():
        return
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    checksum = sha256_file(pack_path)
    try:
        archive_path = str(pack_path.relative_to(ROOT))
    except ValueError:
        archive_path = str(pack_path.relative_to(catalog_path.parent.parent))
    for pack in catalog.get("packs", []):
        if pack.get("archive_path") == archive_path:
            pack["checksum"] = checksum
    _ = catalog_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the shipped OpenNeuro MRI lite pack.")
    _ = parser.add_argument("--provider", choices=["claude", "codex"], help="Generate pregenerated analysis with this provider")
    _ = parser.add_argument("--model", default=None, help="AI model override")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = build_pack(provider=args.provider, model=args.model)
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
