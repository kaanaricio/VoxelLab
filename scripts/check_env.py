#!/usr/bin/env python3
"""Environment preflight checks for optional cloud/release workflows."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import sys


CLOUD_REQUIRED = (
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
)


def load_dotenv(path: str = ".env") -> dict[str, str]:
    """Return simple KEY=VALUE pairs from .env without adding a dependency."""
    env: dict[str, str] = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def merged_env() -> dict[str, str]:
    # Example shape: {"R2_BUCKET": "scan-data", "R2_PUBLIC_URL": "https://..."}
    env = dict(os.environ)
    for key, value in load_dotenv().items():
        _ = env.setdefault(key, value)
    return env


def find_executable(name: str) -> str | None:
    # Example shape: "/repo/.venv/bin/modal" when npm run setup -- --cloud created it.
    found = shutil.which(name)
    if found:
        return found
    for directory in (Path(sys.executable).parent, Path.cwd() / ".venv" / "bin", Path.cwd() / ".venv" / "Scripts"):
        candidate = directory / (f"{name}.exe" if os.name == "nt" else name)
        if candidate.exists():
            return str(candidate)
    return None


def check_cloud(dry_run: bool) -> list[str]:
    env = merged_env()
    errors: list[str] = []
    for key in CLOUD_REQUIRED:
        if not env.get(key):
            errors.append(f"missing {key}")
    for exe in ("modal", "zstd"):
        if find_executable(exe) is None:
            errors.append(f"missing executable: {exe}")
    if not dry_run:
        errors.append("non-dry-run cloud checks are not implemented; refusing to touch R2/Modal")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--mode", choices=["cloud"], default="cloud")
    _ = parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    errors = check_cloud(dry_run=args.dry_run)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("cloud env preflight ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
