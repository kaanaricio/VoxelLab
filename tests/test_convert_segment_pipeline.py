from __future__ import annotations

import json
import shutil
from pathlib import Path

import nibabel as nib
import numpy as np
from PIL import Image
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid

import convert
import segment


def write_synthetic_nifti(path: Path) -> np.ndarray:
    # Shape: synthetic xyz volume with smooth intensity ramps across a 16x16x4 MR stack.
    volume = np.zeros((16, 16, 4), dtype=np.float32)
    for z in range(volume.shape[2]):
        yy, xx = np.mgrid[:16, :16]
        volume[:, :, z] = 25 + z * 20 + xx * 4 + yy * 3
    nib.save(nib.Nifti1Image(volume, np.diag([1.0, 1.0, 1.5, 1.0])), str(path))
    return volume


def write_mr_dicom_series(folder: Path, volume_xyz: np.ndarray) -> None:
    study_uid = generate_uid()
    series_uid = generate_uid()
    frame_uid = generate_uid()

    for z in range(volume_xyz.shape[2]):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = MRImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian

        ds = FileDataset(str(folder / f"IM{z + 1:04d}.dcm"), {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID = MRImageStorage
        ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_uid
        ds.Modality = "MR"
        ds.PatientName = "SYNTHETIC^TEST"
        ds.PatientID = "synthetic"
        ds.SeriesDescription = "Synthetic MR"
        ds.ProtocolName = "Synthetic MR"
        ds.StudyDate = "20260411"
        ds.InstanceNumber = z + 1
        ds.ImagePositionPatient = [0.0, 0.0, float(z) * 1.5]
        ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        ds.PixelSpacing = [1.0, 1.0]
        ds.SliceThickness = 1.5
        ds.Rows = int(volume_xyz.shape[1])
        ds.Columns = int(volume_xyz.shape[0])
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.PixelData = np.asarray(volume_xyz[:, :, z].T, dtype=np.uint16).tobytes()
        ds.save_as(folder / f"IM{z + 1:04d}.dcm", enforce_file_format=True)


def test_convert_to_segment_pipeline_on_synthetic_nifti_source(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "dicom_source"
    dicom_folder = source / "series_a"
    dicom_folder.mkdir(parents=True)
    nifti_path = tmp_path / "synthetic.nii.gz"
    volume_xyz = write_synthetic_nifti(nifti_path)
    write_mr_dicom_series(dicom_folder, nib.load(str(nifti_path)).get_fdata(dtype=np.float32))

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(json.dumps({"patient": "anonymous", "studyDate": "", "series": []}))

    monkeypatch.setattr(convert, "OUT", data_dir)
    monkeypatch.setattr(segment, "DATA", data_dir)

    entry = convert.process_series(source, "series_a", "synthetic", "Synthetic MR", "Synthetic volume")
    assert entry is not None
    assert entry["slices"] == volume_xyz.shape[2]

    manifest = convert.upsert_series({"patient": "anonymous", "studyDate": "", "series": []}, [entry], entry["studyDate"])
    _ = (data_dir / "manifest.json").write_text(json.dumps(manifest))

    _ = shutil.copytree(data_dir / "synthetic", data_dir / "synthetic_brain")
    segment.process("synthetic")
    segment.update_manifest(["synthetic"])

    seg_files = sorted((data_dir / "synthetic_seg").glob("*.png"))
    assert len(seg_files) == volume_xyz.shape[2]

    labels = np.stack([np.array(Image.open(path), dtype=np.uint8) for path in seg_files])
    assert labels.shape == (4, 16, 16)
    assert set(np.unique(labels)).issubset({0, 1, 2, 3})
    assert int((labels > 0).sum()) > 300

    written_manifest = json.loads((data_dir / "manifest.json").read_text())
    assert written_manifest["series"][0]["hasSeg"] is True
