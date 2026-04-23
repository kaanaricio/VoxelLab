#!/usr/bin/env python3
"""Install public demo packs for VoxelLab."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "demo_packs" / "catalog.json"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_assets import validate_assets


def load_catalog(path: Path = CATALOG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def packs_by_id(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {pack["id"]: pack for pack in catalog.get("packs", []) if isinstance(pack, dict) and isinstance(pack.get("id"), str)}


def resolve_selected_packs(
    catalog: dict[str, Any],
    demo_mode: str,
    include_mri: bool = False,
    include_ct: bool = False,
    requested: list[str] | None = None,
) -> list[dict[str, Any]]:
    pack_map = packs_by_id(catalog)
    mode_ids = list(catalog.get("modes", {}).get(demo_mode, []))
    if include_mri and "mri-source" not in mode_ids:
        mode_ids.append("mri-source")
    if include_ct and "ct-source" not in mode_ids:
        mode_ids.append("ct-source")
    if requested:
        for pack_id in requested:
            if pack_id not in mode_ids:
                mode_ids.append(pack_id)
    mode_ids = list(dict.fromkeys(mode_ids))
    missing = [pack_id for pack_id in mode_ids if pack_id not in pack_map]
    if missing:
        raise ValueError(f"unknown pack ids in catalog selection: {missing}")
    return [pack_map[pack_id] for pack_id in mode_ids]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def download_to_path(url: str, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in {"", "file"}:
        source = Path(parsed.path if parsed.scheme else url)
        if not source.is_absolute():
            source = ROOT / source
        _ = shutil.copy2(source, target)
        return target

    with urllib.request.urlopen(url, timeout=120) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    return target


def verify_checksum(path: Path, expected: str) -> None:
    if not expected:
        return
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(f"{path.name}: sha256 {actual} != expected {expected}")


def sha256_zip_contents(path: Path) -> str:
    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as bundle:
        # Shape: "patient/IM0001.dcm" -> stable digest input independent of ZIP wrapper timestamps.
        for info in sorted(bundle.infolist(), key=lambda item: str(item.filename or "")):
            name = str(info.filename or "")
            if not name or info.is_dir():
                continue
            name_bytes = name.encode("utf-8")
            digest.update(len(name_bytes).to_bytes(4, "big"))
            digest.update(name_bytes)
            digest.update(int(info.file_size).to_bytes(8, "big"))
            with bundle.open(info) as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def verify_zip_contents_checksum(path: Path, expected: str) -> None:
    if not expected:
        return
    actual = sha256_zip_contents(path)
    if actual != expected:
        raise ValueError(f"{path.name}: zip content sha256 {actual} != expected {expected}")


def require_checksum(item: dict[str, Any], context: str) -> str:
    checksum = str(item.get("sha256", "") or "").strip().lower()
    if len(checksum) != 64 or any(ch not in "0123456789abcdef" for ch in checksum):
        raise ValueError(f"{context}: expected sha256 checksum in catalog")
    return checksum


def extract_zip_safe(bundle: zipfile.ZipFile, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    root = target_dir.resolve()
    # Shape: "patient/IM0001.dcm" -> /tmp/extract/patient/IM0001.dcm inside `root`.
    for info in bundle.infolist():
        name = str(info.filename or "")
        if not name:
            continue
        if Path(name).is_absolute():
            raise ValueError(f"{name}: zip member must be relative")
        destination = (root / name).resolve()
        if not destination.is_relative_to(root):
            raise ValueError(f"{name}: zip member escapes extraction root")
    for info in bundle.infolist():
        _ = bundle.extract(info, target_dir)


def merge_manifest_entries(data_dir: Path, pack_manifest: dict[str, Any]) -> list[str]:
    manifest_path = data_dir / "manifest.json"
    existing = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"patient": "anonymous", "studyDate": "", "series": []}
    existing_series = {item["slug"]: item for item in existing.get("series", []) if isinstance(item, dict) and isinstance(item.get("slug"), str)}
    touched: list[str] = []
    for series in pack_manifest.get("series", []):
        slug = series["slug"]
        existing_series[slug] = series
        touched.append(slug)
    existing["series"] = sorted(existing_series.values(), key=lambda item: item["name"].lower())
    write_json(manifest_path, existing)
    return touched


def copy_pack_tree(src_dir: Path, data_dir: Path, slugs: list[str]) -> None:
    for slug in slugs:
        prefix = f"{slug}"
        for path in src_dir.glob(f"{prefix}*"):
            dest = data_dir / path.name
            if path.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                _ = shutil.copytree(path, dest)
            else:
                _ = shutil.copy2(path, dest)


def install_artifact_pack(pack: dict[str, Any], data_dir: Path) -> dict[str, Any]:
    archive_path = ROOT / pack["archive_path"]
    if not archive_path.is_file():
        raise FileNotFoundError(f"missing artifact archive: {archive_path}")
    verify_checksum(archive_path, pack.get("checksum", ""))
    with tempfile.TemporaryDirectory(prefix="voxellab-pack-") as tempdir:
        temp_root = Path(tempdir)
        with zipfile.ZipFile(archive_path) as bundle:
            extract_zip_safe(bundle, temp_root)
        pack_manifest_path = temp_root / "manifest.json"
        if not pack_manifest_path.is_file():
            raise ValueError(f"{archive_path.name}: missing manifest.json in bundle")
        pack_manifest = json.loads(pack_manifest_path.read_text(encoding="utf-8"))
        errors = validate_assets(pack_manifest, temp_root, exhaustive=False)
        if errors:
            raise ValueError(errors[0])
        slugs = [series["slug"] for series in pack_manifest.get("series", [])]
        data_dir.mkdir(parents=True, exist_ok=True)
        copy_pack_tree(temp_root, data_dir, slugs)
        _ = merge_manifest_entries(data_dir, pack_manifest)
        return {"pack": pack["id"], "installed": slugs, "target": str(data_dir)}


def install_source_pack(pack: dict[str, Any], root: Path) -> dict[str, Any]:
    target_dir = root / pack["target_dir"]
    target_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[str] = []

    for item in pack.get("files", []):
        rel_path = Path(item["path"])
        dest = target_dir / rel_path
        if dest.exists():
            downloaded.append(str(rel_path))
            continue
        checksum = require_checksum(item, f"{pack['id']} files[{rel_path}]")
        _ = download_to_path(item["url"], dest)
        verify_checksum(dest, checksum)
        downloaded.append(str(rel_path))

    for item in pack.get("series_zips", []):
        patient_id = item["patient_id"]
        dest_dir = target_dir / patient_id
        if dest_dir.is_dir():
            downloaded.append(f"{patient_id}/")
            continue
        with tempfile.TemporaryDirectory(prefix=f"voxellab-{patient_id.lower()}-") as tempdir:
            zip_path = Path(tempdir) / f"{patient_id}.zip"
            checksum = require_checksum(item, f"{pack['id']} series_zips[{patient_id}]")
            _ = download_to_path(item["url"], zip_path)
            verify_zip_contents_checksum(zip_path, checksum)
            with zipfile.ZipFile(zip_path) as bundle:
                extract_zip_safe(bundle, dest_dir)
        downloaded.append(f"{patient_id}/")

    notice = {
        "pack": pack["id"],
        "title": pack["title"],
        "license_note": pack["license_note"],
        "attribution": pack.get("attribution") or {},
    }
    write_json(target_dir / "PACK_INFO.json", notice)
    return {"pack": pack["id"], "installed": downloaded, "target": str(target_dir)}


def install_pack(pack: dict[str, Any], root: Path, data_dir: Path) -> dict[str, Any]:
    if pack.get("kind") == "artifact" or pack.get("archive_path"):
        return install_artifact_pack(pack, data_dir)
    return install_source_pack(pack, root)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Install VoxelLab public demo packs.")
    _ = parser.add_argument("--catalog", type=Path, default=CATALOG_PATH, help="Pack catalog path")
    _ = parser.add_argument("--root", type=Path, default=ROOT, help="Repo root")
    _ = parser.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Viewer data dir")
    _ = parser.add_argument("--demo", choices=["none", "lite", "standard", "full"], default=None, help="Named pack set")
    _ = parser.add_argument("--pack", action="append", dest="packs", help="Install one pack id. Repeatable.")
    _ = parser.add_argument("--with-mri", action="store_true", help="Add the MRI source pack")
    _ = parser.add_argument("--with-ct", action="store_true", help="Add the CT source pack")
    _ = parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    catalog = load_catalog(args.catalog)
    demo_mode = args.demo or catalog.get("defaultMode", "none")
    selected = resolve_selected_packs(
        catalog,
        demo_mode=demo_mode,
        include_mri=args.with_mri,
        include_ct=args.with_ct,
        requested=args.packs,
    )
    results = [install_pack(pack, args.root.resolve(), args.data_dir.resolve()) for pack in selected]
    payload = {"demo": demo_mode, "packs": [pack["id"] for pack in selected], "results": results}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Installed demo mode: {demo_mode}")
        for item in results:
            print(f"- {item['pack']}: {item['target']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
