from __future__ import annotations

import math

import numpy as np

import projection_rtk
from projection_reconstruction import filtered_backprojection_parallel, reconstruct_projection_volume


class FakeProjection:
    def __init__(self, pixel_array, instance: int):
        self.pixel_array = pixel_array
        self.SeriesInstanceUID = "1.2.projection.series"
        self.StudyInstanceUID = "1.2.study"
        self.Modality = "XA"
        self.InstanceNumber = instance


def test_reconstruct_projection_volume_builds_calibrated_derived_volume():
    detector_rows = 4
    detector_cols = 32
    angles = [0, 30, 60, 90, 120, 150]
    detector_axis = np.arange(detector_cols, dtype=np.float32)
    center = (detector_cols - 1) / 2.0
    profile = np.exp(-((detector_axis - center) ** 2) / 18.0).astype(np.float32)
    datasets = [FakeProjection(np.tile(profile, (detector_rows, 1)), index + 1) for index in range(len(angles))]

    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.projection.series",
        "name": "Calibrated CBCT",
        "projectionSetId": "projection_set_1",
        "projection": {
            "geometryModel": "parallel-beam-stack",
            "anglesDeg": angles,
            "outputShape": [24, 24, 4],
            "outputSpacingMm": [1.0, 1.0, 1.5],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.for",
        },
    }

    result = reconstruct_projection_volume(datasets, manifest, np)

    assert result["volume"].shape == (4, 24, 24)
    assert float(result["volume"][2, 12, 12]) > float(result["volume"][2, 0, 0])
    assert result["geometry"]["frameOfReferenceUID"] == "1.2.for"
    assert result["projectionSet"]["id"] == "projection_set_1"
    assert result["projectionSet"]["projectionKind"] == "parallel-beam"
    assert result["projectionSet"]["reconstructionStatus"] == "reconstructed"
    assert result["report"]["backend"] == "parallel-fbp"
    assert result["report"]["geometryModel"] == "parallel-beam-stack"


def test_filtered_backprojection_parallel_normalizes_full_rotation_coverage() -> None:
    detector_count = 32
    detector_axis = np.arange(detector_count, dtype=np.float32)
    center = (detector_count - 1) / 2.0
    profile = np.exp(-((detector_axis - center) ** 2) / 18.0).astype(np.float32)
    full_angles = [0.0, 90.0, 180.0, 270.0]
    sinogram = np.tile(profile[:, None], (1, len(full_angles)))

    current = filtered_backprojection_parallel(sinogram, full_angles, 24, np)

    # Shape: legacy implementation forced half-rotation scaling even for 360-degree coverage.
    detector_axis = np.arange(detector_count, dtype=np.float32)
    detector_center = (detector_count - 1) / 2.0
    filtered = np.fft.irfft(
        np.fft.rfft(sinogram, axis=0) * (2.0 * np.abs(np.fft.rfftfreq(detector_count).astype(np.float32)))[:, None],
        n=detector_count,
        axis=0,
    )
    grid = np.linspace(-(24 - 1) / 2.0, (24 - 1) / 2.0, 24, dtype=np.float32)
    xx, yy = np.meshgrid(grid, grid, indexing="xy")
    legacy = np.zeros((24, 24), dtype=np.float32)
    for index, angle_deg in enumerate(full_angles):
      theta = math.radians(float(angle_deg))
      detector_positions = xx * math.cos(theta) + yy * math.sin(theta) + detector_center
      legacy += np.interp(detector_positions.ravel(), detector_axis, filtered[:, index], left=0.0, right=0.0).reshape(24, 24)
    legacy *= math.pi / (2.0 * len(full_angles))

    ratio = float(current[12, 12]) / max(float(legacy[12, 12]), 1e-6)
    assert math.isfinite(ratio)
    assert 1.9 <= ratio <= 2.1


def test_filtered_backprojection_parallel_keeps_coverage_scaling_continuous_around_half_rotation() -> None:
    detector_count = 32
    detector_axis = np.arange(detector_count, dtype=np.float32)
    center = (detector_count - 1) / 2.0
    profile = np.exp(-((detector_axis - center) ** 2) / 18.0).astype(np.float32)
    below_half = [0.0, 60.0, 120.0, 179.0]
    above_half = [0.0, 60.0, 120.0, 181.0]

    below = filtered_backprojection_parallel(np.tile(profile[:, None], (1, len(below_half))), below_half, 24, np)
    above = filtered_backprojection_parallel(np.tile(profile[:, None], (1, len(above_half))), above_half, 24, np)

    ratio = float(above[12, 12]) / max(float(below[12, 12]), 1e-6)
    assert math.isfinite(ratio)
    assert 0.95 <= ratio <= 1.05


def test_reconstruct_projection_volume_requires_rtk_for_non_parallel_geometry(monkeypatch):
    datasets = [FakeProjection(np.ones((4, 4), dtype=np.float32), 1)]
    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.projection.series",
        "projection": {
            "geometryModel": "circular-cbct",
            "anglesDeg": [0],
            "outputShape": [8, 8, 2],
            "outputSpacingMm": [1.0, 1.0, 1.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.for",
        },
    }

    monkeypatch.setattr(projection_rtk, "configured_rtk_command", lambda: "")
    try:
        _ = reconstruct_projection_volume(datasets, manifest, np)
    except RuntimeError as exc:
        assert "requires RTK" in str(exc)
    else:
        raise AssertionError("expected non-parallel projection geometry to require RTK")
