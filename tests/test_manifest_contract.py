from __future__ import annotations

import copy
from pathlib import Path

from scripts.check_manifest import load_json, validate_config_data, validate_manifest_data

FIXTURES = Path(__file__).parent / "fixtures" / "manifest"


def fixture_manifest() -> dict:
    return load_json(FIXTURES / "valid_manifest.json")


def test_manifest_fixture_is_valid() -> None:
    assert validate_manifest_data(fixture_manifest()) == []


def test_manifest_allows_empty_public_export() -> None:
    manifest = {"patient": "anonymous", "studyDate": "", "series": []}

    assert validate_manifest_data(manifest) == []


def test_manifest_rejects_missing_required_series_field() -> None:
    manifest = fixture_manifest()
    del manifest["series"][0]["pixelSpacing"]

    errors = validate_manifest_data(manifest)

    assert "series[0]: missing required field: pixelSpacing" in errors


def test_manifest_rejects_duplicate_slugs() -> None:
    manifest = fixture_manifest()
    manifest["series"].append(copy.deepcopy(manifest["series"][0]))

    errors = validate_manifest_data(manifest)

    assert any("duplicate slug" in error and "sample" in error for error in errors)


def test_manifest_rejects_bad_slice_dimensions_and_counts() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["slices"] = 0
    manifest["series"][0]["width"] = "2"

    errors = validate_manifest_data(manifest)

    assert "series[0].slices: expected positive integer" in errors
    assert "series[0].width: expected int" in errors


def test_manifest_allows_null_group_for_cloud_series() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["group"] = None

    assert validate_manifest_data(manifest) == []


def test_manifest_allows_string_compare_group_keys() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["group"] = "for:1.2.840.123"

    assert validate_manifest_data(manifest) == []


def test_manifest_accepts_explicit_volume_reconstruction_fields() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "volumeStack",
            "reconstructionCapability": "display-volume",
            "renderability": {"canView2D": True, "canMpr3D": True, "reason": ""},
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 1],
            "orientation": [1, 0, 0, 0, 1, 0],
        }
    )
    derived = copy.deepcopy(manifest["series"][0])
    derived.update(
        {
            "slug": "derived_cbct",
            "name": "Derived CBCT",
            "geometryKind": "derivedVolume",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
            "sourceProjectionSetId": "projection_set_1",
        }
    )
    manifest["series"].append(derived)
    manifest["projectionSets"] = [
        {
            "id": "projection_set_1",
            "name": "Source CBCT",
            "sourceSeriesSlug": "sample_projection",
            "modality": "XA",
            "projectionKind": "cbct",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "requires-reconstruction",
            "renderability": "2d",
        }
    ]

    assert validate_manifest_data(manifest) == []


def test_manifest_rejects_projection_display_volume_combo() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "projectionSet",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0].reconstructionCapability: expected requires-reconstruction for geometryKind projectionSet" in errors


def test_manifest_rejects_projection_renderability_claiming_mpr_3d() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "singleProjection",
            "reconstructionCapability": "2d-only",
            "renderability": {"canView2D": True, "canMpr3D": True, "reason": ""},
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0].renderability.canMpr3D: expected false unless reconstructionCapability is display-volume" in errors


def test_manifest_rejects_display_volume_without_mpr_geometry() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "volumeStack",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0]: display-volume MPR requires firstIPP, lastIPP, and orientation" in errors


def test_manifest_rejects_display_volume_with_irregular_slice_spacing() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "volumeStack",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 1],
            "orientation": [1, 0, 0, 0, 1, 0],
            "sliceSpacingRegular": False,
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0].sliceSpacingRegular: display-volume series must have regular slice spacing" in errors


def test_manifest_rejects_mpr_geometry_not_aligned_with_slice_axis() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "volumeStack",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 10, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0].firstIPP/lastIPP: slice axis must align with orientation normal for accurate MPR" in errors


