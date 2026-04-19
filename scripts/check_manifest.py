#!/usr/bin/env python3
"""Fast manifest/config contract checks for the static MRI viewer."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from series_contract import load_json, validate_manifest_data


def validate_config_data(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return ["config: expected object"]

    errors: list[str] = []
    for key in ("modalWebhookBase", "r2PublicUrl", "siteName", "disclaimer", "localApiToken"):
        if key in data and not isinstance(data[key], str):
            errors.append(f"config.{key}: expected string")
    if "modalAuthToken" in data:
        errors.append("config.modalAuthToken: no longer supported; keep Modal auth server-side")
    if "trustedUploadOrigins" in data:
        value = data["trustedUploadOrigins"]
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            errors.append("config.trustedUploadOrigins: expected string list")

    features = data.get("features")
    if features is not None:
        if not isinstance(features, dict):
            errors.append("config.features: expected object")
        else:
            for key in ("cloudProcessing", "aiAnalysis"):
                if key in features and not isinstance(features[key], bool):
                    errors.append(f"config.features.{key}: expected bool")

    return errors


def validate_paths(manifest_path: Path, config_path: Path | None) -> list[str]:
    errors: list[str] = []
    try:
        errors.extend(validate_manifest_data(load_json(manifest_path)))
    except ValueError as exc:
        errors.append(str(exc))

    if config_path is not None:
        try:
            errors.extend(validate_config_data(load_json(config_path)))
        except ValueError as exc:
            errors.append(str(exc))

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate data/manifest.json and config.json contracts.")
    _ = parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repo root. Default: current directory.")
    _ = parser.add_argument("--manifest", type=Path, help="Manifest path. Default: <root>/data/manifest.json.")
    _ = parser.add_argument("--config", type=Path, help="Config path. Default: <root>/config.json.")
    _ = parser.add_argument("--no-config", action="store_true", help="Skip config.json validation.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    manifest_path = args.manifest or root / "data" / "manifest.json"
    config_path = None if args.no_config else args.config or root / "config.json"
    errors = validate_paths(manifest_path, config_path)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"OK: {manifest_path}")
    if config_path is not None:
        print(f"OK: {config_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
