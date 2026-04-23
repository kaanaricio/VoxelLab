from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


class FakeImage:
    @classmethod
    def debian_slim(cls, **_kwargs):
        return cls()

    def apt_install(self, *_args, **_kwargs):
        return self

    def pip_install(self, *_args, **_kwargs):
        return self


class FakeSecret:
    def __init__(self, name: str):
        self.name = name

    @staticmethod
    def from_name(name: str):
        return FakeSecret(name)


class FakeRetries:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeApp:
    def __init__(self, _name: str):
        pass

    def function(self, **_kwargs):
        def decorator(fn):
            fn.spawn = lambda *_args, **_kwargs: None
            return fn

        return decorator


def fake_fastapi_endpoint(**_kwargs):
    def decorator(fn):
        return fn

    return decorator


def import_modal_app():
    fake_modal = types.SimpleNamespace(
        App=FakeApp,
        Image=FakeImage,
        Retries=FakeRetries,
        Secret=FakeSecret,
        fastapi_endpoint=fake_fastapi_endpoint,
    )
    sys.modules["modal"] = fake_modal
    _ = sys.modules.pop("modal_app", None)
    return importlib.import_module("modal_app")


def test_modal_request_validation_accepts_expected_shapes():
    modal_app = import_modal_app()

    assert modal_app.validate_job_id("abc123-def_456") == "abc123-def_456"
    assert modal_app.validate_upload_id("f000001") == "f000001"
    assert modal_app.validate_modality("CT") == "CT"
    assert modal_app.validate_processing_mode("standard") == "standard"
    assert modal_app.validate_processing_mode("projection_set_reconstruction") == "projection_set_reconstruction"
    assert modal_app.validate_processing_mode("ultrasound_scan_conversion") == "ultrasound_scan_conversion"
    assert modal_app.validate_input_kind("dicom_volume_stack") == "dicom_volume_stack"
    assert modal_app.validate_input_kind("calibrated_projection_set") == "calibrated_projection_set"
    assert modal_app.validate_input_kind("calibrated_ultrasound_source") == "calibrated_ultrasound_source"
    assert modal_app.validate_upload_filename("slice-0001.dcm") == "slice-0001.dcm"


def test_modal_request_validation_rejects_r2_key_escape_shapes():
    modal_app = import_modal_app()

    assert modal_app.validate_job_id("../abc123") == ""
    assert modal_app.validate_job_id("short") == ""
    assert modal_app.validate_upload_id("../item") == ""
    assert modal_app.validate_modality("PET") == ""
    assert modal_app.validate_modality("DX") == ""
    assert modal_app.validate_processing_mode("fdka") == ""
    assert modal_app.validate_input_kind("../projection") == ""
    assert modal_app.validate_upload_filename("../slice.dcm") == ""
    assert modal_app.validate_upload_filename("folder/slice.dcm") == ""


def test_modal_config_env_parsing_is_bounded_and_simple(monkeypatch):
    # Example value: Modal can try GPUs in order and cap transfer workers for R2 fan-out.
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "L4,A10G")
    monkeypatch.setenv("MRI_VIEWER_MODAL_CPU", "2.5")
    monkeypatch.setenv("MRI_VIEWER_MODAL_MEMORY_MB", "128")
    monkeypatch.setenv("MRI_VIEWER_MODAL_R2_SECRET", "custom-r2-secret")
    monkeypatch.setenv("MRI_VIEWER_R2_TRANSFER_WORKERS", "500")
    monkeypatch.setenv("MRI_VIEWER_MODAL_WEB_RETRIES", "0")

    modal_app = import_modal_app()

    assert modal_app.PROCESS_FUNCTION_CONFIG["gpu"] == ["L4", "A10G"]
    assert modal_app.PROCESS_FUNCTION_CONFIG["cpu"] == 2.5
    assert modal_app.PROCESS_FUNCTION_CONFIG["memory"] == 512
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", ",")
    assert modal_app.env_gpu("MRI_VIEWER_MODAL_GPU") is None
    assert modal_app.R2_SECRET.name == "custom-r2-secret"
    assert modal_app.R2_TRANSFER_WORKERS == 64
    assert "retries" not in modal_app.WEB_FUNCTION_CONFIG


