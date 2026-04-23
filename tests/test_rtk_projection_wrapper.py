from __future__ import annotations

import json
import subprocess
import sys
import warnings
from pathlib import Path

import numpy as np
import pytest

pytestmark = pytest.mark.filterwarnings("ignore:.*__module__ attribute.*:DeprecationWarning")


def test_rtk_projection_wrapper_smoke(tmp_path: Path) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        itk = pytest.importorskip("itk")
        from itk import RTK as rtk

    geometry = rtk.ThreeDCircularProjectionGeometry.New()
    geometry.AddProjection(600.0, 1200.0, 0.0)
    geometry.AddProjection(600.0, 1200.0, 90.0)
    matrices = [itk.array_from_matrix(geometry.GetMatrix(index)).tolist() for index in range(2)]

    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.projection.series",
        "projectionMatrices": matrices,
        "projection": {
            "geometryModel": "circular-cbct",
            "anglesDeg": [0.0, 90.0],
            "outputShape": [8, 8, 4],
            "outputSpacingMm": [1.0, 1.0, 1.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.for",
            "detectorSpacingMm": [1.0, 1.0],
        },
    }
    manifest_path = tmp_path / "manifest.json"
    projections_path = tmp_path / "projections.npy"
    output_path = tmp_path / "output.json"
    _ = manifest_path.write_text(json.dumps(manifest, indent=2))
    np.save(projections_path, np.zeros((2, 8, 8), dtype=np.float32))

    _ = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parent.parent / "scripts" / "rtk_projection_wrapper.py"),
            "--input-manifest",
            str(manifest_path),
            "--projections",
            str(projections_path),
            "--output-json",
            str(output_path),
        ],
        check=True,
        timeout=120,
        capture_output=True,
        text=True,
    )

    payload = json.loads(output_path.read_text())
    volume = np.load(output_path.with_name(payload["volumePath"]), allow_pickle=False)
    assert volume.shape == (4, 8, 8)
    assert payload["report"]["backend"] == "itk-rtk-fdk-cpu"
    assert payload["report"]["runtime"] == "itk-rtk"
    assert isinstance(payload["report"]["fieldOfViewApplied"], bool)