def test_manifest_infers_projection_renderability_when_capability_omitted() -> None:
    manifest = fixture_manifest()
    manifest["series"][0].update(
        {
            "geometryKind": "projectionSet",
            "renderability": "volume",
        }
    )

    errors = validate_manifest_data(manifest)

    assert "series[0].renderability: expected 2d unless reconstructionCapability is display-volume" in errors


def test_manifest_accepts_projection_set_registry() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [
        {
            "id": "projection_set_1",
            "name": "DX projection pair",
            "sourceSeriesSlug": "sample",
            "modality": "DX",
            "projectionKind": "xray",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "requires-calibration",
            "renderability": "2d",
            "missingGeometry": ["projectionMatrices", "calibrationStatus"],
        }
    ]
    manifest["series"][0].update(
        {
            "geometryKind": "derivedVolume",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
            "sourceProjectionSetId": "projection_set_1",
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 1],
            "orientation": [1, 0, 0, 0, 1, 0],
        }
    )

    assert validate_manifest_data(manifest) == []


def test_manifest_accepts_calibrated_projection_registry_and_ultrasound_source() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [
        {
            "id": "projection_set_1",
            "name": "CBCT sweep",
            "sourceSeriesSlug": "sample_projection",
            "modality": "XA",
            "projectionKind": "cbct",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "reconstructed",
            "renderability": "2d",
            "calibrationStatus": "calibrated",
            "projectionMatrices": [[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0]]],
            "detectorPixels": [16, 16],
            "detectorSpacingMm": [1.0, 1.0],
            "frameOfReferenceUID": "1.2.for",
        }
    ]
    manifest["series"].append(
        {
            "slug": "us_source",
            "name": "Calibrated US",
            "description": "source",
            "modality": "US",
            "slices": 2,
            "width": 16,
            "height": 16,
            "pixelSpacing": [1.0, 1.0],
            "sliceThickness": 1.0,
            "hasBrain": False,
            "hasSeg": False,
            "hasRaw": False,
            "geometryKind": "ultrasoundSource",
            "reconstructionCapability": "requires-reconstruction",
            "renderability": "2d",
            "sourceSeriesUID": "1.2.us.source",
            "ultrasoundCalibration": {
                "status": "calibrated",
                "mode": "stacked-sector",
                "probeGeometry": "sector",
                "source": "external-json",
            },
        }
    )

    assert validate_manifest_data(manifest) == []


def test_manifest_validates_engine_report_shape() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["engineReport"] = {
        "backend": "parallel-fbp",
        "geometryModel": "parallel-beam-stack",
        "validation": "prototype",
    }

    assert validate_manifest_data(manifest) == []

    manifest["series"][0]["engineReport"] = {"backend": "", "validation": "fake"}
    errors = validate_manifest_data(manifest)
    assert "series[0].engineReport.backend: expected non-empty string" in errors
    assert "series[0].engineReport.validation: expected one of ['external-engine', 'prototype', 'reference-parity']" in errors


def test_manifest_rejects_bad_projection_set_registry() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [
        {
            "id": "../bad",
            "name": "Bad",
            "modality": "DX",
            "projectionKind": "fake",
            "projectionCount": 0,
            "reconstructionCapability": "display-volume",
            "reconstructionStatus": "reconstructed",
            "renderability": "volume",
            "missingGeometry": ["projectionMatrices"],
        }
    ]
    manifest["series"][0]["sourceProjectionSetId"] = "missing_projection_set"

    errors = validate_manifest_data(manifest)

    assert "projectionSets[0].id: expected safe projection set id" in errors
    assert "projectionSets[0].projectionKind: expected one of ['cbct', 'parallel-beam', 'tomosynthesis', 'unknown', 'xray']" in errors
    assert "projectionSets[0].reconstructionCapability: expected requires-reconstruction" in errors
    assert "projectionSets[0].renderability: expected 2d" in errors
    assert "projectionSets[0].projectionCount: expected positive integer" in errors
    assert "series[0].sourceProjectionSetId: unknown projection set id: missing_projection_set" in errors


