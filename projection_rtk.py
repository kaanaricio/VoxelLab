"""Optional external projection reconstruction bridge."""

from __future__ import annotations

import importlib.metadata
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from engine_report import normalize_engine_validation
from geometry import cross3, normalize3

def _bundled_rtk_wrapper() -> str:
    wrapper = Path(__file__).resolve().parent / "scripts" / "rtk_projection_wrapper.py"
    if not wrapper.exists():
        return ""
    try:
        _ = importlib.metadata.version("itk-rtk")
    except importlib.metadata.PackageNotFoundError:
        return ""
    return f"{sys.executable} {wrapper}"


def configured_rtk_command() -> str:
    raw = str(os.environ.get("MRI_VIEWER_RTK_COMMAND", "") or "").strip()
    if raw:
        return raw
    bundled = _bundled_rtk_wrapper()
    if bundled:
        return bundled
    return ""


def rtk_available() -> bool:
    return bool(configured_rtk_command())


def backend_report(geometry_model: str, backend: str) -> dict[str, Any]:
    return {
        "backend": backend,
        "geometryModel": geometry_model,
        "validation": "prototype" if backend == "parallel-fbp" else "external-engine",
        "rtkAvailable": rtk_available(),
    }


def _projection_pixels(dataset: Any, np: Any) -> Any:
    pixels = dataset.pixel_array.astype(np.float32)
    slope = float(getattr(dataset, "RescaleSlope", 1) or 1)
    intercept = float(getattr(dataset, "RescaleIntercept", 0) or 0)
    return pixels * slope + intercept


def _detector_spacing_mm(dataset: Any) -> list[float]:
    spacing = getattr(dataset, "PixelSpacing", None) or getattr(dataset, "ImagerPixelSpacing", None) or []
    if isinstance(spacing, str):
        spacing = spacing.split("\\")
    try:
        row = float(spacing[0])
        col = float(spacing[1])
    except Exception:
        return [1.0, 1.0]
    return [row if row > 0 else 1.0, col if col > 0 else 1.0]


def _base_geometry(source_manifest: dict[str, Any]) -> dict[str, Any]:
    projection = source_manifest["projection"]
    spacing = [float(value) for value in projection["outputSpacingMm"]]
    first_ipp = [float(value) for value in projection["firstIPP"]]
    orientation = [float(value) for value in projection["orientation"]]
    depth = max(int(projection["outputShape"][2]) - 1, 0)
    row = orientation[:3]
    col = orientation[3:6]
    slice_dir = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]
    return {
        "pixelSpacing": spacing[:2],
        "sliceThickness": spacing[2],
        "sliceSpacing": spacing[2],
        "sliceSpacingRegular": True,
        "firstIPP": first_ipp,
        "lastIPP": [
            first_ipp[0] + slice_dir[0] * spacing[2] * depth,
            first_ipp[1] + slice_dir[1] * spacing[2] * depth,
            first_ipp[2] + slice_dir[2] * spacing[2] * depth,
        ],
        "orientation": orientation,
        "frameOfReferenceUID": str(projection["frameOfReferenceUID"]),
    }


def _base_projection_set(datasets: list[Any], source_manifest: dict[str, Any], detector_shape: tuple[int, int]) -> dict[str, Any]:
    projection = source_manifest["projection"]
    series_uid = str(getattr(datasets[0], "SeriesInstanceUID", "") or "")
    detector_spacing = _detector_spacing_mm(datasets[0])
    return {
        "id": str(source_manifest.get("projectionSetId", "") or f"{series_uid or 'projection'}_projection_set"),
        "name": str(source_manifest.get("name", "") or "Projection source"),
        "sourceSeriesUID": series_uid,
        "frameOfReferenceUID": str(projection["frameOfReferenceUID"]),
        "projectionKind": "cbct",
        "projectionCount": len(datasets),
        "reconstructionCapability": "requires-reconstruction",
        "reconstructionStatus": "reconstructed",
        "renderability": "2d",
        "calibrationStatus": "calibrated",
        "projectionMatrices": source_manifest.get("projectionMatrices", []),
        "detectorPixels": [int(detector_shape[0]), int(detector_shape[1])],
        "detectorSpacingMm": detector_spacing,
    }


