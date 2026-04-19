from __future__ import annotations

import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def get_r2_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def iter_r2_object_keys(s3, bucket: str, prefix: str):
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj.get("Key")
            if key:
                yield key
        token = resp.get("NextContinuationToken")
        if not token:
            break


def download_r2_objects(s3, bucket: str, prefix: str, out_dir: Path, max_workers: int) -> int:
    keys = [
        key for key in iter_r2_object_keys(s3, bucket, prefix)
        if key.split("/")[-1] and not key.split("/")[-1].startswith(".")
    ]
    if not keys:
        return 0

    def download_one(key: str) -> None:
        s3.download_file(bucket, key, str(out_dir / key.split("/")[-1]))

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(download_one, key) for key in keys]
        for future in as_completed(futures):
            future.result()
    return len(keys)


def upload_r2_files(s3, bucket: str, uploads: list[tuple[Path, str, str]], max_workers: int) -> None:
    if not uploads:
        return

    def upload_one(item: tuple[Path, str, str]) -> None:
        path, key, content_type = item
        s3.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(upload_one, item) for item in uploads]
        for future in as_completed(futures):
            future.result()


def compress_raw_volume(raw_path: Path, zst_path: Path) -> None:
    _ = subprocess.run(["zstd", "-19", "--ultra", "-f", "-q", str(raw_path), "-o", str(zst_path)], check=True)
