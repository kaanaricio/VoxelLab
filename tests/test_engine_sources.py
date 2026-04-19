from __future__ import annotations

from engine_sources import normalize_source_manifest, projection_manifest_errors, projection_summary, ultrasound_summary


def test_normalize_source_manifest_promotes_geometry_model_and_version() -> None:
    manifest = normalize_source_manifest(
        {
            "sourceKind": "projection",
            "seriesUID": "1.2.series",
            "projection": {
                "geometry": "parallel-beam-stack",
                "anglesDeg": [0, 90],
                "outputShape": [8, 8, 2],
                "outputSpacingMm": [1, 1, 1],
                "firstIPP": [0, 0, 0],
                "orientation": [1, 0, 0, 0, 1, 0],
                "frameOfReferenceUID": "1.2.for",
            },
        }
    )

    assert manifest["sourceRecordVersion"] == 1
    assert manifest["projection"]["geometryModel"] == "parallel-beam-stack"


def test_projection_manifest_errors_accepts_v2_geometry_model() -> None:
    errors = projection_manifest_errors(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "projection",
            "seriesUID": "1.2.series",
            "projection": {
                "geometryModel": "limited-angle-tomo",
                "anglesDeg": [0, 30],
                "outputShape": [8, 8, 2],
                "outputSpacingMm": [1, 1, 1],
                "firstIPP": [0, 0, 0],
                "orientation": [1, 0, 0, 0, 1, 0],
                "frameOfReferenceUID": "1.2.for",
            },
        },
        2,
        "1.2.series",
    )

    assert errors == []


def test_projection_and_ultrasound_summary_include_versioned_contract_fields() -> None:
    projection = projection_summary(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "projection",
            "projection": {
                "geometryModel": "circular-cbct",
                "anglesDeg": [0, 45, 90],
            },
        }
    )
    ultrasound = ultrasound_summary(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "ultrasound",
            "ultrasound": {
                "mode": "tracked-freehand-sector",
                "probeGeometry": "sector",
                "profileId": "tracked-freehand-sector-default",
            },
        }
    )

    assert projection["sourceRecordVersion"] == 2
    assert projection["geometry"] == "circular-cbct"
    assert ultrasound["sourceRecordVersion"] == 2
    assert ultrasound["profileId"] == "tracked-freehand-sector-default"


def test_manifest_output_shape_requires_real_ints_and_reasonable_volume_size() -> None:
    errors = projection_manifest_errors(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "projection",
            "seriesUID": "1.2.series",
            "projection": {
                "geometryModel": "limited-angle-tomo",
                "anglesDeg": [0, 30],
                "outputShape": [8.5, "8", 2],
                "outputSpacingMm": [1, 1, 1],
                "firstIPP": [0, 0, 0],
                "orientation": [1, 0, 0, 0, 1, 0],
                "frameOfReferenceUID": "1.2.for",
            },
        },
        2,
        "1.2.series",
    )
    huge_errors = projection_manifest_errors(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "projection",
            "seriesUID": "1.2.series",
            "projection": {
                "geometryModel": "limited-angle-tomo",
                "anglesDeg": [0, 30],
                "outputShape": [100000, 100000, 100000],
                "outputSpacingMm": [1, 1, 1],
                "firstIPP": [0, 0, 0],
                "orientation": [1, 0, 0, 0, 1, 0],
                "frameOfReferenceUID": "1.2.for",
            },
        },
        2,
        "1.2.series",
    )

    assert any("outputShape" in error for error in errors)
    assert any("outputShape" in error for error in huge_errors)
