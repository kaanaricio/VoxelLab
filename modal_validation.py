from __future__ import annotations

import os
import re
import secrets
from urllib.parse import parse_qs, urlparse

from engine_sources import SOURCE_MANIFEST_NAMES
from modal_contract import (
    validate_input_kind as _validate_input_kind_shared,
    validate_processing_mode as _validate_processing_mode_shared,
)

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
MODALITIES = {"auto", "MR", "CT"}


def env_int(name: str, default: int, *, min_value: int | None = None, max_value: int | None = None) -> int:
    raw = os.environ.get(name, "")
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    if min_value is not None:
        value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def env_float(name: str, default: float, *, min_value: float | None = None, max_value: float | None = None) -> float:
    raw = os.environ.get(name, "")
    try:
        value = float(raw) if raw else default
    except ValueError:
        value = default
    if min_value is not None:
        value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def env_gpu(name: str, default: str = "T4") -> str | list[str] | None:
    raw = os.environ.get(name, default).strip()
    if raw.lower() in {"", "none", "cpu"}:
        return None
    choices = [item.strip() for item in raw.split(",") if item.strip()]
    if not choices:
        return None
    return choices if len(choices) > 1 else choices[0]


def retry_policy(max_retries: int, initial_delay: float, backoff: float):
    if max_retries <= 0:
        return None
    import modal

    return modal.Retries(
        max_retries=max_retries,
        initial_delay=initial_delay,
        backoff_coefficient=backoff,
    )


def drop_none(**kwargs) -> dict:
    return {key: value for key, value in kwargs.items() if value is not None}


def validate_job_id(job_id: object) -> str:
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        return ""
    return job_id


def validate_modality(modality: object) -> str:
    if not isinstance(modality, str) or modality not in MODALITIES:
        return ""
    return modality


def validate_processing_mode(mode: object) -> str:
    return _validate_processing_mode_shared(mode)


def validate_input_kind(kind: object, processing_mode: str = "standard") -> str:
    return _validate_input_kind_shared(kind, processing_mode)


def validate_upload_filename(filename: object) -> str:
    if not isinstance(filename, str) or not filename or len(filename) > 180:
        return ""
    if "/" in filename or "\\" in filename or filename in {".", ".."} or ".." in filename:
        return ""
    return filename


def validate_upload_id(upload_id: object) -> str:
    if not isinstance(upload_id, str) or not UPLOAD_ID_RE.fullmatch(upload_id):
        return ""
    return upload_id


def validate_total_upload_bytes(value: object) -> int | None:
    if value in {None, ""}:
        return 0
    try:
        size = int(value)
    except (TypeError, ValueError):
        return None
    return size if size >= 0 else None


def upload_object_name(upload_id: str, filename: str) -> str:
    return f"{upload_id}__{filename}"


def upload_content_type(filename: str) -> str:
    # Shape: "IM0001" -> "application/dicom", "voxellab.source.json" -> "application/json".
    return "application/json" if filename in SOURCE_MANIFEST_NAMES else "application/dicom"


def normalize_upload_items(payload: dict) -> tuple[list[dict[str, str]], str | None]:
    raw_items = payload.get("items")
    if raw_items is not None:
        if not isinstance(raw_items, list) or not raw_items:
            return [], "invalid job_id or items"
        seen_ids: set[str] = set()
        items: list[dict[str, str]] = []
        for raw_item in raw_items[:500]:
            if not isinstance(raw_item, dict):
                return [], "invalid upload item"
            upload_id = validate_upload_id(raw_item.get("upload_id", ""))
            filename = validate_upload_filename(raw_item.get("filename", ""))
            if not upload_id or not filename:
                return [], "invalid upload item"
            if upload_id in seen_ids:
                return [], f"duplicate upload_id: {upload_id}"
            seen_ids.add(upload_id)
            items.append({
                "upload_id": upload_id,
                "filename": filename,
                "content_type": upload_content_type(filename),
            })
        return items, None

    filenames = payload.get("filenames", [])
    if not isinstance(filenames, list) or not filenames:
        return [], "invalid job_id or filenames"
    seen_filenames: set[str] = set()
    items = []
    for raw_filename in filenames[:500]:
        filename = validate_upload_filename(raw_filename)
        if not filename:
            return [], "invalid filename"
        if filename in seen_filenames:
            return [], "duplicate filename; send structured upload ids"
        seen_filenames.add(filename)
        items.append({
            "upload_id": filename,
            "filename": filename,
            "content_type": upload_content_type(filename),
        })
    return items, None


def presigned_upload_expiry_seconds(url: str) -> int | None:
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
    except Exception:
        return None
    for key in ("X-Amz-Expires", "x-amz-expires", "expires"):
        values = query.get(key)
        if not values:
            continue
        try:
            return int(values[0])
        except (TypeError, ValueError):
            return None
    return None


def validate_presigned_upload_url(url: str, *, max_seconds: int = 900, fallback_seconds: int | None = None) -> bool:
    expiry = presigned_upload_expiry_seconds(url)
    if expiry is None:
        return fallback_seconds is not None and fallback_seconds <= max_seconds
    return 0 < expiry <= max_seconds


def auth_error(token: object, expected_token: str | None = None) -> str:
    expected = expected_token if expected_token is not None else os.environ.get("MODAL_AUTH_TOKEN", "").strip()
    if not expected:
        return "modal auth token is not configured"
    if not isinstance(token, str) or not token or not secrets.compare_digest(token, expected):
        return "unauthorized"
    return ""
