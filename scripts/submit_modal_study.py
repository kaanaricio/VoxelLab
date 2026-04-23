#!/usr/bin/env python3
"""Submit a local DICOM folder to the deployed Modal/R2 processing flow."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path

from cloud_series import normalize_origin
from engine_sources import SOURCE_MANIFEST_NAMES
from engine_preflight import validate_projection_source, validate_ultrasound_source
from modal_contract import INPUT_KINDS, PROCESSING_MODES, default_input_kind, validate_input_kind, validate_processing_mode
from pipeline_paths import SKIP_NAMES
from series_contract import normalize_series_entry

ROOT = Path(__file__).resolve().parents[1]

FUNCTIONS = {
    "get_upload_urls": "get-upload-urls",
    "start_processing": "start-processing",
    "check_status": "check-status",
}

SKIP_SUFFIXES = {".jpg", ".jpeg", ".png", ".txt", ".json"}


def load_config(path: Path) -> dict:
    return json.loads(path.read_text())


@lru_cache(maxsize=1)
def load_dotenv(path: Path = ROOT / ".env") -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def env_value(name: str) -> str:
    return os.environ.get(name) or load_dotenv().get(name, "")


def trusted_upload_origins(r2_base: str, configured: list[str] | None = None) -> list[str]:
    origins: list[str] = []
    for value in [r2_base, *(configured or [])]:
        origin = normalize_origin(str(value).rstrip("/"))
        if origin and origin not in origins:
            origins.append(origin)
    return origins


def validate_upload_url(url: str, allowlist: list[str]) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError("upload URL must be HTTPS")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if allowlist and origin not in allowlist:
        raise RuntimeError(f"upload URL escaped trusted origins: {origin}")
    return url


def modal_endpoint(base: str, function_name: str) -> str:
    suffix = FUNCTIONS[function_name]
    raw = base.rstrip("/")
    parsed = urllib.parse.urlparse(raw)
    host = parsed.netloc or parsed.path
    if host.endswith(".modal.run"):
        host = host.removesuffix(".modal.run")
    for known in FUNCTIONS.values():
        if host.endswith(f"-{known}"):
            host = host[: -(len(known) + 1)]
            break
    return f"https://{host}-{suffix}.modal.run"


def post_json(url: str, payload: dict, timeout: int = 60) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def get_json(url: str, timeout: int = 60) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def upload_content_type(path: Path) -> str:
    return "application/json" if path.name in SOURCE_MANIFEST_NAMES else "application/dicom"


def put_file(url: str, path: Path, timeout: int = 120) -> None:
    data = path.read_bytes()
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", upload_content_type(path))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"upload failed for {path.name}: HTTP {resp.status}")


def candidate_files(folder: Path) -> list[Path]:
    files = []
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.name in SKIP_NAMES or path.name.startswith("._"):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES and path.name not in SOURCE_MANIFEST_NAMES:
            continue
        files.append(path)
    return files


def chunks(values: list[Path], size: int) -> list[list[Path]]:
    return [values[index:index + size] for index in range(0, len(values), size)]


def upload_items(paths: list[Path], start_index: int = 0) -> list[dict[str, str | Path]]:
    items = []
    for offset, path in enumerate(paths):
        items.append({
            "upload_id": f"f{start_index + offset:06d}",
            "filename": path.name,
            "path": path,
        })
    return items


def start_processing_payload(
    job_id: str,
    modality: str,
    processing_mode: str,
    input_kind: str,
    total_upload_bytes: int = 0,
) -> dict:
    payload = {
        "job_id": job_id,
        "modality": modality,
        "processing_mode": processing_mode,
        "total_upload_bytes": int(total_upload_bytes),
    }
    if input_kind:
        payload["input_kind"] = input_kind
    return payload


def submit_preflight_errors(source: Path, processing_mode: str, skip_upload: bool) -> list[str]:
    if skip_upload:
        return []
    if processing_mode == "projection_set_reconstruction":
        return validate_projection_source(source)
    if processing_mode == "ultrasound_scan_conversion":
        return validate_ultrasound_source(source)
    return []


def submit(args: argparse.Namespace) -> dict:
    processing_mode = validate_processing_mode(getattr(args, "processing_mode", "standard"))
    input_kind = validate_input_kind(getattr(args, "input_kind", ""), processing_mode)
    if not processing_mode:
        raise SystemExit("invalid --processing-mode")
    if not input_kind:
        raise SystemExit("invalid --input-kind")
    if input_kind != default_input_kind(processing_mode):
        raise SystemExit(f"{processing_mode} requires --input-kind {default_input_kind(processing_mode)}")
    preflight_errors = submit_preflight_errors(args.source, processing_mode, bool(args.skip_upload))
    if preflight_errors:
        raise SystemExit("\n".join(preflight_errors))

    config = load_config(args.config)
    base = args.modal_base or env_value("MODAL_WEBHOOK_BASE") or config["modalWebhookBase"]
    r2_base = (args.r2_public_url or env_value("R2_PUBLIC_URL") or config.get("r2PublicUrl", "")).rstrip("/")
    modal_auth_token = env_value("MODAL_AUTH_TOKEN")
    if not base:
        raise SystemExit("missing MODAL_WEBHOOK_BASE; set it in .env or pass --modal-base")
    if not modal_auth_token:
        raise SystemExit("missing MODAL_AUTH_TOKEN; set it in .env")
    upload_endpoint = modal_endpoint(base, "get_upload_urls")
    start_endpoint = modal_endpoint(base, "start_processing")
    status_endpoint = modal_endpoint(base, "check_status")
    upload_origin_allowlist = trusted_upload_origins(
        r2_base,
        [*(config.get("trustedUploadOrigins") or []), *(args.trusted_upload_origin or [])],
    )
    total_upload_bytes = 0

    if args.skip_upload:
        print(f"[{args.job_id}] skipping upload; using existing R2 upload prefix", flush=True)
    else:
        files = candidate_files(args.source)
        if not files:
            raise SystemExit(f"no candidate DICOM files in {args.source}")
        total_upload_bytes = sum(path.stat().st_size for path in files)

        print(f"[{args.job_id}] uploading {len(files)} files from {args.source}", flush=True)
        uploaded = 0
        progress_lock = threading.Lock()
        for batch_start, batch in enumerate(chunks(files, args.batch_size)):
            batch_items = upload_items(batch, start_index=batch_start * args.batch_size)
            response = post_json(
                upload_endpoint,
                {
                    "job_id": args.job_id,
                    "token": modal_auth_token,
                    "items": [
                        {"upload_id": item["upload_id"], "filename": item["filename"]}
                        for item in batch_items
                    ],
                },
            )
            if "urls" not in response:
                raise RuntimeError(f"upload URL request failed: {response}")
            with ThreadPoolExecutor(max_workers=args.upload_workers) as pool:
                futures = {}
                for item in batch_items:
                    path = item["path"]
                    url = response["urls"].get(item["upload_id"])
                    if not url:
                        raise RuntimeError(f"missing upload URL for {path.name}")
                    futures[pool.submit(put_file, validate_upload_url(url, upload_origin_allowlist), path)] = path
                for future in as_completed(futures):
                    path = futures[future]
                    future.result()
                    with progress_lock:
                        uploaded += 1
                        should_report = uploaded % args.progress_every == 0 or uploaded == len(files)
                    if should_report:
                        print(f"[{args.job_id}] uploaded {uploaded}/{len(files)}", flush=True)

    start = post_json(
        start_endpoint,
        {
            **start_processing_payload(
                args.job_id,
                args.modality,
                processing_mode,
                input_kind,
                0 if args.skip_upload else total_upload_bytes,
            ),
            "token": modal_auth_token,
        },
    )
    if start.get("status") != "started":
        raise RuntimeError(f"start failed: {start}")
    print(f"[{args.job_id}] started Modal processing", flush=True)

    deadline = time.time() + args.max_wait_seconds
    last_status = None
    while time.time() < deadline:
        status = post_json(status_endpoint, {"job_id": args.job_id, "token": modal_auth_token})
        if status != last_status:
            print(f"[{args.job_id}] status: {status}", flush=True)
            last_status = status
        if status.get("status") == "complete":
            if status.get("series_entry"):
                status["series_entry"] = normalize_series_entry(status.get("series_entry"), r2_base)
                print(f"[{args.job_id}] series returned by Modal status endpoint", flush=True)
            elif r2_base:
                series_url = f"{r2_base}/results/{urllib.parse.quote(args.job_id)}/series.json"
                try:
                    status["series_entry"] = normalize_series_entry(get_json(series_url), r2_base)
                    print(f"[{args.job_id}] series: {series_url}", flush=True)
                except urllib.error.HTTPError as exc:
                    print(f"[{args.job_id}] series fetch skipped: HTTP {exc.code} from {series_url}", flush=True)
            return status
        if status.get("status") == "error":
            raise RuntimeError(f"Modal processing failed: {status}")
        time.sleep(args.poll_seconds)
    raise TimeoutError(f"timed out waiting for {args.job_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload a local DICOM folder to Modal/R2 and poll for output.")
    _ = parser.add_argument("source", type=Path)
    _ = parser.add_argument("--job-id", required=True)
    _ = parser.add_argument("--modality", choices=["auto", "CT", "MR"], default="auto")
    _ = parser.add_argument(
        "--processing-mode",
        choices=list(PROCESSING_MODES),
        default="standard",
    )
    _ = parser.add_argument(
        "--input-kind",
        choices=["", *INPUT_KINDS],
        default="",
    )
    _ = parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    _ = parser.add_argument("--modal-base", default="")
    _ = parser.add_argument("--r2-public-url", default="")
    _ = parser.add_argument("--trusted-upload-origin", action="append", default=[])
    _ = parser.add_argument("--batch-size", type=int, default=450)
    _ = parser.add_argument("--upload-workers", type=int, default=8)
    _ = parser.add_argument("--skip-upload", action="store_true")
    _ = parser.add_argument("--progress-every", type=int, default=25)
    _ = parser.add_argument("--poll-seconds", type=int, default=10)
    _ = parser.add_argument("--max-wait-seconds", type=int, default=3600)
    args = parser.parse_args()

    result = submit(args)
    print(json.dumps(result, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
