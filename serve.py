"""
Tiny dev server for the MRI viewer.

Runs exactly like `python3 -m http.server 8000` for static files, but adds a
small JSON API so the Generate Analysis button in the viewer can actually
kick off analyze.py without the user dropping into a terminal.

Endpoints:
    POST /api/analyze?slug=<slug>    start analyze.py for one series
    GET  /api/analyze/status          which slugs are currently running +
                                      last line of stdout
    POST /api/ask                     body: {slug, slice, question, x, y} or {slug, slice, question, region:{x0,y0,x1,y1}}
                                      point-and-ask the configured local AI
                                      provider about a crop of a specific
                                      slice. Cached to
                                      data/<slug>_asks.json.
    POST /api/consult                 synthesize all per-slice findings
                                      into a consolidated recommendation.
                                      Cached to data/consult.json. Pass
                                      ?force=1 to regenerate.
    GET  /api/consult                 return the cached consult if any.

analyze.py is already idempotent: if a JSON sidecar already exists for the
slug, only missing slices are sent to the configured AI provider. That means
the button is safe to click — it never re-pays for work that is already
cached.

Run from the mri-viewer folder:
    python3 serve.py              # :8000
    python3 serve.py --port 8080
"""

import argparse
import http.server
import json
import os
import secrets
import ssl
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import parse_qs, urlparse

from ai_runtime import public_ai_status
from runtime_env import overlay_env

try:
    import certifi
except Exception:
    certifi = None

ROOT = Path(__file__).parent
DATA = ROOT / "data"
LOCAL_API_TOKEN = (os.environ.get("VIEWER_LOCAL_API_TOKEN") or "").strip() or secrets.token_urlsafe(24)
MODAL_FUNCTIONS = {
    "get_upload_urls": "get-upload-urls",
    "start_processing": "start-processing",
    "check_status": "check-status",
}
LOCAL_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
RATE_LIMITS = {
    "/api/analyze": (5, 60.0),
    "/api/ask": (20, 60.0),
}
PRIVATE_LOCAL_API_PATHS = {
    "/api/local-token",
    "/api/proxy-asset",
    "/api/analyze/status",
    "/api/consult",
}
PRIVATE_LOCAL_API_TOKEN_PATHS = {
    "/api/proxy-asset",
    "/api/analyze/status",
    "/api/consult",
}

