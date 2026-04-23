#!/usr/bin/env python3
"""Run parity-oriented internal engine checks for advanced imaging paths."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = {
    "projection": [
        [sys.executable, "-m", "pytest", "tests/test_projection_reconstruction.py", "-q"],
        [sys.executable, "-m", "pytest", "tests/test_projection_rtk.py", "-q"],
        [sys.executable, "-m", "pytest", "tests/test_rtk_projection_wrapper.py", "-q"],
    ],
    "ultrasound": [
        [sys.executable, "-m", "pytest", "tests/test_ultrasound_reconstruction.py", "-q"],
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run parity-oriented advanced imaging checks.")
    _ = parser.add_argument("--suite", choices=sorted(SUITES), action="append", help="Named suite to run. Repeatable.")
    _ = parser.add_argument("--all", action="store_true", help="Run every known parity suite.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    suite_names = sorted(SUITES) if args.all or not args.suite else args.suite
    for suite_name in suite_names:
        print(f"== {suite_name} parity ==", flush=True)
        for command in SUITES[suite_name]:
            _ = subprocess.run(command, cwd=ROOT, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
