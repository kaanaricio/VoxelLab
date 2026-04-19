"""Stdlib helpers for validated spatial AI context.

The generator may use image libraries, but runtime AI scripts import this file.
Keep it dependency-free so `analyze.py` can run without pipeline extras.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import OrderedDict
from pathlib import Path
from typing import Any

VERSION = 1

KNOWN_INTENSITY_UNITS = {"display_uint8", "HU", "ADC_10e-3_mm2_s", "normalized_raw"}

TISSUE_LABELS = {0: "background", 1: "csf", 2: "gm", 3: "wm"}

MAX_CONTEXT_CACHE_ENTRIES = 64
_CONTEXT_CACHE: OrderedDict[str, tuple[str, dict[str, Any] | None, str | None]] = OrderedDict()


def _remember_context(cache_key: str, value: tuple[str, dict[str, Any] | None, str | None]) -> None:
    if cache_key in _CONTEXT_CACHE:
        _CONTEXT_CACHE.move_to_end(cache_key)
    _CONTEXT_CACHE[cache_key] = value
    while len(_CONTEXT_CACHE) > MAX_CONTEXT_CACHE_ENTRIES:
        _ = _CONTEXT_CACHE.popitem(last=False)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_num_vec(value: Any, length: int) -> bool:
    return isinstance(value, list) and len(value) == length and all(is_number(item) for item in value)


def _validate_intensity(errors: list[str], path: str, value: Any) -> None:
    if not isinstance(value, dict):
        errors.append(f"{path}: expected object")
        return
    units = value.get("units")
    if units not in KNOWN_INTENSITY_UNITS:
        errors.append(f"{path}.units: expected one of {sorted(KNOWN_INTENSITY_UNITS)}")
    source = value.get("source")
    if source is not None and (not isinstance(source, str) or not source):
        errors.append(f"{path}.source: expected non-empty string")
    for key in ("mean", "std", "p5", "p95"):
        if key in value and not is_number(value[key]):
            errors.append(f"{path}.{key}: expected finite number")


def validate_context_payload(payload: Any, slug: str, expected_slices: int) -> list[str]:
    """Return contract errors for a `data/<slug>_context.json` payload."""
    if not isinstance(payload, dict):
        return ["context: expected object"]

    errors: list[str] = []
    if payload.get("slug") != slug:
        errors.append(f"context.slug: expected {slug!r}")
    if payload.get("version") != VERSION:
        errors.append(f"context.version: expected {VERSION}")

    slices = payload.get("slices")
    if not isinstance(slices, list):
        return errors + ["context.slices: expected list"]
    if len(slices) != expected_slices:
        errors.append(f"context.slices: expected {expected_slices} slices, got {len(slices)}")

    seen: set[int] = set()
    for position, item in enumerate(slices):
        item_path = f"context.slices[{position}]"
        if not isinstance(item, dict):
            errors.append(f"{item_path}: expected object")
            continue
        index = item.get("index")
        if not isinstance(index, int) or isinstance(index, bool):
            errors.append(f"{item_path}.index: expected int")
        else:
            if index in seen:
                errors.append(f"{item_path}.index: duplicate slice {index}")
            seen.add(index)
            if index != position:
                errors.append(f"{item_path}.index: expected {position}, got {index}")

        for key in ("centerVoxel", "centerMm"):
            value = item.get(key)
            if value is not None and not _is_num_vec(value, 3):
                errors.append(f"{item_path}.{key}: expected null or 3 finite numbers")

        if "intensity" in item:
            _validate_intensity(errors, f"{item_path}.intensity", item["intensity"])

        tissue = item.get("tissue")
        if tissue is not None and not isinstance(tissue, dict):
            errors.append(f"{item_path}.tissue: expected null or object")

        regions = item.get("regions", [])
        if not isinstance(regions, list):
            errors.append(f"{item_path}.regions: expected list")
        else:
            region_labels: set[int] = set()
            for region_position, region in enumerate(regions):
                region_path = f"{item_path}.regions[{region_position}]"
                if not isinstance(region, dict):
                    errors.append(f"{region_path}: expected object")
                    continue
                label = region.get("label")
                if not isinstance(label, int) or isinstance(label, bool) or label <= 0 or label > 65535:
                    errors.append(f"{region_path}.label: expected positive int label")
                elif label in region_labels:
                    errors.append(f"{region_path}.label: duplicate label {label}")
                else:
                    region_labels.add(label)
                if "name" in region and not isinstance(region["name"], str):
                    errors.append(f"{region_path}.name: expected string")
                for key in ("areaPx", "areaMm2"):
                    if key in region and not is_number(region[key]):
                        errors.append(f"{region_path}.{key}: expected finite number")
                if "centroidPx" in region and not _is_num_vec(region["centroidPx"], 2):
                    errors.append(f"{region_path}.centroidPx: expected 2 finite numbers")
                if "intensity" in region:
                    _validate_intensity(errors, f"{region_path}.intensity", region["intensity"])

        symmetry = item.get("symmetry")
        if symmetry is not None:
            if not isinstance(symmetry, dict):
                errors.append(f"{item_path}.symmetry: expected null or object")
            else:
                for key in ("score", "rankWithinSeries"):
                    if key in symmetry and not is_number(symmetry[key]):
                        errors.append(f"{item_path}.symmetry.{key}: expected finite number")

    expected_indexes = set(range(expected_slices))
    if seen and seen != expected_indexes:
        missing = sorted(expected_indexes - seen)
        extra = sorted(seen - expected_indexes)
        if missing:
            errors.append(f"context.slices: missing indexes {missing[:5]}")
        if extra:
            errors.append(f"context.slices: unexpected indexes {extra[:5]}")
    return errors


def load_context(data_dir: Path, slug: str, series_meta: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Load valid context or return `(None, warning)` for runtime fallback."""
    if not series_meta.get("hasContext"):
        return None, None
    path = data_dir / f"{slug}_context.json"
    try:
        stat = path.stat()
    except FileNotFoundError as exc:
        return None, f"{slug}: context unavailable: {exc}"
    cache_key = str(path.resolve())
    signature = f"{stat.st_mtime_ns}:{stat.st_size}:{int(series_meta.get('slices', 0) or 0)}"
    cached = _CONTEXT_CACHE.get(cache_key)
    if cached and cached[0] == signature:
        _CONTEXT_CACHE.move_to_end(cache_key)
        return cached[1], cached[2]
    try:
        payload = json.loads(path.read_text())
    except Exception as exc:
        warning = f"{slug}: context unavailable: {exc}"
        _remember_context(cache_key, (signature, None, warning))
        return None, warning
    errors = validate_context_payload(payload, slug, int(series_meta.get("slices", 0) or 0))
    if errors:
        warning = f"{slug}: invalid context sidecar: {errors[0]}"
        _remember_context(cache_key, (signature, None, warning))
        return None, warning
    _remember_context(cache_key, (signature, payload, None))
    return payload, None