def env_bool(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(value: str | None) -> list[str] | None:
    if value is None or value == "":
        return None
    return [item.strip() for item in value.split(",") if item.strip()]


def runtime_config() -> dict:
    try:
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    except Exception:
        config = {}
    env = overlay_env()
    for env_key, config_key in (
        ("R2_PUBLIC_URL", "r2PublicUrl"),
        ("SITE_NAME", "siteName"),
        ("VIEWER_DISCLAIMER", "disclaimer"),
    ):
        if env.get(env_key):
            config[config_key] = env[env_key]
    if modal_proxy_available():
        config["modalWebhookBase"] = "/api/cloud"
    trusted_upload_origins = env_list(env.get("TRUSTED_UPLOAD_ORIGINS"))
    if trusted_upload_origins is not None:
        config["trustedUploadOrigins"] = trusted_upload_origins
    features = dict(config.get("features") or {})
    for env_key, feature_key in (
        ("VIEWER_CLOUD_PROCESSING", "cloudProcessing"),
        ("VIEWER_AI_ANALYSIS", "aiAnalysis"),
    ):
        parsed = env_bool(env.get(env_key))
        if parsed is not None:
            features[feature_key] = parsed
    if features:
        config["features"] = features
    config["ai"] = public_ai_status(bool(features.get("aiAnalysis", True)), env=env)
    config["localAiAvailable"] = bool(config["ai"].get("ready"))
    return config

# Defer ask.py import so serve.py can start even if PIL isn't installed —
# /api/analyze and static files don't need it.
def _lazy_ask():
    import ask as ask_mod
    return ask_mod


def valid_slugs() -> set[str]:
    """Canonical set of series slugs from the manifest.

    Used as a hard whitelist before any untrusted slug value flows into a
    filesystem path or a subprocess argument. Also prevents slugs that
    look like CLI flags (e.g. "--force") from reaching analyze.py via
    argv position slot, which would otherwise trigger unintended flag
    handling in the child process.
    """
    try:
        m = json.loads((DATA / "manifest.json").read_text())
        return {s["slug"] for s in m.get("series", [])}
    except Exception:
        return set()


def modal_cloud_base() -> str:
    return (overlay_env().get("MODAL_WEBHOOK_BASE") or "").strip()


def modal_auth_token() -> str:
    return (overlay_env().get("MODAL_AUTH_TOKEN") or "").strip()


def modal_proxy_available() -> bool:
    return bool(modal_cloud_base() and modal_auth_token())


def modal_endpoint(base: str, function_name: str) -> str:
    suffix = MODAL_FUNCTIONS[function_name]
    raw = base.rstrip("/")
    parsed = urlparse(raw)
    host = parsed.netloc or parsed.path
    if host.endswith(".modal.run"):
        host = host.removesuffix(".modal.run")
    for known in MODAL_FUNCTIONS.values():
        if host.endswith(f"-{known}"):
            host = host[: -(len(known) + 1)]
            break
    return f"https://{host}-{suffix}.modal.run"


def proxy_modal_json(function_name: str, payload: dict, timeout: int = 60) -> tuple[int, dict]:
    base = modal_cloud_base()
    token = modal_auth_token()
    if not base or not token:
        return 503, {"error": "cloud processing is not configured"}
    req = urlrequest.Request(
        modal_endpoint(base, function_name),
        data=json.dumps({**payload, "token": token}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urlrequest.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except Exception:
            body = {"error": str(exc)}
        return exc.code, body
    except Exception as exc:
        return 502, {"error": str(exc)}

# slug -> {"proc": Popen, "last": str, "started": float}
RUNNING: dict = {}
LOCK = threading.Lock()
RATE_LIMIT_BUCKETS: dict[str, dict[str, float]] = {}
RATE_LIMIT_LOCK = threading.Lock()


def localhost_origin(origin: str) -> str:
    try:
        parsed = urlparse(origin)
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"}:
        return ""
    return origin if parsed.hostname in LOCAL_ORIGIN_HOSTS else ""


def is_same_origin(origin: str, host: str) -> bool:
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    return bool(host) and parsed.scheme in {"http", "https"} and parsed.netloc == host


def content_security_policy() -> str:
    return "; ".join([
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "script-src 'self' https://cdn.jsdelivr.net",
        "worker-src 'self' blob: https://cdn.jsdelivr.net",
        "style-src 'self'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' https:",
        "font-src 'self' data:",
    ])


def local_nostore_static_path(path: str) -> bool:
    return path in {"/", "/index.html", "/sw.js"} or path.endswith((".js", ".mjs", ".css", ".html"))


def https_origin(value: str | None) -> str:
    try:
        parsed = urlparse(str(value or "").strip())
    except Exception:
        return ""
    if parsed.scheme == "https" and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return ""


def manifest_proxy_origins(manifest_path: Path | None = None) -> set[str]:
    origins = set()
    path = manifest_path or (DATA / "manifest.json")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return origins
    for series in manifest.get("series", []) or []:
        if not isinstance(series, dict):
            continue
        for value in [
            series.get("sliceUrlBase"),
            series.get("rawUrl"),
            series.get("regionUrlBase"),
            series.get("regionMetaUrl"),
            *(series.get("overlayUrlBases", {}) or {}).values(),
        ]:
            origin = https_origin(value)
            if origin:
                origins.add(origin)
    return origins


def configured_proxy_origins(config: dict | None = None) -> set[str]:
    cfg = config or runtime_config()
    origins = manifest_proxy_origins()
    for value in [cfg.get("r2PublicUrl"), *(cfg.get("trustedUploadOrigins") or [])]:
        origin = https_origin(value)
        if origin:
            origins.add(origin)
    return origins


def allowed_proxy_asset_url(url: str, config: dict | None = None) -> str:
    try:
        parsed = urlparse(url)
    except Exception:
        return ""
    if parsed.scheme != "https" or not parsed.netloc:
        return ""
    origin = f"{parsed.scheme}://{parsed.netloc}"
    allowed_origins = configured_proxy_origins(config)
    if origin in allowed_origins:
        return url
    return ""


def proxy_asset_request(url: str) -> urlrequest.Request:
    return urlrequest.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (VoxelLab local asset proxy)"},
    )


def proxy_asset_ssl_context():
    context = ssl.create_default_context()
    cafile = None
    if certifi is not None:
        try:
            cafile = certifi.where()
        except Exception:
            cafile = None
    if cafile:
        context.load_verify_locations(cafile=cafile)
    return context


PROXY_ASSET_SSL_CONTEXT = proxy_asset_ssl_context()


def consume_rate_limit(path: str, client_key: str) -> tuple[bool, int]:
    capacity, window_seconds = RATE_LIMITS[path]
    refill_per_second = capacity / window_seconds
    now = time.monotonic()
    key = f"{path}:{client_key}"
    with RATE_LIMIT_LOCK:
        bucket = RATE_LIMIT_BUCKETS.get(key, {"tokens": float(capacity), "updated": now})
        tokens = min(float(capacity), bucket["tokens"] + (now - bucket["updated"]) * refill_per_second)
        if tokens < 1:
            RATE_LIMIT_BUCKETS[key] = {"tokens": tokens, "updated": now}
            retry_after = max(1, int((1 - tokens) / refill_per_second) + 1)
            return False, retry_after
        RATE_LIMIT_BUCKETS[key] = {"tokens": tokens - 1, "updated": now}
        return True, 0


def valid_cloud_upload_items(items) -> bool:
    if not isinstance(items, list) or not items:
        return False
    for item in items:
        if not isinstance(item, dict):
            return False
        upload_id = str(item.get("upload_id") or "").strip()
        filename = str(item.get("filename") or "").strip()
        if not upload_id or not filename:
            return False
    return True


def validate_cloud_proxy_payload(path: str, payload) -> tuple[int, dict] | None:
    if not isinstance(payload, dict):
        return 400, {"error": "expected JSON object body"}

    if path == "/api/cloud/get_upload_urls":
        if not valid_cloud_upload_items(payload.get("items")):
            return 400, {"error": "expected body {items:[{upload_id, filename}, ...]}"}
        return None

    job_id = str(payload.get("job_id") or "").strip()
    if not job_id:
        return 400, {"error": "missing job_id"}

    if path == "/api/cloud/start_processing":
        total_upload_bytes = payload.get("total_upload_bytes")
        if total_upload_bytes is not None:
            try:
                if int(total_upload_bytes) < 0:
                    raise ValueError()
            except (TypeError, ValueError):
                return 400, {"error": "total_upload_bytes must be a non-negative integer"}
    return None


def validate_ask_payload(body, known_slugs: set[str]) -> tuple[dict, tuple[int, dict] | None]:
    if not isinstance(body, dict):
        return {}, (400, {"error": "expected JSON object body"})
    try:
        slug = str(body["slug"])
        slice_idx = int(body["slice"])
        question = str(body["question"]).strip()
    except (KeyError, ValueError, TypeError):
        return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})

    has_region = body.get("region") is not None
    has_point = "x" in body or "y" in body
    if has_region == has_point:
        return {}, (400, {"error": "expected exactly one location: either {x, y} or {region:{x0,y0,x1,y1}}"})

    parsed = {
        "slug": slug,
        "slice_idx": slice_idx,
        "question": question,
        "x": None,
        "y": None,
        "region": None,
    }

    if has_region:
        try:
            reg = body["region"]
            x0 = int(reg["x0"])
            y0 = int(reg["y0"])
            x1 = int(reg["x1"])
            y1 = int(reg["y1"])
        except (KeyError, ValueError, TypeError):
            return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})
        if min(x0, y0, x1, y1) < 0:
            return {}, (400, {"error": "region coordinates must be non-negative integers"})
        if x1 < x0 or y1 < y0:
            return {}, (400, {"error": "region coordinates must define a non-empty top-left to bottom-right box"})
        parsed["region"] = (x0, y0, x1, y1)
    else:
        try:
            x = int(body["x"])
            y = int(body["y"])
        except (KeyError, ValueError, TypeError):
            return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})
        parsed["x"] = x
        parsed["y"] = y

    if slug not in known_slugs:
        return {}, (400, {"error": f"unknown slug: {slug}"})
    if slice_idx < 0:
        return {}, (400, {"error": "slice must be a non-negative integer"})
    if not question:
        return {}, (400, {"error": "empty question"})
    if len(question) > 2000:
        return {}, (400, {"error": "question too long (max 2000 chars)"})
    return parsed, None


