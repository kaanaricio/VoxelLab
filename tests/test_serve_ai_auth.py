from __future__ import annotations

import io
import json
from pathlib import Path
import types

import serve


def test_ai_post_guard_rejects_disabled_ai() -> None:
    code, body = serve.ai_post_guard({"ai": {"enabled": False}})

    assert code == 503
    assert "disabled" in body["error"].lower()


def test_ai_post_guard_reports_unready_provider() -> None:
    code, body = serve.ai_post_guard({"ai": {"enabled": True, "ready": False, "provider": "codex", "issues": ["config broken"]}})

    assert code == 503
    assert body["provider"] == "codex"
    assert "config broken" in body["error"]


def test_handler_local_api_token_accepts_matching_header() -> None:
    handler = object.__new__(serve.Handler)
    handler.headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}

    assert handler._has_local_api_token() is True


def test_handler_local_api_token_rejects_missing_header() -> None:
    handler = object.__new__(serve.Handler)
    handler.headers = {}

    assert handler._has_local_api_token() is False


def make_handler(path: str, headers: dict[str, str] | None = None, body: bytes = b"") -> tuple[serve.Handler, dict]:
    captured: dict = {}
    handler = object.__new__(serve.Handler)
    handler.path = path
    handler.headers = headers or {}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler._json = lambda code, body: captured.update({"code": code, "body": body})
    return handler, captured


def test_runtime_config_overlays_env_proxy_and_feature_flags(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "config.json").write_text(json.dumps({
        "modalWebhookBase": "https://remote.example",
        "r2PublicUrl": "https://static.example",
        "trustedUploadOrigins": ["https://static-upload.example"],
        "siteName": "VoxelLab Base",
        "disclaimer": "Base disclaimer",
        "features": {
            "cloudProcessing": True,
            "aiAnalysis": False,
        },
    }))
    env = {
        "MODAL_WEBHOOK_BASE": "https://example-org--medical-imaging-pipeline.modal.run",
        "MODAL_AUTH_TOKEN": "modal-auth-token",
        "TRUSTED_UPLOAD_ORIGINS": "https://upload-a.example, https://upload-b.example",
        "R2_PUBLIC_URL": "https://public-r2.example",
        "SITE_NAME": "VoxelLab Local",
        "VIEWER_DISCLAIMER": "Local disclaimer",
        "VIEWER_CLOUD_PROCESSING": "false",
        "VIEWER_AI_ANALYSIS": "true",
    }
    ai_status = {
        "enabled": True,
        "provider": "codex",
        "ready": False,
        "issues": ["missing key"],
    }
    called: dict = {}

    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: env.copy())

    def fake_public_ai_status(enabled: bool, env: dict | None = None):
        called["enabled"] = enabled
        called["env"] = env
        return ai_status

    monkeypatch.setattr(serve, "public_ai_status", fake_public_ai_status)

    config = serve.runtime_config()

    assert config["modalWebhookBase"] == "/api/cloud"
    assert config["trustedUploadOrigins"] == ["https://upload-a.example", "https://upload-b.example"]
    assert config["r2PublicUrl"] == "https://public-r2.example"
    assert config["siteName"] == "VoxelLab Local"
    assert config["disclaimer"] == "Local disclaimer"
    assert config["features"] == {
        "cloudProcessing": False,
        "aiAnalysis": True,
    }
    assert config["ai"] == ai_status
    assert config["localAiAvailable"] is False
    assert called["enabled"] is True
    assert called["env"]["MODAL_AUTH_TOKEN"] == "modal-auth-token"
    assert "localApiToken" not in config


def test_do_get_config_json_returns_runtime_config(monkeypatch) -> None:
    expected = {"siteName": "VoxelLab"}
    handler, captured = make_handler("/config.json")
    monkeypatch.setattr(serve, "runtime_config", lambda: expected)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": expected}


def test_do_get_local_token_returns_same_origin_token() -> None:
    handler, captured = make_handler("/api/local-token", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {"localApiToken": serve.LOCAL_API_TOKEN}}


def test_do_get_proxy_asset_rejects_untrusted_target(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fevil.example%2Fdata%2Fa.png",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "runtime_config", lambda: {
        "r2PublicUrl": "https://pub.example/assets",
        "trustedUploadOrigins": ["https://uploads.example"],
    })

    serve.Handler.do_GET(handler)

    assert captured == {"code": 400, "body": {"error": "invalid or untrusted asset url"}}


