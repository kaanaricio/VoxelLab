"""
Send key slices from each MRI series to the configured local AI provider and
save descriptive findings.

NOT A DIAGNOSIS. The configured AI provider is a general-purpose model, not a
radiologist-certified medical AI. This script produces *descriptive*
observations that should only be used as a starting point for a real
radiologist reading. Do not act on findings from this script.

Usage:
    python3 analyze.py              # analyze all series (skips already-done)
    python3 analyze.py t2_tse       # analyze one series
    python3 analyze.py --slices 12 t2_tse
    python3 analyze.py --force      # re-analyze even if JSON already exists
    python3 analyze.py --provider codex t2_tse

Idempotent: previously-analyzed slices are cached in data/<slug>_analysis.json
and reused on the next run. JSON is written after *every* slice, so a crash or
Ctrl-C mid-run loses at most one slice. This is deliberate — the DICOM pixel
data does not change, and re-sending the same slices to the AI provider just burns
tokens.

Writes:
    data/<slug>_analysis.json    (written incrementally after each slice)
    + sets hasAnalysis: true in manifest.json once the series is complete
"""

import argparse
import json
import re
import sys
from pathlib import Path

from ai_runtime import configured_provider, require_provider_ready, resolve_model, run_structured
from series_contract import validate_manifest_data
from spatial_context import format_analysis_context, get_slice_context, load_context

DATA = Path(__file__).parent / "data"
SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

DEFAULT_MODEL = None
DEFAULT_SAMPLE_COUNT = 5

SYSTEM_PROMPT = """You are assisting a non-medical user exploring their own brain MRI scans at home. You are NOT a radiologist and your output is NOT a diagnosis.

For each slice image you Read, describe what you observe in plain, educational language. Focus on:
- Anatomical structures visible (ventricles, gray/white matter, CSF spaces, basal ganglia, etc.)
- Symmetry left vs. right
- Anything unusual in signal intensity, shape, size, or symmetry that a human might want to ask a radiologist about
- The MRI sequence type if identifiable (T1, T2, FLAIR, DWI, SWI) and what it's sensitive to

Be specific about the slice content. Do NOT diagnose conditions. Do NOT guess. If something looks unusual, describe the observation neutrally and classify severity as "attention" (worth asking about) or "note" (normal/benign observation). Reserve "abnormal" only if there is a clearly visible structural abnormality (mass, bleed, large asymmetry, etc.)."""


FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": ["note", "attention", "abnormal"]},
        "text": {"type": "string"},
        "regions_referenced": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["severity", "text"],
    "additionalProperties": False,
}

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
    "additionalProperties": False,
}

def call_ai(prompt: str, schema: dict, model: str | None, provider: str | None, images: list[Path] | None = None, timeout: int = 180) -> dict:
    return run_structured(
        prompt=prompt,
        system=SYSTEM_PROMPT,
        schema=schema,
        model=model,
        provider=provider,
        images=images,
        timeout=timeout,
    )


def _validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(f"invalid slug: {slug!r}")
    return slug


def build_analysis_prompt(series_meta: dict, slice_idx: int, slice_context: dict | None) -> tuple[str, set[int], str | None]:
    context_text, allowed_regions, fingerprint = format_analysis_context(slice_context, int(series_meta.get("slices", 0) or 0))
    prompt = (
        "Analyze the attached research-viewer slice image.\n"
        f"Series: {series_meta.get('name', 'unknown')}. Slice index: {slice_idx} of {series_meta.get('slices', 'unknown')}.\n\n"
        f"{context_text}\n\n"
        "Task:\n"
        "- Describe visible anatomy and image appearance in plain educational language.\n"
        "- You may reference region names only as approximate pipeline-derived labels.\n"
        "- Do not diagnose, infer disease, recommend treatment, or state certainty.\n"
        "- If context and image disagree, say the context may be unreliable rather than forcing agreement.\n\n"
        "Respond with a JSON object matching the schema: "
        "{severity: 'note' | 'attention' | 'abnormal', text: '1-3 sentences', regions_referenced?: [label integers]}."
    )
    return prompt, allowed_regions, fingerprint


def filter_region_references(raw_labels, allowed_regions: set[int]) -> list[int]:
    if not isinstance(raw_labels, list) or not allowed_regions:
        return []
    seen: set[int] = set()
    labels: list[int] = []
    for label in raw_labels:
        if isinstance(label, int) and not isinstance(label, bool) and label in allowed_regions and label not in seen:
            seen.add(label)
            labels.append(label)
    return labels