def _stream_tail(proc: subprocess.Popen, slug: str) -> None:
    """Consume the child's stdout so we can surface its most recent line to
    the polling client. We don't buffer the whole thing, just the last line.
    """
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        if not line:
            continue
        with LOCK:
            entry = RUNNING.get(slug)
            if entry is not None:
                entry["last"] = line
    _ = proc.wait()
    with LOCK:
        RUNNING.pop(slug, None)


def series_meta(slug: str) -> dict | None:
    try:
        m = json.loads((DATA / "manifest.json").read_text())
    except Exception:
        return None
    return next((s for s in m.get("series", []) if s.get("slug") == slug), None)


def parse_analysis_slices(raw: str, slug: str) -> tuple[list[int] | None, str | None]:
    meta = series_meta(slug)
    if not meta:
        return None, f"unknown slug: {slug}"
    total = int(meta.get("slices", 0))
    selected: set[int] = set()
    try:
        for raw_part in raw.split(","):
            part = raw_part.strip()
            if not part:
                continue
            if "-" in part:
                start_s, end_s = part.split("-", 1)
                start, end = int(start_s), int(end_s)
                if end < start:
                    return None, f"slice range is reversed: {part}"
                values = range(start, end + 1)
            else:
                values = [int(part)]
            for value in values:
                if value < 0 or value >= total:
                    return None, f"slice out of range: {value} (valid 0-{total - 1})"
                selected.add(value)
    except ValueError:
        return None, "slices must be zero-based integers or ranges"
    if not selected:
        return None, "no slices selected"
    return sorted(selected), None


