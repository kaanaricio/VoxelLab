#!/usr/bin/env python3
"""Sanity-check the claim-driven validation matrix markdown."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys


ALLOWED_STATUS = {"supported", "partial", "blocked"}
REQUIRED_COLUMNS = ("claim_id", "status", "validation")


def normalize_header(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", " ", value.strip().lower()).strip()
    if text in {"claim id", "claim"}:
        return "claim_id"
    if text.startswith("status"):
        return "status"
    if text.startswith("validation"):
        return "validation"
    return text.replace(" ", "_")


def parse_tables(lines: list[str]) -> list[tuple[list[str], list[dict[str, str]]]]:
    tables: list[tuple[list[str], list[dict[str, str]]]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if "|" not in line:
            index += 1
            continue
        if index + 1 >= len(lines):
            break
        separator = lines[index + 1]
        if "|" not in separator or "-" not in separator:
            index += 1
            continue
        headers = [normalize_header(cell) for cell in line.strip().strip("|").split("|")]
        rows: list[dict[str, str]] = []
        index += 2
        while index < len(lines) and "|" in lines[index]:
            values = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
            if len(values) == len(headers):
                rows.append(dict(zip(headers, values)))
            index += 1
        tables.append((headers, rows))
    return tables


def validate_matrix(path: Path) -> list[str]:
    errors: list[str] = []
    if not path.exists():
        return [f"validation matrix file not found: {path}"]
    lines = path.read_text(encoding="utf-8").splitlines()
    tables = parse_tables(lines)
    candidate_rows: list[dict[str, str]] = []
    for headers, rows in tables:
        if all(column in headers for column in REQUIRED_COLUMNS):
            candidate_rows.extend(rows)
    if not candidate_rows:
        return [f"validation matrix must include a table with columns: {', '.join(REQUIRED_COLUMNS)}"]

    seen: set[str] = set()
    for row_index, row in enumerate(candidate_rows, start=1):
        claim_id = row.get("claim_id", "").strip("` ").strip()
        status = row.get("status", "").strip("` ").strip().lower()
        validation = row.get("validation", "").strip()
        if not claim_id:
            errors.append(f"row {row_index}: missing claim_id")
        elif claim_id in seen:
            errors.append(f"row {row_index}: duplicate claim_id {claim_id}")
        else:
            seen.add(claim_id)
        if status not in ALLOWED_STATUS:
            errors.append(f"row {row_index}: invalid status {status or '<empty>'}")
        if not validation:
            errors.append(f"row {row_index}: missing validation commands/tests")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the claim-driven validation matrix markdown.")
    _ = parser.add_argument(
        "--matrix",
        default="docs/validation-matrix.md",
        help="Path to the validation matrix markdown file.",
    )
    args = parser.parse_args()

    errors = validate_matrix(Path(args.matrix))
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("validation matrix ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
