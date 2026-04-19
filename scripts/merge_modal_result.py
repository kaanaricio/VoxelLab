#!/usr/bin/env python3
"""Merge one Modal/R2 processed series result into data/manifest.json."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from series_contract import merge_manifest_path


def result_url(r2_public_url: str, job_id: str) -> str:
    base = r2_public_url.rstrip("/")
    return f"{base}/results/{urllib.parse.quote(job_id, safe='')}/series.json"


def infer_public_base(source: str) -> str:
    parsed = urllib.parse.urlparse(source)
    parts = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(parts):
        if part == "results" and index + 2 < len(parts) and parts[index + 2] == "series.json":
            base_path = "/" + "/".join(parts[:index]) if index else ""
            return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, base_path, "", "", "")).rstrip("/")
    return ""


def infer_job_id(source: str) -> str | None:
    parsed = urllib.parse.urlparse(source)
    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    for index, part in enumerate(parts):
        if part == "results" and index + 2 < len(parts) and parts[index + 2] == "series.json":
            return parts[index + 1]
    return None


def read_result_json(source: str, timeout: int = 30) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme in {"http", "https"}:
        with urllib.request.urlopen(source, timeout=timeout) as response:
            data = json.loads(response.read().decode())
    else:
        data = json.loads(Path(source).read_text())
    if not isinstance(data, dict):
        raise ValueError("series result: expected JSON object")
    return data


def companion_projection_source(source: str) -> str:
    if source.endswith("/series.json"):
        return source[:-len("/series.json")] + "/projection_set.json"
    if source.endswith("series.json"):
        return source[:-len("series.json")] + "projection_set.json"
    return ""


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    _ = path.write_text(json.dumps(manifest, indent=2) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch/read a Modal R2 results/<job_id>/series.json and upsert it into data/manifest.json."
    )
    _ = parser.add_argument("source", nargs="?", help="Path or URL to series.json. Optional with --r2-public-url + --job-id.")
    _ = parser.add_argument("--root", type=Path, default=Path.cwd(), help="Repo root. Default: current directory.")
    _ = parser.add_argument("--manifest", type=Path, help="Manifest path. Default: <root>/data/manifest.json.")
    _ = parser.add_argument("--r2-public-url", help="Public R2 base URL used with --job-id to build the result URL.")
    _ = parser.add_argument("--job-id", help="Modal job id. Inferred from results/<job_id>/series.json URLs when omitted.")
    _ = parser.add_argument("--timeout", type=int, default=30, help="Network fetch timeout in seconds.")
    _ = parser.add_argument("--dry-run", action="store_true", help="Validate and report the merge without writing.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source and not (args.r2_public_url and args.job_id):
        print("source or --r2-public-url + --job-id is required", file=sys.stderr)
        return 2

    source = args.source or result_url(args.r2_public_url, args.job_id)
    job_id = args.job_id or infer_job_id(source)
    root = args.root.resolve()
    manifest_path = args.manifest or root / "data" / "manifest.json"

    entry = read_result_json(source, timeout=args.timeout)
    projection_entry = None
    projection_source = companion_projection_source(source)
    if projection_source:
        try:
            projection_entry = read_result_json(projection_source, timeout=args.timeout)
        except Exception:
            projection_entry = None
    public_base = args.r2_public_url or infer_public_base(source)
    manifest, action, index = merge_manifest_path(
        manifest_path,
        entry,
        projection_entry=projection_entry,
        job_id=job_id,
        public_base=public_base,
    )
    if not args.dry_run:
        write_manifest(manifest_path, manifest)

    slug = manifest["series"][index]["slug"]
    suffix = " (dry run)" if args.dry_run else ""
    print(f"{action} series[{index}] {slug} into {manifest_path}{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
