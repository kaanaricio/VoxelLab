from __future__ import annotations

import json
import struct
from pathlib import Path

from series_contract import load_json
from scripts.check_assets import validate_assets

FIXTURES = Path(__file__).parent / "fixtures" / "manifest"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_header(width: int, height: int) -> bytes:
    return PNG_MAGIC + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x00\x00\x00\x00"


def fixture_manifest() -> dict:
    return load_json(FIXTURES / "valid_manifest.json")


def write_stack(root: Path, name: str, count: int, width: int = 2, height: int = 1) -> None:
    folder = root / name
    folder.mkdir(parents=True)
    for index in range(count):
        _ = (folder / f"{index:04d}.png").write_bytes(png_header(width, height))


def write_complete_fixture(root: Path) -> None:
    write_stack(root, "sample", 2)
    write_stack(root, "sample_seg", 2)
    write_stack(root, "sample_regions", 2)
    _ = (root / "sample_regions.json").write_text("{}")


def write_context_sidecar(root: Path, slug: str, slices: int) -> None:
    payload = {"slug": slug, "version": 1, "slices": [{"index": index} for index in range(slices)]}
    _ = (root / f"{slug}_context.json").write_text(json.dumps(payload))


def test_asset_fixture_validates_exhaustively(tmp_path: Path) -> None:
    write_complete_fixture(tmp_path)

    assert validate_assets(fixture_manifest(), tmp_path, exhaustive=True) == []


def test_assets_allow_empty_public_export(tmp_path: Path) -> None:
    manifest = {"patient": "anonymous", "studyDate": "", "series": []}

    assert validate_assets(manifest, tmp_path, exhaustive=True) == []


def test_assets_reject_base_stack_count_mismatch(tmp_path: Path) -> None:
    write_stack(tmp_path, "sample", 1)
    write_stack(tmp_path, "sample_seg", 2)
    write_stack(tmp_path, "sample_regions", 2)
    _ = (tmp_path / "sample_regions.json").write_text("{}")

    errors = validate_assets(fixture_manifest(), tmp_path, exhaustive=True)

    assert "sample: stack has 1 PNGs; expected 2" in errors
    assert "sample: missing PNGs: 0001.png" in errors


def test_assets_reject_overlay_stack_count_mismatch(tmp_path: Path) -> None:
    write_stack(tmp_path, "sample", 2)
    write_stack(tmp_path, "sample_seg", 1)
    write_stack(tmp_path, "sample_regions", 2)
    _ = (tmp_path / "sample_regions.json").write_text("{}")

    errors = validate_assets(fixture_manifest(), tmp_path, exhaustive=True)

    assert "sample_seg: stack has 1 PNGs; expected 2" in errors


def test_assets_reject_bad_png_dimensions(tmp_path: Path) -> None:
    write_complete_fixture(tmp_path)
    _ = (tmp_path / "sample" / "0001.png").write_bytes(png_header(3, 1))

    errors = validate_assets(fixture_manifest(), tmp_path, exhaustive=True)

    assert "sample/0001.png: dimensions 3x1; expected 2x1" in errors


def test_assets_reject_missing_regions_sidecar(tmp_path: Path) -> None:
    write_stack(tmp_path, "sample", 2)
    write_stack(tmp_path, "sample_seg", 2)
    write_stack(tmp_path, "sample_regions", 2)

    errors = validate_assets(fixture_manifest(), tmp_path, exhaustive=True)

    assert "sample: missing sidecar sample_regions.json" in errors


def test_assets_reject_missing_context_sidecar_when_enabled(tmp_path: Path) -> None:
    write_complete_fixture(tmp_path)
    manifest = fixture_manifest()
    manifest["series"][0]["hasContext"] = True

    errors = validate_assets(manifest, tmp_path, exhaustive=True)

    assert "sample: missing sidecar sample_context.json" in errors


def test_assets_accept_valid_context_sidecar_when_enabled(tmp_path: Path) -> None:
    write_complete_fixture(tmp_path)
    manifest = fixture_manifest()
    series = manifest["series"][0]
    series["hasContext"] = True
    write_context_sidecar(tmp_path, "sample", series["slices"])

    assert validate_assets(manifest, tmp_path, exhaustive=True) == []


def test_assets_allow_remote_modal_series_without_local_pngs(tmp_path: Path) -> None:
    manifest = fixture_manifest()
    series = manifest["series"][0]
    series["sliceUrlBase"] = "https://r2.example/data/sample"
    series["hasSeg"] = False
    series["hasRegions"] = True
    series["regionUrlBase"] = "https://r2.example/data/sample_regions"
    series["regionMetaUrl"] = "https://r2.example/data/sample_regions.json"

    assert validate_assets(manifest, tmp_path, exhaustive=True) == []
