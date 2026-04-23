"""Ultrasound scan conversion and simple calibrated 3D reconstruction helpers."""

from __future__ import annotations

import math
from typing import Any

from engine_sources import normalize_source_manifest, ultrasound_manifest_errors
from geometry import cross3, normalize3
from ultrasound_profiles import resolve_ultrasound_profile


def _frame_pixels(ds: Any, np: Any) -> list[Any]:
    pixels = ds.pixel_array.astype(np.float32)
    if pixels.ndim == 2:
        return [pixels]
    if pixels.ndim == 3:
        return [pixels[index] for index in range(pixels.shape[0])]
    raise ValueError("ultrasound reconstruction expects 2D frames or one multi-frame stack")


def _scan_convert_sector(frame: Any, config: dict[str, Any], np: Any, ndimage: Any) -> Any:
    rows, cols = frame.shape
    out_width, out_height = [int(value) for value in config["scanConvertedShape"]]
    spacing_x, spacing_y = [float(value) for value in config["scanConvertedSpacingMm"]]
    theta_min, theta_max = [math.radians(float(value)) for value in config["thetaRangeDeg"]]
    radius_min, radius_max = [float(value) for value in config["radiusRangeMm"]]

    x = (np.arange(out_width, dtype=np.float32) - ((out_width - 1) / 2.0)) * spacing_x
    y = np.arange(out_height, dtype=np.float32) * spacing_y + radius_min
    xx, yy = np.meshgrid(x, y, indexing="xy")

    theta = np.arctan2(xx, yy)
    radius = np.sqrt(xx * xx + yy * yy)
    row_coords = (radius - radius_min) / max(radius_max - radius_min, 1e-6) * max(rows - 1, 1)
    col_coords = (theta - theta_min) / max(theta_max - theta_min, 1e-6) * max(cols - 1, 1)
    sample_coords = np.stack([row_coords, col_coords], axis=0)
    return ndimage.map_coordinates(frame, sample_coords, order=1, mode="constant", cval=0.0)


def _accumulate_frame(volume: Any, weights: Any, image: Any, transform: list[list[float]], config: dict[str, Any], np: Any) -> None:
    out_width, out_height, out_depth = [int(value) for value in config["outputShape"]]
    spacing_x, spacing_y, spacing_z = [float(value) for value in config["outputSpacingMm"]]
    origin = [float(value) for value in config["firstIPP"]]
    img_height, img_width = image.shape

    x = (np.arange(img_width, dtype=np.float32) - ((img_width - 1) / 2.0)) * float(config["scanConvertedSpacingMm"][0])
    y = np.arange(img_height, dtype=np.float32) * float(config["scanConvertedSpacingMm"][1])
    xx, yy = np.meshgrid(x, y, indexing="xy")
    points = np.stack([xx, yy, np.zeros_like(xx), np.ones_like(xx)], axis=-1).reshape(-1, 4)
    world = points @ np.asarray(transform, dtype=np.float32).T
    values = image.reshape(-1)
    valid = values > 0
    world = world[valid]
    values = values[valid]
    if not len(values):
        return

    ix = np.rint((world[:, 0] - origin[0]) / spacing_x).astype(np.int32)
    iy = np.rint((world[:, 1] - origin[1]) / spacing_y).astype(np.int32)
    iz = np.rint((world[:, 2] - origin[2]) / spacing_z).astype(np.int32)
    keep = (
        (ix >= 0) & (ix < out_width) &
        (iy >= 0) & (iy < out_height) &
        (iz >= 0) & (iz < out_depth)
    )
    ix, iy, iz, values = ix[keep], iy[keep], iz[keep], values[keep]
    volume[iz, iy, ix] += values
    weights[iz, iy, ix] += 1.0


def reconstruct_ultrasound_volume(datasets: list[Any], source_manifest: dict[str, Any], np: Any, ndimage: Any) -> dict[str, Any]:
    source_manifest = normalize_source_manifest(source_manifest) or source_manifest
    if not datasets:
        raise ValueError("ultrasound reconstruction requires at least one source dataset")

    series_uid = str(getattr(datasets[0], "SeriesInstanceUID", "") or "")
    frame_count = sum(len(_frame_pixels(ds, np)) for ds in datasets)
    errors = ultrasound_manifest_errors(source_manifest, frame_count, series_uid)
    if errors:
        raise ValueError("; ".join(errors))

    raw_config = dict(source_manifest["ultrasound"])
    config = resolve_ultrasound_profile(raw_config)
    if "scanConvertedShape" not in raw_config:
        config["scanConvertedShape"] = config["outputShape"][:2]
    if "scanConvertedSpacingMm" not in raw_config:
        config["scanConvertedSpacingMm"] = config["outputSpacingMm"][:2]

    frames = []
    for ds in datasets:
        frames.extend(_frame_pixels(ds, np))
    converted = [_scan_convert_sector(frame, config, np, ndimage) for frame in frames]

    out_width, out_height, out_depth = [int(value) for value in config["outputShape"]]
    volume = np.zeros((out_depth, out_height, out_width), dtype=np.float32)
    weights = np.zeros_like(volume)

    if config["mode"] == "stacked-sector":
        row_count = min(out_depth, len(converted))
        positions = np.linspace(0, row_count - 1, row_count, dtype=np.float32)
        for index, plane in enumerate(converted[:row_count]):
            depth = int(round(positions[index]))
            volume[depth] = plane[:out_height, :out_width]
            weights[depth] = (volume[depth] > 0).astype(np.float32)
    else:
        transforms = config["frameTransformsLps"]
        for index, plane in enumerate(converted):
            _accumulate_frame(volume, weights, plane, transforms[index], config, np)

    weights[weights == 0] = 1.0
    volume /= weights

    row = config["orientation"][:3]
    col = config["orientation"][3:6]
    slice_dir = normalize3(cross3(row, col)) or [0.0, 0.0, 1.0]
    first_ipp = [float(value) for value in config["firstIPP"]]
    spacing = [float(value) for value in config["outputSpacingMm"]]
    last_ipp = [
        first_ipp[0] + slice_dir[0] * spacing[2] * max(out_depth - 1, 0),
        first_ipp[1] + slice_dir[1] * spacing[2] * max(out_depth - 1, 0),
        first_ipp[2] + slice_dir[2] * spacing[2] * max(out_depth - 1, 0),
    ]
    return {
        "volume": volume,
        "geometry": {
            "pixelSpacing": spacing[:2],
            "sliceThickness": spacing[2],
            "sliceSpacing": spacing[2],
            "sliceSpacingRegular": True,
            "firstIPP": first_ipp,
            "lastIPP": last_ipp,
            "orientation": [float(value) for value in config["orientation"]],
            "frameOfReferenceUID": str(config.get("frameOfReferenceUID", "") or ""),
        },
        "report": {
            "backend": "sector-scan-conversion",
            "profileId": str(config.get("profileId", "") or ""),
            "mode": str(config.get("mode", "") or ""),
            "probeGeometry": str(config.get("probeGeometry", "") or ""),
            "validation": "prototype",
        },
    }