def get_slice_context(context: dict[str, Any] | None, slice_idx: int) -> dict[str, Any] | None:
    if not context:
        return None
    slices = context.get("slices")
    if not isinstance(slices, list) or slice_idx < 0 or slice_idx >= len(slices):
        return None
    item = slices[slice_idx]
    return item if isinstance(item, dict) else None


def context_fingerprint(value: Any) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def voxel_to_mm(series: dict[str, Any], vx: float, vy: float, vz: float) -> list[float] | None:
    """Python twin of `js/coords.js:voxelToMM`."""
    try:
        first = series["firstIPP"]
        last = series["lastIPP"]
        orientation = series["orientation"]
        spacing = series["pixelSpacing"]
        slices = int(series["slices"])
    except Exception:
        return None
    if not (_is_num_vec(first, 3) and _is_num_vec(last, 3) and _is_num_vec(orientation, 6) and _is_num_vec(spacing, 2)):
        return None
    row = [float(v) for v in orientation[:3]]
    col = [float(v) for v in orientation[3:]]
    row_spacing = float(spacing[0])
    col_spacing = float(spacing[1])
    denom = max(1, slices - 1)
    slice_vec = [(float(last[i]) - float(first[i])) / denom for i in range(3)]
    return [
        round(float(first[i]) + vx * col_spacing * row[i] + vy * row_spacing * col[i] + vz * slice_vec[i], 4)
        for i in range(3)
    ]


