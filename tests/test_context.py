from __future__ import annotations

import json
from pathlib import Path

import pytest

import context
from spatial_context import validate_context_payload


def test_generate_series_context_uses_geometry_and_labels(tmp_path: Path) -> None:
    Image = pytest.importorskip("PIL.Image")

    data = tmp_path / "data"
    data.mkdir()
    for folder in ("sample", "sample_seg", "sample_regions"):
        (data / folder).mkdir()
    Image.new("L", (2, 2), 100).save(data / "sample" / "0000.png")
    Image.new("L", (2, 2), 200).save(data / "sample" / "0001.png")
    Image.new("L", (2, 2), 1).save(data / "sample_seg" / "0000.png")
    Image.new("L", (2, 2), 2).save(data / "sample_seg" / "0001.png")
    Image.new("L", (2, 2), 7).save(data / "sample_regions" / "0000.png")
    Image.new("L", (2, 2), 0).save(data / "sample_regions" / "0001.png")
    _ = (data / "sample_regions.json").write_text(json.dumps({
        "legend": {"7": "Approx region"},
        "regions": {"7": {"name": "Approx region", "voxels": 4}},
    }))
    _ = (data / "sample_stats.json").write_text(json.dumps({
        "slug": "sample",
        "symmetryScores": [0.0, 2.0],
    }))
    series = {
        "slug": "sample",
        "name": "Sample",
        "slices": 2,
        "width": 2,
        "height": 2,
        "pixelSpacing": [2.0, 3.0],
        "sliceThickness": 1.0,
        "firstIPP": [0.0, 0.0, 0.0],
        "lastIPP": [0.0, 0.0, 1.0],
        "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    }

    payload = context.generate_series_context(data, series)

    assert payload["slug"] == "sample"
    assert payload["slices"][0]["centerVoxel"] == [0.5, 0.5, 0]
    assert payload["slices"][0]["centerMm"] == [1.5, 1.0, 0.0]
    assert payload["slices"][0]["intensity"]["units"] == "display_uint8"
    assert payload["slices"][0]["tissue"]["counts"]["csf"] == 4
    assert payload["slices"][0]["regions"][0]["name"] == "Approx region"
    assert payload["slices"][0]["regions"][0]["areaMm2"] == 24.0
    assert payload["slices"][1]["regions"] == []


def test_set_has_context_updates_only_generated_slugs(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    _ = manifest_path.write_text(json.dumps({
        "series": [
            {"slug": "sample"},
            {"slug": "other", "hasContext": False},
        ],
    }))

    context.set_has_context(manifest_path, {"sample"})

    manifest = json.loads(manifest_path.read_text())
    assert manifest["series"][0]["hasContext"] is True
    assert manifest["series"][1]["hasContext"] is False


def test_validate_context_payload_rejects_unknown_intensity_units() -> None:
    errors = validate_context_payload(
        {
            "slug": "sample",
            "version": 1,
            "slices": [{
                "index": 0,
                "intensity": {"source": "base_png", "units": "pretend_hu", "mean": 1.0},
            }],
        },
        "sample",
        1,
    )

    assert "context.slices[0].intensity.units" in errors[0]
