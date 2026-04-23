"""
Point-and-ask + consult endpoints for the viewer.

Two modes:

  ask:     The user selects a rectangle on a slice (or a point via CLI) and
           types a question. We pass a crop of that region plus the full slice
           to the configured AI provider.
           Results are cached in data/<slug>_asks.json keyed by
           (slice, x, y, question) so repeats don't pay for tokens.

  consult: Send ALL per-slice findings + summaries from every series to
           the configured AI provider and ask for a single consolidated read
           of what to bring up with a radiologist.
           Cached at data/consult.json; --force to regenerate.

Invoked by serve.py via /api/ask and /api/consult. Also runnable directly:

    python3 ask.py ask t2_tse 13 380 420 "what is this bright spot?"
    python3 ask.py consult
    python3 ask.py consult --force
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from ai_runtime import configured_provider, require_provider_ready, resolve_model, run_structured
from spatial_context import format_point_context, get_slice_context, load_context, voxel_to_mm

try:
    from PIL import Image
except ImportError:
    Image = None  # only needed for crop; consult mode works without PIL

ROOT = Path(__file__).parent
DATA = ROOT / "data"
DEFAULT_MODEL = None  # None → provider default model

# Input-validation constants. These are the only untrusted values that flow
# into the filesystem or the subprocess — everything else is derived from
# the already-on-disk manifest. Keep these tight.
MAX_QUESTION_LEN = 2000          # characters
MAX_SLICE_INDEX  = 10000         # defensive cap, real max per series is ≤56
MAX_COORD        = 10000

# Shape: "t2_tse" or "cloud_job123" for manifest-backed series directories under DATA/.
SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+$")



def _validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(f"invalid slug: {slug!r}")
    return slug


def _resolve_under_data(path: Path, *, strict: bool) -> Path:
    resolved = path.resolve(strict=strict)
    data_root = DATA.resolve()
    if resolved != data_root and data_root not in resolved.parents:
        raise ValueError(f"path escaped DATA: {path}")
    return resolved


def _series_meta(slug: str) -> dict:
    slug = _validate_slug(slug)
    try:
        manifest = json.loads((DATA / "manifest.json").read_text())
    except Exception as exc:
        raise ValueError("manifest unavailable") from exc
    meta = next((series for series in manifest.get("series", []) if series.get("slug") == slug), None)
    if not meta:
        raise ValueError(f"unknown slug: {slug!r}")
    return meta

ASK_SYSTEM = """You are assisting a non-medical user exploring their own brain MRI scans at home. You are NOT a radiologist and your output is NOT a diagnosis. The user is pointing at a specific spot on a brain MRI slice and asking a question about what they see. Answer in plain, educational language in 2-4 sentences. If the image shows something abnormal, say so neutrally and recommend they ask a radiologist. Never diagnose. Never speculate on severity or treatment."""

CONSULT_SYSTEM = """You are assisting a non-medical user exploring their own brain MRI scans at home. You are NOT a radiologist and your output is NOT a diagnosis. You have per-slice descriptive observations for the available sequences in the study (for example T1, T2, FLAIR, DWI, T2*, or susceptibility-weighted sequences). Your job is to synthesize them into a SHORT educational summary the user can bring to their own radiologist appointment. Structure the response as:

1. Overall impression (2-3 sentences, neutral and educational)
2. Things worth asking a radiologist about (bullet list — observations tagged attention/abnormal or that recur across sequences; say "none" if there are none)
3. What this study cannot assess (contrast-enhanced imaging, missing sequences, diffusion detail if unavailable, etc.) so the user has realistic expectations

Ground rules:
- You are NOT giving a diagnosis.
- Do not speculate about disease entities.
- Do not recommend treatment.
- If findings look like age-expected / normal variants, say so — that's valuable reassurance.
- Be honest if the scans don't show enough to say anything meaningful about a given question."""
def _call_ai(
    prompt: str,
    system: str,
    schema: dict | None = None,
    model: str | None = DEFAULT_MODEL,
    provider: str | None = None,
    images: list[Path] | None = None,
    timeout: int = 240,
) -> dict:
    if schema is None:
        raise RuntimeError("schema is required for VoxelLab AI calls")
    return run_structured(
        prompt=prompt,
        system=system,
        schema=schema,
        model=model,
        provider=provider,
        images=images,
        timeout=timeout,
    )


