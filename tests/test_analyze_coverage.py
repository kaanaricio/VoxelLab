from __future__ import annotations

import json
from pathlib import Path

import analyze


def write_png(path: Path) -> None:
    _ = path.write_bytes(b"".join([
        b"\x89PNG\r\n\x1a\n",
        b"\x00\x00\x00\rIHDR",
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x00\x00\x00\x00",
        b"\x3a\x7e\x9b\x55",
        b"\x00\x00\x00\x0aIDATx\x9cc`\x00\x00\x00\x02\x00\x01",
        b"\xe2!\xbc3",
        b"\x00\x00\x00\x00IEND\xaeB`\x82",
    ]))


def test_process_keeps_partial_slice_runs_out_of_full_coverage(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    series_dir = data_dir / "sample"
    series_dir.mkdir(parents=True)
    for index in range(5):
        write_png(series_dir / f"{index:04d}.png")

    monkeypatch.setattr(analyze, "DATA", data_dir)
    monkeypatch.setattr(
        analyze,
        "analyze_slice",
        lambda series_name, slice_idx, png_path, model, **kwargs: {"slice": slice_idx, "severity": "note", "text": png_path.name},
    )
    monkeypatch.setattr(analyze, "summarize", lambda slug, series_name, findings, model, provider=None: "summary")

    complete = analyze.process(
        "sample",
        {"name": "Sample", "slices": 5},
        "test-model",
        selected_slices=[2],
        sample_count=3,
    )

    written = json.loads((data_dir / "sample_analysis.json").read_text())
    assert complete is False
    assert written["coverage"]["overviewSlices"] == [0, 2, 4]
    assert written["coverage"]["analyzedSlices"] == [2]
    assert written["coverage"]["isComplete"] is False


def test_process_marks_full_overview_complete_once_all_overview_slices_exist(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    series_dir = data_dir / "sample"
    series_dir.mkdir(parents=True)
    for index in range(5):
        write_png(series_dir / f"{index:04d}.png")

    monkeypatch.setattr(analyze, "DATA", data_dir)
    monkeypatch.setattr(
        analyze,
        "analyze_slice",
        lambda series_name, slice_idx, png_path, model, **kwargs: {"slice": slice_idx, "severity": "note", "text": png_path.name},
    )
    monkeypatch.setattr(analyze, "summarize", lambda slug, series_name, findings, model, provider=None: "summary")

    complete = analyze.process(
        "sample",
        {"name": "Sample", "slices": 5},
        "test-model",
        sample_count=3,
    )

    written = json.loads((data_dir / "sample_analysis.json").read_text())
    assert complete is True
    assert written["coverage"]["overviewSlices"] == [0, 2, 4]
    assert written["coverage"]["isComplete"] is True


def test_process_keeps_selected_overview_subset_partial(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    series_dir = data_dir / "sample"
    series_dir.mkdir(parents=True)
    for index in range(5):
        write_png(series_dir / f"{index:04d}.png")

    monkeypatch.setattr(analyze, "DATA", data_dir)
    monkeypatch.setattr(
        analyze,
        "analyze_slice",
        lambda series_name, slice_idx, png_path, model, **kwargs: {"slice": slice_idx, "severity": "note", "text": png_path.name},
    )
    monkeypatch.setattr(analyze, "summarize", lambda slug, series_name, findings, model, provider=None: "summary")

    complete = analyze.process(
        "sample",
        {"name": "Sample", "slices": 5},
        "test-model",
        selected_slices=[0, 2, 4],
        sample_count=3,
    )

    written = json.loads((data_dir / "sample_analysis.json").read_text())
    assert complete is False
    assert written["coverage"]["overviewSlices"] == [0, 2, 4]
    assert written["coverage"]["analyzedSlices"] == [0, 2, 4]
    assert written["coverage"]["isComplete"] is False


def test_build_analysis_prompt_marks_context_as_approximate() -> None:
    prompt, labels, fingerprint = analyze.build_analysis_prompt(
        {"name": "Sample", "slices": 2},
        1,
        {
            "index": 1,
            "centerMm": [1.0, 2.0, 3.0],
            "intensity": {"source": "base_png", "units": "display_uint8", "mean": 12.0},
            "regions": [{"label": 3, "name": "L lateral ventricle", "areaPx": 10}],
            "symmetry": {"score": 4.2, "rankWithinSeries": 0.5},
        },
    )

    assert "Approximate derived context" in prompt
    assert "display_uint8" in prompt
    assert "pipeline-derived" in prompt
    assert labels == {3}
    assert fingerprint


def test_analyze_slice_filters_unprompted_region_labels(monkeypatch) -> None:
    monkeypatch.setattr(
        analyze,
        "call_ai",
        lambda prompt, schema, model, provider, images=None, timeout=180: {
            "severity": "note",
            "text": "Educational observation.",
            "regions_referenced": [3, 999, 3],
        },
    )

    finding = analyze.analyze_slice(
        "Sample",
        0,
        Path("data/sample/0000.png"),
        "test-model",
        provider="codex",
        series_meta={"name": "Sample", "slices": 1},
        context={
            "slices": [{
                "index": 0,
                "regions": [{"label": 3, "name": "Known", "areaPx": 1}],
                "intensity": {"source": "base_png", "units": "display_uint8", "mean": 1.0},
            }],
        },
    )

    assert finding["regions_referenced"] == [3]
    assert "contextFingerprint" in finding
