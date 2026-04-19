"""Small shared environment helpers for local VoxelLab tooling."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).parent


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


def overlay_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(base or os.environ)
    for key, value in load_dotenv().items():
        _ = env.setdefault(key, value)
    return env
