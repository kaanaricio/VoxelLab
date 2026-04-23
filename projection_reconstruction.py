"""Projection reconstruction helpers for calibrated parallel-beam stacks."""

from __future__ import annotations

import math
from typing import Any

from engine_sources import normalize_source_manifest, projection_manifest_errors
from geometry import cross3, normalize3
from projection_rtk import backend_report, reconstruct_with_rtk


def _projection_pixels(ds: Any, np: Any) -> Any:
    pixels = ds.pixel_array.astype(np.float32)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    return pixels * slope + intercept


def _ram_lak_filter(detector_count: int, np: Any) -> Any:
    freqs = np.fft.rfftfreq(detector_count).astype(np.float32)
    return 2.0 * np.abs(freqs)


def _angular_coverage_degrees(angles_deg: list[float]) -> float:
    if len(angles_deg) < 2:
        return 0.0
    # Shape: [0.0, 45.0, 90.0, 135.0] -> sorted wrapped gantry angles in degrees.
    normalized = sorted(float(angle) % 360.0 for angle in angles_deg)
    gaps = [
        normalized[index + 1] - normalized[index]
        for index in range(len(normalized) - 1)
    ] + [normalized[0] + 360.0 - normalized[-1]]
    coverage = max(0.0, 360.0 - max(gaps))
    # Shape: [90.0, 90.0, 90.0, 90.0] -> evenly wrapped full-rotation sampling.
    positive_gaps = [gap for gap in gaps if gap > 1e-6]
    if len(normalized) >= 3 and positive_gaps and max(gaps) <= (min(positive_gaps) * 1.5):
        return 360.0
    return coverage


def filtered_backprojection_parallel(sinogram: Any, angles_deg: list[float], output_size: int, np: Any) -> Any:
    if sinogram.ndim != 2:
        raise ValueError("projection sinogram: expected 2D detector x angle array")
    detector_count, angle_count = sinogram.shape
    if angle_count != len(angles_deg):
        raise ValueError("projection sinogram: expected one angle per projection")

    detector_axis = np.arange(detector_count, dtype=np.float32)
    detector_center = (detector_count - 1) / 2.0
    filtered = np.fft.irfft(
        np.fft.rfft(sinogram, axis=0) * _ram_lak_filter(detector_count, np)[:, None],
        n=detector_count,
        axis=0,
    )

    grid = np.linspace(-(output_size - 1) / 2.0, (output_size - 1) / 2.0, output_size, dtype=np.float32)
    xx, yy = np.meshgrid(grid, grid, indexing="xy")
    recon = np.zeros((output_size, output_size), dtype=np.float32)

    for index, angle_deg in enumerate(angles_deg):
        theta = math.radians(float(angle_deg))
        detector_positions = xx * math.cos(theta) + yy * math.sin(theta) + detector_center
        recon += np.interp(detector_positions.ravel(), detector_axis, filtered[:, index], left=0.0, right=0.0).reshape(
            output_size,
            output_size,
        )

    if angle_count:
        coverage_rad = math.radians(_angular_coverage_degrees(angles_deg) or 180.0)
        recon *= coverage_rad / (2.0 * angle_count)
    return recon


def reconstruct_projection_volume(datasets: list[Any], source_manifest: dict[str, Any], np: Any) -> dict[str, Any]:
    source_manifest = normalize_source_manifest(source_manifest) or source_manifest
    if not datasets:
        raise ValueError("projection reconstruction requires at least one projection image")

    series_uid = str(getattr(datasets[0], "SeriesInstanceUID", "") or "")
    errors = projection_manifest_errors(source_manifest, len(datasets), series_uid)
    if errors:
        raise ValueError("; ".join(errors))

    projection = source_manifest["projection"]
    geometry_model = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    if geometry_model != "parallel-beam-stack":
        reconstructed = reconstruct_with_rtk(datasets, source_manifest, np=np, geometry_model=geometry_model)
        reconstructed.setdefault("report", backend_report(geometry_model, "rtk-cli"))
        return reconstructed

    angles_deg = [float(value) for value in projection["anglesDeg"]]
    output_width, output_height, output_depth = [int(value) for value in projection["outputShape"]]
    spacing = [float(value) for value in projection["outputSpacingMm"]]
    first_ipp = [float(value) for value in projection["firstIPP"]]
    orientation = [float(value) for value in projection["orientation"]]
    frame_uid = str(projection["frameOfReferenceUID"])
    row = orientation[:3]
    col = orientation[3:6]
    slice_dir = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]

    pixel_stack = np.stack([_projection_pixels(ds, np) for ds in datasets], axis=0)
    if pixel_stack.ndim != 3:
        raise ValueError("projection reconstruction expects 2D projection images")
    angle_count, detector_rows, detector_cols = pixel_stack.shape
    if angle_count != len(angles_deg):
        raise ValueError("projection reconstruction requires one calibrated angle per projection image")

    row_positions = np.linspace(0.0, max(detector_rows - 1, 0), output_depth, dtype=np.float32)
    volume = np.zeros((output_depth, output_height, output_width), dtype=np.float32)

    detector_axis = np.arange(detector_rows, dtype=np.float32)
    for depth_index, row_position in enumerate(row_positions):
        lower = int(np.floor(row_position))
        upper = min(lower + 1, detector_rows - 1)
        blend = float(row_position - lower)
        row_samples = (1.0 - blend) * pixel_stack[:, lower, :] + blend * pixel_stack[:, upper, :]
        sinogram = row_samples.T
        slice_size = min(output_width, output_height)
        recon = filtered_backprojection_parallel(sinogram, angles_deg, slice_size, np)
        slice_canvas = np.zeros((output_height, output_width), dtype=np.float32)
        y0 = (output_height - slice_size) // 2
        x0 = (output_width - slice_size) // 2
        slice_canvas[y0:y0 + slice_size, x0:x0 + slice_size] = recon
        volume[depth_index] = slice_canvas

    last_ipp = [
        first_ipp[0] + slice_dir[0] * spacing[2] * max(output_depth - 1, 0),
        first_ipp[1] + slice_dir[1] * spacing[2] * max(output_depth - 1, 0),
        first_ipp[2] + slice_dir[2] * spacing[2] * max(output_depth - 1, 0),
    ]
    projection_set_id = str(source_manifest.get("projectionSetId", "") or f"{series_uid or 'projection'}_projection_set")
    return {
        "volume": volume,
        "geometry": {
            "pixelSpacing": spacing[:2],
            "sliceThickness": spacing[2],
            "sliceSpacing": spacing[2],
            "sliceSpacingRegular": True,
            "firstIPP": first_ipp,
            "lastIPP": last_ipp,
            "orientation": orientation,
            "frameOfReferenceUID": frame_uid,
        },
        "projectionSet": {
            "id": projection_set_id,
            "name": str(source_manifest.get("name", "") or "Projection source"),
            "sourceSeriesUID": series_uid,
            "frameOfReferenceUID": frame_uid,
            "projectionKind": "parallel-beam",
            "projectionCount": len(datasets),
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "reconstructed",
            "renderability": "2d",
            "calibrationStatus": "calibrated",
            "projectionMatrices": source_manifest.get("projectionMatrices", []),
            "detectorPixels": [detector_rows, detector_cols],
            "detectorSpacingMm": spacing[:2],
        },
        "report": backend_report(geometry_model, "parallel-fbp"),
    }
