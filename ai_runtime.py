"""Provider-neutral AI runtime for VoxelLab local tooling."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from runtime_env import ROOT, overlay_env

SUPPORTED_PROVIDERS = {"claude", "codex"}

DEFAULT_MODELS = {
    "claude": "",
    "codex": "",
}


def configured_provider(provider: str | None = None, env: dict[str, str] | None = None) -> str:
    raw = (provider or overlay_env(env).get("VOXELLAB_AI_PROVIDER") or "claude").strip().lower()
    if raw not in SUPPORTED_PROVIDERS:
        raise RuntimeError(
            f"unsupported AI provider {raw!r}; expected one of {sorted(SUPPORTED_PROVIDERS)}"
        )
    return raw


def resolve_model(model: str | None = None, provider: str | None = None, env: dict[str, str] | None = None) -> str:
    env_map = overlay_env(env)
    chosen_provider = configured_provider(provider, env_map)
    return (model or env_map.get("VOXELLAB_AI_MODEL") or DEFAULT_MODELS[chosen_provider] or "").strip()


def _compact_error_text(text: str, limit: int = 240) -> str:
    one_line = " ".join(text.split())
    return one_line[:limit] + ("..." if len(one_line) > limit else "")


def _run_status(cmd: list[str], timeout: int = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=overlay_env(env))


def claude_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("claude", path=env_map.get("PATH")) is None:
        return {
            "provider": "claude",
            "ready": False,
            "issues": ["`claude` CLI not found on PATH"],
            "auth_mode": None,
            "status_source": "missing_cli",
        }
    try:
        result = _run_status(["claude", "auth", "status"], env=env_map)
    except Exception as exc:
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"could not read `claude auth status`: {exc}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    if result.returncode != 0:
        detail = _compact_error_text(result.stderr or result.stdout or str(result.returncode))
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"`claude auth status` failed: {detail}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    try:
        payload = json.loads(result.stdout or "{}")
    except Exception as exc:
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"could not parse `claude auth status`: {exc}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    if not payload.get("loggedIn"):
        return {
            "provider": "claude",
            "ready": False,
            "issues": ["Claude CLI is not logged in; run `claude auth login`."],
            "auth_mode": payload.get("authMethod"),
            "status_source": "status_command",
        }
    auth_method = payload.get("authMethod")
    return {
        "provider": "claude",
        "ready": True,
        "issues": [],
        "auth_mode": auth_method if isinstance(auth_method, str) else None,
        "status_source": "status_command",
    }


def codex_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("codex", path=env_map.get("PATH")) is None:
        return {
            "provider": "codex",
            "ready": False,
            "issues": ["`codex` CLI not found on PATH"],
            "auth_mode": None,
            "status_source": "missing_cli",
        }
    try:
        result = _run_status(["codex", "login", "status"], env=env_map)
    except Exception as exc:
        return {
            "provider": "codex",
            "ready": False,
            "issues": [f"could not read `codex login status`: {exc}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    status_text = result.stderr or result.stdout or ""
    if "Error loading configuration:" in status_text:
        return {
            "provider": "codex",
            "ready": False,
            "issues": [_compact_error_text(status_text)],
            "auth_mode": None,
            "status_source": "config_error",
        }
    if env_map.get("CODEX_API_KEY"):
        return {
            "provider": "codex",
            "ready": True,
            "issues": [],
            "auth_mode": "api_key_env",
            "status_source": "status_command",
        }
    if result.returncode != 0:
        detail = _compact_error_text(status_text or str(result.returncode))
        return {
            "provider": "codex",
            "ready": False,
            "issues": [f"`codex login status` failed: {detail}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    return {
        "provider": "codex",
        "ready": True,
        "issues": [],
        "auth_mode": "login_status",
        "status_source": "status_command",
    }


def provider_status(provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    try:
        chosen = configured_provider(provider, env_map)
    except RuntimeError as exc:
        raw = (provider or env_map.get("VOXELLAB_AI_PROVIDER") or "").strip().lower() or None
        return {
            "provider": raw,
            "ready": False,
            "issues": [str(exc)],
            "auth_mode": None,
            "status_source": "config_error",
        }
    return claude_status(env) if chosen == "claude" else codex_status(env)


def public_ai_status(enabled: bool, provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    if not enabled:
        env_map = overlay_env(env)
        raw = (provider or env_map.get("VOXELLAB_AI_PROVIDER") or "claude").strip().lower() or None
        return {
            "enabled": False,
            "provider": raw,
            "ready": False,
            "issues": ["AI features are disabled in config."],
            "auth_mode": None,
            "status_source": "disabled",
        }
    status = provider_status(provider, env)
    return {"enabled": True, **status}


def require_provider_ready(provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    status = provider_status(provider, env)
    if not status["ready"]:
        issues = "; ".join(status.get("issues") or ["provider not ready"])
        raise RuntimeError(f"{status['provider']} provider not ready: {issues}")
    return status


def _claude_prompt(prompt: str, images: list[Path]) -> str:
    if not images:
        return prompt
    lines = ["Read these local image files before answering:"]
    lines.extend(f"- {path.resolve()}" for path in images)
    lines.append("")
    lines.append(prompt)
    return "\n".join(lines)


def _run_claude(prompt: str, system: str, schema: dict[str, Any], model: str, images: list[Path], timeout: int) -> dict[str, Any]:
    cmd = [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--allowedTools",
        "Read",
        "--append-system-prompt",
        system,
        "--json-schema",
        json.dumps(schema),
        "--no-session-persistence",
    ]
    if model:
        cmd[4:4] = ["--model", model]
    proc = subprocess.run(
        cmd,
        input=_claude_prompt(prompt, images),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=overlay_env(),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"claude returned non-JSON: {exc}\n{proc.stdout[:400]}") from exc
    if payload.get("is_error"):
        raise RuntimeError(f"claude reported error: {payload.get('result', '')}")
    out = payload.get("structured_output")
    if out is None:
        raise RuntimeError(f"no structured_output in response: {json.dumps(payload)[:400]}")
    return out


def _codex_prompt(system: str, prompt: str, images: list[Path]) -> str:
    image_note = ""
    if images:
        image_note = "\nAttached images are part of the input context. Use them directly.\n"
    return f"System instructions:\n{system}\n{image_note}\nUser task:\n{prompt}\n"


def _run_codex(prompt: str, system: str, schema: dict[str, Any], model: str, images: list[Path], timeout: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="voxellab-codex-") as tmpdir:
        tmp = Path(tmpdir)
        schema_path = tmp / "schema.json"
        out_path = tmp / "out.json"
        _ = schema_path.write_text(json.dumps(schema, indent=2), encoding="utf-8")
        cmd = [
            "codex",
            "exec",
            "--sandbox",
            "read-only",
            "--ask-for-approval",
            "never",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(out_path),
            "--color",
            "never",
            "--ephemeral",
        ]
        if model:
            cmd += ["--model", model]
        for image in images:
            cmd += ["--image", str(image.resolve())]
        cmd.append("-")
        proc = subprocess.run(
            cmd,
            input=_codex_prompt(system, prompt, images),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(ROOT),
            env=overlay_env(),
        )
        if proc.returncode != 0:
            detail = proc.stderr.strip() or proc.stdout.strip()
            raise RuntimeError(f"codex exited {proc.returncode}: {detail}")
        raw = out_path.read_text(encoding="utf-8").strip() if out_path.exists() else proc.stdout.strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"codex returned non-JSON: {exc}\n{raw[:400]}") from exc


def run_structured(
    *,
    prompt: str,
    system: str,
    schema: dict[str, Any],
    model: str | None = None,
    provider: str | None = None,
    images: list[Path] | None = None,
    timeout: int = 240,
) -> dict[str, Any]:
    chosen_provider = configured_provider(provider)
    chosen_model = resolve_model(model, chosen_provider)
    _ = require_provider_ready(chosen_provider)
    image_paths = list(images or [])
    if chosen_provider == "claude":
        return _run_claude(prompt, system, schema, chosen_model, image_paths, timeout)
    return _run_codex(prompt, system, schema, chosen_model, image_paths, timeout)
