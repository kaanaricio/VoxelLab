"""Source-manifest contracts for calibrated projection and ultrasound engines."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from geometry import float_list

SOURCE_MANIFEST_NAMES = (
    "voxellab.source.json",
    "voxellab-source.json",
)
SOURCE_RECORD_VERSIONS = {1, 2}
PROJECTION_GEOMETRIES = {"parallel-beam-stack", "circular-cbct", "limited-angle-tomo"}
ULTRASOUND_MODES = {"stacked-sector", "tracked-freehand-sector"}
ULTRASOUND_PROBE_GEOMETRIES = {"sector", "curvilinear", "linear"}
MAX_OUTPUT_SHAPE_DIM = 4096
MAX_OUTPUT_VOXELS = 256 * 1024 * 1024


def _number_list(value: Any, length: int) -> list[float]:
    values = float_list(value, length)
    return values if len(values) >= length else []


def _matrix4_list(value: Any) -> list[list[float]]:
    if not isinstance(value, list) or len(value) != 4:
        return []
    rows: list[list[float]] = []
    for row in value:
        parsed = _number_list(row, 4)
        if len(parsed) != 4:
            return []
        rows.append(parsed)
    return rows


def _output_shape_ok(value: Any) -> bool:
    if not isinstance(value, list) or len(value) != 3:
        return False
    if not all(isinstance(item, int) and not isinstance(item, bool) and item > 0 for item in value):
        return False
    if any(item > MAX_OUTPUT_SHAPE_DIM for item in value):
        return False
    return (value[0] * value[1] * value[2]) <= MAX_OUTPUT_VOXELS


def load_source_manifest(directory: Path) -> dict[str, Any] | None:
    for name in SOURCE_MANIFEST_NAMES:
        path = directory / name
        if not path.exists():
            continue
        payload = json.loads(path.read_text())
        if isinstance(payload, dict):
            return payload
    return None


def _copy_payload(payload: Any) -> dict[str, Any] | None:
    return dict(payload) if isinstance(payload, dict) else None


def source_record_version(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0
    raw = payload.get("sourceRecordVersion", payload.get("version", 1))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return value if value in SOURCE_RECORD_VERSIONS else 0


def normalize_source_manifest(payload: Any) -> dict[str, Any] | None:
    normalized = _copy_payload(payload)
    if normalized is None:
        return None
    version = source_record_version(normalized) or 1
    normalized["sourceRecordVersion"] = version

    if normalized.get("sourceKind") == "projection" and isinstance(normalized.get("projection"), dict):
        projection = dict(normalized["projection"])
        geometry = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
        if geometry:
            projection["geometryModel"] = geometry
            projection["geometry"] = geometry
        normalized["projection"] = projection

    if normalized.get("sourceKind") == "ultrasound" and isinstance(normalized.get("ultrasound"), dict):
        ultrasound = dict(normalized["ultrasound"])
        profile_id = str(ultrasound.get("profileId", "") or "")
        if profile_id:
            ultrasound["profileId"] = profile_id
        normalized["ultrasound"] = ultrasound
    return normalized


def projection_manifest_errors(payload: Any, projection_count: int, series_uid: str = "") -> list[str]:
    errors: list[str] = []
    payload = normalize_source_manifest(payload)
    if payload is None:
        return ["source manifest: expected object"]
    if not payload.get("sourceRecordVersion"):
        errors.append(f"source manifest.sourceRecordVersion: expected one of {sorted(SOURCE_RECORD_VERSIONS)}")
    if payload.get("sourceKind") != "projection":
        return ["source manifest.sourceKind: expected projection"]
    if series_uid and payload.get("seriesUID") not in {"", None, series_uid}:
        errors.append("source manifest.seriesUID: expected source projection series UID match")

    projection = payload.get("projection")
    if not isinstance(projection, dict):
        return errors + ["source manifest.projection: expected object"]

    geometry = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    if geometry not in PROJECTION_GEOMETRIES:
        errors.append(f"source manifest.projection.geometry: expected one of {sorted(PROJECTION_GEOMETRIES)}")

    angles = _number_list(projection.get("anglesDeg", []), 1)
    if len(angles) != projection_count:
        errors.append("source manifest.projection.anglesDeg: expected one angle per projection image")
    elif geometry == "parallel-beam-stack" and len(angles) >= 2:
        normalized = sorted((float(angle) % 360.0) for angle in angles)
        gaps = [
            normalized[index + 1] - normalized[index]
            for index in range(len(normalized) - 1)
        ] + [normalized[0] + 360.0 - normalized[-1]]
        coverage = 360.0 - max(gaps)
        if coverage <= 0:
            errors.append("source manifest.projection.anglesDeg: expected non-degenerate angular coverage")

    output_shape = projection.get("outputShape")
    if not _output_shape_ok(output_shape):
        errors.append("source manifest.projection.outputShape: expected [width, height, depth] positive ints")

    spacing = _number_list(projection.get("outputSpacingMm", []), 3)
    if len(spacing) != 3 or not all(value > 0 for value in spacing):
        errors.append("source manifest.projection.outputSpacingMm: expected three positive numbers")

    first_ipp = _number_list(projection.get("firstIPP", []), 3)
    if len(first_ipp) != 3:
        errors.append("source manifest.projection.firstIPP: expected [x, y, z]")

    orientation = _number_list(projection.get("orientation", []), 6)
    if len(orientation) != 6:
        errors.append("source manifest.projection.orientation: expected six direction-cosine values")

    if not str(projection.get("frameOfReferenceUID", "") or ""):
        errors.append("source manifest.projection.frameOfReferenceUID: expected non-empty string")

    return errors


def ultrasound_manifest_errors(payload: Any, frame_count: int, series_uid: str = "") -> list[str]:
    errors: list[str] = []
    payload = normalize_source_manifest(payload)
    if payload is None:
        return ["source manifest: expected object"]
    if not payload.get("sourceRecordVersion"):
        errors.append(f"source manifest.sourceRecordVersion: expected one of {sorted(SOURCE_RECORD_VERSIONS)}")
    if payload.get("sourceKind") != "ultrasound":
        return ["source manifest.sourceKind: expected ultrasound"]
    if series_uid and payload.get("seriesUID") not in {"", None, series_uid}:
        errors.append("source manifest.seriesUID: expected source ultrasound series UID match")

    ultrasound = payload.get("ultrasound")
    if not isinstance(ultrasound, dict):
        return errors + ["source manifest.ultrasound: expected object"]

    mode = str(ultrasound.get("mode", "") or "")
    if mode not in ULTRASOUND_MODES:
        errors.append(f"source manifest.ultrasound.mode: expected one of {sorted(ULTRASOUND_MODES)}")

    probe_geometry = str(ultrasound.get("probeGeometry", "") or "")
    if probe_geometry not in ULTRASOUND_PROBE_GEOMETRIES:
        errors.append(
            f"source manifest.ultrasound.probeGeometry: expected one of {sorted(ULTRASOUND_PROBE_GEOMETRIES)}"
        )

    theta_range = _number_list(ultrasound.get("thetaRangeDeg", []), 2)
    if len(theta_range) != 2 or theta_range[0] == theta_range[1]:
        errors.append("source manifest.ultrasound.thetaRangeDeg: expected [min, max] with nonzero span")

    radius_range = _number_list(ultrasound.get("radiusRangeMm", []), 2)
    if len(radius_range) != 2 or not (radius_range[1] > radius_range[0] >= 0):
        errors.append("source manifest.ultrasound.radiusRangeMm: expected [min, max] in mm")

    output_shape = ultrasound.get("outputShape")
    if not _output_shape_ok(output_shape):
        errors.append("source manifest.ultrasound.outputShape: expected [width, height, depth] positive ints")

    spacing = _number_list(ultrasound.get("outputSpacingMm", []), 3)
    if len(spacing) != 3 or not all(value > 0 for value in spacing):
        errors.append("source manifest.ultrasound.outputSpacingMm: expected three positive numbers")

    first_ipp = _number_list(ultrasound.get("firstIPP", []), 3)
    if len(first_ipp) != 3:
        errors.append("source manifest.ultrasound.firstIPP: expected [x, y, z]")

    orientation = _number_list(ultrasound.get("orientation", []), 6)
    if len(orientation) != 6:
        errors.append("source manifest.ultrasound.orientation: expected six direction-cosine values")

    frame_uid = str(ultrasound.get("frameOfReferenceUID", "") or "")
    if mode == "tracked-freehand-sector" and not frame_uid:
        errors.append("source manifest.ultrasound.frameOfReferenceUID: expected non-empty string")

    transforms = ultrasound.get("frameTransformsLps", [])
    if mode == "tracked-freehand-sector":
        if not isinstance(transforms, list) or len(transforms) != frame_count:
            errors.append("source manifest.ultrasound.frameTransformsLps: expected one 4x4 transform per frame")
        else:
            for index, matrix in enumerate(transforms):
                if not _matrix4_list(matrix):
                    errors.append(f"source manifest.ultrasound.frameTransformsLps[{index}]: expected 4x4 matrix")
                    break

    return errors


def projection_summary(payload: dict[str, Any]) -> dict[str, Any]:
    payload = normalize_source_manifest(payload) or {}
    projection = payload.get("projection", {})
    return {
        "status": "calibrated",
        "geometry": str(projection.get("geometryModel", projection.get("geometry", "")) or ""),
        "angleCount": len(projection.get("anglesDeg", []) or []),
        "source": "external-json",
        "sourceRecordVersion": int(payload.get("sourceRecordVersion", 1) or 1),
    }


def ultrasound_summary(payload: dict[str, Any]) -> dict[str, Any]:
    payload = normalize_source_manifest(payload) or {}
    ultrasound = payload.get("ultrasound", {})
    return {
        "status": "calibrated",
        "mode": str(ultrasound.get("mode", "") or ""),
        "probeGeometry": str(ultrasound.get("probeGeometry", "") or ""),
        "source": "external-json",
        "profileId": str(ultrasound.get("profileId", "") or ""),
        "sourceRecordVersion": int(payload.get("sourceRecordVersion", 1) or 1),
    }
