from __future__ import annotations

import json
import hashlib
import struct
import zipfile
from pathlib import Path

import scripts.install_demo_data as demo_install
from scripts.build_openneuro_lite_pack import update_catalog_checksum

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_header(width: int, height: int) -> bytes:
    return PNG_MAGIC + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x00\x00\x00\x00"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_resolve_selected_packs_expands_mode_and_extras() -> None:
    catalog = {
        "modes": {"lite": ["lite"]},
        "packs": [
            {"id": "lite"},
            {"id": "mri-source"},
            {"id": "ct-source"},
        ],
    }

    packs = demo_install.resolve_selected_packs(catalog, demo_mode="lite", include_mri=True, include_ct=True)

    assert [pack["id"] for pack in packs] == ["lite", "mri-source", "ct-source"]


def test_resolve_selected_packs_stably_dedupes_requested_ids() -> None:
    catalog = {
        "modes": {"lite": ["lite"]},
        "packs": [
            {"id": "lite"},
            {"id": "mri-source"},
        ],
    }

    packs = demo_install.resolve_selected_packs(
        catalog,
        demo_mode="lite",
        requested=["lite", "mri-source", "lite", "mri-source"],
    )

    assert [pack["id"] for pack in packs] == ["lite", "mri-source"]


def test_install_artifact_pack_extracts_data_and_merges_manifest(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    archive_path = pack_dir / "fixture.zip"
    with zipfile.ZipFile(archive_path, "w") as bundle:
        bundle.writestr(
            "manifest.json",
            json.dumps(
                {
                    "patient": "demo",
                    "studyDate": "",
                    "series": [
                        {
                            "slug": "sample",
                            "name": "Sample",
                            "description": "Fixture",
                            "slices": 2,
                            "width": 2,
                            "height": 1,
                            "pixelSpacing": [0.5, 0.5],
                            "sliceThickness": 1.0,
                            "hasBrain": False,
                            "hasSeg": False,
                            "hasRaw": False,
                            "hasRegions": False,
                            "hasStats": False,
                            "hasAnalysis": False,
                        }
                    ],
                }
            ),
        )
        bundle.writestr("sample/0000.png", png_header(2, 1))
        bundle.writestr("sample/0001.png", png_header(2, 1))

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(
        json.dumps(
            {
                "patient": "anonymous",
                "studyDate": "",
                "series": [{"slug": "existing", "name": "Existing", "description": "", "slices": 1, "width": 1, "height": 1, "pixelSpacing": [1, 1], "sliceThickness": 1, "hasBrain": False, "hasSeg": False, "hasRaw": False, "hasRegions": False, "hasStats": False, "hasAnalysis": False}],
            }
        ),
        encoding="utf-8",
    )

    result = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, data_dir)

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sample"]
    assert (data_dir / "sample" / "0000.png").is_file()
    assert [series["slug"] for series in manifest["series"]] == ["existing", "sample"]


def test_install_source_pack_copies_local_files_and_writes_notice(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    payload = b"fake"
    _ = (source / "scan.nii.gz").write_bytes(payload)

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(payload),
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    target = tmp_path / "demo_sources" / "openneuro_on01802"
    notice = json.loads((target / "PACK_INFO.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sub-ON01802/ses-01/anat/scan.nii.gz"]
    assert (target / "sub-ON01802" / "ses-01" / "anat" / "scan.nii.gz").read_bytes() == b"fake"
    assert notice["pack"] == "mri-source"


def test_install_artifact_pack_rejects_zip_members_that_escape_target(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    archive_path = pack_dir / "fixture.zip"
    with zipfile.ZipFile(archive_path, "w") as bundle:
        bundle.writestr("../escape.txt", b"boom")

    with __import__("pytest").raises(ValueError, match="escapes extraction root"):
        _ = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, tmp_path / "data")


def test_install_source_pack_requires_checksums(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"fake")

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="expected sha256 checksum"):
        _ = demo_install.install_source_pack(pack, tmp_path)


def test_series_zip_checksum_ignores_zip_wrapper_metadata(tmp_path: Path) -> None:
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"
    shared_payload = b"dicom-bytes"
    first_info = zipfile.ZipInfo("patient/IM0001.dcm")
    first_info.date_time = (2024, 1, 1, 0, 0, 0)
    second_info = zipfile.ZipInfo("patient/IM0001.dcm")
    second_info.date_time = (2025, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(first, "w") as bundle:
        bundle.writestr(first_info, shared_payload)
    with zipfile.ZipFile(second, "w") as bundle:
        bundle.writestr(second_info, shared_payload)

    assert demo_install.sha256_file(first) != demo_install.sha256_file(second)
    demo_install.verify_zip_contents_checksum(second, demo_install.sha256_zip_contents(first))


def test_update_catalog_checksum_sets_matching_archive_entry(tmp_path: Path) -> None:
    pack_path = tmp_path / "demo_packs" / "fixture.zip"
    pack_path.parent.mkdir()
    _ = pack_path.write_bytes(b"fixture")
    catalog_path = tmp_path / "demo_packs" / "catalog.json"
    _ = catalog_path.write_text(
        json.dumps(
            {
                "packs": [
                    {"id": "lite", "archive_path": "demo_packs/fixture.zip", "checksum": ""},
                    {"id": "other", "archive_path": "demo_packs/other.zip", "checksum": ""},
                ]
            }
        ),
        encoding="utf-8",
    )

    update_catalog_checksum(pack_path, catalog_path)

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert len(catalog["packs"][0]["checksum"]) == 64
    assert catalog["packs"][1]["checksum"] == ""
