"""Shared preflight checks for calibrated projection and ultrasound sources."""

from __future__ import annotations

import importlib.util
from pathlib import Path

from engine_sources import (
    SOURCE_MANIFEST_NAMES,
    load_source_manifest,
    projection_manifest_errors,
    ultrasound_manifest_errors,
)
from projection_rtk import configured_rtk_command

SKIP_NAMES = {".DS_Store", "Thumbs.db", "DICOMDIR"}


def module_exists(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def source_dicom_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    files: list[Path] = []
    for path in sorted(folder.iterdir()):
        if path.name in SKIP_NAMES or path.name.startswith("._"):
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".txt"}:
            continue
        if path.suffix.lower() == ".json" or path.name in SOURCE_MANIFEST_NAMES:
            continue
        if path.is_file():
            files.append(path)
    return files


def dicom_frame_count(paths: list[Path]) -> int:
    import pydicom

    total = 0
    for path in paths:
        dataset = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        try:
            frames = int(getattr(dataset, "NumberOfFrames", 1) or 1)
        except (TypeError, ValueError):
            frames = 1
        total += frames if frames > 0 else 1
    return total


def validate_projection_source(folder: Path) -> list[str]:
    errors = [f"missing Python module: pydicom"] if not module_exists("pydicom") else []
    files = source_dicom_files(folder)
    if not files:
        return errors + [f"projection source: no candidate DICOM files in {folder}"]
    manifest = load_source_manifest(folder)
    if manifest is None:
        return errors + [f"projection source: missing calibration manifest ({', '.join(SOURCE_MANIFEST_NAMES)}) in {folder}"]
    errors.extend(projection_manifest_errors(manifest, len(files)))
    projection = manifest.get("projection", {}) if isinstance(manifest, dict) else {}
    geometry = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    if geometry in {"circular-cbct", "limited-angle-tomo"} and not configured_rtk_command():
        errors.append("projection source: missing RTK runtime; run `npm run setup -- --pipeline --rtk` or set MRI_VIEWER_RTK_COMMAND")
    return errors


def validate_ultrasound_source(folder: Path) -> list[str]:
    errors = [f"missing Python module: pydicom"] if not module_exists("pydicom") else []
    files = source_dicom_files(folder)
    if not files:
        return errors + [f"ultrasound source: no candidate DICOM files in {folder}"]
    manifest = load_source_manifest(folder)
    if manifest is None:
        return errors + [f"ultrasound source: missing calibration manifest ({', '.join(SOURCE_MANIFEST_NAMES)}) in {folder}"]
    if not errors:
        errors.extend(ultrasound_manifest_errors(manifest, dicom_frame_count(files)))
    return errors
