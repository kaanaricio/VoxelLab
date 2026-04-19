from __future__ import annotations

import json
from pathlib import Path

import pytest

import ask


def test_ask_rejects_coordinates_outside_series_bounds(monkeypatch, tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(json.dumps({
        "series": [{
            "slug": "t2_tse",
            "slices": 2,
            "width": 4,
            "height": 4,
        }],
    }))
    monkeypatch.setattr(ask, "DATA", data)

    with pytest.raises(ValueError, match="coordinates out of range"):
        _ = ask.ask("t2_tse", 0, "what is this?", x=5, y=1)


def test_ask_rejects_invalid_slug_before_path_construction(monkeypatch, tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(json.dumps({"series": []}))
    monkeypatch.setattr(ask, "DATA", data)

    with pytest.raises(ValueError, match="invalid slug"):
        _ = ask.ask("../etc", 0, "what is this?", x=0, y=0)


def test_ask_cache_requires_matching_context_fingerprint() -> None:
    data = {
        "entries": [
            {"key": "0:0:0:abc", "answer": "old context-free answer"},
            {"key": "0:0:0:abc", "contextFingerprint": "ctx1", "answer": "context answer"},
        ],
    }

    assert ask._cached_ask(data, "0:0:0:abc", None)["answer"] == "old context-free answer"
    assert ask._cached_ask(data, "0:0:0:abc", "ctx1")["answer"] == "context answer"
    assert ask._cached_ask(data, "0:0:0:abc", "ctx2") is None


def test_build_ask_prompt_includes_approximate_point_context() -> None:
    prompt = ask.build_ask_prompt(
        crop_path=Path("data/sample_asks/crop.png"),
        slice_png=Path("data/sample/0000.png"),
        slug="sample",
        slice_idx=0,
        width=2,
        height=2,
        x=1,
        y=1,
        question="what is this?",
        point_context_text="Approximate point context:\n- Region: label 7; approximate.",
    )

    assert "Approximate point context" in prompt
    assert "approximate" in prompt
    assert "Do not diagnose" in prompt


def test_ask_bypasses_context_free_cache_when_valid_context_exists(monkeypatch, tmp_path: Path) -> None:
    Image = pytest.importorskip("PIL.Image")

    data = tmp_path / "data"
    data.mkdir()
    (data / "sample").mkdir()
    (data / "sample_seg").mkdir()
    (data / "sample_regions").mkdir()
    Image.new("L", (2, 2), 100).save(data / "sample" / "0000.png")
    Image.new("L", (2, 2), 1).save(data / "sample_seg" / "0000.png")
    Image.new("L", (2, 2), 7).save(data / "sample_regions" / "0000.png")
    _ = (data / "manifest.json").write_text(json.dumps({
        "series": [{
            "slug": "sample",
            "slices": 1,
            "width": 2,
            "height": 2,
            "pixelSpacing": [1.0, 1.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "lastIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "hasContext": True,
        }],
    }))
    _ = (data / "sample_context.json").write_text(json.dumps({
        "slug": "sample",
        "version": 1,
        "slices": [{
            "index": 0,
            "centerMm": [0.5, 0.5, 0.0],
            "intensity": {"source": "base_png", "units": "display_uint8", "mean": 100.0},
            "regions": [{"label": 7, "name": "Approx region", "areaPx": 4, "areaMm2": 4.0}],
        }],
    }))
    key = ask._ask_key(0, 1, 1, "what is this?")
    _ = (data / "sample_asks.json").write_text(json.dumps({
        "slug": "sample",
        "entries": [{"key": key, "answer": "stale"}],
    }))
    prompts = []
    monkeypatch.setattr(ask, "DATA", data)
    monkeypatch.setattr(ask, "ROOT", tmp_path)
    monkeypatch.setattr(ask, "require_provider_ready", lambda provider=None: {"provider": provider or "claude", "ready": True})
    monkeypatch.setattr(
        ask,
        "_call_ai",
        lambda prompt, system, schema, model="test", provider=None, images=None, timeout=240: prompts.append(prompt) or {"answer": "fresh"},
    )

    result = ask.ask("sample", 0, "what is this?", x=1, y=1, model="test", provider="codex")

    assert result["cached"] is False
    assert result["answer"] == "fresh"
    assert result["contextFingerprint"]
    assert "Approx region" in prompts[0]
