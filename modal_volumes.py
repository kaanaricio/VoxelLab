from __future__ import annotations

from pathlib import Path
from typing import Any

from geometry import affine_lps_from_series, geometry_from_slices
from modal_io import compress_raw_volume
from series_contract import normalize_series_entry


def normalize_volume_for_pngs(vol, modality: str, np) -> Any:
    if modality == "CT":
        lo, hi = -160.0, 240.0
        pngs = np.clip((vol - lo) / (hi - lo), 0, 1)
        return (pngs * 255).astype(np.uint8)
    nz = vol[vol > 0]
    if nz.size:
        p_lo, p_hi = np.percentile(nz, [1, 99])
    else:
        p_lo, p_hi = 0, max(float(vol.max()), 1)
    pngs = np.clip((vol - p_lo) / max(p_hi - p_lo, 1), 0, 1)
    return (pngs * 255).astype(np.uint8)


def normalize_volume_for_raw(vol, modality: str, np) -> Any:
    if modality == "CT":
        lo_hu, hi_hu = -1024.0, 2048.0
        return np.clip((vol - lo_hu) / (hi_hu - lo_hu), 0, 1)
    nz = vol[vol > 0]
    lo_r, hi_r = (
        float(np.percentile(nz, [0.1, 99.9])[0]),
        float(np.percentile(nz, [0.1, 99.9])[1]),
    ) if nz.size else (0.0, 1.0)
    return np.clip((vol - lo_r) / max(hi_r - lo_r, 1e-6), 0, 1)


def write_png_stack(out_dir: Path, pngs, Image) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for z in range(pngs.shape[0]):
        Image.fromarray(pngs[z], mode="L").save(out_dir / f"{z:04d}.png")


def write_nifti_from_dicom_stack(vol_dhw, slices, out_path: Path, np, nib) -> None:
    geometry = geometry_from_slices(slices)
    series = {
        "pixelSpacing": geometry["pixelSpacing"],
        "sliceThickness": geometry["sliceThickness"],
        "sliceSpacing": geometry["sliceSpacing"],
        "firstIPP": geometry["firstIPP"],
        "lastIPP": geometry["lastIPP"],
        "orientation": geometry["orientation"],
        "slices": len(slices),
    }
    affine = np.diag([-1.0, -1.0, 1.0, 1.0]) @ np.asarray(affine_lps_from_series(series), dtype=np.float64)
    vol_xyz = np.transpose(vol_dhw, (2, 1, 0))
    nib.save(nib.Nifti1Image(vol_xyz.astype(np.float32), affine), str(out_path))


def source_uid_value(source_manifest: dict[str, Any], key: str, fallback: str = "") -> str:
    return str(source_manifest.get(key, "") or fallback or "")


def build_projection_set_entry(
    projection_set: dict[str, Any],
    *,
    modality: str,
    source_series_slug: str = "",
    projection_calibration: dict[str, Any] | None = None,
    engine_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Shape: {"id":"projection_set_1","projectionKind":"cbct","projectionCount":120,...}.
    entry = {
        "id": str(projection_set["id"]),
        "name": str(projection_set.get("name", "") or projection_set["id"]),
        "modality": str(modality or projection_set.get("modality", "") or "OT").upper(),
        "projectionKind": str(projection_set.get("projectionKind", "") or "unknown"),
        "projectionCount": int(projection_set["projectionCount"]),
        "reconstructionCapability": "requires-reconstruction",
        "reconstructionStatus": str(projection_set.get("reconstructionStatus", "") or "requires-reconstruction"),
        "renderability": "2d",
    }
    if source_series_slug:
        entry["sourceSeriesSlug"] = source_series_slug
    for key in (
        "sourceSeriesUID",
        "frameOfReferenceUID",
        "calibrationStatus",
        "projectionMatrices",
        "detectorPixels",
        "detectorSpacingMm",
    ):
        value = projection_set.get(key)
        if value not in (None, "") and value != [] and value != {}:
            entry[key] = value
    if isinstance(projection_calibration, dict) and projection_calibration:
        entry["projectionCalibration"] = projection_calibration
    if isinstance(engine_report, dict) and engine_report:
        entry["engineReport"] = engine_report
    return entry


def build_derived_volume_entry(
    *,
    slug: str,
    name: str,
    description: str,
    modality: str,
    width: int,
    height: int,
    depth: int,
    geometry: dict[str, Any],
    public_url: str,
    source_projection_set_id: str = "",
    source_series_uid: str = "",
    frame_of_reference_uid: str = "",
    body_part: str = "",
    engine_source_kind: str = "",
    engine_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entry = {
        "slug": slug,
        "name": name,
        "description": description,
        "modality": modality,
        "slices": depth,
        "width": width,
        "height": height,
        "pixelSpacing": geometry["pixelSpacing"],
        "sliceThickness": float(geometry["sliceThickness"]),
        "sliceSpacing": float(geometry["sliceSpacing"]),
        "sliceSpacingRegular": bool(geometry["sliceSpacingRegular"]),
        "firstIPP": geometry["firstIPP"],
        "lastIPP": geometry["lastIPP"],
        "orientation": geometry["orientation"],
        "group": None,
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": True,
        "geometryKind": "derivedVolume",
        "reconstructionCapability": "display-volume",
        "renderability": "volume",
        "engineSourceKind": engine_source_kind,
    }
    if isinstance(engine_report, dict) and engine_report:
        entry["engineReport"] = engine_report
    if source_projection_set_id:
        entry["sourceProjectionSetId"] = source_projection_set_id
    if source_series_uid:
        entry["sourceSeriesUID"] = source_series_uid
    if frame_of_reference_uid:
        entry["frameOfReferenceUID"] = frame_of_reference_uid
    if body_part:
        entry["bodyPart"] = body_part
    return normalize_series_entry(entry, public_url)


def write_volume_outputs(*, vol, slug: str, modality: str, out_root: Path, public_url: str, Image, np) -> tuple[Path, Path]:
    out_dir = out_root / slug
    pngs = normalize_volume_for_pngs(vol, modality, np)
    write_png_stack(out_dir, pngs, Image)
    raw_path = out_root.parent / f"{slug}.raw"
    u16 = (normalize_volume_for_raw(vol, modality, np) * 65535).astype(np.uint16)
    _ = raw_path.write_bytes(u16.tobytes())
    zst_path = out_root.parent / f"{slug}.raw.zst"
    compress_raw_volume(raw_path, zst_path)
    return out_dir, zst_path
