#!/usr/bin/env python3
"""Validate local viewer assets without network, GPU, Modal, or R2 access."""

from __future__ import annotations

import argparse
import struct
import sys
import urllib.parse
from pathlib import Path
from typing import Any

try:
    from series_contract import load_json, validate_manifest_data
    from spatial_context import KNOWN_INTENSITY_UNITS, validate_context_payload
except ImportError:  # pragma: no cover - used when run as scripts/check_assets.py
    repo_root = Path(__file__).resolve().parent.parent
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from series_contract import load_json, validate_manifest_data
    from spatial_context import KNOWN_INTENSITY_UNITS, validate_context_payload

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

STACK_FLAGS = {
    "hasBrain": "_brain",
    "hasSeg": "_seg",
    "hasSym": "_sym",
    "hasRegions": "_regions",
}

SIDECAR_FLAGS = {
    "hasRegions": "_regions.json",
    "hasStats": "_stats.json",
    "hasAnalysis": "_analysis.json",
    "hasContext": "_context.json",
}

REMOTE_STACK_URL_FIELDS = {
    "": "sliceUrlBase",
    "_regions": "regionUrlBase",
}

REMOTE_SIDECAR_URL_FIELDS = {
    "hasRegions": "regionMetaUrl",
}


def is_remote_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) < 24 or not header.startswith(PNG_MAGIC) or header[12:16] != b"IHDR":
        raise ValueError("not a PNG with an IHDR header")
    return struct.unpack(">II", header[16:24])


def expected_png_names(count: int) -> set[str]:
    return {f"{index:04d}.png" for index in range(count)}


def sample_indexes(count: int, exhaustive: bool) -> list[int]:
    if exhaustive:
        return list(range(count))
    return sorted({0, count // 2, count - 1})


def validate_stack(
    data_dir: Path,
    stack_name: str,
    count: int,
    width: int,
    height: int,
    exhaustive: bool,
) -> list[str]:
    folder = data_dir / stack_name
    if not folder.is_dir():
        return [f"{stack_name}: missing directory {folder}"]

    actual_names = {path.name for path in folder.glob("*.png")}
    expected_names = expected_png_names(count)
    errors: list[str] = []
    if len(actual_names) != count:
        errors.append(f"{stack_name}: stack has {len(actual_names)} PNGs; expected {count}")
    missing = sorted(expected_names - actual_names)
    extras = sorted(actual_names - expected_names)
    if missing:
        errors.append(f"{stack_name}: missing PNGs: {', '.join(missing[:5])}{' ...' if len(missing) > 5 else ''}")
    if extras:
        errors.append(f"{stack_name}: unexpected PNGs: {', '.join(extras[:5])}{' ...' if len(extras) > 5 else ''}")

    for index in sample_indexes(count, exhaustive):
        path = folder / f"{index:04d}.png"
        if not path.exists():
            continue
        try:
            actual_width, actual_height = png_size(path)
        except ValueError as exc:
            errors.append(f"{stack_name}/{path.name}: {exc}")
            continue
        if (actual_width, actual_height) != (width, height):
            errors.append(
                f"{stack_name}/{path.name}: dimensions {actual_width}x{actual_height}; expected {width}x{height}"
            )
    return errors


def validate_sidecars(data_dir: Path, series: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    slug = series["slug"]
    for flag, suffix in SIDECAR_FLAGS.items():
        if is_remote_url(series.get(REMOTE_SIDECAR_URL_FIELDS.get(flag, ""))):
            continue
        if series.get(flag) and not (data_dir / f"{slug}{suffix}").is_file():
            errors.append(f"{slug}: missing sidecar {slug}{suffix}")
    return errors


def validate_context_sidecar(data_dir: Path, series: dict[str, Any]) -> list[str]:
    if not series.get("hasContext"):
        return []

    slug = series["slug"]
    path = data_dir / f"{slug}_context.json"
    if not path.is_file():
        return []

    try:
        payload = load_json(path)
    except ValueError as exc:
        return [str(exc)]

    context_errors = validate_context_payload(payload, slug, series["slices"])
    if not context_errors:
        return []

    known_units = sorted(KNOWN_INTENSITY_UNITS)
    errors = [f"{slug}_context.json: {error}" for error in context_errors]
    if any("unit" in error for error in context_errors):
        errors.append(f"{slug}_context.json: known intensity units {known_units}")
    return errors


def stack_is_remote(series: dict[str, Any], suffix: str) -> bool:
    return is_remote_url(series.get(REMOTE_STACK_URL_FIELDS.get(suffix, "")))


def validate_assets(
    manifest: dict[str, Any],
    data_dir: Path,
    exhaustive: bool = False,
    slugs: set[str] | None = None,
) -> list[str]:
    errors = validate_manifest_data(manifest)
    if errors:
        return errors

    series_list = manifest["series"]
    known_slugs = {series["slug"] for series in series_list}
    if slugs:
        unknown = sorted(slugs - known_slugs)
        if unknown:
            errors.extend(f"unknown slug: {slug}" for slug in unknown)

    for series in series_list:
        slug = series["slug"]
        if slugs and slug not in slugs:
            continue
        count = series["slices"]
        width = series["width"]
        height = series["height"]
        if not stack_is_remote(series, ""):
            errors.extend(validate_stack(data_dir, slug, count, width, height, exhaustive))
        for flag, suffix in STACK_FLAGS.items():
            if series.get(flag) and not stack_is_remote(series, suffix):
                errors.extend(validate_stack(data_dir, f"{slug}{suffix}", count, width, height, exhaustive))
        errors.extend(validate_sidecars(data_dir, series))
        errors.extend(validate_context_sidecar(data_dir, series))

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate local data/ PNG stacks and sidecars.")
    _ = parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repo root. Default: current directory.")
    _ = parser.add_argument("--manifest", type=Path, help="Manifest path. Default: <root>/data/manifest.json.")
    _ = parser.add_argument("--data-dir", type=Path, help="Data directory. Default: manifest parent.")
    _ = parser.add_argument("--mode", choices=["local-fast", "full"], default="local-fast")
    _ = parser.add_argument("--exhaustive", action="store_true", help="Check dimensions for every PNG instead of first/mid/last.")
    _ = parser.add_argument("--slug", action="append", dest="slugs", help="Limit validation to a series slug. Repeatable.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    manifest_path = args.manifest or root / "data" / "manifest.json"
    data_dir = args.data_dir or manifest_path.parent
    try:
        manifest = load_json(manifest_path)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1
    exhaustive = args.exhaustive or args.mode == "full"
    errors = validate_assets(manifest, data_dir, exhaustive=exhaustive, slugs=set(args.slugs or []))
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    mode = "exhaustive" if exhaustive else "fast"
    print(f"OK: {data_dir} assets ({mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
