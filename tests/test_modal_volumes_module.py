from __future__ import annotations

import numpy as np

from modal_volumes import build_derived_volume_entry, normalize_volume_for_pngs, normalize_volume_for_raw


def test_modal_volumes_normalization_and_entry_urls():
    vol = np.array([[-1000.0, 0.0, 1000.0]], dtype=np.float32)
    pngs = normalize_volume_for_pngs(vol, "CT", np)
    raw = normalize_volume_for_raw(vol, "CT", np)
    entry = build_derived_volume_entry(
        slug="cloud_proj_123",
        name="Projection reconstruction",
        description="3 slices",
        modality="CT",
        width=16,
        height=16,
        depth=3,
        geometry={
            "pixelSpacing": [1, 1],
            "sliceThickness": 1.0,
            "sliceSpacing": 1.0,
            "sliceSpacingRegular": True,
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 2],
            "orientation": [1, 0, 0, 0, 1, 0],
        },
        public_url="https://cdn.example",
        source_projection_set_id="proj-1",
    )

    assert pngs.dtype == np.uint8
    assert raw.min() >= 0 and raw.max() <= 1
    assert entry["sourceProjectionSetId"] == "proj-1"
    assert entry["sliceUrlBase"] == "https://cdn.example/data/cloud_proj_123"
    assert entry["rawUrl"] == "https://cdn.example/cloud_proj_123.raw.zst"