def test_manifest_accepts_parallel_beam_projection_kind() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [
        {
            "id": "projection_set_1",
            "name": "Parallel beam source",
            "sourceSeriesSlug": "sample",
            "modality": "XA",
            "projectionKind": "parallel-beam",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "reconstructed",
            "renderability": "2d",
        }
    ]

    assert validate_manifest_data(manifest) == []


def test_manifest_rejects_calibrated_projection_set_missing_geometry_and_projection_registry_absence() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [
        {
            "id": "projection_set_1",
            "name": "Bad CBCT",
            "sourceSeriesSlug": "sample_projection",
            "modality": "XA",
            "projectionKind": "cbct",
            "projectionCount": 2,
            "reconstructionCapability": "requires-reconstruction",
            "reconstructionStatus": "reconstructed",
            "renderability": "2d",
            "calibrationStatus": "calibrated",
        }
    ]
    manifest["series"][0]["sourceProjectionSetId"] = "projection_set_1"
    errors = validate_manifest_data(manifest)
    assert "projectionSets[0].projectionMatrices: calibrated sets require one matrix per projection" in errors
    assert "projectionSets[0].detectorPixels: calibrated sets require positive [rows, cols]" in errors
    assert "projectionSets[0].detectorSpacingMm: calibrated sets require positive [row, col] spacing" in errors

    manifest = fixture_manifest()
    manifest["series"][0]["sourceProjectionSetId"] = "projection_set_1"
    errors = validate_manifest_data(manifest)
    assert "series[0].sourceProjectionSetId: projectionSets registry is required" in errors


def test_manifest_rejects_derived_binding_to_unknown_source_series() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["derivedObjectBindings"] = [
        {
            "derivedKind": "seg",
            "frameOfReferenceUID": "1.2.for",
            "sourceSeriesUID": "missing.source.series",
            "requiresRegistration": False,
            "affineCompatibility": "exact",
        }
    ]

    errors = validate_manifest_data(manifest)

    assert "series[0].derivedObjectBindings[0].sourceSeriesUID: unknown sourceSeriesUID: missing.source.series" in errors


def test_manifest_accepts_derived_binding_with_source_series_slug_fallback() -> None:
    manifest = fixture_manifest()
    manifest["series"].append(
        {
            "slug": "sample_source",
            "name": "Source",
            "description": "source",
            "slices": 2,
            "width": 32,
            "height": 32,
            "pixelSpacing": [1.0, 1.0],
            "sliceThickness": 1.0,
            "hasBrain": False,
            "hasSeg": False,
            "hasRaw": False,
            "sourceSeriesUID": "1.2.source",
            "frameOfReferenceUID": "1.2.for",
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 1],
            "orientation": [1, 0, 0, 0, 1, 0],
        }
    )
    manifest["series"][0]["derivedObjectBindings"] = [
        {
            "derivedKind": "seg",
            "frameOfReferenceUID": "1.2.for",
            "sourceSeriesSlug": "sample_source",
            "requiresRegistration": False,
            "affineCompatibility": "exact",
        }
    ]
    manifest["series"][0]["firstIPP"] = [0, 0, 0]
    manifest["series"][0]["lastIPP"] = [0, 0, 1]
    manifest["series"][0]["orientation"] = [1, 0, 0, 0, 1, 0]
    manifest["series"][0]["sliceSpacingRegular"] = True

    errors = validate_manifest_data(manifest)

    assert errors == []


def test_manifest_rejects_exact_binding_when_frame_of_reference_mismatches_source() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["frameOfReferenceUID"] = "1.2.derived"
    manifest["series"].append(
        {
            "slug": "source_series",
            "name": "Source Series",
            "description": "source",
            "slices": 2,
            "width": 32,
            "height": 32,
            "pixelSpacing": [1.0, 1.0],
            "sliceThickness": 1.0,
            "hasBrain": False,
            "hasSeg": False,
            "hasRaw": False,
            "sourceSeriesUID": "1.2.source",
            "frameOfReferenceUID": "1.2.source.for",
        }
    )
    manifest["series"][0]["derivedObjectBindings"] = [
        {
            "derivedKind": "seg",
            "frameOfReferenceUID": "1.2.derived",
            "sourceSeriesUID": "1.2.source",
            "requiresRegistration": False,
            "affineCompatibility": "exact",
        }
    ]

    errors = validate_manifest_data(manifest)

    assert "series[0].derivedObjectBindings[0].affineCompatibility: exact/within-tolerance bindings require matching FrameOfReferenceUID" in errors


