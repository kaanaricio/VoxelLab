from __future__ import annotations

import json
from pathlib import Path

import engine_preflight
import pytest

import scripts.check_pipeline_ready as preflight
from scripts.check_pipeline_ready import has_candidate_files, manifest_series, parse_slugs, resolve_source, validate_ct_pipeline, validate_synthseg_pipeline

pytestmark = pytest.mark.filterwarnings("ignore:.*write_like_original.*:DeprecationWarning")


def test_resolve_source_prefers_cli_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_DICOM_ROOT", "/definitely/missing")

    assert resolve_source(str(tmp_path)) == tmp_path.resolve()


def test_candidate_files_ignore_sidecars(tmp_path: Path) -> None:
    _ = (tmp_path / "0000.png").write_bytes(b"not dicom")
    _ = (tmp_path / ".DS_Store").write_bytes(b"")

    assert not has_candidate_files(tmp_path)

    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")

    assert has_candidate_files(tmp_path)


def test_parse_slugs_rejects_unknown_values() -> None:
    try:
        _ = parse_slugs(["unknown_slug"], ["known_slug"], ["known_slug"])
    except ValueError as exc:
        assert "unknown_slug" in str(exc)
    else:
        raise AssertionError("expected parse_slugs to reject unknown slug")


def test_ct_preflight_reports_missing_source_folder(tmp_path: Path, monkeypatch) -> None:
    # Provide a manifest with a CT series that has sourceFolder
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(
        '{"series":[{"slug":"ct_test","modality":"CT","sourceFolder":"TestFolder"}]}'
    )
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    import pipeline_paths
    monkeypatch.setattr(pipeline_paths, "DATA", data)

    errors = validate_ct_pipeline(tmp_path, ["ct_test"])

    assert any("ct_test: no candidate DICOM files" in error for error in errors)


def test_synthseg_preflight_reports_missing_brain_stack(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text('{"series":[{"slug":"t2_tse"}]}')

    errors = validate_synthseg_pipeline(tmp_path, data, ["t2_tse"], tmp_path / "venv")

    assert any("t2_tse: no brain PNG stack" in error for error in errors)


def test_manifest_series_treats_invalid_json_as_missing(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    _ = manifest.write_text("{not json")

    assert manifest_series(manifest) == set()


def test_projection_preflight_requires_calibration_manifest(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")

    errors = preflight.validate_projection_source(tmp_path)

    assert any("missing calibration manifest" in error for error in errors)


def test_projection_preflight_reports_missing_rtk_runtime_for_cbct(tmp_path: Path, monkeypatch) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")
    _ = (tmp_path / "voxellab.source.json").write_text(json.dumps({
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.proj",
        "projection": {
            "geometryModel": "circular-cbct",
            "anglesDeg": [0],
            "outputShape": [8, 8, 4],
            "outputSpacingMm": [1, 1, 1],
            "firstIPP": [0, 0, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
            "frameOfReferenceUID": "1.2.for",
        },
    }))
    monkeypatch.setattr(engine_preflight, "configured_rtk_command", lambda: "")

    errors = preflight.validate_projection_source(tmp_path)

    assert any("missing RTK runtime" in error for error in errors)


def test_ultrasound_preflight_counts_multiframe_inputs(tmp_path: Path) -> None:
    pydicom = pytest.importorskip("pydicom")
    from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(tmp_path / "cine.dcm"), {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = SecondaryCaptureImageStorage
    dataset.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    dataset.SeriesInstanceUID = generate_uid()
    dataset.StudyInstanceUID = generate_uid()
    dataset.Modality = "US"
    dataset.NumberOfFrames = 2
    dataset.Rows = 2
    dataset.Columns = 2
    dataset.save_as(tmp_path / "cine.dcm", enforce_file_format=True)
    _ = (tmp_path / "voxellab.source.json").write_text(json.dumps({
        "sourceRecordVersion": 2,
        "sourceKind": "ultrasound",
        "seriesUID": str(dataset.SeriesInstanceUID),
        "ultrasound": {
            "mode": "tracked-freehand-sector",
            "probeGeometry": "sector",
            "thetaRangeDeg": [-30, 30],
            "radiusRangeMm": [0, 50],
            "outputShape": [8, 8, 2],
            "outputSpacingMm": [1, 1, 1],
            "firstIPP": [0, 0, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
            "frameOfReferenceUID": "1.2.us.for",
            "frameTransformsLps": [
                [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
                [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
            ],
        },
    }))

    errors = preflight.validate_ultrasound_source(tmp_path)

    assert errors == []