def test_modal_endpoint_auth_rejects_missing_or_wrong_token(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")
    modal_app = import_modal_app()

    assert modal_app.auth_error("") == "unauthorized"
    assert modal_app.auth_error("wrong-token") == "unauthorized"
    assert modal_app.auth_error("secret-token") == ""


def test_modal_projection_validation_rejects_missing_calibration():
    modal_app = import_modal_app()
    selected, error = modal_app.ensure_projection_inputs(
        [FakeDicom(modality="XA", series_uid="proj", instance=1)],
        None,
    )
    assert selected == []
    assert "source manifest" in error


class FakeDicom:
    def __init__(
        self,
        *,
        modality: str = "CT",
        series_uid: str = "series-a",
        rows: int = 512,
        cols: int = 512,
        instance: int = 1,
        image_type=None,
        orientation=None,
        position=None,
        pixel_spacing=None,
    ):
        self.Modality = modality
        self.SeriesInstanceUID = series_uid
        self.Rows = rows
        self.Columns = cols
        self.InstanceNumber = instance
        self.PixelSpacing = pixel_spacing if pixel_spacing is not None else [1, 1]
        self.ImageOrientationPatient = orientation if orientation is not None else [1, 0, 0, 0, 1, 0]
        self.ImagePositionPatient = position if position is not None else [0, 0, instance - 1]
        if image_type is not None:
            self.ImageType = image_type
        self.pixel_array = [[1, 2], [3, 4]]


class FakePixelCube:
    def __init__(self, frames):
        self._frames = frames
        rows = len(frames[0]) if frames else 0
        cols = len(frames[0][0]) if frames and frames[0] else 0
        self.shape = (len(frames), rows, cols)

    def __getitem__(self, index):
        return self._frames[index]


class FakeSeqItem:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def test_modal_stack_selection_picks_largest_coherent_shape():
    modal_app = import_modal_app()
    datasets = [
        FakeDicom(series_uid="scout", rows=256, cols=232, instance=1),
        FakeDicom(series_uid="main", rows=792, cols=512, instance=2),
        FakeDicom(series_uid="main", rows=792, cols=512, instance=1),
    ]

    selected, modality, key = modal_app.select_primary_dicom_stack(datasets, "CT")

    assert modality == "CT"
    assert key[1] == "main"
    assert [(ds.Rows, ds.Columns, ds.InstanceNumber) for ds in selected] == [
        (792, 512, 1),
        (792, 512, 2),
    ]


def test_modal_stack_selection_respects_requested_modality():
    modal_app = import_modal_app()
    datasets = [
        FakeDicom(modality="MR", series_uid="mr", rows=64, cols=64, instance=1),
        FakeDicom(modality="CT", series_uid="ct", rows=512, cols=512, instance=1),
        FakeDicom(modality="CT", series_uid="ct", rows=512, cols=512, instance=2),
    ]

    selected, modality, key = modal_app.select_primary_dicom_stack(datasets, "MR")

    assert len(selected) == 1
    assert modality == "MR"
    assert key[1] == "mr"


def test_modal_stack_selection_rejects_projection_and_localizer_inputs():
    modal_app = import_modal_app()
    datasets = [
        FakeDicom(modality="DX", series_uid="dx", instance=1),
        FakeDicom(modality="CT", series_uid="localizer", image_type=["ORIGINAL", "PRIMARY", "LOCALIZER"], instance=2),
    ]

    selected, modality, key = modal_app.select_primary_dicom_stack(datasets, "auto")

    assert selected == []
    assert modality == ""
    assert key == ("", "", 0, 0)


def test_modal_projection_validation_accepts_one_calibrated_projection_series():
    modal_app = import_modal_app()
    datasets = [
        FakeDicom(modality="XA", series_uid="proj", instance=1),
        FakeDicom(modality="XA", series_uid="proj", instance=2),
    ]
    manifest = {
        "sourceKind": "projection",
        "seriesUID": "proj",
        "projection": {
            "geometry": "parallel-beam-stack",
            "anglesDeg": [0, 90],
            "outputShape": [16, 16, 2],
            "outputSpacingMm": [1, 1, 1],
            "firstIPP": [0, 0, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
            "frameOfReferenceUID": "1.2.for",
        },
    }

    selected, error = modal_app.ensure_projection_inputs(datasets, manifest)

    assert error == ""
    assert len(selected) == 2


def test_modal_ultrasound_validation_accepts_calibrated_source():
    modal_app = import_modal_app()
    ds = FakeDicom(modality="US", series_uid="us", instance=1)
    ds.pixel_array = FakePixelCube([
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]],
    ])
    manifest = {
        "sourceKind": "ultrasound",
        "seriesUID": "us",
        "ultrasound": {
            "mode": "stacked-sector",
            "probeGeometry": "sector",
            "thetaRangeDeg": [-30, 30],
            "radiusRangeMm": [0, 50],
            "outputShape": [8, 8, 2],
            "outputSpacingMm": [1, 1, 1],
            "firstIPP": [0, 0, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
            "frameOfReferenceUID": "1.2.us.for",
        },
    }

    selected, error = modal_app.ensure_ultrasound_inputs([ds], manifest, __import__("numpy"))

    assert error == ""
    assert len(selected) == 1


def test_modal_expand_primary_stack_expands_enhanced_multiframe_dataset():
    modal_app = import_modal_app()
    ds = FakeDicom(series_uid="enhanced", instance=1)
    ds.NumberOfFrames = 2
    ds.FrameOfReferenceUID = "1.2.840.enhanced"
    ds.SharedFunctionalGroupsSequence = [
        FakeSeqItem(
            PixelMeasuresSequence=[FakeSeqItem(PixelSpacing=[1, 1], SliceThickness=1.0)],
            PlaneOrientationSequence=[FakeSeqItem(ImageOrientationPatient=[1, 0, 0, 0, 1, 0])],
        ),
    ]
    ds.PerFrameFunctionalGroupsSequence = [
        FakeSeqItem(PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 0])]),
        FakeSeqItem(PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 1])]),
    ]
    ds.pixel_array = FakePixelCube([
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]],
    ])

    expanded, error = modal_app.expand_primary_stack([ds])

    assert error == ""
    assert len(expanded) == 2
    assert expanded[0].ImagePositionPatient == [0.0, 0.0, 0.0]
    assert expanded[1].ImagePositionPatient == [0.0, 0.0, 1.0]
    assert expanded[0].pixel_array == [[1, 2], [3, 4]]