def test_do_get_analyze_status_rejects_missing_local_api_token() -> None:
    handler, captured = make_handler("/api/analyze/status", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_get_proxy_asset_rejects_missing_local_api_token() -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png",
        headers={"Sec-Fetch-Site": "same-origin"},
    )

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_post_cloud_proxy_rejects_missing_local_api_token(monkeypatch) -> None:
    handler, captured = make_handler("/api/cloud/get_upload_urls")
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_post_cloud_proxy_forwards_body_with_runtime_token(monkeypatch) -> None:
    body = b'{"job_id":"job_123","items":[{"upload_id":"f000000"}]}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/start_processing", headers=headers, body=body)
    seen: dict = {}
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    def fake_proxy(function_name: str, payload: dict, timeout: int = 60):
        seen["function_name"] = function_name
        seen["payload"] = payload
        seen["timeout"] = timeout
        return 200, {"status": "started"}

    monkeypatch.setattr(serve, "proxy_modal_json", fake_proxy)

    serve.Handler.do_POST(handler)

    assert seen == {
        "function_name": "start_processing",
        "payload": {"job_id": "job_123", "items": [{"upload_id": "f000000"}]},
        "timeout": 120,
    }
    assert captured == {"code": 200, "body": {"status": "started"}}


def test_do_post_cloud_proxy_rejects_invalid_upload_url_payload(monkeypatch) -> None:
    body = b'{"items":[{"filename":"slice.dcm"}]}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/get_upload_urls", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "expected body {items:[{upload_id, filename}, ...]}"},
    }


def test_do_post_cloud_proxy_rejects_missing_job_id(monkeypatch) -> None:
    body = b'{}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/check_status", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "missing job_id"}}


def test_do_post_cloud_proxy_rejects_negative_upload_bytes(monkeypatch) -> None:
    body = b'{"job_id":"job_123","total_upload_bytes":-1}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/start_processing", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "total_upload_bytes must be a non-negative integer"},
    }


def test_do_post_analyze_rejects_unknown_slug(monkeypatch) -> None:
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    handler, captured = make_handler("/api/analyze?slug=missing", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "start_analysis", lambda slug, force=False, slices=None: (400, f"unknown slug: {slug}"))

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"message": "unknown slug: missing", "slug": "missing"}}


def test_do_post_analyze_parses_slice_ranges_before_starting(monkeypatch) -> None:
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    handler, captured = make_handler("/api/analyze?slug=scan&slices=0,2-3&force=1", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "series_meta", lambda slug: {"slug": slug, "slices": 5})
    seen = {}

    def fake_start_analysis(slug: str, force: bool = False, slices=None):
      seen["slug"] = slug
      seen["force"] = force
      seen["slices"] = slices
      return 202, "started: scan (force)"

    monkeypatch.setattr(serve, "start_analysis", fake_start_analysis)

    serve.Handler.do_POST(handler)

    assert seen == {"slug": "scan", "force": True, "slices": [0, 2, 3]}
    assert captured == {"code": 202, "body": {"message": "started: scan (force)", "slug": "scan"}}


def test_do_get_analyze_status_returns_running_payload(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/analyze/status",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "status_payload", lambda: {"scan": {"running": True, "last": "working"}})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {"scan": {"running": True, "last": "working"}}}


def test_do_get_consult_returns_cached_consult(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "consult.json").write_text(json.dumps({"impression": "Stable.", "ask_radiologist": [], "limitations": "None."}))
    handler, captured = make_handler(
        "/api/consult",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured == {
        "code": 200,
        "body": {"cached": True, "impression": "Stable.", "ask_radiologist": [], "limitations": "None."},
    }


def test_do_get_consult_returns_empty_on_invalid_cache(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "consult.json").write_text("[1,2,3]")
    handler, captured = make_handler(
        "/api/consult",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {}}


def test_do_post_consult_forwards_force_flag(monkeypatch) -> None:
    headers = {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
    }
    handler, captured = make_handler("/api/consult?force=1", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "consult_ready", lambda: True)
    seen = {}

    class FakeAsk:
        @staticmethod
        def consult(force=False):
            seen["force"] = force
            return {"impression": "ok", "ask_radiologist": [], "limitations": ""}

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert seen == {"force": True}
    assert captured == {"code": 200, "body": {"impression": "ok", "ask_radiologist": [], "limitations": ""}}


def test_do_post_consult_rejects_when_no_analysis_is_available(monkeypatch) -> None:
    headers = {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
    }
    handler, captured = make_handler("/api/consult", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "consult_ready", lambda: False)

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "no analysis data to consult on — run analyze.py first"}}