# ASK

ASK_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}


def _ask_cache_path(slug: str) -> Path:
    return DATA / f"{slug}_asks.json"


def _load_asks(slug: str) -> dict:
    p = _ask_cache_path(slug)
    if not p.exists():
        return {"slug": slug, "entries": []}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {"slug": slug, "entries": []}


def _save_asks(slug: str, data: dict) -> None:
    _ = _ask_cache_path(slug).write_text(json.dumps(data, indent=2))


def _ask_key(slice_idx: int, x: int, y: int, question: str) -> str:
    # Round coords so two clicks 5 px apart count as the same question
    bx = x // 20
    by = y // 20
    h = hashlib.sha1(question.strip().lower().encode()).hexdigest()[:10]
    return f"{slice_idx}:{bx}:{by}:{h}"


def _ask_region_key(slice_idx: int, x0: int, y0: int, x1: int, y1: int, question: str) -> str:
    """Cache key for rectangular selection (coarse grid to merge near-identical drags)."""
    g = 16
    bx0, by0, bx1, by1 = x0 // g, y0 // g, x1 // g, y1 // g
    h = hashlib.sha1(question.strip().lower().encode()).hexdigest()[:10]
    return f"{slice_idx}:r:{bx0}:{by0}:{bx1}:{by1}:{h}"


def _clamp_region(
    x0: int, y0: int, x1: int, y1: int, width: int, height: int,
) -> tuple[int, int, int, int]:
    """Inclusive pixel bounds (l, t, r, b), clamped to the image, l<=r, t<=b."""
    lm, rm = min(x0, x1), max(x0, x1)
    tm, bm = min(y0, y1), max(y0, y1)
    l = max(0, min(lm, width - 1))
    r = max(0, min(rm, width - 1))
    t = max(0, min(tm, height - 1))
    b = max(0, min(bm, height - 1))
    if l > r:
        l, r = r, l
    if t > b:
        t, b = b, t
    return l, t, r, b


def _downscale_max_side(im, max_side: int = 512):
    w, h = im.size
    if max(w, h) <= max_side:
        return im
    scale = max_side / max(w, h)
    nw = max(1, int(w * scale))
    nh = max(1, int(h * scale))
    return im.resize((nw, nh), Image.Resampling.BILINEAR)


def _region_mean_intensity(img, l: int, t: int, r: int, b: int) -> float:
    crop = img.crop((l, t, r + 1, b + 1))
    pixels = list(crop.getdata())
    return float(sum(pixels) / len(pixels)) if pixels else 0.0


def _cached_ask(data: dict, key: str, context_fingerprint: str | None) -> dict | None:
    for entry in data.get("entries", []):
        if entry.get("key") != key:
            continue
        if entry.get("contextFingerprint") != context_fingerprint:
            continue
        return {"cached": True, **entry}
    return None


def _pixel_label(slug: str, suffix: str, slice_idx: int, x: int, y: int, size: tuple[int, int]) -> int | None:
    if Image is None:
        return None
    path = DATA / f"{slug}{suffix}" / f"{slice_idx:04d}.png"
    if not path.exists():
        return None
    try:
        img = Image.open(path).convert("L")
    except Exception:
        return None
    if img.size != size:
        return None
    value = int(img.getpixel((x, y)))
    return value if value > 0 else None


