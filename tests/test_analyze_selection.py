from __future__ import annotations

import json

import pytest

import analyze
from analyze import parse_slice_spec, representative_slice_ids


def test_representative_slice_ids_are_bounded_and_evenly_spaced() -> None:
    assert representative_slice_ids(27, 5) == [0, 6, 13, 20, 26]
    assert representative_slice_ids(3, 5) == [0, 1, 2]


def test_parse_slice_spec_accepts_ids_and_ranges() -> None:
    assert parse_slice_spec("0, 3-5, 3", 10) == [0, 3, 4, 5]


def test_parse_slice_spec_rejects_out_of_range_values() -> None:
    with pytest.raises(ValueError, match="slice out of range"):
        _ = parse_slice_spec("0,10", 10)


def test_update_manifest_rejects_invalid_slug(tmp_path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "manifest.json").write_text(json.dumps({"patient": "anonymous", "studyDate": "", "series": []}))
    monkeypatch.setattr(analyze, "DATA", data_dir)

    with pytest.raises(ValueError, match="invalid slug"):
        analyze.update_manifest(["../bad"])
