from __future__ import annotations

import json
import traceback

from modal_validation import (
    auth_error,
    normalize_upload_items,
    validate_presigned_upload_url,
    validate_total_upload_bytes,
    upload_object_name,
    validate_input_kind,
    validate_job_id,
    validate_modality,
    validate_processing_mode,
)

_context = {
    "bucket": "",
    "get_r2_client": None,
    "process_study": None,
    "upload_expiry_seconds": 3600,
    "max_upload_bytes": 2 * 1024 * 1024 * 1024,
}


def configure_webhooks(
    *,
    bucket: str,
    get_r2_client,
    process_study,
    upload_expiry_seconds: int = 3600,
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024,
) -> None:
    _context["bucket"] = bucket
    _context["get_r2_client"] = get_r2_client
    _context["process_study"] = process_study
    _context["upload_expiry_seconds"] = min(int(upload_expiry_seconds or 900), 900)
    _context["max_upload_bytes"] = max(int(max_upload_bytes or 0), 0)


def _status_not_found(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    return code in {"404", "NoSuchKey"}


def start_processing(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    modality = validate_modality(item.get("modality", "auto"))
    processing_mode = validate_processing_mode(item.get("processing_mode", "standard"))
    input_kind = validate_input_kind(item.get("input_kind", ""), processing_mode)
    total_upload_bytes = validate_total_upload_bytes(item.get("total_upload_bytes"))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    if not modality:
        return {"status": "error", "error": "invalid modality"}
    if not processing_mode:
        return {"status": "error", "error": "invalid processing_mode"}
    if not input_kind:
        return {"status": "error", "error": "invalid input_kind"}
    if total_upload_bytes is None:
        return {"status": "error", "error": "invalid total_upload_bytes"}
    if _context["max_upload_bytes"] and total_upload_bytes > _context["max_upload_bytes"]:
        return {
            "status": "error",
            "error": f"total upload size exceeds limit ({_context['max_upload_bytes']} bytes)",
            "maxUploadBytes": _context["max_upload_bytes"],
        }
    if processing_mode == "projection_set_reconstruction" and input_kind != "calibrated_projection_set":
        return {"status": "error", "error": "projection reconstruction requires calibrated_projection_set input_kind"}

    s3 = _context["get_r2_client"]()
    s3.put_object(
        Bucket=_context["bucket"],
        Key=f"results/{job_id}/status.json",
        Body=json.dumps({"status": "processing"}),
        ContentType="application/json",
    )
    _context["process_study"].spawn(job_id, modality, processing_mode, input_kind)
    return {"status": "started", "job_id": job_id}


def check_status(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    s3 = _context["get_r2_client"]()
    try:
        resp = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/status.json")
        try:
            status = json.loads(resp["Body"].read())
        except json.JSONDecodeError as exc:
            traceback.print_exc()
            return {"status": "error", "error": "status_parse_failed", "detail": str(exc)}
        if status.get("status") == "complete":
            try:
                result = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/series.json")
                status["series_entry"] = json.loads(result["Body"].read())
            except Exception as exc:
                status["series_entry_error"] = str(exc)
            try:
                projection = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/projection_set.json")
                status["projection_set_entry"] = json.loads(projection["Body"].read())
            except Exception:
                pass
        return status
    except Exception as exc:
        if _status_not_found(exc):
            return {"status": "processing"}
        traceback.print_exc()
        return {"status": "error", "error": "status_unavailable", "detail": str(exc)}


def get_upload_urls(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    upload_items, error = normalize_upload_items(item)
    if error:
        return {"status": "error", "error": error}

    s3 = _context["get_r2_client"]()
    urls = {}
    for upload_item in upload_items:
        key = f"uploads/{job_id}/{upload_object_name(upload_item['upload_id'], upload_item['filename'])}"
        url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": _context["bucket"], "Key": key, "ContentType": upload_item["content_type"]},
            ExpiresIn=_context["upload_expiry_seconds"],
        )
        if not validate_presigned_upload_url(url, max_seconds=900, fallback_seconds=_context["upload_expiry_seconds"]):
            return {"status": "error", "error": "upload URL expiry exceeds 15 minute limit"}
        urls[upload_item["upload_id"]] = url
    return {"urls": urls, "uploadExpirySeconds": _context["upload_expiry_seconds"]}
