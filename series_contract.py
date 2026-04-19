"""Canonical series/manifest contract helpers."""

from __future__ import annotations

import copy
import json
import math
import re
from pathlib import Path
from typing import Any

from cloud_series import apply_public_series_urls, normalize_origin, validate_public_series_urls
from engine_report import ENGINE_REPORT_VALIDATIONS
from geometry import compare_group_key, cross3 as _cross3, dot3 as _dot3, norm3 as _norm3

SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

# Shape: {"slug": str, "slices": positive int, "hasSeg": bool, ...}.
REQUIRED_SERIES_FIELDS = {
    "slug": str,
    "name": str,
    "description": str,
    "slices": int,
    "width": int,
    "height": int,
    "pixelSpacing": list,
    "sliceThickness": (int, float),
    "hasBrain": bool,
    "hasSeg": bool,
    "hasRaw": bool,
}

# Shape: {"pixelSpacing": 2, "orientation": 6, "firstIPP": 3}.
VECTOR_LENGTHS = {
    "pixelSpacing": 2,
    "firstIPP": 3,
    "lastIPP": 3,
    "orientation": 6,
    "previewDims": 3,
}

# Shape: ["hasSym", "hasStats", "hasAnalysis", "hasRegions", ...].
OPTIONAL_BOOL_FIELDS = [
    "hasSym",
    "hasStats",
    "hasAnalysis",
    "hasRegions",
    "hasMaskRaw",
    "hasPreview",
    "hasContext",
]

# Shape: {"volumeStack": "display-volume", "projectionSet": "requires-reconstruction"}.
GEOMETRY_CAPABILITY = {
    "volumeStack": "display-volume",
    "derivedVolume": "display-volume",
    "projectionSet": "requires-reconstruction",
    "ultrasoundSource": "requires-reconstruction",
    "singleProjection": "2d-only",
    "imageStack": "2d-only",
    "singleImage": "2d-only",
}
RENDERABILITY_VALUES = {"volume", "2d"}
GEOMETRY_RECORD_KINDS = {"cartesian_volume", "cartesian_stack_irregular", "single_frame", "insufficient"}
DERIVED_OBJECT_KINDS = {"seg", "rtstruct", "sr", "registration", "derived-volume"}
AFFINE_COMPATIBILITY_VALUES = {"exact", "within-tolerance", "requires-registration", "incompatible"}
PROJECTION_KINDS = {"cbct", "parallel-beam", "tomosynthesis", "xray", "unknown"}
PROJECTION_STATUSES = {"requires-calibration", "requires-reconstruction", "reconstruction-pending", "reconstruction-failed", "reconstructed"}

JOB_ID_FIELDS = ("sourceJobId", "modalJobId", "jobId", "job_id")
MODAL_REQUIRED_URL_FIELDS = ("rawUrl", "sliceUrlBase")

dot3 = _dot3
norm3 = _norm3
cross3 = _cross3


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ValueError(f"{path}: file not found") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON: {exc}") from exc


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def type_name(expected_type: Any) -> str:
    if isinstance(expected_type, tuple):
        return " or ".join(t.__name__ for t in expected_type)
    return expected_type.__name__


def validate_vector(series_path: str, key: str, value: Any) -> list[str]:
    errors: list[str] = []
    expected_len = VECTOR_LENGTHS[key]
    if not isinstance(value, list) or len(value) != expected_len:
        return [f"{series_path}.{key}: expected list length {expected_len}"]
    if not all(is_number(v) for v in value):
        errors.append(f"{series_path}.{key}: expected finite numbers")
    if key in {"pixelSpacing", "previewDims"} and not all(v > 0 for v in value):
        errors.append(f"{series_path}.{key}: expected positive values")
    return errors