def build_ask_prompt(
    *,
    crop_path: Path,
    slice_png: Path,
    slug: str,
    slice_idx: int,
    width: int,
    height: int,
    x: int,
    y: int,
    question: str,
    point_context_text: str,
    selection_mode: str = "point",
    region_bounds: tuple[int, int, int, int] | None = None,
) -> str:
    if selection_mode == "region" and region_bounds is not None:
        x0, y0, x1, y1 = region_bounds
        crop_desc = (
            f"The first image is the exact rectangular region the user selected on the slice "
            f"(inclusive pixel bounds: column {x0}–{x1}, row {y0}–{y1}). "
            f"It may be scaled down if large, preserving aspect ratio."
        )
        action_desc = (
            f"The user selected that rectangle on the full slice and asked:\n"
        )
    else:
        crop_desc = (
            "The first image is a crop from the research-viewer slice, centered on the point the user chose. "
        )
        action_desc = f"The user pointed at pixel ({x}, {y}) in the full slice and asked:\n"

    return (
        "Analyze the attached images.\n"
        f"{crop_desc}"
        f"The second image is the full slice (series: {slug}, slice index {slice_idx}, image dims {width}x{height}).\n\n"
        f"{action_desc}"
        f"\"{question}\"\n\n"
        f"{point_context_text}\n\n"
        "Answer in plain, educational language in 2-4 sentences. Identify the anatomical "
        "structure if you can. Use derived labels only as approximate context. Do not diagnose, "
        "recommend treatment, or imply that a derived label is certain. If the image is insufficient "
        "or the derived context may be wrong, say so. Respond with JSON {answer: \"...\"}."
        f"Crop path: {crop_path}\n"
        f"Full-slice path: {slice_png}\n"
    )


