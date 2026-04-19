#!/usr/bin/env python3
"""Report SAM embedding sidecars and local embed preflight status."""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Callable


REQUIRED_MODULES = [
    ("numpy", "numpy"),
    ("torch", "torch"),
    ("Pillow", "PIL"),
    ("segment-anything", "segment_anything"),
]

SIDECAR_SUFFIXES = {
    "meta": "_sam_meta.json",
    "bin": "_sam_embed.bin",
    "zst": "_sam_embed.bin.zst",
}


def module_exists(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ValueError(f"{path}: file not found") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("series"), list):
        raise ValueError(f"{path}: expected manifest object with series list")
    return data


def selected_series(manifest: dict[str, Any], slugs: set[str]) -> tuple[list[dict[str, Any]], list[str]]:
    series = [item for item in manifest["series"] if isinstance(item, dict)]
    if not slugs:
        return series, []
    known = {str(item.get("slug")) for item in series}
    return [item for item in series if item.get("slug") in slugs], sorted(slugs - known)


def positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def sidecar_paths(data_dir: Path, slug: str) -> dict[str, Path]:
    return {kind: data_dir / f"{slug}{suffix}" for kind, suffix in SIDECAR_SUFFIXES.items()}


def expected_embed_bytes(meta: dict[str, Any]) -> int | None:
    keys = ("slices", "embed_dim", "embed_h", "embed_w")
    if meta.get("dtype") != "float16" or not all(positive_int(meta.get(key)) for key in keys):
        return None
    return int(meta["slices"] * meta["embed_dim"] * meta["embed_h"] * meta["embed_w"] * 2)


def validate_meta(meta: Any, series: dict[str, Any]) -> tuple[list[str], int | None]:
    if not isinstance(meta, dict):
        return ["meta is not an object"], None

    errors: list[str] = []
    slug = str(series.get("slug"))
    if meta.get("slug") != slug:
        errors.append(f"meta slug {meta.get('slug')!r} does not match {slug!r}")
    if positive_int(series.get("slices")) and meta.get("slices") != series["slices"]:
        errors.append(f"meta slices {meta.get('slices')!r} does not match manifest {series['slices']}")
    if meta.get("dtype") != "float16":
        errors.append(f"meta dtype {meta.get('dtype')!r} is not float16")

    expected_bytes = expected_embed_bytes(meta)
    if expected_bytes is None:
        errors.append("meta embedding shape is incomplete")
    elif meta.get("total_bytes") != expected_bytes:
        errors.append(f"meta total_bytes {meta.get('total_bytes')!r} does not match expected {expected_bytes}")

    return errors, expected_bytes


def read_meta(path: Path) -> tuple[Any | None, str | None]:
    try:
        return json.loads(path.read_text()), None
    except FileNotFoundError:
        return None, None
    except json.JSONDecodeError as exc:
        return None, f"invalid meta JSON: {exc}"


def series_report(data_dir: Path, series: dict[str, Any]) -> dict[str, Any]:
    slug = str(series.get("slug", ""))
    paths = sidecar_paths(data_dir, slug)
    errors: list[str] = []
    png_count = len(list((data_dir / slug).glob("*.png")))

    meta, meta_error = read_meta(paths["meta"])
    expected_bytes: int | None = None
    if meta_error:
        errors.append(meta_error)
    elif meta is not None:
        meta_errors, expected_bytes = validate_meta(meta, series)
        errors.extend(meta_errors)

    bin_size = paths["bin"].stat().st_size if paths["bin"].is_file() else None
    if expected_bytes is not None and bin_size is not None and bin_size != expected_bytes:
        errors.append(f"embed bin has {bin_size} bytes; expected {expected_bytes}")

    report = {
        "slug": slug,
        "manifest_slices": series.get("slices"),
        "png_count": png_count,
        "can_embed": png_count > 0,
        "meta": paths["meta"].is_file() and not meta_error,
        "bin": bin_size is not None,
        "zst": paths["zst"].is_file(),
        "complete": meta is not None and bin_size is not None and not errors,
        "errors": errors,
    }
    report["needs_embedding"] = not report["complete"]
    return report


def dependency_errors(exists: Callable[[str], bool] = module_exists) -> list[str]:
    return [f"missing Python module: {package}" for package, module in REQUIRED_MODULES if not exists(module)]


def build_report(
    manifest_path: Path,
    data_dir: Path,
    slugs: set[str] | None = None,
    exists: Callable[[str], bool] = module_exists,
) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    series, unknown = selected_series(manifest, slugs or set())
    reports = [series_report(data_dir, item) for item in series]

    prereq_errors = dependency_errors(exists)
    prereq_errors.extend(f"unknown slug: {slug}" for slug in unknown)
    for item in reports:
        if item["needs_embedding"] and item["png_count"] == 0:
            prereq_errors.append(f"{item['slug']}: no PNG stack in {data_dir / item['slug']}")

    return {
        "ready_to_run": not prereq_errors,
        "prerequisite_errors": prereq_errors,
        "zstd": shutil.which("zstd") is not None,
        "series": reports,
    }


def print_text_report(report: dict[str, Any]) -> None:
    print("SAM embedding preflight")
    print(f"ready_to_run: {'yes' if report['ready_to_run'] else 'no'}")
    print(f"zstd: {'yes' if report['zstd'] else 'no'}")

    if report["prerequisite_errors"]:
        print("prerequisites:")
        for error in report["prerequisite_errors"]:
            print(f"  ERROR: {error}")

    print("series:")
    for item in report["series"]:
        status = "have" if item["complete"] else "need"
        extras = []
        if item["zst"]:
            extras.append("zst")
        if item["errors"]:
            extras.append("sidecar-error")
        suffix = f" ({', '.join(extras)})" if extras else ""
        print(f"  {status}: {item['slug']} pngs={item['png_count']}{suffix}")
        for error in item["errors"]:
            print(f"    ERROR: {error}")

    missing = [item["slug"] for item in report["series"] if item["needs_embedding"] and item["can_embed"]]
    blocked = [item["slug"] for item in report["series"] if item["needs_embedding"] and not item["can_embed"]]
    if missing:
        print(f"run: python3 slimsam_embed.py {' '.join(missing)}")
    if blocked:
        print(f"blocked: local PNG stack missing for {' '.join(blocked)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report SAM embedding sidecars and local prerequisites.")
    _ = parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repo root. Default: current directory.")
    _ = parser.add_argument("--manifest", type=Path, help="Manifest path. Default: <root>/data/manifest.json.")
    _ = parser.add_argument("--data-dir", type=Path, help="Data directory. Default: manifest parent.")
    _ = parser.add_argument("--slug", action="append", dest="slugs", help="Limit report to one series slug. Repeatable.")
    _ = parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    manifest_path = args.manifest or root / "data" / "manifest.json"
    data_dir = args.data_dir or manifest_path.parent
    try:
        report = build_report(manifest_path, data_dir, set(args.slugs or []))
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text_report(report)
    return 0 if report["ready_to_run"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