def start_analysis(slug: str, force: bool = False, slices: list[int] | None = None) -> tuple[int, str]:
    # Strict whitelist: without this, a slug of "--force" would be
    # interpreted as a flag by analyze.py's argparse and re-run everything.
    if slug not in valid_slugs():
        return 400, f"unknown slug: {slug}"
    with LOCK:
        if slug in RUNNING:
            return 409, f"already running: {slug}"
    # "--" separator tells analyze.py's argparse that everything after is
    # positional, not a flag. Belt and suspenders on top of the whitelist.
    cmd = [sys.executable, "-u", str(ROOT / "analyze.py")]
    if force:
        cmd.append("--force")
    if slices is not None:
        cmd += ["--slices", ",".join(str(s) for s in slices)]
    cmd += ["--", slug]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        cwd=str(ROOT),
    )
    with LOCK:
        RUNNING[slug] = {"proc": proc, "last": "starting…"}
    threading.Thread(target=_stream_tail, args=(proc, slug), daemon=True).start()
    return 202, f"started: {slug}{' (force)' if force else ''}"


def status_payload() -> dict:
    with LOCK:
        return {
            slug: {
                "running": True,
                "last": entry["last"],
            }
            for slug, entry in RUNNING.items()
        }


def consult_ready() -> bool:
    try:
        manifest = json.loads((DATA / "manifest.json").read_text())
    except Exception:
        return False
    for series in manifest.get("series", []):
        slug = str((series or {}).get("slug") or "").strip()
        if not slug:
            continue
        try:
            analysis = json.loads((DATA / f"{slug}_analysis.json").read_text())
        except Exception:
            continue
        if analysis.get("findings"):
            return True
    return False