def _wrapper_manifest(source_manifest: dict[str, Any], geometry_model: str) -> dict[str, Any]:
    projection = dict(source_manifest["projection"])
    projection["geometryModel"] = geometry_model
    return {**source_manifest, "projection": projection}


def _run_wrapper(command: str, manifest_path: Path, projections_path: Path, output_path: Path) -> None:
    argv = shlex.split(command)
    if not argv:
        raise RuntimeError("MRI_VIEWER_RTK_COMMAND is empty")
    try:
        _ = subprocess.run(
            [
                *argv,
                "--input-manifest",
                str(manifest_path),
                "--projections",
                str(projections_path),
                "--output-json",
                str(output_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = str(exc.stderr or exc.stdout or "").strip()
        detail = f": {stderr}" if stderr else ""
        raise RuntimeError(f"projection reconstruction wrapper failed{detail}") from exc


def reconstruct_with_rtk(datasets: list[Any], source_manifest: dict[str, Any], np: Any, geometry_model: str = "", **_kwargs: Any) -> dict[str, Any]:
    command = configured_rtk_command()
    if not command:
        raise RuntimeError(
            f"projection geometry {geometry_model or '(unknown)'} requires RTK; run `npm run setup -- --pipeline --rtk` or set MRI_VIEWER_RTK_COMMAND"
        )

    projection_stack = np.stack([_projection_pixels(dataset, np) for dataset in datasets], axis=0)
    detector_shape = tuple(int(value) for value in projection_stack.shape[1:3])
    base_geometry = _base_geometry(source_manifest)
    base_projection_set = _base_projection_set(datasets, source_manifest, detector_shape)
    detector_spacing = _detector_spacing_mm(datasets[0])

    with tempfile.TemporaryDirectory(prefix="voxellab_rtk_") as temp_dir:
        temp_root = Path(temp_dir)
        manifest_path = temp_root / "input_manifest.json"
        projections_path = temp_root / "projections.npy"
        output_path = temp_root / "output.json"

        wrapper_manifest = _wrapper_manifest(source_manifest, geometry_model)
        wrapper_manifest["projection"] = {
            **wrapper_manifest["projection"],
            "detectorSpacingMm": detector_spacing,
            "detectorPixels": [detector_shape[0], detector_shape[1]],
        }
        _ = manifest_path.write_text(json.dumps(wrapper_manifest, indent=2))
        np.save(projections_path, projection_stack)
        _run_wrapper(command, manifest_path, projections_path, output_path)

        if not output_path.exists():
            raise RuntimeError(f"projection geometry {geometry_model or '(unknown)'} wrapper did not produce output.json")
        payload = json.loads(output_path.read_text())
        if not isinstance(payload, dict):
            raise RuntimeError("projection reconstruction wrapper output must be an object")

        volume_path = Path(str(payload.get("volumePath", "") or ""))
        if not volume_path.is_absolute():
            volume_path = temp_root / volume_path
        if not volume_path.exists():
            raise RuntimeError("projection reconstruction wrapper must emit volumePath to a saved NumPy volume")

        volume = np.load(volume_path, allow_pickle=False)
        if getattr(volume, "ndim", 0) != 3:
            raise RuntimeError("projection reconstruction wrapper volume must be 3D")

        geometry = dict(base_geometry)
        if isinstance(payload.get("geometry"), dict):
            geometry.update(payload["geometry"])
        projection_set = dict(base_projection_set)
        if isinstance(payload.get("projectionSet"), dict):
            projection_set.update(payload["projectionSet"])
        report = backend_report(geometry_model, "rtk-cli")
        if isinstance(payload.get("report"), dict):
            report.update(payload["report"])
        report["backend"] = str(report.get("backend", "rtk-cli") or "rtk-cli")
        report["geometryModel"] = str(report.get("geometryModel", geometry_model) or geometry_model)
        report["validation"] = normalize_engine_validation(report.get("validation", "external-engine"))
        return {
            "volume": volume,
            "geometry": geometry,
            "projectionSet": projection_set,
            "report": report,
        }