def analyze_slice(
    series_name: str,
    slice_idx: int,
    png_path: Path,
    model: str | None,
    provider: str | None = None,
    series_meta: dict | None = None,
    context: dict | None = None,
) -> dict:
    meta = series_meta or {"name": series_name, "slices": "unknown"}
    slice_context = get_slice_context(context, slice_idx)
    prompt, allowed_regions, fingerprint = build_analysis_prompt(meta, slice_idx, slice_context)
    out = call_ai(prompt, FINDING_SCHEMA, model, provider, images=[png_path])
    finding = {"slice": slice_idx, "severity": out.get("severity", "note"), "text": out.get("text", "")}
    regions_referenced = filter_region_references(out.get("regions_referenced"), allowed_regions)
    if regions_referenced:
        finding["regions_referenced"] = regions_referenced
    if fingerprint:
        finding["contextFingerprint"] = fingerprint
    return finding


def representative_slice_ids(total: int, sample_count: int = DEFAULT_SAMPLE_COUNT) -> list[int]:
    """Return evenly spaced zero-based slices for a bounded overview pass."""
    if total <= 0 or sample_count <= 0:
        return []
    if total <= sample_count:
        return list(range(total))
    if sample_count == 1:
        return [total // 2]
    return sorted({round(i * (total - 1) / (sample_count - 1)) for i in range(sample_count)})


def parse_slice_spec(spec: str, total: int) -> list[int]:
    """Parse zero-based slice ids/ranges like "0,12,20-22"."""
    selected: set[int] = set()
    for raw_part in spec.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start, end = int(start_s), int(end_s)
            if end < start:
                raise ValueError(f"slice range is reversed: {part}")
            values = range(start, end + 1)
        else:
            values = [int(part)]
        for value in values:
            if value < 0 or value >= total:
                raise ValueError(f"slice out of range: {value} (valid 0-{total - 1})")
            selected.add(value)
    if not selected:
        raise ValueError("no slices selected")
    return sorted(selected)


def summarize(slug: str, series_name: str, findings: list, model: str | None, provider: str | None = None) -> str:
    grounded = sum(1 for finding in findings if finding.get("contextFingerprint"))
    bullets = "\n".join(f"- slice {f['slice']}: {f['text']}" for f in findings)
    prompt = (
        f"You just reviewed a brain MRI series.\n\n"
        f"Series: {series_name} ({slug})\n"
        f"Grounded observations: {grounded} of {len(findings)} findings include approximate derived context.\n"
        f"If not all findings are grounded, briefly note that older cached observations may be less reliable than context-grounded ones.\n\n"
        f"{bullets}\n\n"
        f"Summarize in 2-3 sentences:\n"
        f"- The sequence type and what it shows\n"
        f"- Overall impression (symmetric? normal-appearing structures? anything notable?)\n"
        f"- A reminder that this is not a diagnosis\n\n"
        f"Respond with JSON {{summary: '<text>'}}."
    )
    out = call_ai(prompt, SUMMARY_SCHEMA, model, provider)
    return out.get("summary", "")


def process(
    slug: str,
    series_meta: dict,
    model: str | None,
    provider: str | None = None,
    force: bool = False,
    selected_slices: list[int] | None = None,
    sample_count: int = DEFAULT_SAMPLE_COUNT,
):
    slug = _validate_slug(slug)
    name = series_meta["name"]
    total = series_meta["slices"]
    folder = DATA / slug
    out_path = DATA / f"{slug}_analysis.json"

    # Load any previously-written analysis so we can resume instead of
    # re-sending slices we've already paid for.
    existing = {}
    if out_path.exists() and not force:
        try:
            existing = json.loads(out_path.read_text())
        except Exception:
            existing = {}
    context, context_warning = load_context(DATA, slug, series_meta)
    if context_warning:
        print(f"  WARNING: {context_warning}", flush=True)
    cached = {int(f["slice"]): f for f in existing.get("findings", [])}
    overview_slices = representative_slice_ids(total, sample_count)
    was_complete = bool(existing.get("coverage", {}).get("isComplete"))
    is_partial_request = selected_slices is not None

    out = {
        "slug": slug,
        "name": name,
        "provider": existing.get("provider", configured_provider(provider)),
        "model": existing.get("model", resolve_model(model, provider)),
        "disclaimer": "AI-generated descriptive observations. NOT A DIAGNOSIS. Always consult a radiologist.",
        "summary": existing.get("summary", ""),
        "findings": sorted(cached.values(), key=lambda f: f["slice"]),
        "coverage": existing.get("coverage", {}),
    }
    # Write immediately so a later abort doesn't blow away prior runs' data.
    _ = out_path.write_text(json.dumps(out, indent=2))

    slice_ids = selected_slices if selected_slices is not None else representative_slice_ids(total, sample_count)
    need = [i for i in slice_ids if i not in cached]
    mode = f"selected {len(slice_ids)}" if selected_slices is not None else f"{len(slice_ids)} representative"
    print(
        f"\n=== {name} ({slug}) — {total} slices, {mode} — "
        + f"{len(cached)} cached, {len(need)} to analyze ===",
        flush=True,
    )

    if not need and existing.get("summary"):
        print(f"  (fully cached — nothing to do)", flush=True)
        completed_overview = all(slice_idx in cached for slice_idx in overview_slices)
        return was_complete or (not is_partial_request and completed_overview and bool(out.get("summary", "").strip()))

    for i in need:
        png = folder / f"{i:04d}.png"
        if not png.exists():
            continue
        try:
            f = analyze_slice(name, i, png, model, provider=provider, series_meta=series_meta, context=context)
            cached[i] = f
            tag = f.get("severity", "note")
            print(f"  slice {i:3d}  [{tag:9s}]  {f.get('text', '')[:80]}", flush=True)
        except Exception as e:
            print(f"  slice {i:3d}  ERROR: {e}", flush=True)
            continue
        # Flush to disk after every slice — this is the whole point of the
        # idempotent rewrite. No Ctrl-C = wasted tokens.
        out["findings"] = sorted(cached.values(), key=lambda f: f["slice"])
        _ = out_path.write_text(json.dumps(out, indent=2))

    # Generate summary only if we actually did new work (or none exists yet)
    if need or not out.get("summary"):
        try:
            out["summary"] = summarize(slug, name, out["findings"], model, provider=provider)
        except Exception as e:
            print(f"  summary error: {e}", flush=True)
    is_complete = was_complete or (
        not is_partial_request
        and all(slice_idx in cached for slice_idx in overview_slices)
        and bool(out.get("summary", "").strip())
    )
    out["coverage"] = {
        "overviewSlices": overview_slices,
        "analyzedSlices": sorted(cached),
        "isComplete": is_complete,
    }
    _ = out_path.write_text(json.dumps(out, indent=2))
    print(f"  wrote {out_path.name} ({len(out['findings'])} findings)", flush=True)
    return out["coverage"]["isComplete"]


def update_manifest(slugs):
    path = DATA / "manifest.json"
    wanted = {_validate_slug(slug) for slug in slugs}
    m = json.loads(path.read_text())
    for s in m["series"]:
        if s["slug"] in wanted:
            s["hasAnalysis"] = True
    errors = validate_manifest_data(m)
    if errors:
        raise ValueError("\n".join(errors))
    _ = path.write_text(json.dumps(m, indent=2))


def main() -> bool:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument("slugs", nargs="*", help="series slugs to analyze (default: all)")
    _ = ap.add_argument("--provider", choices=["claude", "codex"], help="AI provider (default: VOXELLAB_AI_PROVIDER or claude)")
    _ = ap.add_argument("--model", default=DEFAULT_MODEL, help="AI model (default: provider-specific)")
    _ = ap.add_argument("--slices", help='zero-based slice ids/ranges, e.g. "12" or "0,12,20-22"')
    _ = ap.add_argument("--sample-count", type=int, default=DEFAULT_SAMPLE_COUNT, help="representative slices per series")
    _ = ap.add_argument("--force", action="store_true", help="re-analyze slices even if already cached")
    args = ap.parse_args()

    try:
        status = require_provider_ready(args.provider)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return False
    print(f"Using provider {status['provider']} ({status.get('auth_mode') or 'ready'})", flush=True)

    m = json.loads((DATA / "manifest.json").read_text())
    requested = args.slugs or [s["slug"] for s in m["series"]]

    processed = []
    ok = True
    for slug in requested:
        meta = next((s for s in m["series"] if s["slug"] == slug), None)
        if not meta:
            print(f"unknown slug: {slug}", file=sys.stderr, flush=True)
            ok = False
            continue
        try:
            selected = parse_slice_spec(args.slices, meta["slices"]) if args.slices else None
        except ValueError as e:
            print(f"{slug}: {e}", file=sys.stderr, flush=True)
            ok = False
            continue
        completed = process(
            slug,
            meta,
            args.model,
            provider=args.provider,
            force=args.force,
            selected_slices=selected,
            sample_count=args.sample_count,
        )
        if completed:
            processed.append(slug)

    update_manifest(processed)
    print("\nDone. Refresh the viewer.", flush=True)
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
