from __future__ import annotations

from pathlib import Path

import pytest

from scripts.submit_modal_study import (
    candidate_files,
    chunks,
    modal_endpoint,
    normalize_series_entry,
    submit_preflight_errors,
    start_processing_payload,
    submit,
    trusted_upload_origins,
    upload_content_type,
    upload_items,
    validate_upload_url,
)


def test_modal_endpoint_derives_function_urls_from_app_prefix() -> None:
    url = modal_endpoint("https://example-org--medical-imaging-pipeline", "get_upload_urls")

    assert url == "https://example-org--medical-imaging-pipeline-get-upload-urls.modal.run"


def test_modal_endpoint_accepts_existing_function_url() -> None:
    base = "https://example-org--medical-imaging-pipeline-check-status.modal.run"

    assert modal_endpoint(base, "start_processing").endswith("-start-processing.modal.run")


def test_candidate_files_skip_sidecars(tmp_path: Path) -> None:
    _ = (tmp_path / "1.dcm").write_bytes(b"x")
    _ = (tmp_path / "2.jpg").write_bytes(b"x")
    _ = (tmp_path / "voxellab.source.json").write_text("{}")
    _ = (tmp_path / ".DS_Store").write_bytes(b"x")

    assert [path.name for path in candidate_files(tmp_path)] == ["1.dcm", "voxellab.source.json"]


def test_chunks_batches_values() -> None:
    assert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]


def test_upload_items_assign_unique_ids_for_duplicate_basenames() -> None:
    items = upload_items([Path("/a/IM0001"), Path("/b/IM0001")], start_index=7)

    assert items == [
        {"upload_id": "f000007", "filename": "IM0001", "path": Path("/a/IM0001")},
        {"upload_id": "f000008", "filename": "IM0001", "path": Path("/b/IM0001")},
    ]


def test_upload_content_type_matches_presign_contract() -> None:
    assert upload_content_type(Path("/tmp/scan.dcm")) == "application/dicom"
    assert upload_content_type(Path("/tmp/voxellab.source.json")) == "application/json"


def test_start_processing_payload_includes_projection_reconstruction_contract() -> None:
    assert start_processing_payload(
        "job123",
        "auto",
        "projection_set_reconstruction",
        "calibrated_projection_set",
        4096,
    ) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "projection_set_reconstruction",
        "input_kind": "calibrated_projection_set",
        "total_upload_bytes": 4096,
    }


def test_start_processing_payload_includes_ultrasound_scan_conversion_contract() -> None:
    assert start_processing_payload(
        "job123",
        "auto",
        "ultrasound_scan_conversion",
        "calibrated_ultrasound_source",
        2048,
    ) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "ultrasound_scan_conversion",
        "input_kind": "calibrated_ultrasound_source",
        "total_upload_bytes": 2048,
    }


def test_normalize_series_entry_backfills_public_urls() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRaw": True}, "https://r2.example")

    assert entry == {
        "slug": "cloud_job123",
        "hasRaw": True,
        "sliceUrlBase": "https://r2.example/data/cloud_job123",
        "rawUrl": "https://r2.example/cloud_job123.raw.zst",
    }


def test_normalize_series_entry_backfills_region_urls() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRegions": True}, "https://r2.example")

    assert entry["regionUrlBase"] == "https://r2.example/data/cloud_job123_regions"
    assert entry["regionMetaUrl"] == "https://r2.example/data/cloud_job123_regions.json"


def test_validate_upload_url_rejects_untrusted_origin() -> None:
    with pytest.raises(RuntimeError, match="trusted origins"):
        _ = validate_upload_url("https://evil.example/upload", ["https://r2.example"])


def test_trusted_upload_origins_merge_r2_and_explicit_hosts() -> None:
    assert trusted_upload_origins("https://r2.example/base", ["https://upload.example", "https://r2.example"]) == [
        "https://r2.example",
        "https://upload.example",
    ]


def test_submit_requires_modal_base_when_config_and_env_are_blank(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 8,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 1,
    })()

    monkeypatch.delenv("MODAL_WEBHOOK_BASE", raising=False)
    monkeypatch.delenv("MODAL_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("R2_PUBLIC_URL", raising=False)
    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {})
    with pytest.raises(SystemExit, match="missing MODAL_WEBHOOK_BASE"):
        _ = submit(args)


def test_submit_requires_modal_auth_token_when_base_exists(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://modal.example", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 8,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 1,
    })()

    monkeypatch.delenv("MODAL_AUTH_TOKEN", raising=False)
    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {})
    with pytest.raises(SystemExit, match="missing MODAL_AUTH_TOKEN"):
        _ = submit(args)


def test_submit_preflight_errors_validate_projection_sources(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"x")

    errors = submit_preflight_errors(tmp_path, "projection_set_reconstruction", False)

    assert any("missing calibration manifest" in error for error in errors)


def test_submit_skips_advanced_preflight_when_skip_upload(tmp_path: Path) -> None:
    assert submit_preflight_errors(tmp_path, "projection_set_reconstruction", True) == []


def test_submit_rejects_invalid_input_kind_before_network(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://modal.example", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "projection_set_reconstruction",
        "input_kind": "dicom_volume_stack",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 8,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 1,
    })()

    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {"MODAL_AUTH_TOKEN": "token"})
    with pytest.raises(SystemExit, match="projection_set_reconstruction requires --input-kind calibrated_projection_set"):
        _ = submit(args)