def test_do_post_ask_rejects_empty_question(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":0,"question":"   ","x":1,"y":2}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "empty question"}}


def test_do_post_ask_forwards_region_payload(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","region":{"x0":1,"y0":2,"x1":5,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})
    seen = {}

    class FakeAsk:
        @staticmethod
        def ask(slug, slice_idx, question, region=None):
            seen["slug"] = slug
            seen["slice_idx"] = slice_idx
            seen["question"] = question
            seen["region"] = region
            return {"answer": "ok"}

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert seen == {
        "slug": "scan",
        "slice_idx": 4,
        "question": "what is this?",
        "region": (1, 2, 5, 6),
    }
    assert captured == {"code": 200, "body": {"answer": "ok"}}


def test_do_post_ask_rejects_ambiguous_point_and_region_payload(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","x":1,"y":2,"region":{"x0":1,"y0":2,"x1":5,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "expected exactly one location: either {x, y} or {region:{x0,y0,x1,y1}}"},
    }


def test_do_post_ask_rejects_inverted_region_box(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","region":{"x0":5,"y0":2,"x1":1,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "region coordinates must define a non-empty top-left to bottom-right box"},
    }


def test_do_post_ask_rejects_negative_slice(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":-1,"question":"what is this?","x":1,"y":2}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "slice must be a non-negative integer"}}


def test_json_writer_ignores_broken_pipe() -> None:
    handler = object.__new__(serve.Handler)
    handler.send_response = lambda code: None
    handler.send_header = lambda key, value: None
    handler.end_headers = lambda: None
    handler.wfile = types.SimpleNamespace(write=lambda payload: (_ for _ in ()).throw(BrokenPipeError()))

    serve.Handler._json(handler, 200, {"ok": True})


def test_log_message_suppresses_optional_sidecar_404(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    writes: list[str] = []
    monkeypatch.setattr(serve.sys, "stderr", types.SimpleNamespace(write=writes.append))

    serve.Handler.log_message(handler, '"GET /data/example_analysis.json HTTP/1.1" 404 -')

    assert writes == []


def test_log_message_keeps_unexpected_404(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    writes: list[str] = []
    monkeypatch.setattr(serve.sys, "stderr", types.SimpleNamespace(write=writes.append))

    serve.Handler.log_message(handler, '"GET /missing.json HTTP/1.1" 404 -')

    assert writes == ['[serve] "GET /missing.json HTTP/1.1" 404 -\n']


def test_consume_rate_limit_enforces_capacity(monkeypatch) -> None:
    serve.RATE_LIMIT_BUCKETS.clear()
    times = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    monkeypatch.setattr(serve.time, "monotonic", lambda: next(times))

    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    allowed, retry_after = serve.consume_rate_limit("/api/analyze", "127.0.0.1")
    assert allowed is False
    assert retry_after >= 1


def test_enforce_rate_limit_returns_retry_hint(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    monkeypatch.setattr(handler, "_rate_limit_key", lambda: "local")
    monkeypatch.setattr(serve, "consume_rate_limit", lambda path, key: (False, 12))

    assert handler._enforce_rate_limit("/api/ask") == (
        429,
        {"error": "rate limit exceeded", "retryAfterSeconds": 12},
    )


def test_localhost_origin_allows_only_loopback_hosts() -> None:
    assert serve.localhost_origin("http://localhost:8000") == "http://localhost:8000"
    assert serve.localhost_origin("https://127.0.0.1:3000") == "https://127.0.0.1:3000"
    assert serve.localhost_origin("https://evil.example") == ""


def test_allowed_proxy_asset_url_allows_only_configured_https_origins() -> None:
    config = {
        "r2PublicUrl": "https://pub.example/assets",
        "trustedUploadOrigins": ["https://uploads.example"],
    }

    assert serve.allowed_proxy_asset_url("https://pub.example/data/a.png", config) == "https://pub.example/data/a.png"
    assert serve.allowed_proxy_asset_url("https://uploads.example/file.dcm", config) == "https://uploads.example/file.dcm"
    assert serve.allowed_proxy_asset_url("https://evil.example/data/a.png", config) == ""
    assert serve.allowed_proxy_asset_url("http://pub.example/data/a.png", config) == ""


def test_configured_proxy_origins_include_manifest_remote_asset_hosts(tmp_path: Path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    _ = manifest.write_text(json.dumps({
        "patient": "anonymous",
        "studyDate": "",
        "series": [{
            "slug": "cloud_ct",
            "sliceUrlBase": "https://pub-manifest.example/data/cloud_ct",
            "rawUrl": "https://raw-manifest.example/cloud_ct.raw.zst",
            "regionMetaUrl": "https://labels.example/cloud_ct_regions.json",
            "overlayUrlBases": {
                "cloud_ct_sym": "https://sym.example/data/cloud_ct",
            },
        }],
    }), encoding="utf-8")
    monkeypatch.setattr(serve, "DATA", tmp_path)

    origins = serve.configured_proxy_origins({})

    assert "https://pub-manifest.example" in origins
    assert "https://raw-manifest.example" in origins
    assert "https://labels.example" in origins
    assert "https://sym.example" in origins


def test_allowed_proxy_asset_url_rejects_all_when_no_proxy_origins_are_configured() -> None:
    assert serve.allowed_proxy_asset_url("https://pub.example/data/a.png", {}) == ""


def test_proxy_asset_request_uses_browser_user_agent() -> None:
    req = serve.proxy_asset_request("https://pub.example/data/a.png")

    assert req.full_url == "https://pub.example/data/a.png"
    assert req.get_header("User-agent") == "Mozilla/5.0 (VoxelLab local asset proxy)"


def test_end_headers_adds_localhost_cors_and_csp(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.path = "/index.html"
    handler.headers = {"Origin": "http://localhost:8000"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert ("Access-Control-Allow-Origin", "http://localhost:8000") in headers
    assert ("Access-Control-Allow-Methods", "GET, POST, OPTIONS") in headers
    assert ("Access-Control-Allow-Headers", "Content-Type, X-VoxelLab-Local-Token") in headers
    assert ("Vary", "Origin") in headers
    csp = dict(headers)["Content-Security-Policy"]
    assert "script-src 'self' https://cdn.jsdelivr.net" in csp


def test_end_headers_skips_cors_for_sensitive_local_api_routes(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.path = "/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png"
    handler.headers = {"Origin": "http://localhost:8000"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert "Access-Control-Allow-Origin" not in dict(headers)
    assert "Content-Security-Policy" in dict(headers)


def test_end_headers_skips_cors_for_non_local_origin(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.headers = {"Origin": "https://evil.example"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert "Access-Control-Allow-Origin" not in dict(headers)
    assert "Content-Security-Policy" in dict(headers)


def test_do_options_returns_204(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    seen: dict = {}
    handler.send_response = lambda code: seen.setdefault("code", code)
    handler.send_header = lambda key, value: seen.setdefault("headers", []).append((key, value))
    handler.end_headers = lambda: seen.setdefault("ended", True)

    serve.Handler.do_OPTIONS(handler)

    assert seen["code"] == 204
    assert ("Content-Length", "0") in seen["headers"]
    assert seen["ended"] is True


def test_private_local_api_options_reject_cross_origin_with_403() -> None:
    handler, captured = make_handler(
        "/api/consult",
        headers={"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_OPTIONS(handler)

    assert captured == {"code": 403, "body": {"error": "/api/consult is same-origin only"}}


def test_private_local_api_get_rejects_cross_origin_with_403() -> None:
    handler, captured = make_handler(
        "/api/local-token",
        headers={"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "/api/local-token is same-origin only"}}


def test_private_local_api_get_rejects_missing_browser_context_headers() -> None:
    handler, captured = make_handler("/api/local-token")

    serve.Handler.do_GET(handler)

    assert captured == {
        "code": 403,
        "body": {"error": "/api/local-token requires a same-origin browser context"},
    }


def test_private_local_api_get_allows_same_origin_fetch_metadata_without_origin() -> None:
    handler, captured = make_handler("/api/local-token", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {"localApiToken": serve.LOCAL_API_TOKEN}}