def _format_intensity(intensity: dict[str, Any] | None) -> str:
    if not isinstance(intensity, dict):
        return "unavailable"
    units = intensity.get("units", "unknown")
    source = intensity.get("source", "unknown")
    values = []
    for key in ("mean", "std", "p5", "p95"):
        value = intensity.get(key)
        if is_number(value):
            values.append(f"{key} {float(value):.2f}")
    suffix = "; ".join(values) if values else "no numeric summary"
    return f"{suffix}; units {units}; source {source}"


def region_by_label(slice_context: dict[str, Any] | None, label: int | None) -> dict[str, Any] | None:
    if label is None or not slice_context:
        return None
    for region in slice_context.get("regions") or []:
        if isinstance(region, dict) and region.get("label") == label:
            return region
    return None


def format_analysis_context(slice_context: dict[str, Any] | None, total_slices: int) -> tuple[str, set[int], str | None]:
    if not slice_context:
        return "Approximate derived context: unavailable.", set(), None

    regions = [r for r in slice_context.get("regions") or [] if isinstance(r, dict) and isinstance(r.get("label"), int)]
    regions = sorted(regions, key=lambda item: float(item.get("areaPx", 0) or 0), reverse=True)[:8]
    labels = {int(region["label"]) for region in regions}
    region_lines = [
        f"  - label {region['label']}: {region.get('name', 'unnamed')} ({float(region.get('areaPx', 0) or 0):.0f} px)"
        for region in regions
    ]
    if not region_lines:
        region_lines = ["  - none available"]

    tissue = slice_context.get("tissue")
    tissue_text = "unavailable"
    if isinstance(tissue, dict):
        tissue_text = json.dumps(tissue.get("fractionsOfNonBackground") or tissue.get("counts") or {}, sort_keys=True)

    symmetry = slice_context.get("symmetry")
    symmetry_text = "unavailable"
    if isinstance(symmetry, dict):
        score = symmetry.get("score", "unavailable")
        rank = symmetry.get("rankWithinSeries", "unavailable")
        symmetry_text = f"score {score}, within-series rank {rank}; image math, not diagnosis"

    center = slice_context.get("centerMm")
    center_text = json.dumps(center) if center is not None else "unavailable"
    text = (
        "Approximate derived context:\n"
        + f"- Location: {center_text} in DICOM LPS mm.\n"
        + f"- Slice: {slice_context.get('index')} of {total_slices} zero-based slices.\n"
        + f"- Tissue: {tissue_text}.\n"
        + f"- Symmetry: {symmetry_text}.\n"
        + f"- Intensity: {_format_intensity(slice_context.get('intensity'))}.\n"
        + "- Regions on this slice, pipeline-derived and approximate:\n"
        + "\n".join(region_lines)
    )
    return text, labels, context_fingerprint({"analysis_context": text})


def format_point_context(
    slice_context: dict[str, Any] | None,
    *,
    x: int,
    y: int,
    mm: list[float] | None,
    pixel_intensity: dict[str, Any] | None,
    tissue_label: int | None,
    region_label: int | None,
) -> tuple[str, str | None]:
    if not slice_context:
        base = "Approximate point context: unavailable."
        return base, None

    region = region_by_label(slice_context, region_label)
    region_text = "unavailable"
    if region:
        area = region.get("areaMm2", "unavailable")
        region_text = f"label {region_label}: {region.get('name', 'unnamed')}; areaMm2 {area}; approximate"
    elif region_label:
        region_text = f"label {region_label}; no matching sidecar stats; approximate"

    tissue_text = "unavailable"
    if tissue_label is not None:
        tissue_text = f"{TISSUE_LABELS.get(tissue_label, f'label {tissue_label}')}; source seg_png; approximate"

    symmetry = slice_context.get("symmetry")
    symmetry_text = "unavailable"
    if isinstance(symmetry, dict):
        symmetry_text = f"{symmetry.get('rankWithinSeries', 'unavailable')}; image math only"

    intensity_text = _format_intensity(pixel_intensity) if pixel_intensity else _format_intensity(slice_context.get("intensity"))
    text = (
        "Approximate point context:\n"
        f"- Pixel: ({x}, {y}), slice {slice_context.get('index')}.\n"
        f"- LPS mm: {json.dumps(mm) if mm is not None else 'unavailable'}.\n"
        f"- Tissue: {tissue_text}.\n"
        f"- Region: {region_text}.\n"
        f"- Pixel intensity: {intensity_text}.\n"
        f"- Symmetry rank: {symmetry_text}."
    )
    return text, context_fingerprint({"point_context": text})
