#!/usr/bin/env python3
"""Dry-run readiness checks for long medical-image pipeline jobs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine_preflight import source_dicom_files, validate_projection_source, validate_ultrasound_source
from pipeline_paths import ENV_DICOM_ROOT, slug_source_map, series_by_modality
from synthseg_integration import find_mri_synthseg, synthseg_repo_errors


def has_candidate_files(folder: Path) -> bool:
    return bool(source_dicom_files(folder))


def resolve_source(raw: str | None) -> Path | None:
    value = raw or os.environ.get(ENV_DICOM_ROOT)
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    return path if path.is_dir() else None


def validate_modules(names: list[str]) -> list[str]:
    import importlib.util
    return [f"missing Python module: {name}" for name in names if importlib.util.find_spec(name) is None]


def validate_ct_pipeline(source: Path | None, slugs: list[str]) -> list[str]:
    errors = validate_modules(["nibabel", "numpy", "pydicom", "PIL", "scipy"])
    if shutil.which("TotalSegmentator") is None:
        errors.append("missing executable on PATH: TotalSegmentator")
    if source is None:
        errors.append(f"missing DICOM root; set {ENV_DICOM_ROOT} or pass --source DIR")
        return errors
    sources = slug_source_map()
    for slug in slugs:
        src = sources.get(slug)
        if not src:
            errors.append(f"{slug}: no sourceFolder in manifest")
            continue
        folder = source / src
        if not has_candidate_files(folder):
            errors.append(f"{slug}: no candidate DICOM files in {folder}")
    return errors


def manifest_series(manifest_path: Path) -> set[str]:
    if not manifest_path.exists():
        return set()
    try:
        data = json.loads(manifest_path.read_text())
    except Exception:
        return set()
    return {str(series.get("slug")) for series in data.get("series", [])}


def validate_synthseg_pipeline(root: Path, data: Path, slugs: list[str], venv: Path) -> list[str]:
    errors = validate_modules(["nibabel", "numpy", "PIL", "scipy"])
    if find_mri_synthseg() is None:
        errors.extend(synthseg_repo_errors(root, venv))

    known_slugs = manifest_series(data / "manifest.json")
    if not known_slugs:
        errors.append(f"missing or unreadable manifest: {data / 'manifest.json'}")
    for slug in slugs:
        if known_slugs and slug not in known_slugs:
            errors.append(f"{slug}: not present in manifest")
        brain_dir = data / f"{slug}_brain"
        if not list(brain_dir.glob("*.png")):
            errors.append(f"{slug}: no brain PNG stack in {brain_dir}")
    return errors


def parse_slugs(raw: list[str], allowed: dict[str, str] | list[str], default: list[str]) -> list[str]:
    allowed_set = set(allowed)
    slugs = raw or default
    bad = [slug for slug in slugs if slug not in allowed_set]
    if bad:
        raise ValueError(f"unknown slug(s): {', '.join(bad)}")
    return slugs


def main() -> int:
    parser = argparse.ArgumentParser(description="Dry-run preflight for CT/SynthSeg pipeline runs.")
    _ = parser.add_argument("--source", type=str, default=None, help=f"DICOM root (default: {ENV_DICOM_ROOT})")
    _ = parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    _ = parser.add_argument("--data", type=Path, default=None)
    _ = parser.add_argument("--synthseg-venv", type=Path, default=Path("/tmp/synthseg_env"))
    _ = parser.add_argument("--ct", nargs="*", default=None, metavar="SLUG", help="CT slugs to check")
    _ = parser.add_argument("--synthseg", nargs="*", default=None, metavar="SLUG", help="SynthSeg slugs to check")
    _ = parser.add_argument("--projection-source", action="append", default=[], metavar="DIR", help="Calibrated projection folder to validate")
    _ = parser.add_argument("--ultrasound-source", action="append", default=[], metavar="DIR", help="Calibrated ultrasound folder to validate")
    _ = parser.add_argument("--no-ct", action="store_true")
    _ = parser.add_argument("--no-synthseg", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    data = (args.data or root / "data").resolve()
    errors: list[str] = []

    ct_known = series_by_modality("CT")
    mr_known = series_by_modality("MR")

    try:
        if not args.no_ct:
            ct_slugs = parse_slugs(args.ct or [], ct_known, ct_known)
            errors.extend(validate_ct_pipeline(resolve_source(args.source), ct_slugs))
        if not args.no_synthseg:
            ss_slugs = parse_slugs(args.synthseg or [], mr_known, mr_known)
            errors.extend(validate_synthseg_pipeline(root, data, ss_slugs, args.synthseg_venv))
        for raw in args.projection_source:
            errors.extend(validate_projection_source(Path(raw).expanduser().resolve()))
        for raw in args.ultrasound_source:
            errors.extend(validate_ultrasound_source(Path(raw).expanduser().resolve()))
    except ValueError as exc:
        errors.append(str(exc))

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("pipeline preflight ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
