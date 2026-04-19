from __future__ import annotations

from modal_volumes import build_projection_set_entry
from series_contract import merge_manifest_series, normalize_series_entry, validate_modal_series, validate_projection_set


def fixture_manifest() -> dict:
    return {
        "patient": "fixture",
        "studyDate": "2026-04-09",
        "series": [
            {
                "slug": "sample",
                "name": "Sample",
                "description": "Tiny fixture stack",
                "slices": 2,
                "width": 2,
                "height": 1,
                "pixelSpacing": [0.5, 0.5],
                "sliceThickness": 1.0,
                "hasBrain": False,
                "hasSeg": True,
                "hasRaw": False,
            }
        ],
    }


def modal_entry(**overrides) -> dict:
    entry = {
        "slug": "cloud_job12345",
        "name": "Cloud CT",
        "description": "2 slices - cloud processed",
        "modality": "CT",
        "slices": 2,
        "width": 4,
        "height": 4,
        "pixelSpacing": [0.7, 0.7],
        "sliceThickness": 1.5,
        "group": None,
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": True,
        "rawUrl": "https://r2.example/cloud_job12345.raw.zst",
        "sliceUrlBase": "https://r2.example/data/cloud_job12345",
    }
    entry.update(overrides)
    return entry


def test_normalize_series_entry_backfills_urls_and_compare_group() -> None:
    entry = normalize_series_entry(
        {
            "slug": "cloud_job12345",
            "hasRaw": True,
            "frameOfReferenceUID": "1.2.for",
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 1],
            "orientation": [1, 0, 0, 0, 1, 0],
        },
        "https://r2.example",
        job_id="job12345",
    )

    assert entry["sliceUrlBase"] == "https://r2.example/data/cloud_job12345"
    assert entry["rawUrl"] == "https://r2.example/cloud_job12345.raw.zst"
    assert entry["group"] == "for:1.2.for"
    assert entry["sourceJobId"] == "job12345"


def test_validate_modal_series_entry_requires_cloud_urls() -> None:
    errors = validate_modal_series(
        {
            "slug": "cloud_job12345",
            "name": "Cloud CT",
            "description": "2 slices - cloud processed",
            "slices": 2,
            "width": 4,
            "height": 4,
            "pixelSpacing": [0.7, 0.7],
            "sliceThickness": 1.5,
            "hasBrain": False,
            "hasSeg": False,
            "hasRaw": True,
        }
    )

    assert "series: missing required field: rawUrl" in errors
    assert "series: missing required field: sliceUrlBase" in errors


def test_merge_manifest_series_upserts_projection_registry() -> None:
    merged, action, index = merge_manifest_series(
        fixture_manifest(),
        modal_entry(
            geometryKind="derivedVolume",
            reconstructionCapability="display-volume",
            renderability={"canView2D": True, "canMpr3D": True, "reason": ""},
            sourceProjectionSetId="projection_set_1",
            firstIPP=[0, 0, 0],
            lastIPP=[0, 0, 1],
            orientation=[1, 0, 0, 0, 1, 0],
        ),
        projection_entry={
            "id": "projection_set_1",
            "name": "Source CBCT",
            "sourceSeriesSlug": "sample_projection",
            "modality": "XA",
            "projectionKind": "cbct",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "reconstructed",
            "renderability": "2d",
        },
        job_id="job12345",
    )

    assert action == "inserted"
    assert index == 1
    assert merged["series"][1]["sourceJobId"] == "job12345"
    assert merged["projectionSets"][0]["id"] == "projection_set_1"


def test_build_projection_set_entry_matches_projection_registry_contract() -> None:
    projection_entry = build_projection_set_entry(
        {
            "id": "projection_set_1",
            "name": "Source CBCT",
            "projectionKind": "cbct",
            "projectionCount": 2,
            "reconstructionStatus": "reconstructed",
            "sourceSeriesUID": "1.2.3",
            "frameOfReferenceUID": "1.2.for",
            "calibrationStatus": "calibrated",
            "projectionMatrices": [
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            ],
            "detectorPixels": [64, 64],
            "detectorSpacingMm": [0.8, 0.8],
        },
        modality="XA",
        source_series_slug="local_projection",
        projection_calibration={"status": "calibrated"},
        engine_report={"engine": "rtk-cli"},
    )

    assert validate_projection_set(projection_entry, 0) == []