def test_manifest_rejects_exact_binding_without_trustworthy_geometry() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["frameOfReferenceUID"] = "1.2.for"
    manifest["series"].append(
        {
            "slug": "source_series",
            "name": "Source Series",
            "description": "source",
            "slices": 2,
            "width": 32,
            "height": 32,
            "pixelSpacing": [1.0, 1.0],
            "sliceThickness": 1.0,
            "hasBrain": False,
            "hasSeg": False,
            "hasRaw": False,
            "sourceSeriesUID": "1.2.source",
            "frameOfReferenceUID": "1.2.for",
        }
    )
    manifest["series"][0]["derivedObjectBindings"] = [
        {
            "derivedKind": "seg",
            "frameOfReferenceUID": "1.2.for",
            "sourceSeriesUID": "1.2.source",
            "requiresRegistration": False,
            "affineCompatibility": "exact",
        }
    ]

    errors = validate_manifest_data(manifest)

    assert "series[0].derivedObjectBindings[0].affineCompatibility: exact/within-tolerance bindings require trustworthy geometry on source and derived series" in errors


def test_config_fixture_is_valid() -> None:
    assert validate_config_data(load_json(FIXTURES / "valid_config.json")) == []


def test_config_rejects_bad_feature_flags() -> None:
    config = load_json(FIXTURES / "valid_config.json")
    config["features"]["aiAnalysis"] = "false"

    errors = validate_config_data(config)

    assert "config.features.aiAnalysis: expected bool" in errors


def test_config_rejects_bad_trusted_upload_origins() -> None:
    config = load_json(FIXTURES / "valid_config.json")
    config["trustedUploadOrigins"] = "https://upload.example"

    errors = validate_config_data(config)

    assert "config.trustedUploadOrigins: expected string list" in errors


def test_config_rejects_browser_modal_auth_token() -> None:
    config = load_json(FIXTURES / "valid_config.json")
    config["modalAuthToken"] = "secret"

    errors = validate_config_data(config)

    assert "config.modalAuthToken: no longer supported; keep Modal auth server-side" in errors


# GeometryRecord field validation


def test_manifest_accepts_valid_geometry_record_fields() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["geometryRecordKind"] = "cartesian_volume"
    manifest["series"][0]["sliceSpacingRegular"] = True
    manifest["series"][0]["dimensions"] = {"width": 256, "height": 256, "depth": 10}
    manifest["series"][0]["spacingMm"] = {"row": 0.5, "col": 0.5, "slice": 1.0}
    manifest["series"][0]["sliceSpacingStatsMm"] = {"mean": 1.0, "min": 1.0, "max": 1.0, "regular": True}

    errors = validate_manifest_data(manifest)

    assert errors == []


def test_manifest_rejects_invalid_geometry_record_kind() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["geometryRecordKind"] = "magic_volume"

    errors = validate_manifest_data(manifest)

    assert any("geometryRecordKind" in e for e in errors)


def test_manifest_rejects_cartesian_volume_with_irregular_spacing() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["geometryRecordKind"] = "cartesian_volume"
    manifest["series"][0]["sliceSpacingRegular"] = False

    errors = validate_manifest_data(manifest)

    assert any("cartesian_volume requires regular slice spacing" in e for e in errors)


def test_manifest_rejects_negative_spacing_mm() -> None:
    manifest = fixture_manifest()
    manifest["series"][0]["spacingMm"] = {"row": -0.5, "col": 0.5, "slice": 1.0}

    errors = validate_manifest_data(manifest)

    assert any("spacingMm.row: expected positive number" in e for e in errors)
