"""Canonical patient-space geometry helpers shared by the Python pipeline."""

from __future__ import annotations

import math
from typing import Any


def float_list(value: Any, length: int) -> list[float]:
    try:
        items = [float(item) for item in value]
    except Exception:
        return []
    return items if len(items) >= length else []


def dot3(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def norm3(v: list[float]) -> float:
    return math.sqrt(dot3(v, v))


def cross3(a: list[float], b: list[float]) -> list[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def normalize3(v: list[float]) -> list[float]:
    length = norm3(v)
    return [item / length for item in v] if length > 1e-6 else []


def slice_normal_from_iop(iop: Any) -> list[float]:
    values = float_list(iop, 6)
    if len(values) < 6:
        return []
    row = normalize3(values[:3])
    col = normalize3(values[3:6])
    if not row or not col:
        return []
    return normalize3(cross3(row, col))


def ipp_projection(ds: Any, normal: list[float]) -> float | None:
    ipp = float_list(getattr(ds, "ImagePositionPatient", []), 3)
    if len(ipp) < 3 or not normal:
        return None
    return dot3(ipp, normal)


def slice_sort_key(ds: Any) -> tuple[float, int]:
    instance = int(getattr(ds, "InstanceNumber", 0) or 0)
    normal = slice_normal_from_iop(getattr(ds, "ImageOrientationPatient", []))
    projection = ipp_projection(ds, normal)
    return (projection if projection is not None else 0.0, instance)


def sort_datasets_spatially(datasets: list[Any], get_dataset: Any | None = None) -> list[Any]:
    if not datasets:
        return []
    getter = get_dataset or (lambda item: item)
    first = getter(datasets[0])
    normal = slice_normal_from_iop(getattr(first, "ImageOrientationPatient", []))

    def sort_key(item: Any) -> tuple[float, int]:
        ds = getter(item)
        instance = int(getattr(ds, "InstanceNumber", 0) or 0)
        projection = ipp_projection(ds, normal)
        return (projection if projection is not None else 0.0, instance)

    return sorted(datasets, key=sort_key)


def spacing_from_positions(positions: list[list[float]], normal: list[float]) -> dict[str, Any]:
    if len(positions) < 2 or not normal:
        return {"mean": 0.0, "min": 0.0, "max": 0.0, "regular": False}
    scalars = [dot3(position, normal) for position in positions]
    diffs = [abs(scalars[i + 1] - scalars[i]) for i in range(len(scalars) - 1)]
    positive = [diff for diff in diffs if diff > 1e-4]
    if not positive:
        return {"mean": 0.0, "min": 0.0, "max": 0.0, "regular": False}
    mean = sum(positive) / len(positive)
    min_value = min(positive)
    max_value = max(positive)
    tolerance = max(0.1, mean * 0.02)
    return {
        "mean": mean,
        "min": min_value,
        "max": max_value,
        "regular": (max_value - min_value) <= tolerance,
    }


def extract_enhanced_multiframe_slices(ds: Any) -> list[Any] | None:
    """Extract per-frame geometry from enhanced multi-frame functional groups.

    Returns a list of lightweight objects matching the interface expected by
    geometry_from_slices (PixelSpacing, ImageOrientationPatient,
    ImagePositionPatient, SliceThickness, FrameOfReferenceUID), or None
    if the dataset lacks the required per-frame functional groups.
    """
    per_frame = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
    shared_seq = getattr(ds, "SharedFunctionalGroupsSequence", None)
    if not per_frame or len(per_frame) < 1:
        return None

    shared = shared_seq[0] if shared_seq and len(shared_seq) >= 1 else None
    shared_orient_seq = getattr(shared, "PlaneOrientationSequence", None) if shared else None
    shared_orient = shared_orient_seq[0] if shared_orient_seq and len(shared_orient_seq) >= 1 else None
    shared_iop = float_list(getattr(shared_orient, "ImageOrientationPatient", []), 6) if shared_orient else []
    shared_measures_seq = getattr(shared, "PixelMeasuresSequence", None) if shared else None
    shared_measures = shared_measures_seq[0] if shared_measures_seq and len(shared_measures_seq) >= 1 else None
    shared_spacing = float_list(getattr(shared_measures, "PixelSpacing", []), 2) if shared_measures else []
    shared_thickness = float(getattr(shared_measures, "SliceThickness", 0) or 0) if shared_measures else 0.0
    shared_transform_seq = getattr(shared, "PixelValueTransformationSequence", None) if shared else None
    shared_transform = shared_transform_seq[0] if shared_transform_seq and len(shared_transform_seq) >= 1 else None
    shared_slope = float(getattr(shared_transform, "RescaleSlope", getattr(ds, "RescaleSlope", 1)) or 1)
    shared_intercept = float(getattr(shared_transform, "RescaleIntercept", getattr(ds, "RescaleIntercept", 0)) or 0)
    frame_uid = str(getattr(ds, "FrameOfReferenceUID", "") or "")

    class _FrameSlice:
        pass

    frames: list[Any] = []
    for frame in per_frame:
        pos_seq = getattr(frame, "PlanePositionSequence", None)
        pos = pos_seq[0] if pos_seq and len(pos_seq) >= 1 else None
        ipp = float_list(getattr(pos, "ImagePositionPatient", []), 3) if pos else []
        if len(ipp) < 3:
            return None

        orient_seq = getattr(frame, "PlaneOrientationSequence", None)
        orient = orient_seq[0] if orient_seq and len(orient_seq) >= 1 else None
        iop = float_list(getattr(orient, "ImageOrientationPatient", []), 6) if orient else shared_iop
        if len(iop) < 6:
            return None
        transform_seq = getattr(frame, "PixelValueTransformationSequence", None)
        transform = transform_seq[0] if transform_seq and len(transform_seq) >= 1 else None

        s = _FrameSlice()
        s.ImagePositionPatient = ipp
        s.ImageOrientationPatient = iop
        s.PixelSpacing = shared_spacing or [1.0, 1.0]
        s.SliceThickness = shared_thickness
        s.FrameOfReferenceUID = frame_uid
        s.RescaleSlope = float(getattr(transform, "RescaleSlope", shared_slope) or shared_slope)
        s.RescaleIntercept = float(getattr(transform, "RescaleIntercept", shared_intercept) or shared_intercept)
        s.InstanceNumber = len(frames) + 1
        frames.append(s)

    return frames if frames else None


def geometry_from_slices(slices: list[Any]) -> dict[str, Any]:
    if not slices:
        return {}

    first = slices[0]
    pixel_spacing = float_list(getattr(first, "PixelSpacing", []), 2)
    row_spacing = pixel_spacing[0] if len(pixel_spacing) >= 2 and pixel_spacing[0] > 0 else 1.0
    col_spacing = pixel_spacing[1] if len(pixel_spacing) >= 2 and pixel_spacing[1] > 0 else row_spacing

    orientation = float_list(getattr(first, "ImageOrientationPatient", []), 6) or [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    row = normalize3(orientation[:3]) or [1.0, 0.0, 0.0]
    col = normalize3(orientation[3:6]) or [0.0, 1.0, 0.0]
    normal = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]

    positions = [float_list(getattr(ds, "ImagePositionPatient", []), 3) for ds in slices]
    positions = [position for position in positions if len(position) >= 3]
    spacing_stats = spacing_from_positions(positions, normal)

    slice_thickness = float(getattr(first, "SliceThickness", 0.0) or 0.0)
    effective_spacing = spacing_stats["mean"] if spacing_stats["mean"] > 0 else (slice_thickness or 1.0)
    first_ipp = positions[0] if positions else [0.0, 0.0, 0.0]
    last_ipp = positions[-1] if positions else first_ipp

    frame_uid = str(getattr(first, "FrameOfReferenceUID", "") or "")

    return {
        "pixelSpacing": [row_spacing, col_spacing],
        "sliceThickness": slice_thickness or effective_spacing,
        "sliceSpacing": effective_spacing,
        "sliceSpacingRegular": bool(spacing_stats["regular"]),
        "sliceSpacingStats": spacing_stats,
        "firstIPP": first_ipp,
        "lastIPP": last_ipp,
        "orientation": [*row, *col],
        "frameOfReferenceUID": frame_uid,
    }


def series_effective_slice_spacing(series: dict[str, Any]) -> float:
    explicit = float(series.get("sliceSpacing", 0.0) or 0.0)
    if explicit > 0:
        return explicit
    first = series.get("firstIPP")
    last = series.get("lastIPP")
    count = int(series.get("slices", 0) or 0)
    if isinstance(first, list) and isinstance(last, list) and len(first) >= 3 and len(last) >= 3 and count > 1:
        dx = float(last[0]) - float(first[0])
        dy = float(last[1]) - float(first[1])
        dz = float(last[2]) - float(first[2])
        return math.sqrt(dx * dx + dy * dy + dz * dz) / (count - 1)
    return float(series.get("sliceThickness", 1.0) or 1.0)


def affine_lps_from_series(series: dict[str, Any]) -> list[list[float]]:
    orientation = float_list(series.get("orientation", []), 6) or [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    row = normalize3(orientation[:3]) or [1.0, 0.0, 0.0]
    col = normalize3(orientation[3:6]) or [0.0, 1.0, 0.0]
    first_ipp = float_list(series.get("firstIPP", []), 3) or [0.0, 0.0, 0.0]
    row_spacing = float(series.get("pixelSpacing", [1.0, 1.0])[0] or 1.0)
    col_spacing = float(series.get("pixelSpacing", [1.0, 1.0])[1] or row_spacing)
    slice_spacing = series_effective_slice_spacing(series)

    last_ipp = float_list(series.get("lastIPP", []), 3)
    slices = int(series.get("slices", 0) or 0)
    slice_dir = []
    if len(last_ipp) >= 3 and slices > 1:
        delta = [(last_ipp[i] - first_ipp[i]) / (slices - 1) for i in range(3)]
        slice_dir = normalize3(delta)
    if not slice_dir:
        slice_dir = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]

    return [
        [row[0] * col_spacing, col[0] * row_spacing, slice_dir[0] * slice_spacing, first_ipp[0]],
        [row[1] * col_spacing, col[1] * row_spacing, slice_dir[1] * slice_spacing, first_ipp[1]],
        [row[2] * col_spacing, col[2] * row_spacing, slice_dir[2] * slice_spacing, first_ipp[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]


def classify_geometry_kind(spacing_stats: dict[str, Any], slice_count: int) -> str:
    if slice_count <= 0:
        return "insufficient"
    if slice_count == 1:
        return "single_frame"
    if spacing_stats.get("mean", 0) <= 0:
        return "insufficient"
    if spacing_stats.get("regular"):
        return "cartesian_volume"
    return "cartesian_stack_irregular"


def build_geometry_record(
    slices: list[Any],
    *,
    width: int = 0,
    height: int = 0,
    source: str = "dicom_classic_singleframe",
) -> dict[str, Any]:
    """Build a canonical GeometryRecord from sorted DICOM-like slice objects.

    The returned dict is the cross-language contract consumed by capability
    policy, viewer, and pipeline code.
    """
    geo = geometry_from_slices(slices)
    if not geo:
        return {
            "kind": "insufficient",
            "dimensions": {"width": width, "height": height, "depth": 0},
            "spacingMm": {"row": 1.0, "col": 1.0, "slice": 1.0},
            "sliceSpacingStatsMm": {"mean": 0.0, "min": 0.0, "max": 0.0, "regular": False},
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "lastIPP": [0.0, 0.0, 0.0],
            "affineLps": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
            "frameOfReferenceUID": "",
            "source": source,
        }

    spacing_stats = geo["sliceSpacingStats"]
    kind = classify_geometry_kind(spacing_stats, len(slices))

    series_for_affine = {
        "pixelSpacing": geo["pixelSpacing"],
        "sliceSpacing": geo["sliceSpacing"],
        "slices": len(slices),
        "firstIPP": geo["firstIPP"],
        "lastIPP": geo["lastIPP"],
        "orientation": geo["orientation"],
    }
    affine = affine_lps_from_series(series_for_affine)

    return {
        "kind": kind,
        "dimensions": {"width": width, "height": height, "depth": len(slices)},
        "spacingMm": {
            "row": geo["pixelSpacing"][0],
            "col": geo["pixelSpacing"][1],
            "slice": geo["sliceSpacing"],
        },
        "sliceSpacingStatsMm": spacing_stats,
        "orientation": geo["orientation"],
        "firstIPP": geo["firstIPP"],
        "lastIPP": geo["lastIPP"],
        "affineLps": affine,
        "frameOfReferenceUID": geo["frameOfReferenceUID"],
        "source": source,
    }


def compare_group_key(series: dict[str, Any]) -> str | None:
    frame_uid = str(series.get("frameOfReferenceUID", "") or "")
    if frame_uid:
        return f"for:{frame_uid}"
    first = float_list(series.get("firstIPP", []), 3)
    orientation = float_list(series.get("orientation", []), 6)
    if len(first) < 3 or len(orientation) < 6:
        return None
    rounded_ipp = ",".join(f"{value:.1f}" for value in first)
    rounded_iop = ",".join(f"{value:.4f}" for value in orientation)
    return f"fallback:{rounded_ipp}|{rounded_iop}"