def test_modal_mpr_geometry_validation_accepts_regular_orthogonal_stack():
    modal_app = import_modal_app()
    slices = [
        FakeDicom(instance=1, position=[0, 0, 0]),
        FakeDicom(instance=2, position=[0, 0, 1]),
    ]

    assert modal_app.mpr_geometry_error(slices) == ""


def test_modal_mpr_geometry_validation_rejects_misaligned_slice_axis():
    modal_app = import_modal_app()
    slices = [
        FakeDicom(instance=1, position=[0, 0, 0]),
        FakeDicom(instance=2, position=[0, 10, 0]),
    ]

    assert "slice positions aligned" in modal_app.mpr_geometry_error(slices)


def test_modal_mpr_geometry_validation_rejects_irregular_slice_spacing():
    modal_app = import_modal_app()
    slices = [
        FakeDicom(instance=1, position=[0, 0, 0]),
        FakeDicom(instance=2, position=[0, 0, 1]),
        FakeDicom(instance=3, position=[0, 0, 3]),
    ]

    assert "regular slice spacing" in modal_app.mpr_geometry_error(slices)


def test_iter_r2_object_keys_reads_all_pages():
    modal_app = import_modal_app()

    class FakeS3:
        def list_objects_v2(self, **kwargs):
            if "ContinuationToken" not in kwargs:
                return {
                    "Contents": [{"Key": "uploads/job/a.dcm"}],
                    "NextContinuationToken": "page-2",
                }
            return {"Contents": [{"Key": "uploads/job/b.dcm"}]}

    assert list(modal_app.iter_r2_object_keys(FakeS3(), "scan-data", "uploads/job/")) == [
        "uploads/job/a.dcm",
        "uploads/job/b.dcm",
    ]


def test_normalize_upload_items_accepts_duplicate_filenames_when_ids_differ():
    modal_app = import_modal_app()

    items, error = modal_app.normalize_upload_items({
        "items": [
            {"upload_id": "f000001", "filename": "IM0001"},
            {"upload_id": "f000002", "filename": "IM0001"},
        ]
    })

    assert error is None
    assert items == [
        {"upload_id": "f000001", "filename": "IM0001", "content_type": "application/dicom"},
        {"upload_id": "f000002", "filename": "IM0001", "content_type": "application/dicom"},
    ]


def test_normalize_upload_items_rejects_legacy_duplicate_filenames():
    modal_app = import_modal_app()

    items, error = modal_app.normalize_upload_items({"filenames": ["IM0001", "IM0001"]})

    assert items == []
    assert "duplicate filename" in error


def test_r2_download_and_upload_helpers_batch_without_changing_keys(tmp_path: Path):
    modal_app = import_modal_app()

    class FakeS3:
        def __init__(self):
            self.downloads = []
            self.uploads = []

        def list_objects_v2(self, **_kwargs):
            return {
                "Contents": [
                    {"Key": "uploads/job/slice-0001.dcm"},
                    {"Key": "uploads/job/.DS_Store"},
                    {"Key": "uploads/job/slice-0002.dcm"},
                ],
            }

        def download_file(self, bucket, key, filename):
            self.downloads.append((bucket, key, Path(filename).name))
            _ = Path(filename).write_text(key)

        def upload_file(self, filename, bucket, key, ExtraArgs):
            self.uploads.append((Path(filename).name, bucket, key, ExtraArgs["ContentType"]))

    s3 = FakeS3()
    count = modal_app.download_r2_objects(s3, "scan-data", "uploads/job/", tmp_path, max_workers=2)
    assert count == 2
    assert sorted(path.name for path in tmp_path.iterdir()) == ["slice-0001.dcm", "slice-0002.dcm"]

    modal_app.upload_r2_files(
        s3,
        "scan-data",
        [(tmp_path / "slice-0001.dcm", "data/cloud_job/0001.png", "image/png")],
        max_workers=0,
    )
    assert s3.uploads == [("slice-0001.dcm", "scan-data", "data/cloud_job/0001.png", "image/png")]
