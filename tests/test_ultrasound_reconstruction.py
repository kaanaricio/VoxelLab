from __future__ import annotations

import numpy as np
from scipy import ndimage

from ultrasound_reconstruction import reconstruct_ultrasound_volume


class FakeUltrasound:
    def __init__(self, pixel_array):
        self.pixel_array = pixel_array
        self.SeriesInstanceUID = "1.2.us.series"
        self.Modality = "US"


def test_reconstruct_ultrasound_volume_scan_converts_calibrated_sector_stack():
    rows = cols = 32
    frame_a = np.zeros((rows, cols), dtype=np.float32)
    frame_b = np.zeros((rows, cols), dtype=np.float32)
    frame_a[8:24, 10:22] = 1.0
    frame_b[12:28, 12:24] = 1.0
    ds = FakeUltrasound(np.stack([frame_a, frame_b], axis=0))

    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "ultrasound",
        "seriesUID": "1.2.us.series",
        "ultrasound": {
            "mode": "stacked-sector",
            "probeGeometry": "sector",
            "profileId": "stacked-sector-default",
            "thetaRangeDeg": [-35.0, 35.0],
            "radiusRangeMm": [0.0, 60.0],
            "outputShape": [32, 32, 2],
            "outputSpacingMm": [1.0, 1.0, 2.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.us.for",
        },
    }

    result = reconstruct_ultrasound_volume([ds], manifest, np, ndimage)

    assert result["volume"].shape == (2, 32, 32)
    assert float(result["volume"].max()) > 0.0
    assert result["geometry"]["frameOfReferenceUID"] == "1.2.us.for"
    assert result["geometry"]["sliceSpacingRegular"] is True
    assert result["report"]["backend"] == "sector-scan-conversion"
    assert result["report"]["profileId"] == "stacked-sector-default"
