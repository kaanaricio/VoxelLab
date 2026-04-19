#!/usr/bin/env python3
"""Refresh context sidecars and AI analysis artifacts for bundled data."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import analyze
import ask
import context
from ai_runtime import configured_provider, require_provider_ready, resolve_model
DATA = ROOT / "data"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh VoxelLab demo AI artifacts.")
    _ = parser.add_argument("slugs", nargs="*", help="Series slugs. Defaults to manifest-backed local stacks.")
    _ = parser.add_argument("--provider", choices=["claude", "codex"], help="AI provider override")
    _ = parser.add_argument("--model", default=None, help="AI model override")
    _ = parser.add_argument("--sample-count", type=int, default=analyze.DEFAULT_SAMPLE_COUNT)
    _ = parser.add_argument("--force", action="store_true", help="Regenerate analysis and consult even if cached")
    _ = parser.add_argument("--skip-context", action="store_true", help="Do not regenerate spatial context sidecars")
    _ = parser.add_argument("--skip-consult", action="store_true", help="Do not regenerate consult.json")
    return parser.parse_args()


def manifest_series() -> tuple[Path, dict[str, dict]]:
    path = DATA / "manifest.json"
    manifest = json.loads(path.read_text())
    return path, context.series_by_slug(manifest)


def selected_slugs(requested: list[str], by_slug: dict[str, dict]) -> list[str]:
    return requested or [slug for slug in by_slug if (DATA / slug).is_dir()]


def generate_context(slugs: list[str], by_slug: dict[str, dict], manifest_path: Path) -> bool:
    wrote: set[str] = set()
    ok = True
    for slug in slugs:
        series = by_slug.get(slug)
        if not series:
            print(f"unknown slug: {slug}", file=sys.stderr)
            ok = False
            continue
        try:
            payload = context.generate_series_context(DATA, series)
            path = context.write_context(DATA, payload)
            wrote.add(slug)
            print(f"wrote {path}")
        except Exception as exc:
            print(f"{slug}: {exc}", file=sys.stderr)
            ok = False
    if wrote:
        context.set_has_context(manifest_path, wrote)
    return ok


def main() -> int:
    args = parse_args()
    manifest_path, by_slug = manifest_series()
    slugs = selected_slugs(args.slugs, by_slug)
    ok = True

    if not args.skip_context:
        ok = generate_context(slugs, by_slug, manifest_path) and ok

    try:
        status = require_provider_ready(args.provider)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    provider = configured_provider(args.provider)
    model = resolve_model(args.model, provider)
    print(f"Using provider {provider} ({status.get('auth_mode') or 'ready'})")
    print(f"Using model {model}")

    completed: list[str] = []
    for slug in slugs:
        series = by_slug.get(slug)
        if not series:
            print(f"unknown slug: {slug}", file=sys.stderr)
            ok = False
            continue
        try:
            done = analyze.process(
                slug,
                series,
                model,
                provider=provider,
                force=args.force,
                sample_count=args.sample_count,
            )
            if done:
                completed.append(slug)
        except Exception as exc:
            print(f"{slug}: {exc}", file=sys.stderr)
            ok = False

    if completed:
        analyze.update_manifest(completed)

    if not args.skip_consult:
        try:
            result = ask.consult(model=model, provider=provider, force=args.force)
            print(f"consult cached={result.get('cached')}")
        except Exception as exc:
            print(f"consult: {exc}", file=sys.stderr)
            ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
