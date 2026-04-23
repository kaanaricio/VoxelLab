from __future__ import annotations

from engine_sources import projection_manifest_errors, ultrasound_manifest_errors
from geometry import (
    cross3,
    dot3,
    extract_enhanced_multiframe_slices,
    float_list,
    geometry_from_slices,
    norm3,
    sort_datasets_spatially,
)

PROJECTION_MODALITIES = {"CR", "DX", "IO", "MG", "PX", "RF", "XA"}
PROJECTION_IMAGE_MARKERS = {"LOCALIZER", "SCOUT", "PROJECTION"}


def dicom_group_key(ds) -> tuple[str, str, int, int]:
    modality = str(getattr(ds, "Modality", "") or "")
    series_uid = str(getattr(ds, "SeriesInstanceUID", "") or "")
    if not series_uid:
        series_uid = "|".join(
            str(getattr(ds, field, "") or "")
            for field in ("StudyInstanceUID", "SeriesNumber", "SeriesDescription")
        )
    return (
        modality,
        series_uid,
        int(getattr(ds, "Rows", 0) or 0),
        int(getattr(ds, "Columns", 0) or 0),
    )


def is_projection_like_dicom(ds) -> bool:
    modality = str(getattr(ds, "Modality", "") or "").upper()
    if modality in PROJECTION_MODALITIES:
        return True
    image_type = getattr(ds, "ImageType", [])
    if isinstance(image_type, str):
        image_type = image_type.split("\\")
    return any(str(value).upper() in PROJECTION_IMAGE_MARKERS for value in image_type)


def mpr_geometry_error(slices: list) -> str:
    if len(slices) < 2:
        return "MPR volume processing requires at least two slices"
    geometry = geometry_from_slices(slices)
    first, last = slices[0], slices[-1]
    spacing = geometry.get("pixelSpacing") or float_list(getattr(first, "PixelSpacing", []), 2)
    if len(spacing) < 2 or spacing[0] <= 0 or spacing[1] <= 0:
        return "MPR volume processing requires positive DICOM PixelSpacing"

    orientation = geometry.get("orientation") or float_list(getattr(first, "ImageOrientationPatient", []), 6)
    if len(orientation) < 6:
        return "MPR volume processing requires ImageOrientationPatient"
    row, col = orientation[:3], orientation[3:6]
    row_norm = norm3(row)
    col_norm = norm3(col)
    if abs(row_norm - 1) > 0.02 or abs(col_norm - 1) > 0.02 or abs(dot3(row, col)) > 0.02:
        return "MPR volume processing requires orthonormal row/column orientation"

    first_ipp = float_list(getattr(first, "ImagePositionPatient", []), 3)
    last_ipp = float_list(getattr(last, "ImagePositionPatient", []), 3)
    if len(first_ipp) < 3 or len(last_ipp) < 3:
        return "MPR volume processing requires ImagePositionPatient on the first and last slices"

    normal = cross3(row, col)
    span = [last_ipp[i] - first_ipp[i] for i in range(3)]
    normal_norm = norm3(normal)
    span_norm = norm3(span)
    if normal_norm <= 1e-6 or span_norm <= 1e-6:
        return "MPR volume processing requires nonzero slice normal and slice span"
    alignment = abs(dot3(span, normal)) / (span_norm * normal_norm)
    if alignment < 0.9999:
        return "MPR volume processing requires slice positions aligned with the orientation normal"
    stats = geometry.get("sliceSpacingStats", {})
    if len(slices) > 2 and stats and not stats.get("regular", False):
        return "MPR volume processing requires regular slice spacing"
    return ""


def _eligible_dicom_groups(datasets: list, requested_modality: str) -> dict[tuple[str, str, int, int], list]:
    groups: dict[tuple[str, str, int, int], list] = {}
    for ds in datasets:
        key = dicom_group_key(ds)
        if key[0] not in {"CT", "MR"} or is_projection_like_dicom(ds) or key[2] <= 0 or key[3] <= 0:
            continue
        if requested_modality != "auto" and key[0] != requested_modality:
            continue
        groups.setdefault(key, []).append(ds)
    return groups


def _dropped_dicom_series_from_groups(
    groups: dict[tuple[str, str, int, int], list],
    selected_key: tuple[str, str, int, int],
) -> list[dict]:
    dropped = []
    # Shape: {"seriesUID":"1.2.3","modality":"MR","rows":512,"columns":512,"sliceCount":180}.
    for key, group in groups.items():
        if key == selected_key:
            continue
        dropped.append({
            "modality": key[0],
            "seriesUID": key[1],
            "rows": key[2],
            "columns": key[3],
            "sliceCount": len(group),
        })
    return dropped


