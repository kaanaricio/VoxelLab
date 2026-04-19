#!/usr/bin/env python3
"""RTK-backed projection reconstruction wrapper for VoxelLab."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine_report import normalize_engine_validation
from engine_sources import normalize_source_manifest, projection_manifest_errors
from geometry import cross3, normalize3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run RTK projection reconstruction from a VoxelLab manifest + NPY stack.")
    _ = parser.add_argument("--input-manifest", required=True, help="Path to normalized projection source manifest JSON.")
    _ = parser.add_argument("--projections", required=True, help="Path to NumPy .npy projection stack with shape [projection,row,col].")
    _ = parser.add_argument("--output-json", required=True, help="Path to output JSON metadata contract.")
    _ = parser.add_argument("--backend", choices=("auto", "cpu"), default="auto", help="RTK backend selection.")
    return parser.parse_args()


def load_rtk() -> tuple[Any, Any]:
    try:
        import itk
        from itk import RTK as rtk
    except Exception as exc:  # pragma: no cover - import failure path is runtime-specific.
        raise RuntimeError("itk-rtk is required; run `npm run setup -- --pipeline --rtk` or `./.venv/bin/python -m pip install itk-rtk`") from exc
    return itk, rtk


def detector_spacing(projection: dict[str, Any]) -> list[float]:
    spacing = projection.get("detectorSpacingMm", projection.get("inputSpacingMm", [1.0, 1.0]))
    values = [float(spacing[0]), float(spacing[1])] if isinstance(spacing, list) and len(spacing) >= 2 else [1.0, 1.0]
    return [values[0] if values[0] > 0 else 1.0, values[1] if values[1] > 0 else 1.0]


def projection_origin(rows: int, cols: int, spacing_rc: list[float]) -> list[float]:
    row_spacing, col_spacing = spacing_rc
    return [
        -((cols - 1) * col_spacing) / 2.0,
        -((rows - 1) * row_spacing) / 2.0,
        0.0,
    ]


def volume_direction(itk: Any, orientation: list[float]) -> Any:
    row = orientation[:3]
    col = orientation[3:6]
    slice_dir = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]
    matrix = np.array([
        [row[0], col[0], slice_dir[0]],
        [row[1], col[1], slice_dir[1]],
        [row[2], col[2], slice_dir[2]],
    ], dtype=np.float64)
    return itk.matrix_from_array(matrix)


def build_geometry(itk: Any, rtk: Any, projection: dict[str, Any], projection_count: int, matrix_list: list[list[list[float]]]) -> Any:
    geometry = rtk.ThreeDCircularProjectionGeometry.New()
    if matrix_list:
        for matrix in matrix_list:
            added = geometry.AddProjection(itk.matrix_from_array(np.asarray(matrix, dtype=np.float64)))
            if added is False:
                raise RuntimeError("RTK rejected one of the calibrated projection matrices")
        return geometry

    rtk_geometry = projection.get("rtkGeometry")
    if not isinstance(rtk_geometry, dict):
        raise RuntimeError("non-parallel RTK reconstruction requires projectionMatrices or projection.rtkGeometry")

    sid = float(rtk_geometry.get("sourceToIsocenterDistanceMm", 0.0) or 0.0)
    sdd = float(rtk_geometry.get("sourceToDetectorDistanceMm", 0.0) or 0.0)
    if sid <= 0 or sdd <= 0:
        raise RuntimeError("projection.rtkGeometry requires positive sourceToIsocenterDistanceMm and sourceToDetectorDistanceMm")
    angles = rtk_geometry.get("gantryAnglesDeg", projection.get("anglesDeg", []))
    if not isinstance(angles, list) or len(angles) != projection_count:
        raise RuntimeError("projection.rtkGeometry.gantryAnglesDeg must contain one angle per projection")
    offsets_x = rtk_geometry.get("projectionOffsetsXMm", [])
    offsets_y = rtk_geometry.get("projectionOffsetsYMm", [])
    out_of_plane = rtk_geometry.get("outOfPlaneAnglesDeg", [])
    in_plane = rtk_geometry.get("inPlaneAnglesDeg", [])
    source_offsets_x = rtk_geometry.get("sourceOffsetsXMm", [])
    source_offsets_y = rtk_geometry.get("sourceOffsetsYMm", [])

    def seq(values: Any, index: int) -> float:
        if isinstance(values, list) and index < len(values):
            return float(values[index] or 0.0)
        return 0.0

    for index, angle in enumerate(angles):
        geometry.AddProjection(
            sid,
            sdd,
            float(angle),
            seq(offsets_x, index),
            seq(offsets_y, index),
            seq(out_of_plane, index),
            seq(in_plane, index),
            seq(source_offsets_x, index),
            seq(source_offsets_y, index),
        )
    return geometry


def image_array(itk: Any, image: Any, label: str) -> np.ndarray:
    array = itk.GetArrayFromImage(image)
    if array is None:
        raise RuntimeError(f"RTK {label} filter did not produce an output image")
    return array.astype(np.float32, copy=False)


def reconstruct(manifest: dict[str, Any], projection_stack: np.ndarray, backend: str = "auto") -> dict[str, Any]:
    if projection_stack.ndim != 3:
        raise RuntimeError("projection stack must be a 3D NumPy array shaped [projection,row,col]")
    projection_stack = projection_stack.astype(np.float32, copy=False)
    projection_count, rows, cols = projection_stack.shape
    errors = projection_manifest_errors(manifest, projection_count, str(manifest.get("seriesUID", "") or ""))
    if errors:
        raise RuntimeError("; ".join(errors))

    projection = manifest["projection"]
    geometry_model = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    if geometry_model == "limited-angle-tomo":
        raise RuntimeError("limited-angle geometry requires an iterative reconstruction runtime; FDK is not appropriate")
    itk, rtk = load_rtk()
    matrix_list = manifest.get("projectionMatrices", projection.get("projectionMatrices", []))
    geometry = build_geometry(itk, rtk, projection, projection_count, matrix_list if isinstance(matrix_list, list) else [])

    detector_spacing_rc = detector_spacing(projection)
    projections = itk.image_view_from_array(projection_stack)
    projections.SetSpacing([detector_spacing_rc[1], detector_spacing_rc[0], 1.0])
    projections.SetOrigin(projection_origin(rows, cols, detector_spacing_rc))

    width, height, depth = [int(value) for value in projection["outputShape"]]
    row_spacing, col_spacing, slice_spacing = [float(value) for value in projection["outputSpacingMm"]]
    first_ipp = [float(value) for value in projection["firstIPP"]]
    orientation = [float(value) for value in projection["orientation"]]

    image_type = itk.Image[itk.F, 3]
    source = rtk.ConstantImageSource[image_type].New()
    source.SetOrigin(first_ipp)
    source.SetSpacing([col_spacing, row_spacing, slice_spacing])
    source.SetSize([width, height, depth])
    source.SetConstant(0.0)
    source.SetDirection(volume_direction(itk, orientation))

    fdk = rtk.FDKConeBeamReconstructionFilter[image_type].New()
    fdk.SetInput(0, source.GetOutput())
    fdk.SetInput(1, projections)
    fdk.SetGeometry(geometry)
    fdk.GetRampFilter().SetTruncationCorrection(0.0)
    fdk.GetRampFilter().SetHannCutFrequency(0.0)
    fdk.Update()

    volume = image_array(itk, fdk.GetOutput(), "FDK")
    fov_applied = False
    if hasattr(rtk, "FieldOfViewImageFilter"):
        try:
            fov = rtk.FieldOfViewImageFilter[image_type, image_type].New()
            fov.SetInput(0, fdk.GetOutput())
            fov.SetProjectionsStack(projections)
            fov.SetGeometry(geometry)
            fov.Update()
            volume = image_array(itk, fov.GetOutput(), "field-of-view")
            fov_applied = True
        except Exception:
            fov_applied = False
    report = {
        "backend": "itk-rtk-fdk-cpu",
        "geometryModel": geometry_model,
        "validation": "external-engine",
        "runtime": "itk-rtk",
        "backendMode": backend,
        "fieldOfViewApplied": fov_applied,
    }
    return {"volume": volume, "report": report}


def main() -> int:
    args = parse_args()
    manifest = normalize_source_manifest(json.loads(Path(args.input_manifest).read_text()))
    if not isinstance(manifest, dict):
        raise SystemExit("input manifest must be a JSON object")
    projection_stack = np.load(args.projections, allow_pickle=False)
    result = reconstruct(manifest, projection_stack, backend=args.backend)

    output_path = Path(args.output_json)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    volume_path = output_path.with_name(f"{output_path.stem}.volume.npy")
    np.save(volume_path, result["volume"])
    payload = {
        "volumePath": volume_path.name,
        "report": {
            **result["report"],
            "validation": normalize_engine_validation(result["report"].get("validation")),
        },
    }
    _ = output_path.write_text(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
