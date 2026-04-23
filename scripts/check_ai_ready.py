#!/usr/bin/env python3
"""Doctor command for VoxelLab's local AI provider setup."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ai_runtime import public_ai_status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check whether the configured AI provider is ready.")
    _ = parser.add_argument("--provider", choices=["claude", "codex"], help="Provider override")
    _ = parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    _ = parser.add_argument("--disabled", action="store_true", help="Treat AI as disabled for contract testing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    status = public_ai_status(not args.disabled, provider=args.provider)
    if args.json:
        print(json.dumps(status, indent=2))
    else:
        print(f"provider: {status['provider']}")
        print(f"enabled:  {status['enabled']}")
        print(f"ready:    {status['ready']}")
        if status.get("auth_mode"):
            print(f"auth:     {status['auth_mode']}")
        if status.get("issues"):
            print("issues:")
            for issue in status["issues"]:
                print(f"  - {issue}")
    return 0 if status["enabled"] and status["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