def select_primary_dicom_stack_details(
    datasets: list,
    requested_modality: str,
) -> tuple[list, str, tuple[str, str, int, int], list[dict]]:
    groups = _eligible_dicom_groups(datasets, requested_modality)
    if not groups:
        return [], "", ("", "", 0, 0), []
    key, selected = max(groups.items(), key=lambda item: len(item[1]))
    return sort_datasets_spatially(selected), key[0], key, _dropped_dicom_series_from_groups(groups, key)


def select_primary_dicom_stack(datasets: list, requested_modality: str) -> tuple[list, str, tuple[str, str, int, int]]:
    selected, modality, key, _dropped = select_primary_dicom_stack_details(datasets, requested_modality)
    return selected, modality, key


def dropped_dicom_series(datasets: list, requested_modality: str, selected_key: tuple[str, str, int, int]) -> list[dict]:
    return _dropped_dicom_series_from_groups(_eligible_dicom_groups(datasets, requested_modality), selected_key)


def stack_pixels_with_rescale(slices: list) -> object:
    import numpy as np

    # Shape: -1024.0 -> float32 voxel after per-slice DICOM rescale is applied.
    return np.stack([
        np.asarray(ds.pixel_array, dtype=np.float32)
        if float(getattr(ds, "RescaleSlope", 1) or 1) == 1.0
        and float(getattr(ds, "RescaleIntercept", 0) or 0) == 0.0
        else np.asarray(ds.pixel_array, dtype=np.float32) * float(getattr(ds, "RescaleSlope", 1) or 1)
        + float(getattr(ds, "RescaleIntercept", 0) or 0)
        for ds in slices
    ])


def expand_primary_stack(datasets: list) -> tuple[list, str]:
    expanded = []
    for ds in datasets:
        frames = extract_enhanced_multiframe_slices(ds)
        if not frames:
            expanded.append(ds)
            continue

        pixel_frames = getattr(ds, "pixel_array", None)
        shape = getattr(pixel_frames, "shape", ())
        if len(shape) < 3 or shape[0] < len(frames):
            return [], "enhanced multi-frame stack requires per-frame pixel access before volume processing"

        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
        rows = int(getattr(ds, "Rows", 0) or 0)
        cols = int(getattr(ds, "Columns", 0) or 0)
        series_uid = getattr(ds, "SeriesInstanceUID", "")
        study_uid = getattr(ds, "StudyInstanceUID", "")
        modality = getattr(ds, "Modality", "")
        for i, frame in enumerate(frames):
            frame.pixel_array = pixel_frames[i]
            frame.Rows = rows
            frame.Columns = cols
            frame.RescaleSlope = float(getattr(frame, "RescaleSlope", slope) or slope)
            frame.RescaleIntercept = float(getattr(frame, "RescaleIntercept", intercept) or intercept)
            frame.SeriesInstanceUID = series_uid
            frame.StudyInstanceUID = study_uid
            frame.Modality = modality
        expanded.extend(frames)

    return sort_datasets_spatially(expanded), ""


def ensure_projection_inputs(datasets: list, source_manifest: dict | None) -> tuple[list, str]:
    if not source_manifest:
        return [], "projection reconstruction requires voxellab.source.json source manifest"
    if not datasets:
        return [], "projection reconstruction requires at least one uploaded projection image"
    series_uids = {str(getattr(ds, "SeriesInstanceUID", "") or "") for ds in datasets}
    if len(series_uids) != 1:
        return [], "projection reconstruction requires one coherent projection series per job"
    if any(not is_projection_like_dicom(ds) for ds in datasets):
        return [], "projection reconstruction rejects non-projection images in calibrated mode"
    errors = projection_manifest_errors(source_manifest, len(datasets), next(iter(series_uids)))
    if errors:
        return [], "; ".join(errors)
    return datasets, ""


def ensure_ultrasound_inputs(datasets: list, source_manifest: dict | None, np) -> tuple[list, str]:
    if not source_manifest:
        return [], "ultrasound scan conversion requires voxellab.source.json source manifest"
    if not datasets:
        return [], "ultrasound scan conversion requires at least one uploaded ultrasound dataset"
    modalities = {str(getattr(ds, "Modality", "") or "").upper() for ds in datasets}
    if modalities != {"US"}:
        return [], "ultrasound scan conversion requires ultrasound source datasets only"
    series_uids = {str(getattr(ds, "SeriesInstanceUID", "") or "") for ds in datasets}
    if len(series_uids) != 1:
        return [], "ultrasound scan conversion requires one coherent ultrasound series per job"
    frame_count = 0
    for ds in datasets:
        shape = getattr(getattr(ds, "pixel_array", None), "shape", ())
        frame_count += int(shape[0]) if len(shape) == 3 else 1
    errors = ultrasound_manifest_errors(source_manifest, frame_count, next(iter(series_uids)))
    if errors:
        return [], "; ".join(errors)
    return datasets, ""
