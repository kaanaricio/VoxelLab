from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.merge_modal_result import infer_job_id, read_result_json, result_url
from series_contract import merge_manifest_path


def write_json(path: Path, data: dict) -> None:
    _ = path.write_text(json.dumps(data))


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


def test_read_result_json_accepts_local_file(tmp_path: Path) -> None:
    path = tmp_path / "series.json"
    write_json(path, modal_entry())

    assert read_result_json(str(path))["slug"] == "cloud_job12345"


def test_result_url_and_job_id_inference_round_trip() -> None:
    url = result_url("https://r2.example/", "job/with space")

    assert url == "https://r2.example/results/job%2Fwith%20space/series.json"
    assert infer_job_id(url) == "job/with space"


def test_merge_appends_without_dropping_existing_series(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    merged, action, index = merge_manifest_path(manifest_path, modal_entry(), job_id="job12345")

    assert action == "inserted"
    assert index == 1
    assert [series["slug"] for series in merged["series"]] == ["sample", "cloud_job12345"]
    assert merged["series"][1]["sourceJobId"] == "job12345"


def test_merge_accepts_modal_result_with_explicit_volume_reconstruction_fields(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    merged, action, index = merge_manifest_path(
        manifest_path,
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
    assert merged["series"][1]["geometryKind"] == "derivedVolume"
    assert merged["series"][1]["renderability"]["canMpr3D"] is True


def test_merge_updates_existing_series_by_slug(tmp_path: Path) -> None:
    manifest = fixture_manifest()
    manifest["series"].append(modal_entry(name="Old Name", sourceJobId="job12345"))
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, manifest)

    merged, action, index = merge_manifest_path(manifest_path, modal_entry(name="New Name"), job_id="job12345")

    assert action == "updated"
    assert index == 1
    assert len(merged["series"]) == 2
    assert merged["series"][1]["name"] == "New Name"


def test_merge_appends_new_series_when_only_source_series_uid_matches(tmp_path: Path) -> None:
    manifest = fixture_manifest()
    manifest["series"].append(modal_entry(slug="cloud_old", sourceSeriesUID="1.2.3"))
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, manifest)

    merged, action, index = merge_manifest_path(
        manifest_path,
        modal_entry(slug="cloud_new", sourceSeriesUID="1.2.3"),
        job_id="job99999",
    )

    assert action == "inserted"
    assert index == 2
    assert [series["slug"] for series in merged["series"]] == ["sample", "cloud_old", "cloud_new"]
    assert merged["series"][2]["sourceJobId"] == "job99999"


def test_merge_updates_existing_series_by_job_id(tmp_path: Path) -> None:
    manifest = fixture_manifest()
    manifest["series"].append(modal_entry(slug="cloud_old", sourceJobId="job12345"))
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, manifest)

    merged, action, index = merge_manifest_path(manifest_path, modal_entry(slug="cloud_new"), job_id="job12345")

    assert action == "updated"
    assert index == 1
    assert [series["slug"] for series in merged["series"]] == ["sample", "cloud_new"]


def test_merge_hydrates_region_urls_from_public_base(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    merged, action, index = merge_manifest_path(
        manifest_path,
        modal_entry(hasRegions=True),
        job_id="job12345",
        public_base="https://r2.example",
    )

    assert action == "inserted"
    assert merged["series"][index]["regionUrlBase"] == "https://r2.example/data/cloud_job12345_regions"
    assert merged["series"][index]["regionMetaUrl"] == "https://r2.example/data/cloud_job12345_regions.json"


def test_merge_backfills_canonical_compare_group_from_frame_of_reference(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    merged, action, index = merge_manifest_path(
        manifest_path,
        modal_entry(
            frameOfReferenceUID="1.2.840.same",
            firstIPP=[0, 0, 0],
            lastIPP=[0, 0, 1],
            orientation=[1, 0, 0, 0, 1, 0],
        ),
        job_id="job12345",
    )

    assert action == "inserted"
    assert merged["series"][index]["group"] == "for:1.2.840.same"


def test_merge_rejects_result_urls_outside_public_base(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    with pytest.raises(ValueError, match="expected origin https://r2.example"):
        _ = merge_manifest_path(
            manifest_path,
            modal_entry(rawUrl="https://evil.example/cloud_job12345.raw.zst"),
            public_base="https://r2.example",
        )


def test_merge_rejects_ambiguous_existing_matches(tmp_path: Path) -> None:
    manifest = fixture_manifest()
    manifest["series"].append(modal_entry(slug="cloud_same", sourceSeriesUID="1.2.3"))
    manifest["series"].append(modal_entry(slug="cloud_other", sourceJobId="job12345"))
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, manifest)

    with pytest.raises(ValueError, match="matches multiple manifest entries"):
        _ = merge_manifest_path(
            manifest_path,
            modal_entry(slug="cloud_same", sourceSeriesUID="9.9.9"),
            job_id="job12345",
        )


def test_merge_rejects_result_without_cloud_slice_urls(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())
    entry = modal_entry()
    del entry["sliceUrlBase"]

    with pytest.raises(ValueError, match="missing required field: sliceUrlBase"):
        _ = merge_manifest_path(manifest_path, entry)


def test_merge_rejects_projection_result_claiming_display_volume(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    write_json(manifest_path, fixture_manifest())

    with pytest.raises(ValueError, match="expected requires-reconstruction for geometryKind projectionSet"):
        _ = merge_manifest_path(
            manifest_path,
            modal_entry(
                geometryKind="projectionSet",
                reconstructionCapability="display-volume",
                renderability="volume",
            ),
        )