def validate_renderability(series_path: str, value: Any, capability: str | None) -> list[str]:
    errors: list[str] = []
    if isinstance(value, str):
        if value not in RENDERABILITY_VALUES:
            return [f"{series_path}.renderability: expected one of {sorted(RENDERABILITY_VALUES)}"]
        if capability == "display-volume" and value != "volume":
            errors.append(f"{series_path}.renderability: expected volume for display-volume")
        if capability in {"requires-reconstruction", "2d-only"} and value == "volume":
            errors.append(f"{series_path}.renderability: expected 2d unless reconstructionCapability is display-volume")
        return errors

    if not isinstance(value, dict):
        return [f"{series_path}.renderability: expected string or object"]

    for key in ("canView2D", "canMpr3D"):
        if key not in value:
            errors.append(f"{series_path}.renderability.{key}: missing required field")
        elif not isinstance(value[key], bool):
            errors.append(f"{series_path}.renderability.{key}: expected bool")
    if "reason" in value and not isinstance(value["reason"], str):
        errors.append(f"{series_path}.renderability.reason: expected string")

    can_view_2d = value.get("canView2D")
    can_mpr_3d = value.get("canMpr3D")
    if capability == "display-volume":
        if can_view_2d is False:
            errors.append(f"{series_path}.renderability.canView2D: expected true for display-volume")
        if can_mpr_3d is False:
            errors.append(f"{series_path}.renderability.canMpr3D: expected true for display-volume")
    if capability in {"requires-reconstruction", "2d-only"} and can_mpr_3d is True:
        errors.append(f"{series_path}.renderability.canMpr3D: expected false unless reconstructionCapability is display-volume")
    return errors


def vector3(value: Any) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 3 or not all(is_number(item) for item in value):
        return None
    return [float(item) for item in value]


def orientation_vectors(value: Any) -> tuple[list[float], list[float]] | None:
    if not isinstance(value, list) or len(value) != 6 or not all(is_number(item) for item in value):
        return None
    return [float(item) for item in value[:3]], [float(item) for item in value[3:]]


def claims_display_volume(series: dict[str, Any]) -> bool:
    geometry = series.get("geometryKind")
    capability = series.get("reconstructionCapability")
    renderability = series.get("renderability")
    if geometry in {"volumeStack", "derivedVolume"} or capability == "display-volume":
        return True
    if renderability == "volume":
        return True
    return isinstance(renderability, dict) and renderability.get("canMpr3D") is True


