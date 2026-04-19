from __future__ import annotations

from modal_dicom import (
    dropped_dicom_series,
    ensure_projection_inputs,
    expand_primary_stack,
    mpr_geometry_error,
    select_primary_dicom_stack,
    stack_pixels_with_rescale,
)


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


def test_modal_dicom_selects_primary_stack():
    selected, modality, key = select_primary_dicom_stack([
        FakeDicom(series_uid="scout", rows=64, cols=64, instance=1),
        FakeDicom(series_uid="main", rows=512, cols=512, instance=2),
        FakeDicom(series_uid="main", rows=512, cols=512, instance=1),
    ], "CT")

    assert modality == "CT"
    assert key[1] == "main"
    assert [ds.InstanceNumber for ds in selected] == [1, 2]


def test_modal_dicom_expands_multiframe_and_validates_geometry():
    ds = FakeDicom(series_uid="enhanced", instance=1)
    ds.NumberOfFrames = 2
    ds.FrameOfReferenceUID = "1.2.840.enhanced"
    ds.SharedFunctionalGroupsSequence = [
        FakeSeqItem(
            PixelMeasuresSequence=[FakeSeqItem(PixelSpacing=[1, 1], SliceThickness=1.0)],
            PlaneOrientationSequence=[FakeSeqItem(ImageOrientationPatient=[1, 0, 0, 0, 1, 0])],
        )
    ]
    ds.PerFrameFunctionalGroupsSequence = [
        FakeSeqItem(PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 0])]),
        FakeSeqItem(PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 1])]),
    ]
    ds.pixel_array = FakePixelCube([
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]],
    ])

    expanded, error = expand_primary_stack([ds])

    assert error == ""
    assert len(expanded) == 2
    assert mpr_geometry_error(expanded) == ""


def test_modal_dicom_expands_multiframe_with_per_frame_rescale() -> None:
    ds = FakeDicom(series_uid="enhanced", instance=1)
    ds.NumberOfFrames = 2
    ds.FrameOfReferenceUID = "1.2.840.enhanced"
    ds.SharedFunctionalGroupsSequence = [
        FakeSeqItem(
            PixelMeasuresSequence=[FakeSeqItem(PixelSpacing=[1, 1], SliceThickness=1.0)],
            PlaneOrientationSequence=[FakeSeqItem(ImageOrientationPatient=[1, 0, 0, 0, 1, 0])],
        )
    ]
    ds.PerFrameFunctionalGroupsSequence = [
        FakeSeqItem(
            PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 0])],
            PixelValueTransformationSequence=[FakeSeqItem(RescaleSlope=2.0, RescaleIntercept=-100.0)],
        ),
        FakeSeqItem(
            PlanePositionSequence=[FakeSeqItem(ImagePositionPatient=[0, 0, 1])],
            PixelValueTransformationSequence=[FakeSeqItem(RescaleSlope=3.0, RescaleIntercept=-200.0)],
        ),
    ]
    ds.pixel_array = FakePixelCube([
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]],
    ])

    expanded, error = expand_primary_stack([ds])

    assert error == ""
    assert expanded[0].RescaleSlope == 2.0
    assert expanded[0].RescaleIntercept == -100.0
    assert expanded[1].RescaleSlope == 3.0
    assert expanded[1].RescaleIntercept == -200.0


def test_modal_dicom_stack_pixels_applies_per_slice_rescale() -> None:
    first = FakeDicom(modality="MR", instance=1)
    first.pixel_array = [[1, 2], [3, 4]]
    first.RescaleSlope = 2.0
    first.RescaleIntercept = -10.0
    second = FakeDicom(modality="MR", instance=2)
    second.pixel_array = [[5, 6], [7, 8]]
    second.RescaleSlope = 3.0
    second.RescaleIntercept = -20.0

    vol = stack_pixels_with_rescale([first, second])

    assert vol.tolist() == [
        [[-8.0, -6.0], [-4.0, -2.0]],
        [[-5.0, -2.0], [1.0, 4.0]],
    ]


def test_modal_dicom_projection_inputs_require_source_manifest():
    selected, error = ensure_projection_inputs(
        [FakeDicom(modality="XA", series_uid="proj", instance=1)],
        None,
    )

    assert selected == []
    assert "source manifest" in error


def test_modal_dicom_reports_non_primary_series_as_dropped() -> None:
    datasets = [
        FakeDicom(series_uid="main", rows=512, cols=512, instance=1),
        FakeDicom(series_uid="main", rows=512, cols=512, instance=2),
        FakeDicom(series_uid="other", rows=256, cols=256, instance=1),
    ]
    _, _, key = select_primary_dicom_stack(datasets, "CT")

    dropped = dropped_dicom_series(datasets, "CT", key)

    assert dropped == [{
        "modality": "CT",
        "seriesUID": "other",
        "rows": 256,
        "columns": 256,
        "sliceCount": 1,
    }]
