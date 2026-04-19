from __future__ import annotations

import importlib.metadata
import os
import sys
from pathlib import Path

import numpy as np

from projection_reconstruction import reconstruct_projection_volume
from projection_rtk import configured_rtk_command
from scripts import rtk_projection_wrapper


class FakeProjection:
    def __init__(self, pixel_array, instance: int):
        self.pixel_array = pixel_array
        self.SeriesInstanceUID = "1.2.projection.series"
        self.StudyInstanceUID = "1.2.study"
        self.Modality = "XA"
        self.InstanceNumber = instance


def circular_manifest() -> dict:
    return {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.projection.series",
        "name": "Calibrated CBCT",
        "projectionSetId": "projection_set_1",
        "projection": {
            "geometryModel": "circular-cbct",
            "anglesDeg": [0, 90],
            "outputShape": [8, 8, 3],
            "outputSpacingMm": [1.0, 1.0, 1.5],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.for",
        },
    }


def fake_datasets() -> list[FakeProjection]:
    pixels = np.arange(16, dtype=np.float32).reshape(4, 4)
    return [FakeProjection(pixels, 1), FakeProjection(pixels + 1, 2)]


def test_reconstruct_projection_volume_accepts_external_wrapper(tmp_path: Path) -> None:
    wrapper = tmp_path / "rtk_wrapper.py"
    _ = wrapper.write_text(
        """import argparse, json, numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--input-manifest')
parser.add_argument('--projections')
parser.add_argument('--output-json')
args = parser.parse_args()
stack = np.load(args.projections, allow_pickle=False)
volume = np.full((3, 8, 8), float(stack.mean()), dtype=np.float32)
volume_path = str((__import__('pathlib').Path(args.output_json).parent / 'volume.npy'))
np.save(volume_path, volume)
payload = {
    'volumePath': volume_path,
    'geometry': {'lastIPP': [0.0, 0.0, 3.0]},
    'projectionSet': {'projectionKind': 'cbct'},
    'report': {'backend': 'rtk-wrapper', 'validation': 'reference-parity'},
}
open(args.output_json, 'w').write(json.dumps(payload))
"""
    )
    previous = os.environ.get("MRI_VIEWER_RTK_COMMAND")
    os.environ["MRI_VIEWER_RTK_COMMAND"] = f"{sys.executable} {wrapper}"
    try:
        result = reconstruct_projection_volume(fake_datasets(), circular_manifest(), np)
    finally:
        if previous is None:
            _ = os.environ.pop("MRI_VIEWER_RTK_COMMAND", None)
        else:
            os.environ["MRI_VIEWER_RTK_COMMAND"] = previous

    assert result["volume"].shape == (3, 8, 8)
    assert float(result["volume"][1, 1, 1]) > 0
    assert result["geometry"]["lastIPP"] == [0.0, 0.0, 3.0]
    assert result["projectionSet"]["projectionKind"] == "cbct"
    assert result["report"]["backend"] == "rtk-wrapper"
    assert result["report"]["geometryModel"] == "circular-cbct"
    assert result["report"]["validation"] == "reference-parity"


def test_reconstruct_projection_volume_preserves_oriented_last_ipp_defaults(tmp_path: Path) -> None:
    wrapper = tmp_path / "rtk_wrapper_default_geometry.py"
    _ = wrapper.write_text(
        """import argparse, json, numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--input-manifest')
parser.add_argument('--projections')
parser.add_argument('--output-json')
args = parser.parse_args()
volume_path = str((__import__('pathlib').Path(args.output_json).parent / 'volume.npy'))
np.save(volume_path, np.ones((3, 8, 8), dtype=np.float32))
open(args.output_json, 'w').write(json.dumps({'volumePath': volume_path}))
"""
    )
    manifest = circular_manifest()
    manifest["projection"]["orientation"] = [0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    previous = os.environ.get("MRI_VIEWER_RTK_COMMAND")
    os.environ["MRI_VIEWER_RTK_COMMAND"] = f"{sys.executable} {wrapper}"
    try:
        result = reconstruct_projection_volume(fake_datasets(), manifest, np)
    finally:
        if previous is None:
            _ = os.environ.pop("MRI_VIEWER_RTK_COMMAND", None)
        else:
            os.environ["MRI_VIEWER_RTK_COMMAND"] = previous

    assert result["geometry"]["lastIPP"] == [3.0, 0.0, 0.0]


def test_reconstruct_projection_volume_reports_wrapper_failure(tmp_path: Path) -> None:
    wrapper = tmp_path / "rtk_wrapper_fail.py"
    _ = wrapper.write_text("import sys\nsys.stderr.write('wrapper boom')\nraise SystemExit(2)\n")
    previous = os.environ.get("MRI_VIEWER_RTK_COMMAND")
    os.environ["MRI_VIEWER_RTK_COMMAND"] = f"{sys.executable} {wrapper}"
    try:
        try:
            _ = reconstruct_projection_volume(fake_datasets(), circular_manifest(), np)
        except RuntimeError as exc:
            assert "wrapper failed" in str(exc)
            assert "wrapper boom" in str(exc)
        else:
            raise AssertionError("expected wrapper failure")
    finally:
        if previous is None:
            _ = os.environ.pop("MRI_VIEWER_RTK_COMMAND", None)
        else:
            os.environ["MRI_VIEWER_RTK_COMMAND"] = previous


def test_reconstruct_projection_volume_clamps_invalid_wrapper_validation(tmp_path: Path) -> None:
    wrapper = tmp_path / "rtk_wrapper_bad_validation.py"
    _ = wrapper.write_text(
        """import argparse, json, numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--input-manifest')
parser.add_argument('--projections')
parser.add_argument('--output-json')
args = parser.parse_args()
volume_path = str((__import__('pathlib').Path(args.output_json).parent / 'volume.npy'))
np.save(volume_path, np.ones((3, 8, 8), dtype=np.float32))
open(args.output_json, 'w').write(json.dumps({'volumePath': volume_path, 'report': {'validation': 'totally-made-up'}}))
"""
    )
    previous = os.environ.get("MRI_VIEWER_RTK_COMMAND")
    os.environ["MRI_VIEWER_RTK_COMMAND"] = f"{sys.executable} {wrapper}"
    try:
        result = reconstruct_projection_volume(fake_datasets(), circular_manifest(), np)
    finally:
        if previous is None:
            _ = os.environ.pop("MRI_VIEWER_RTK_COMMAND", None)
        else:
            os.environ["MRI_VIEWER_RTK_COMMAND"] = previous

    assert result["report"]["validation"] == "external-engine"


def test_configured_rtk_command_defaults_to_bundled_wrapper(monkeypatch) -> None:
    try:
        _ = importlib.metadata.version("itk-rtk")
    except importlib.metadata.PackageNotFoundError:
        return
    monkeypatch.delenv("MRI_VIEWER_RTK_COMMAND", raising=False)
    command = configured_rtk_command()
    assert "scripts/rtk_projection_wrapper.py" in command


def test_rtk_wrapper_rejects_limited_angle_tomography_before_fdk() -> None:
    manifest = circular_manifest()
    manifest["projection"]["geometryModel"] = "limited-angle-tomo"

    try:
        _ = rtk_projection_wrapper.reconstruct(manifest, np.zeros((2, 4, 4), dtype=np.float32))
    except RuntimeError as exc:
        assert "iterative reconstruction runtime" in str(exc)
    else:
        raise AssertionError("expected limited-angle tomo to reject FDK wrapper path")