def validate_volume_geometry(series_path: str, series: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    has_geometry = any(key in series for key in ("firstIPP", "lastIPP", "orientation"))
    if not has_geometry and not claims_display_volume(series):
        return errors
    if claims_display_volume(series) and series.get("sliceSpacingRegular") is False:
        errors.append(f"{series_path}.sliceSpacingRegular: display-volume series must have regular slice spacing")

    missing = [key for key in ("firstIPP", "lastIPP", "orientation") if key not in series]
    if missing:
        if claims_display_volume(series):
            errors.append(f"{series_path}: display-volume MPR requires firstIPP, lastIPP, and orientation")
        return errors

    first = vector3(series.get("firstIPP"))
    last = vector3(series.get("lastIPP"))
    orientation = orientation_vectors(series.get("orientation"))
    if first is None or last is None or orientation is None:
        return errors

    row, col = orientation
    row_norm = norm3(row)
    col_norm = norm3(col)
    if abs(row_norm - 1) > 0.02:
        errors.append(f"{series_path}.orientation: row direction cosine must be unit length")
    if abs(col_norm - 1) > 0.02:
        errors.append(f"{series_path}.orientation: column direction cosine must be unit length")
    if abs(dot3(row, col)) > 0.02:
        errors.append(f"{series_path}.orientation: row and column direction cosines must be orthogonal")

    normal = cross3(row, col)
    normal_norm = norm3(normal)
    if normal_norm <= 1e-6:
        errors.append(f"{series_path}.orientation: row/column cross product must define a slice normal")
        return errors

    slices = series.get("slices", 0)
    if isinstance(slices, int) and not isinstance(slices, bool) and slices > 1:
        span = [last[i] - first[i] for i in range(3)]
        span_norm = norm3(span)
        if span_norm <= 1e-6:
            errors.append(f"{series_path}.firstIPP/lastIPP: multi-slice volume requires nonzero slice span")
        else:
            alignment = abs(dot3(span, normal)) / (span_norm * normal_norm)
            if alignment < 0.98:
                errors.append(f"{series_path}.firstIPP/lastIPP: slice axis must align with orientation normal for accurate MPR")

    return errors


def validate_reconstruction_fields(series_path: str, series: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    geometry = series.get("geometryKind")
    capability = series.get("reconstructionCapability")

    if geometry is not None and (not isinstance(geometry, str) or geometry not in GEOMETRY_CAPABILITY):
        errors.append(f"{series_path}.geometryKind: expected one of {sorted(GEOMETRY_CAPABILITY)}")
        geometry = None
    if capability is not None and (not isinstance(capability, str) or capability not in set(GEOMETRY_CAPABILITY.values())):
        errors.append(f"{series_path}.reconstructionCapability: expected one of {sorted(set(GEOMETRY_CAPABILITY.values()))}")
        capability = None

    expected_capability = GEOMETRY_CAPABILITY.get(geometry) if geometry is not None else None
    if expected_capability is not None and capability is not None and capability != expected_capability:
        errors.append(f"{series_path}.reconstructionCapability: expected {expected_capability} for geometryKind {geometry}")

    if "renderability" in series:
        errors.extend(validate_renderability(series_path, series["renderability"], capability or expected_capability))

    return errors


def validate_projection_set(value: Any, index: int) -> list[str]:
    path = f"projectionSets[{index}]"
    if not isinstance(value, dict):
        return [f"{path}: expected object"]

    errors: list[str] = []
    for key in ("id", "name", "modality", "projectionKind", "reconstructionStatus"):
        if key not in value:
            errors.append(f"{path}: missing required field: {key}")
        elif not isinstance(value[key], str) or not value[key]:
            errors.append(f"{path}.{key}: expected non-empty string")

    projection_id = value.get("id")
    if isinstance(projection_id, str) and ("/" in projection_id or "\\" in projection_id or ".." in projection_id or not SLUG_RE.match(projection_id)):
        errors.append(f"{path}.id: expected safe projection set id")

    if value.get("projectionKind") not in PROJECTION_KINDS:
        errors.append(f"{path}.projectionKind: expected one of {sorted(PROJECTION_KINDS)}")
    if value.get("reconstructionStatus") not in PROJECTION_STATUSES:
        errors.append(f"{path}.reconstructionStatus: expected one of {sorted(PROJECTION_STATUSES)}")
    if value.get("reconstructionCapability", "requires-reconstruction") != "requires-reconstruction":
        errors.append(f"{path}.reconstructionCapability: expected requires-reconstruction")
    if value.get("renderability", "2d") != "2d":
        errors.append(f"{path}.renderability: expected 2d")
    if not is_positive_int(value.get("projectionCount")):
        errors.append(f"{path}.projectionCount: expected positive integer")

    if "calibrationStatus" in value and value.get("calibrationStatus") not in {"missing", "calibrated"}:
        errors.append(f"{path}.calibrationStatus: expected one of ['calibrated', 'missing']")
    if value.get("calibrationStatus") == "calibrated":
        matrices = value.get("projectionMatrices")
        if not isinstance(matrices, list) or len(matrices) != value.get("projectionCount"):
            errors.append(f"{path}.projectionMatrices: calibrated sets require one matrix per projection")
        detector_pixels = value.get("detectorPixels")
        if not isinstance(detector_pixels, list) or len(detector_pixels) != 2 or not all(is_positive_int(v) for v in detector_pixels):
            errors.append(f"{path}.detectorPixels: calibrated sets require positive [rows, cols]")
        detector_spacing = value.get("detectorSpacingMm")
        if not isinstance(detector_spacing, list) or len(detector_spacing) != 2 or not all(is_number(v) and v > 0 for v in detector_spacing):
            errors.append(f"{path}.detectorSpacingMm: calibrated sets require positive [row, col] spacing")
        if not isinstance(value.get("frameOfReferenceUID"), str) or not value.get("frameOfReferenceUID"):
            errors.append(f"{path}.frameOfReferenceUID: calibrated sets require non-empty FrameOfReferenceUID")

    missing = value.get("missingGeometry")
    if missing is not None and (not isinstance(missing, list) or not all(isinstance(item, str) and item for item in missing)):
        errors.append(f"{path}.missingGeometry: expected non-empty strings")

    for key in ("sourceSeriesSlug", "sourceStudyUID", "sourceSeriesUID", "frameOfReferenceUID", "bodyPart"):
        if key in value and (not isinstance(value[key], str) or not value[key]):
            errors.append(f"{path}.{key}: expected non-empty string")
    if isinstance(value.get("sourceSeriesSlug"), str):
        slug = value["sourceSeriesSlug"]
        if "/" in slug or "\\" in slug or ".." in slug or not SLUG_RE.match(slug):
            errors.append(f"{path}.sourceSeriesSlug: expected safe asset slug")

    return errors


def validate_geometry_record_fields(series_path: str, series: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    record_kind = series.get("geometryRecordKind")
    if record_kind is not None:
        if not isinstance(record_kind, str) or record_kind not in GEOMETRY_RECORD_KINDS:
            errors.append(f"{series_path}.geometryRecordKind: expected one of {sorted(GEOMETRY_RECORD_KINDS)}")
        if record_kind == "cartesian_volume" and series.get("sliceSpacingRegular") is False:
            errors.append(f"{series_path}.geometryRecordKind: cartesian_volume requires regular slice spacing")

    dims = series.get("dimensions")
    if dims is not None:
        if not isinstance(dims, dict):
            errors.append(f"{series_path}.dimensions: expected object")
        else:
            for key in ("width", "height", "depth"):
                val = dims.get(key)
                if val is not None and not is_positive_int(val) and val != 0:
                    errors.append(f"{series_path}.dimensions.{key}: expected non-negative integer")

    spacing = series.get("spacingMm")
    if spacing is not None:
        if not isinstance(spacing, dict):
            errors.append(f"{series_path}.spacingMm: expected object")
        else:
            for key in ("row", "col", "slice"):
                val = spacing.get(key)
                if val is not None and (not is_number(val) or val <= 0):
                    errors.append(f"{series_path}.spacingMm.{key}: expected positive number")

    stats = series.get("sliceSpacingStatsMm")
    if stats is not None:
        if not isinstance(stats, dict):
            errors.append(f"{series_path}.sliceSpacingStatsMm: expected object")
        else:
            for key in ("mean", "min", "max"):
                val = stats.get(key)
                if val is not None and (not is_number(val) or val < 0):
                    errors.append(f"{series_path}.sliceSpacingStatsMm.{key}: expected non-negative number")
            if "regular" in stats and not isinstance(stats["regular"], bool):
                errors.append(f"{series_path}.sliceSpacingStatsMm.regular: expected bool")

    bindings = series.get("derivedObjectBindings")
    if bindings is not None:
        if not isinstance(bindings, list):
            errors.append(f"{series_path}.derivedObjectBindings: expected list")
        else:
            for index, binding in enumerate(bindings):
                errors.extend(validate_derived_object_binding(f"{series_path}.derivedObjectBindings[{index}]", binding))

    return errors


def validate_derived_object_binding(path: str, binding: Any) -> list[str]:
    if not isinstance(binding, dict):
        return [f"{path}: expected object"]
    errors: list[str] = []
    kind = binding.get("derivedKind")
    if not isinstance(kind, str) or kind not in DERIVED_OBJECT_KINDS:
        errors.append(f"{path}.derivedKind: expected one of {sorted(DERIVED_OBJECT_KINDS)}")
    frame_uid = binding.get("frameOfReferenceUID")
    if not isinstance(frame_uid, str) or not frame_uid:
        errors.append(f"{path}.frameOfReferenceUID: expected non-empty string")
    has_source_uid = isinstance(binding.get("sourceSeriesUID"), str) and bool(binding.get("sourceSeriesUID"))
    has_source_slug = isinstance(binding.get("sourceSeriesSlug"), str) and bool(binding.get("sourceSeriesSlug"))
    if not has_source_uid and not has_source_slug:
        errors.append(f"{path}.sourceSeriesUID or sourceSeriesSlug: expected non-empty string")
    if "requiresRegistration" not in binding or not isinstance(binding["requiresRegistration"], bool):
        errors.append(f"{path}.requiresRegistration: expected bool")
    compat = binding.get("affineCompatibility")
    if compat is None or (not isinstance(compat, str) or compat not in AFFINE_COMPATIBILITY_VALUES):
        errors.append(f"{path}.affineCompatibility: expected one of {sorted(AFFINE_COMPATIBILITY_VALUES)}")
    if compat in {"requires-registration", "incompatible"} and binding.get("requiresRegistration") is False:
        errors.append(f"{path}: requiresRegistration must be true when affineCompatibility requires registration")
    return errors


def has_trustworthy_geometry(series: dict[str, Any]) -> bool:
    return (
        isinstance(series.get("orientation"), list)
        and len(series["orientation"]) >= 6
        and isinstance(series.get("firstIPP"), list)
        and len(series["firstIPP"]) >= 3
        and isinstance(series.get("lastIPP"), list)
        and len(series["lastIPP"]) >= 3
        and is_positive_int(series.get("slices"))
        and isinstance(series.get("pixelSpacing"), list)
        and len(series["pixelSpacing"]) >= 2
        and all(is_number(value) and value > 0 for value in series["pixelSpacing"][:2])
        and series.get("sliceSpacingRegular") is not False
    )


def validate_derived_binding_semantics(series: list[Any]) -> list[str]:
    errors: list[str] = []
    by_source_uid: dict[str, tuple[int, dict[str, Any]]] = {}
    by_slug: dict[str, tuple[int, dict[str, Any]]] = {}

    for index, item in enumerate(series):
        if not isinstance(item, dict):
            continue
        slug = item.get("slug")
        source_uid = item.get("sourceSeriesUID")
        if isinstance(slug, str) and slug:
            by_slug[slug] = (index, item)
        if isinstance(source_uid, str) and source_uid:
            by_source_uid[source_uid] = (index, item)

    for index, item in enumerate(series):
        if not isinstance(item, dict) or not isinstance(item.get("derivedObjectBindings"), list):
            continue
        derived_for = item.get("frameOfReferenceUID") if isinstance(item.get("frameOfReferenceUID"), str) else ""
        for binding_index, binding in enumerate(item["derivedObjectBindings"]):
            if not isinstance(binding, dict):
                continue
            path = f"series[{index}].derivedObjectBindings[{binding_index}]"
            source_uid = binding.get("sourceSeriesUID") if isinstance(binding.get("sourceSeriesUID"), str) else ""
            source_slug = binding.get("sourceSeriesSlug") if isinstance(binding.get("sourceSeriesSlug"), str) else ""
            if not source_uid and not source_slug:
                continue
            source_ref = by_source_uid.get(source_uid) if source_uid else None
            if source_ref is None and source_slug:
                source_ref = by_slug.get(source_slug)
            if not source_ref:
                if source_uid:
                    errors.append(f"{path}.sourceSeriesUID: unknown sourceSeriesUID: {source_uid}")
                else:
                    errors.append(f"{path}.sourceSeriesSlug: unknown sourceSeriesSlug: {source_slug}")
                continue

            source_index, source_series = source_ref
            if source_index == index:
                errors.append(f"{path}: derived series cannot bind to itself")
            source_for = source_series.get("frameOfReferenceUID") if isinstance(source_series.get("frameOfReferenceUID"), str) else ""
            binding_for = binding.get("frameOfReferenceUID") if isinstance(binding.get("frameOfReferenceUID"), str) else ""
            compat = binding.get("affineCompatibility")
            requires_registration = binding.get("requiresRegistration")

            if source_uid and source_slug:
                slug_ref = by_slug.get(source_slug)
                uid_ref = by_source_uid.get(source_uid)
                if slug_ref and uid_ref and slug_ref[0] != uid_ref[0]:
                    errors.append(f"{path}: sourceSeriesUID and sourceSeriesSlug must resolve to the same source series")

            if source_for and binding_for and source_for != binding_for and compat in {"exact", "within-tolerance"}:
                errors.append(f"{path}.affineCompatibility: exact/within-tolerance bindings require matching FrameOfReferenceUID")
            if derived_for and binding_for and derived_for != binding_for and compat in {"exact", "within-tolerance"}:
                errors.append(f"{path}.frameOfReferenceUID: exact/within-tolerance bindings must match the derived series FrameOfReferenceUID")
            if compat in {"exact", "within-tolerance"} and (not has_trustworthy_geometry(source_series) or not has_trustworthy_geometry(item)):
                errors.append(f"{path}.affineCompatibility: exact/within-tolerance bindings require trustworthy geometry on source and derived series")
            if compat in {"requires-registration", "incompatible"} and requires_registration is False:
                errors.append(f"{path}.requiresRegistration: expected true for {compat} binding")
    return errors


def validate_series(series: Any, index: int) -> list[str]:
    path = f"series[{index}]"
    if not isinstance(series, dict):
        return [f"{path}: expected object"]

    errors: list[str] = []
    for key, expected_type in REQUIRED_SERIES_FIELDS.items():
        if key not in series:
            errors.append(f"{path}: missing required field: {key}")
            continue
        if not isinstance(series[key], expected_type) or isinstance(series[key], bool) and expected_type is int:
            errors.append(f"{path}.{key}: expected {type_name(expected_type)}")

    slug = series.get("slug")
    if isinstance(slug, str):
        if not slug:
            errors.append(f"{path}.slug: expected non-empty string")
        if "/" in slug or "\\" in slug or ".." in slug or not SLUG_RE.match(slug):
            errors.append(f"{path}.slug: expected safe asset slug")

    for key in ("slices", "width", "height"):
        if key in series and not is_positive_int(series[key]):
            errors.append(f"{path}.{key}: expected positive integer")

    if "sliceThickness" in series and (not is_number(series["sliceThickness"]) or series["sliceThickness"] <= 0):
        errors.append(f"{path}.sliceThickness: expected positive number")

    for key in VECTOR_LENGTHS:
        if key in series:
            errors.extend(validate_vector(path, key, series[key]))

    for key in OPTIONAL_BOOL_FIELDS:
        if key in series and not isinstance(series[key], bool):
            errors.append(f"{path}.{key}: expected bool")

    errors.extend(validate_reconstruction_fields(path, series))
    errors.extend(validate_volume_geometry(path, series))
    errors.extend(validate_geometry_record_fields(path, series))

    for key in ("tr", "te"):
        if key in series and not is_number(series[key]):
            errors.append(f"{path}.{key}: expected finite number")
    if "sliceSpacing" in series and (not is_number(series["sliceSpacing"]) or series["sliceSpacing"] <= 0):
        errors.append(f"{path}.sliceSpacing: expected positive number")
    if "sliceSpacingRegular" in series and not isinstance(series["sliceSpacingRegular"], bool):
        errors.append(f"{path}.sliceSpacingRegular: expected bool")
    if "group" in series:
        group = series["group"]
        if group is not None and not is_number(group) and not (isinstance(group, str) and group):
            errors.append(f"{path}.group: expected finite number, non-empty string, or null")

    for key in (
        "modality",
        "sequence",
        "anatomySource",
        "rawUrl",
        "maskUrl",
        "sliceUrlBase",
        "regionUrlBase",
        "regionMetaUrl",
        "sourceProjectionSetId",
        "sourceStudyUID",
        "sourceSeriesUID",
        "frameOfReferenceUID",
        "bodyPart",
        "engineSourceKind",
    ):
        if key in series and (not isinstance(series[key], str) or not series[key]):
            errors.append(f"{path}.{key}: expected non-empty string")

    ultrasound_calibration = series.get("ultrasoundCalibration")
    if ultrasound_calibration is not None:
        if not isinstance(ultrasound_calibration, dict):
            errors.append(f"{path}.ultrasoundCalibration: expected object")
        else:
            for key in ("status", "mode", "probeGeometry", "source"):
                if key not in ultrasound_calibration or not isinstance(ultrasound_calibration[key], str) or not ultrasound_calibration[key]:
                    errors.append(f"{path}.ultrasoundCalibration.{key}: expected non-empty string")
    engine_report = series.get("engineReport")
    if engine_report is not None:
        if not isinstance(engine_report, dict):
            errors.append(f"{path}.engineReport: expected object")
        else:
            if "backend" in engine_report and (not isinstance(engine_report["backend"], str) or not engine_report["backend"]):
                errors.append(f"{path}.engineReport.backend: expected non-empty string")
            if "geometryModel" in engine_report and (not isinstance(engine_report["geometryModel"], str) or not engine_report["geometryModel"]):
                errors.append(f"{path}.engineReport.geometryModel: expected non-empty string")
            if "validation" in engine_report and engine_report["validation"] not in ENGINE_REPORT_VALIDATIONS:
                errors.append(f"{path}.engineReport.validation: expected one of {sorted(ENGINE_REPORT_VALIDATIONS)}")

    return errors


def validate_manifest_data(data: Any) -> list[str]:
    if not isinstance(data, dict):
        return ["manifest: expected object"]

    errors: list[str] = []
    series = data.get("series")
    if not isinstance(series, list):
        return ["manifest.series: expected list"]

    seen_slugs: dict[str, int] = {}
    for index, item in enumerate(series):
        errors.extend(validate_series(item, index))
        if isinstance(item, dict) and isinstance(item.get("slug"), str):
            slug = item["slug"]
            if slug in seen_slugs:
                errors.append(f"series[{index}].slug: duplicate slug also used by series[{seen_slugs[slug]}]: {slug}")
            else:
                seen_slugs[slug] = index

    errors.extend(validate_derived_binding_semantics(series))

    projection_sets = data.get("projectionSets")
    seen_projection_sets: dict[str, int] = {}
    if projection_sets is not None:
        if not isinstance(projection_sets, list):
            errors.append("manifest.projectionSets: expected list")
        else:
            for index, item in enumerate(projection_sets):
                errors.extend(validate_projection_set(item, index))
                if isinstance(item, dict) and isinstance(item.get("id"), str):
                    projection_id = item["id"]
                    if projection_id in seen_projection_sets:
                        errors.append(f"projectionSets[{index}].id: duplicate id also used by projectionSets[{seen_projection_sets[projection_id]}]: {projection_id}")
                    else:
                        seen_projection_sets[projection_id] = index

    if seen_projection_sets:
        for index, item in enumerate(series):
            if not isinstance(item, dict) or "sourceProjectionSetId" not in item:
                continue
            source_id = item["sourceProjectionSetId"]
            if isinstance(source_id, str) and source_id not in seen_projection_sets:
                errors.append(f"series[{index}].sourceProjectionSetId: unknown projection set id: {source_id}")
    else:
        for index, item in enumerate(series):
            if isinstance(item, dict) and isinstance(item.get("sourceProjectionSetId"), str):
                errors.append(f"series[{index}].sourceProjectionSetId: projectionSets registry is required")

    for key in ("patient", "studyDate"):
        if key in data and not isinstance(data[key], str):
            errors.append(f"manifest.{key}: expected string")

    return errors


def normalize_series_entry(
    entry: dict[str, Any] | None,
    public_base: str = "",
    *,
    job_id: str | None = None,
    region_dir_name: str = "",
    region_meta_name: str = "",
) -> dict[str, Any] | None:
    # Shape: {"slug":"cloud_job123","hasRaw":true,"sliceUrlBase":"https://.../data/cloud_job123"}.
    if not isinstance(entry, dict) or not entry.get("slug"):
        return None
    normalized = (
        apply_public_series_urls(
            entry,
            public_base,
            region_dir_name=region_dir_name,
            region_meta_name=region_meta_name,
        )
        if public_base
        else copy.deepcopy(entry)
    )
    trusted_origin = normalize_origin(public_base)
    if trusted_origin:
        for key in ("sliceUrlBase", "rawUrl", "regionUrlBase", "regionMetaUrl"):
            value = normalized.get(key)
            if value and normalize_origin(value) != trusted_origin:
                raise ValueError(f"series.{key}: expected origin {trusted_origin}")
    if normalized.get("group") is None:
        group = compare_group_key(normalized)
        if group is not None:
            normalized["group"] = group
    if job_id and not any(normalized.get(key) for key in JOB_ID_FIELDS):
        normalized["sourceJobId"] = job_id
    return normalized


def validate_modal_series(entry: dict[str, Any], public_base: str = "") -> list[str]:
    errors = [error.replace("series[0]", "series", 1) for error in validate_series(entry, 0)]
    for key in MODAL_REQUIRED_URL_FIELDS:
        if key not in entry:
            errors.append(f"series: missing required field: {key}")
        elif not isinstance(entry[key], str) or not entry[key]:
            errors.append(f"series.{key}: expected non-empty string")
    errors.extend(validate_public_series_urls(entry, public_base))
    return errors


def find_existing_series_index(manifest: dict[str, Any], entry: dict[str, Any], job_id: str | None = None) -> int | None:
    series = manifest.get("series") if isinstance(manifest, dict) else None
    if not isinstance(series, list):
        raise ValueError("manifest.series: expected list")
    # Shape: {1: ["slug"], 3: ["job_id"]} for one manifest series selected by canonical identity only.
    matches: dict[int, list[str]] = {}
    slug = entry.get("slug")
    if isinstance(slug, str) and slug:
        for index, item in enumerate(series):
            if isinstance(item, dict) and item.get("slug") == slug:
                matches.setdefault(index, []).append("slug")
    if job_id:
        for index, item in enumerate(series):
            if isinstance(item, dict) and any(item.get(key) == job_id for key in JOB_ID_FIELDS):
                matches.setdefault(index, []).append("job_id")
    if len(matches) > 1:
        detail = ", ".join(f"series[{index}] via {','.join(keys)}" for index, keys in sorted(matches.items()))
        raise ValueError(f"series result matches multiple manifest entries: {detail}")
    return next(iter(matches), None)


def upsert_projection_set(manifest: dict[str, Any], projection_entry: dict[str, Any] | None) -> None:
    if projection_entry is None:
        return
    if not isinstance(projection_entry, dict):
        raise ValueError("projection_set_entry: expected manifest-like projection source object")
    projection_id = str(projection_entry.get("projectionSetId") or projection_entry.get("id") or "").strip()
    if not projection_id:
        raise ValueError("projection_set_entry: expected manifest-like projection source object")
    manifest["projectionSets"] = manifest.get("projectionSets") if isinstance(manifest.get("projectionSets"), list) else []
    normalized = dict(projection_entry)
    normalized["id"] = projection_id
    existing_index = next((i for i, item in enumerate(manifest["projectionSets"]) if item.get("id") == projection_id), None)
    if existing_index is None:
        _ = manifest["projectionSets"].append(normalized)
        return
    merged = dict(manifest["projectionSets"][existing_index])
    merged.update(normalized)
    manifest["projectionSets"][existing_index] = merged


def merge_manifest_series(
    manifest: dict[str, Any],
    result_entry: dict[str, Any],
    *,
    projection_entry: dict[str, Any] | None = None,
    job_id: str | None = None,
    public_base: str = "",
) -> tuple[dict[str, Any], str, int]:
    if not isinstance(manifest, dict) or not isinstance(manifest.get("series"), list):
        raise ValueError("manifest: expected object with series list")
    entry = normalize_series_entry(result_entry, public_base, job_id=job_id)
    if entry is None:
        raise ValueError("series: missing required field: slug")
    errors = validate_modal_series(entry, public_base)
    if errors:
        raise ValueError("\n".join(errors))
    next_manifest = copy.deepcopy(manifest)
    upsert_projection_set(next_manifest, projection_entry)
    index = find_existing_series_index(next_manifest, entry, job_id)
    if index is None:
        next_manifest["series"].append(entry)
        index = len(next_manifest["series"]) - 1
        action = "inserted"
    else:
        merged = dict(next_manifest["series"][index])
        merged.update(entry)
        next_manifest["series"][index] = merged
        action = "updated"
    errors = validate_manifest_data(next_manifest)
    if errors:
        raise ValueError("\n".join(errors))
    return next_manifest, action, index


def merge_manifest_path(
    manifest_path: Path,
    result_entry: dict[str, Any],
    *,
    projection_entry: dict[str, Any] | None = None,
    job_id: str | None = None,
    public_base: str = "",
) -> tuple[dict[str, Any], str, int]:
    return merge_manifest_series(
        load_json(manifest_path),
        result_entry,
        projection_entry=projection_entry,
        job_id=job_id,
        public_base=public_base,
    )