def ask(
    slug: str,
    slice_idx: int,
    question: str,
    *,
    x: int | None = None,
    y: int | None = None,
    region: tuple[int, int, int, int] | None = None,
    model: str | None = DEFAULT_MODEL,
    provider: str | None = None,
) -> dict:
    """Ask about a slice: either a point (x, y) or an inclusive rectangular region.

    Pass ``region=(x0,y0,x1,y1)`` for marquee selection; otherwise pass ``x`` and ``y`` for point mode.
    """
    slug = _validate_slug(slug)
    meta = _series_meta(slug)
    if not isinstance(question, str) or not question.strip():
        raise ValueError("empty question")
    if len(question) > MAX_QUESTION_LEN:
        raise ValueError(f"question too long (max {MAX_QUESTION_LEN} chars)")
    slice_idx = int(slice_idx)
    if slice_idx < 0 or slice_idx > MAX_SLICE_INDEX or slice_idx >= int(meta.get("slices", 0) or 0):
        raise ValueError(f"slice out of range: {slice_idx}")

    if region is not None:
        if x is not None or y is not None:
            raise ValueError("pass either region= or (x, y), not both")
        rx0, ry0, rx1, ry1 = (int(region[0]), int(region[1]), int(region[2]), int(region[3]))
    elif x is not None and y is not None:
        rx0 = ry0 = rx1 = ry1 = 0  # unused until point branch sets x,y
    else:
        raise ValueError("expected region=(x0,y0,x1,y1) or x and y")

    width = int(meta.get("width", 0) or 0)
    height = int(meta.get("height", 0) or 0)

    if region is not None:
        l, t, r, b = _clamp_region(rx0, ry0, rx1, ry1, width, height)
        if r - l < 1 or b - t < 1:
            raise ValueError("selection region is empty")
        cx = (l + r) // 2
        cy = (t + b) // 2
        key = _ask_region_key(slice_idx, l, t, r, b, question)
        selection_mode = "region"
        region_bounds = (l, t, r, b)
        point_x, point_y = cx, cy
    else:
        x = int(x)
        y = int(y)
        if x < 0 or x > MAX_COORD or y < 0 or y > MAX_COORD or x >= width or y >= height:
            raise ValueError(f"coordinates out of range: ({x}, {y})")
        key = _ask_key(slice_idx, x, y, question)
        selection_mode = "point"
        region_bounds = None
        point_x, point_y = x, y
        l = t = r = b = 0  # set in crop section for point mode

    data = _load_asks(slug)
    context, context_warning = load_context(DATA, slug, meta)
    if context_warning:
        print(f"WARNING: {context_warning}", file=sys.stderr)
    if context is None:
        cached = _cached_ask(data, key, None)
        if cached:
            return cached

    if Image is None:
        raise RuntimeError("PIL not available — install pillow")

    slice_png = DATA / slug / f"{slice_idx:04d}.png"
    try:
        _ = _resolve_under_data(slice_png, strict=True)
    except FileNotFoundError:
        raise FileNotFoundError(f"slice not found: {slice_png}")

    img = Image.open(slice_png).convert("L")
    W, H = img.size
    slice_context = get_slice_context(context, slice_idx)
    point_mm = voxel_to_mm(meta, point_x, point_y, slice_idx)
    tissue_label = _pixel_label(slug, "_seg", slice_idx, point_x, point_y, (W, H))
    region_lbl = _pixel_label(slug, "_regions", slice_idx, point_x, point_y, (W, H))
    if selection_mode == "region":
        mean_int = _region_mean_intensity(img, l, t, r, b)
    else:
        mean_int = float(img.getpixel((point_x, point_y)))
    pixel_intensity = {
        "source": "base_png",
        "units": "display_uint8",
        "mean": mean_int,
    }
    point_context_text, context_fingerprint = format_point_context(
        slice_context,
        x=point_x,
        y=point_y,
        mm=point_mm,
        pixel_intensity=pixel_intensity,
        tissue_label=tissue_label,
        region_label=region_lbl,
    )
    cached = _cached_ask(data, key, context_fingerprint)
    if cached:
        return cached

    _ = require_provider_ready(provider)

    if selection_mode == "point":
        R = 96
        px, py = point_x, point_y
        l = max(0, px - R)
        t = max(0, py - R)
        r_ex = min(W, px + R)
        b_ex = min(H, py + R)
        crop = img.crop((l, t, r_ex, b_ex))
    else:
        crop = img.crop((l, t, r + 1, b + 1))
        crop = _downscale_max_side(crop, 512)

    crop_dir = DATA / f"{slug}_asks"
    crop_dir.mkdir(exist_ok=True)
    _ = _resolve_under_data(crop_dir, strict=True)
    if selection_mode == "region":
        crop_path = crop_dir / f"{slice_idx:04d}_r{l}_{t}_{r}_{b}_{key[-10:]}.png"
    else:
        crop_path = crop_dir / f"{slice_idx:04d}_{point_x}_{point_y}_{key[-10:]}.png"
    _ = _resolve_under_data(crop_path, strict=False)
    crop.save(crop_path)

    prompt = build_ask_prompt(
        crop_path=crop_path,
        slice_png=slice_png,
        slug=slug,
        slice_idx=slice_idx,
        width=W,
        height=H,
        x=point_x,
        y=point_y,
        question=question,
        point_context_text=point_context_text,
        selection_mode=selection_mode,
        region_bounds=region_bounds,
    )
    out = _call_ai(
        prompt,
        ASK_SYSTEM,
        ASK_SCHEMA,
        model=model,
        provider=provider,
        images=[crop_path, slice_png],
    )
    answer = (out or {}).get("answer", "").strip()

    entry: dict = {
        "key":      key,
        "slice":    slice_idx,
        "x":        point_x,
        "y":        point_y,
        "question": question,
        "answer":   answer,
        "crop":     str(crop_path.relative_to(ROOT)),
    }
    if selection_mode == "region" and region_bounds is not None:
        entry["region"] = list(region_bounds)
    if context_fingerprint:
        entry["contextFingerprint"] = context_fingerprint
    data.setdefault("entries", []).append(entry)
    _save_asks(slug, data)
    return {"cached": False, **entry}


# CONSULT

CONSULT_SCHEMA = {
    "type": "object",
    "properties": {
        "impression": {"type": "string"},
        "ask_radiologist": {"type": "array", "items": {"type": "string"}},
        "limitations": {"type": "string"},
    },
    "required": ["impression", "ask_radiologist", "limitations"],
    "additionalProperties": False,
}


