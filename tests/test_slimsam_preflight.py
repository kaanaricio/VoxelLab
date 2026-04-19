from __future__ import annotations

import json
from pathlib import Path

from scripts.check_slimsam_ready import build_report, dependency_errors, series_report


def write_manifest(path: Path, slugs: list[str]) -> None:
    _ = path.write_text(json.dumps({"series": [{"slug": slug, "slices": 2} for slug in slugs]}))


def write_stack(data_dir: Path, slug: str, count: int = 2) -> None:
    folder = data_dir / slug
    folder.mkdir()
    for index in range(count):
        _ = (folder / f"{index:04d}.png").write_bytes(b"png-ish")


def write_sidecars(data_dir: Path, slug: str, slices: int = 2, total_bytes: int | None = None) -> None:
    total = total_bytes if total_bytes is not None else slices * 1 * 2 * 3 * 2
    meta = {
        "slug": slug,
        "slices": slices,
        "embed_dim": 1,
        "embed_h": 2,
        "embed_w": 3,
        "dtype": "float16",
        "total_bytes": total,
    }
    _ = (data_dir / f"{slug}_sam_meta.json").write_text(json.dumps(meta))
    _ = (data_dir / f"{slug}_sam_embed.bin").write_bytes(b"\0" * total)


def test_report_marks_complete_and_missing_sidecars(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    manifest = data / "manifest.json"
    write_manifest(manifest, ["ready", "missing"])
    write_stack(data, "ready")
    write_stack(data, "missing")
    write_sidecars(data, "ready")

    report = build_report(manifest, data, exists=lambda _: True)
    by_slug = {item["slug"]: item for item in report["series"]}

    assert report["ready_to_run"]
    assert by_slug["ready"]["complete"]
    assert not by_slug["ready"]["needs_embedding"]
    assert not by_slug["missing"]["complete"]
    assert by_slug["missing"]["needs_embedding"]


def test_needed_series_without_png_stack_blocks_embed_run(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    manifest = data / "manifest.json"
    write_manifest(manifest, ["missing"])

    report = build_report(manifest, data, exists=lambda _: True)

    assert not report["ready_to_run"]
    assert f"missing: no PNG stack in {data / 'missing'}" in report["prerequisite_errors"]
    assert not report["series"][0]["can_embed"]


def test_sidecar_size_mismatch_is_not_complete(tmp_path: Path) -> None:
    write_stack(tmp_path, "bad")
    write_sidecars(tmp_path, "bad", total_bytes=8)
    _ = (tmp_path / "bad_sam_embed.bin").write_bytes(b"\0" * 4)

    report = series_report(tmp_path, {"slug": "bad", "slices": 2})

    assert not report["complete"]
    assert "meta total_bytes 8 does not match expected 24" in report["errors"]
    assert "embed bin has 4 bytes; expected 24" in report["errors"]


def test_dependency_errors_use_package_names() -> None:
    errors = dependency_errors(exists=lambda module: module != "segment_anything")

    assert errors == ["missing Python module: segment-anything"]


def test_unknown_slug_is_a_prerequisite_error(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    manifest = data / "manifest.json"
    write_manifest(manifest, ["known"])

    report = build_report(manifest, data, slugs={"missing"}, exists=lambda _: True)

    assert not report["ready_to_run"]
    assert report["series"] == []
    assert "unknown slug: missing" in report["prerequisite_errors"]
