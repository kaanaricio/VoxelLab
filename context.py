"""Generate per-series spatial context sidecars for grounded AI prompts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from spatial_context import TISSUE_LABELS, validate_context_payload, voxel_to_mm

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover - exercised by users without pipeline extras
    np = None
    Image = None

ROOT = Path(__file__).parent
DATA = ROOT / "data"

def require_pipeline_deps() -> None:
    if np is None or Image is None:
        raise RuntimeError("context generation requires pipeline extras: run `python3 -m pip install -e '.[pipeline]'`")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def png_path(folder: Path, index: int) -> Path:
    return folder / f"{index:04d}.png"


def load_gray(path: Path):
    assert Image is not None
    return np.array(Image.open(path).convert("L"))


def load_optional_stack_slice(data_dir: Path, slug: str, suffix: str, index: int, shape: tuple[int, int]):
    folder = data_dir / f"{slug}{suffix}"
    path = png_path(folder, index)
    if not path.exists():
        return None
    arr = load_gray(path)
    if tuple(arr.shape) != shape:
        raise ValueError(f"{path}: dimensions {arr.shape[::-1]} do not match base {shape[::-1]}")
    return arr


def numeric_summary(values) -> dict[str, float]:
    vals = np.asarray(values, dtype=np.float32)
    if vals.size == 0:
        vals = np.asarray([0], dtype=np.float32)
    return {
        "mean": round(float(vals.mean()), 4),
        "std": round(float(vals.std()), 4),
        "p5": round(float(np.percentile(vals, 5)), 4),
        "p95": round(float(np.percentile(vals, 95)), 4),
    }


def raw_volume(data_dir: Path, slug: str, series: dict[str, Any], stats: dict[str, Any] | None):
    raw_path = data_dir / f"{slug}.raw"
    if not raw_path.exists():
        return None, None
    count = int(series["slices"])
    height = int(series["height"])
    width = int(series["width"])
    expected = count * height * width
    data = np.fromfile(raw_path, dtype=np.uint16)
    if data.size != expected:
        return None, None
    volume = data.reshape((count, height, width))

    if series.get("modality") == "CT":
        return volume.astype(np.float32) / 65535.0 * (2048.0 + 1024.0) - 1024.0, {
            "source": "raw_u16_ct_window",
            "units": "HU",
        }

    adc = (stats or {}).get("adc")
    if isinstance(adc, dict) and all(key in adc for key in ("hr_lo_raw", "hr_hi_raw", "rescale_slope", "rescale_intercept", "display_divisor")):
        lo = float(adc["hr_lo_raw"])
        hi = float(adc["hr_hi_raw"])
        slope = float(adc["rescale_slope"])
        intercept = float(adc["rescale_intercept"])
        divisor = float(adc["display_divisor"])
        raw_dicom = lo + volume.astype(np.float32) / 65535.0 * (hi - lo)
        physical = (raw_dicom * slope + intercept) / divisor
        return physical, {
            "source": "raw_u16_adc_rescale",
            "units": "ADC_10e-3_mm2_s",
        }
    return None, None


def intensity(values, source: str, units: str) -> dict[str, Any]:
    return {"source": source, "units": units, **numeric_summary(values)}


def tissue_summary(seg) -> dict[str, Any] | None:
    if seg is None:
        return None
    labels, counts = np.unique(seg, return_counts=True)
    raw_counts = {TISSUE_LABELS.get(int(label), f"label_{int(label)}"): int(count) for label, count in zip(labels, counts)}
    tissue_total = sum(count for name, count in raw_counts.items() if name != "background")
    fractions = {
        name: round(count / tissue_total, 6)
        for name, count in raw_counts.items()
        if name != "background" and tissue_total
    }
    return {
        "source": "seg_png",
        "counts": raw_counts,
        "fractionsOfNonBackground": fractions,
    }


def region_name(region_meta: dict[str, Any], label: int) -> str:
    regions = region_meta.get("regions") if isinstance(region_meta.get("regions"), dict) else {}
    item = regions.get(str(label)) if isinstance(regions, dict) else None
    if isinstance(item, dict) and isinstance(item.get("name"), str):
        return item["name"]
    legend = region_meta.get("legend") if isinstance(region_meta.get("legend"), dict) else {}
    value = legend.get(str(label)) if isinstance(legend, dict) else None
    return value if isinstance(value, str) else f"label {label}"


def region_summary(region_arr, base_values, spacing: list[float], region_meta: dict[str, Any], intensity_source: str, units: str) -> list[dict[str, Any]]:
    if region_arr is None:
        return []
    out = []
    row_spacing = float(spacing[0])
    col_spacing = float(spacing[1])
    for raw_label in sorted(int(label) for label in np.unique(region_arr) if int(label) > 0):
        mask = region_arr == raw_label
        ys, xs = np.where(mask)
        out.append({
            "label": raw_label,
            "name": region_name(region_meta, raw_label),
            "source": "regions_png",
            "areaPx": int(mask.sum()),
            "areaMm2": round(float(mask.sum()) * row_spacing * col_spacing, 4),
            "centroidPx": [round(float(xs.mean()), 4), round(float(ys.mean()), 4)],
            "intensity": intensity(base_values[mask], intensity_source, units),
        })
    return out


def symmetry_summary(stats: dict[str, Any] | None, index: int) -> dict[str, Any] | None:
    scores = (stats or {}).get("symmetryScores")
    if not isinstance(scores, list) or index >= len(scores):
        return None
    numeric_scores = [float(score) for score in scores if isinstance(score, (int, float))]
    if not numeric_scores:
        return None
    score = float(scores[index])
    rank = sum(1 for item in numeric_scores if item <= score) / len(numeric_scores)
    return {
        "source": "stats.symmetryScores",
        "score": round(score, 4),
        "rankWithinSeries": round(rank, 6),
        "meaning": "image-math asymmetry rank, not disease probability",
    }


def generate_series_context(data_dir: Path, series: dict[str, Any]) -> dict[str, Any]:
    require_pipeline_deps()
    slug = series["slug"]
    base_dir = data_dir / slug
    if not base_dir.is_dir():
        raise FileNotFoundError(f"{slug}: missing base stack {base_dir}")

    stats_path = data_dir / f"{slug}_stats.json"
    stats = load_json(stats_path) if stats_path.exists() else None
    region_meta_path = data_dir / f"{slug}_regions.json"
    region_meta = load_json(region_meta_path) if region_meta_path.exists() else {}
    raw, raw_info = raw_volume(data_dir, slug, series, stats)

    slices = []
    count = int(series["slices"])
    width = int(series["width"])
    height = int(series["height"])
    for index in range(count):
        base = load_gray(png_path(base_dir, index))
        if tuple(base.shape) != (height, width):
            raise ValueError(f"{slug}/{index:04d}.png: dimensions {base.shape[::-1]} expected {(width, height)}")

        base_values = raw[index] if raw is not None else base
        source = raw_info["source"] if raw_info else "base_png"
        units = raw_info["units"] if raw_info else "display_uint8"

        seg = load_optional_stack_slice(data_dir, slug, "_seg", index, base.shape)
        regions = load_optional_stack_slice(data_dir, slug, "_regions", index, base.shape)
        center_voxel = [round((width - 1) / 2, 4), round((height - 1) / 2, 4), index]
        slices.append({
            "index": index,
            "centerVoxel": center_voxel,
            "centerMm": voxel_to_mm(series, center_voxel[0], center_voxel[1], index),
            "intensity": intensity(base_values, source, units),
            "tissue": tissue_summary(seg),
            "regions": region_summary(regions, base_values, series["pixelSpacing"], region_meta, source, units),
            "symmetry": symmetry_summary(stats, index),
        })

    payload = {
        "slug": slug,
        "version": 1,
        "space": "DICOM_LPS_mm",
        "generatedFrom": {
            "manifest": "data/manifest.json",
            "baseStack": f"data/{slug}/*.png",
            "segStack": f"data/{slug}_seg/*.png" if (data_dir / f"{slug}_seg").is_dir() else None,
            "regionStack": f"data/{slug}_regions/*.png" if (data_dir / f"{slug}_regions").is_dir() else None,
            "regionMeta": f"data/{slug}_regions.json" if region_meta_path.exists() else None,
            "stats": f"data/{slug}_stats.json" if stats_path.exists() else None,
        },
        "slices": slices,
    }
    errors = validate_context_payload(payload, slug, count)
    if errors:
        raise ValueError(f"{slug}: invalid generated context: {errors[0]}")
    return payload


def write_context(data_dir: Path, payload: dict[str, Any]) -> Path:
    path = data_dir / f"{payload['slug']}_context.json"
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    _ = tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True))
    _ = tmp_path.replace(path)
    return path


def set_has_context(manifest_path: Path, slugs: set[str]) -> None:
    manifest = load_json(manifest_path)
    for series in manifest.get("series", []):
        if series.get("slug") in slugs:
            series["hasContext"] = True
    _ = manifest_path.write_text(json.dumps(manifest, indent=2))


def series_by_slug(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {series["slug"]: series for series in manifest.get("series", []) if isinstance(series, dict) and isinstance(series.get("slug"), str)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate VoxelLab spatial context sidecars.")
    _ = parser.add_argument("slugs", nargs="*", help="Series slugs. Defaults to local base stacks only.")
    _ = parser.add_argument("--data-dir", type=Path, default=DATA, help="Data directory. Default: ./data")
    _ = parser.add_argument("--no-manifest-update", action="store_true", help="Do not set hasContext in manifest.json.")
    return parser.parse_args()


def main() -> bool:
    args = parse_args()
    manifest_path = args.data_dir / "manifest.json"
    manifest = load_json(manifest_path)
    by_slug = series_by_slug(manifest)
    slugs = args.slugs or [slug for slug in by_slug if (args.data_dir / slug).is_dir()]
    wrote: set[str] = set()
    ok = True
    for slug in slugs:
        series = by_slug.get(slug)
        if not series:
            print(f"unknown slug: {slug}", file=sys.stderr)
            ok = False
            continue
        try:
            payload = generate_series_context(args.data_dir, series)
            path = write_context(args.data_dir, payload)
            wrote.add(slug)
            print(f"wrote {path}")
        except Exception as exc:
            print(f"{slug}: {exc}", file=sys.stderr)
            ok = False
    if wrote and not args.no_manifest_update:
        set_has_context(manifest_path, wrote)
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
