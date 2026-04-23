"""Shared engine-report contract helpers."""

from __future__ import annotations

ENGINE_REPORT_VALIDATIONS = {"prototype", "external-engine", "reference-parity"}


def normalize_engine_validation(value: object, fallback: str = "external-engine") -> str:
    text = str(value or fallback)
    return text if text in ENGINE_REPORT_VALIDATIONS else fallback
