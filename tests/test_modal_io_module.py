from __future__ import annotations

from pathlib import Path

from modal_io import download_r2_objects, iter_r2_object_keys, upload_r2_files


def test_modal_io_iter_and_transfer_helpers(tmp_path: Path):
    class FakeS3:
        def __init__(self):
            self.uploads = []

        def list_objects_v2(self, **kwargs):
            if "ContinuationToken" not in kwargs:
                return {
                    "Contents": [{"Key": "uploads/job/a.dcm"}],
                    "NextContinuationToken": "page-2",
                }
            return {
                "Contents": [
                    {"Key": "uploads/job/.DS_Store"},
                    {"Key": "uploads/job/b.dcm"},
                ],
            }

        def download_file(self, bucket, key, filename):
            _ = Path(filename).write_text(f"{bucket}:{key}")

        def upload_file(self, filename, bucket, key, ExtraArgs):
            self.uploads.append((Path(filename).name, bucket, key, ExtraArgs["ContentType"]))

    s3 = FakeS3()
    assert list(iter_r2_object_keys(s3, "scan-data", "uploads/job/")) == [
        "uploads/job/a.dcm",
        "uploads/job/.DS_Store",
        "uploads/job/b.dcm",
    ]
    assert download_r2_objects(s3, "scan-data", "uploads/job/", tmp_path, max_workers=2) == 2

    upload_r2_files(
        s3,
        "scan-data",
        [(tmp_path / "a.dcm", "data/cloud_job/0001.png", "image/png")],
        max_workers=0,
    )
    assert s3.uploads == [("a.dcm", "scan-data", "data/cloud_job/0001.png", "image/png")]