def ai_post_guard(config: dict | None = None) -> tuple[int, dict] | None:
    status = dict((config or runtime_config()).get("ai") or {})
    if not status.get("enabled", True):
        return 503, {"error": "AI features are disabled in config."}
    if status.get("ready"):
        return None
    issues = status.get("issues") or ["AI provider is not ready."]
    return 503, {
        "error": f"AI unavailable: {'; '.join(str(issue) for issue in issues)}",
        "provider": status.get("provider"),
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    # Serve only from the mri-viewer folder regardless of where we were
    # launched. `directory=` was added in 3.7.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        origin = localhost_origin(self.headers.get("Origin") or "")
        parsed = urlparse(getattr(self, "path", "") or "")
        if origin:
            if parsed.path not in PRIVATE_LOCAL_API_PATHS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-VoxelLab-Local-Token")
                self.send_header("Vary", "Origin")
        if local_nostore_static_path(parsed.path):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", content_security_policy())
        super().end_headers()

    def _json(self, code: int, body) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            _ = self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # Client disconnected before reading the JSON body.
            return

    def _has_local_api_token(self) -> bool:
        token = self.headers.get("X-VoxelLab-Local-Token") or ""
        return bool(token) and secrets.compare_digest(token, LOCAL_API_TOKEN)

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode() or "{}")
        except Exception:
            return {}

    def _bytes(self, code: int, body: bytes, content_type: str, *, cache_control: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.end_headers()
        try:
            _ = self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _rate_limit_key(self) -> str:
        if isinstance(getattr(self, "client_address", None), tuple) and self.client_address:
            return str(self.client_address[0])
        return "local"

    def _enforce_rate_limit(self, path: str) -> tuple[int, dict] | None:
        allowed, retry_after = consume_rate_limit(path, self._rate_limit_key())
        if allowed:
            return None
        return 429, {"error": "rate limit exceeded", "retryAfterSeconds": retry_after}

    def _private_api_origin_guard(self, parsed) -> tuple[int, dict] | None:
        if parsed.path not in PRIVATE_LOCAL_API_PATHS:
            return None
        origin = self.headers.get("Origin") or ""
        host = self.headers.get("Host") or ""
        if not origin:
            # Shape: "same-origin" for fetch(), "none" for browser navigation.
            sec_fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
            if sec_fetch_site in {"same-origin", "none"}:
                return None
            return 403, {"error": f"{parsed.path} requires a same-origin browser context"}
        if is_same_origin(origin, host):
            return None
        return 403, {"error": f"{parsed.path} is same-origin only"}

    def do_OPTIONS(self):
        parsed = urlparse(getattr(self, "path", "") or "")
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        current_config = runtime_config()
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        if parsed.path in {
            "/api/analyze", "/api/ask", "/api/consult",
            "/api/cloud/get_upload_urls", "/api/cloud/start_processing", "/api/cloud/check_status",
        } and not self._has_local_api_token():
            self._json(403, {"error": "missing or invalid local api token"})
            return
        if parsed.path in {"/api/analyze", "/api/ask", "/api/consult"}:
            ai_guard = ai_post_guard(current_config)
            if ai_guard is not None:
                self._json(*ai_guard)
                return

        if parsed.path == "/api/analyze":
            limited = self._enforce_rate_limit(parsed.path)
            if limited is not None:
                self._json(*limited)
                return
            slug = (qs.get("slug") or [""])[0]
            force = (qs.get("force") or ["0"])[0] in ("1", "true")
            raw_slices = (qs.get("slices") or [""])[0]
            if not slug:
                self._json(400, {"error": "missing slug"})
                return
            slices = None
            if raw_slices:
                slices, error = parse_analysis_slices(raw_slices, slug)
                if error:
                    self._json(400, {"error": error})
                    return
            code, msg = start_analysis(slug, force=force, slices=slices)
            self._json(code, {"message": msg, "slug": slug})
            return

        if parsed.path == "/api/ask":
            limited = self._enforce_rate_limit(parsed.path)
            if limited is not None:
                self._json(*limited)
                return
            body = self._read_json_body()
            ask_req, invalid = validate_ask_payload(body, valid_slugs())
            if invalid is not None:
                self._json(*invalid)
                return
            try:
                if ask_req["region"] is not None:
                    result = _lazy_ask().ask(
                        ask_req["slug"], ask_req["slice_idx"], ask_req["question"], region=ask_req["region"],
                    )
                else:
                    result = _lazy_ask().ask(
                        ask_req["slug"],
                        ask_req["slice_idx"],
                        ask_req["question"],
                        x=ask_req["x"],
                        y=ask_req["y"],
                    )
                self._json(200, result)
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if parsed.path == "/api/consult":
            force = (qs.get("force") or ["0"])[0] in ("1", "true")
            if not consult_ready():
                self._json(400, {"error": "no analysis data to consult on — run analyze.py first"})
                return
            try:
                result = _lazy_ask().consult(force=force)
                self._json(200, result)
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"error": str(e)})
            return

        if parsed.path == "/api/cloud/get_upload_urls":
            payload = self._read_json_body()
            invalid = validate_cloud_proxy_payload(parsed.path, payload)
            if invalid is not None:
                self._json(*invalid)
                return
            code, body = proxy_modal_json("get_upload_urls", payload)
            self._json(code, body)
            return

        if parsed.path == "/api/cloud/start_processing":
            payload = self._read_json_body()
            invalid = validate_cloud_proxy_payload(parsed.path, payload)
            if invalid is not None:
                self._json(*invalid)
                return
            code, body = proxy_modal_json("start_processing", payload, timeout=120)
            self._json(code, body)
            return

        if parsed.path == "/api/cloud/check_status":
            payload = self._read_json_body()
            invalid = validate_cloud_proxy_payload(parsed.path, payload)
            if invalid is not None:
                self._json(*invalid)
                return
            code, body = proxy_modal_json("check_status", payload)
            self._json(code, body)
            return

        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        if parsed.path in PRIVATE_LOCAL_API_TOKEN_PATHS and not self._has_local_api_token():
            self._json(403, {"error": "missing or invalid local api token"})
            return
        if parsed.path == "/api/local-token":
            self._json(200, {"localApiToken": LOCAL_API_TOKEN})
            return
        if parsed.path == "/config.json":
            self._json(200, runtime_config())
            return
        if parsed.path == "/api/proxy-asset":
            current_config = runtime_config()
            target = allowed_proxy_asset_url((parse_qs(parsed.query).get("url") or [""])[0], current_config)
            if not target:
                self._json(400, {"error": "invalid or untrusted asset url"})
                return
            try:
                with urlrequest.urlopen(
                    proxy_asset_request(target),
                    timeout=30,
                    context=PROXY_ASSET_SSL_CONTEXT,
                ) as response:
                    body = response.read()
                    content_type = response.headers.get_content_type() or "application/octet-stream"
                    self._bytes(200, body, content_type, cache_control="private, max-age=60")
                    return
            except urlrequest.HTTPError as exc:
                self._json(exc.code, {"error": f"asset fetch failed: {exc.reason}"})
                return
            except Exception as exc:
                self._json(502, {"error": f"asset fetch failed: {exc}"})
                return
        if parsed.path == "/api/analyze/status":
            if not self._has_local_api_token():
                self._json(403, {"error": "missing or invalid local api token"})
                return
            self._json(200, status_payload())
            return
        if parsed.path == "/api/consult":
            if not self._has_local_api_token():
                self._json(403, {"error": "missing or invalid local api token"})
                return
            # Return the cached consult if it exists, {} otherwise
            p = DATA / "consult.json"
            if p.exists():
                try:
                    self._json(200, {"cached": True, **json.loads(p.read_text())})
                    return
                except Exception:
                    pass
            self._json(200, {})
            return
        # Everything else → static file under ROOT
        return super().do_GET()

    # Quieter access log so the terminal isn't drowned in image requests.
    def log_message(self, format, *args):
        msg = format % args
        if any(marker in msg for marker in ("favicon.ico", "_asks.json", "_analysis.json")) and " 404 " in msg:
            return
        if "/api/" in msg or any(code in msg for code in (" 404 ", " 500 ", " 409 ")):
            _ = sys.stderr.write(f"[serve] {msg}\n")


def main() -> bool:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument("--port", type=int, default=8000)
    _ = ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    try:
        server = http.server.ThreadingHTTPServer((args.bind, args.port), Handler)
    except OSError as e:
        print(f"ERROR: could not bind {args.bind}:{args.port}: {e}", file=sys.stderr)
        return False
    print(f"MRI viewer → http://{args.bind}:{args.port}")
    print(f"Serving:    {ROOT}")
    print(f"API:        POST /api/analyze?slug=<slug>  +  GET /api/analyze/status")
    print("Local API:  private helper routes require a same-origin browser context; proxy/status/consult also require the runtime token from /api/local-token")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