def consult(model: str | None = DEFAULT_MODEL, provider: str | None = None, force: bool = False) -> dict:
    out_path = DATA / "consult.json"
    if out_path.exists() and not force:
        try:
            return {"cached": True, **json.loads(out_path.read_text())}
        except Exception:
            pass

    _ = require_provider_ready(provider)

    manifest = json.loads((DATA / "manifest.json").read_text())
    sections = []
    for s in manifest["series"]:
        slug = s["slug"]
        ap = DATA / f"{slug}_analysis.json"
        if not ap.exists():
            continue
        a = json.loads(ap.read_text())
        if not a.get("findings"):
            continue
        grounded = sum(1 for finding in a["findings"] if finding.get("contextFingerprint"))
        lines = [f"## {s['name']} ({slug}) — {s['description']}"]
        lines.append(f"Grounded observations: {grounded}/{len(a['findings'])}. If not all observations are grounded, treat older cached observations as lower-confidence descriptive notes.")
        if a.get("summary"):
            lines.append(f"Summary: {a['summary']}")
        lines.append("Per-slice observations:")
        for f in a["findings"]:
            tag = (f.get("severity") or "note").upper()
            lines.append(f"- slice {f['slice']+1} [{tag}]: {f['text']}")
        sections.append("\n".join(lines))

    if not sections:
        raise RuntimeError("no analysis data to consult on — run analyze.py first")

    # Also pass symmetry peaks so the model knows which slices had the
    # most visual asymmetry (we already computed these offline).
    peaks = []
    for s in manifest["series"]:
        sp = DATA / f"{s['slug']}_stats.json"
        if sp.exists():
            st = json.loads(sp.read_text())
            scores = st.get("symmetryScores") or []
            if scores:
                peak_idx = max(range(len(scores)), key=lambda i: scores[i])
                peaks.append(f"- {s['slug']}: most asymmetric slice #{peak_idx+1} (score {scores[peak_idx]:.1f})")

    prompt = (
        "You have the full set of descriptive observations from a brain MRI study "
        + "below. The available series were read slice-by-slice by an earlier pass "
        + "of the same model. Your job now is to synthesize without assuming that "
        + "every possible sequence is present.\n\n"
        + "\n\n".join(sections)
        + ("\n\nAutomated symmetry peaks (image-math, not AI):\n" + "\n".join(peaks) if peaks else "")
        + "\n\nRespond with JSON matching the schema: {impression: '<2-3 sentences>', "
        + "ask_radiologist: ['<bullet>', '<bullet>', ...] (empty if nothing notable), "
        + "limitations: '<1-2 sentences on what this study cannot assess>'}."
    )
    result = _call_ai(prompt, CONSULT_SYSTEM, CONSULT_SCHEMA, model=model, provider=provider, timeout=360)

    out = {
        "disclaimer": (
            "AI-generated consolidated read. NOT A DIAGNOSIS. "
            + "Always consult a qualified radiologist."
        ),
        "provider":   configured_provider(provider),
        "model":      resolve_model(model, provider),
        "impression": (result or {}).get("impression", ""),
        "ask_radiologist": (result or {}).get("ask_radiologist", []),
        "limitations":     (result or {}).get("limitations", ""),
    }
    _ = out_path.write_text(json.dumps(out, indent=2))
    return {"cached": False, **out}


# CLI

def main() -> bool:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("ask")
    _ = a.add_argument("slug")
    _ = a.add_argument("slice", type=int)
    _ = a.add_argument("x", type=int)
    _ = a.add_argument("y", type=int)
    _ = a.add_argument("question")
    _ = a.add_argument("--provider", choices=["claude", "codex"], help="AI provider (default: VOXELLAB_AI_PROVIDER or claude)")
    _ = a.add_argument("--model", default=DEFAULT_MODEL, help="AI model (default: provider-specific)")

    c = sub.add_parser("consult")
    _ = c.add_argument("--force", action="store_true")
    _ = c.add_argument("--provider", choices=["claude", "codex"], help="AI provider (default: VOXELLAB_AI_PROVIDER or claude)")
    _ = c.add_argument("--model", default=DEFAULT_MODEL, help="AI model (default: provider-specific)")

    args = ap.parse_args()
    try:
        if args.cmd == "ask":
            r = ask(
                args.slug,
                args.slice,
                args.question,
                x=args.x,
                y=args.y,
                model=args.model,
                provider=args.provider,
            )
            print(json.dumps(r, indent=2))
        elif args.cmd == "consult":
            r = consult(model=args.model, provider=args.provider, force=args.force)
            print(json.dumps(r, indent=2))
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return False
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
