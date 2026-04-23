from __future__ import annotations

from convert import upsert_series


def test_upsert_series_preserves_existing_non_mr_entries() -> None:
    manifest = {
        "patient": "anonymous",
        "studyDate": "2025-01-01",
        "projectionSets": [{"id": "projection_set_1"}],
        "series": [
            {"slug": "ct_existing", "name": "CT", "hasRaw": True},
            {"slug": "mr_existing", "name": "Old MR", "hasRaw": True, "group": 7, "source": "existing"},
        ],
    }
    updated = upsert_series(
        manifest,
        [{"slug": "mr_existing", "name": "New MR", "hasRaw": False, "studyDate": "2026-04-10"}],
        "2026-04-10",
    )

    assert updated["studyDate"] == "2025-01-01"
    assert updated["projectionSets"] == [{"id": "projection_set_1"}]
    assert [series["slug"] for series in updated["series"]] == ["ct_existing", "mr_existing"]
    assert updated["series"][1]["name"] == "New MR"
    assert updated["series"][1]["hasRaw"] is True
    assert updated["series"][1]["group"] == 7
    assert updated["series"][1]["source"] == "existing"
