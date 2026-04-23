"""Shared Modal processing contract for cloud jobs and submitters."""

from __future__ import annotations

PROCESSING_MODE_DEFAULT_INPUT_KIND = {
    "standard": "dicom_volume_stack",
    "projection_set_reconstruction": "calibrated_projection_set",
    "ultrasound_scan_conversion": "calibrated_ultrasound_source",
}
PROCESSING_MODES = tuple(PROCESSING_MODE_DEFAULT_INPUT_KIND.keys())
INPUT_KINDS = tuple(dict.fromkeys(PROCESSING_MODE_DEFAULT_INPUT_KIND.values()))


def default_input_kind(processing_mode: str = "standard") -> str:
    return PROCESSING_MODE_DEFAULT_INPUT_KIND.get(processing_mode, "")


def validate_processing_mode(mode: object) -> str:
    """Return a supported processing mode or an empty string when invalid."""
    if mode in {None, ""}:
        return "standard"
    if not isinstance(mode, str) or mode not in PROCESSING_MODE_DEFAULT_INPUT_KIND:
        return ""
    return mode


def validate_input_kind(kind: object, processing_mode: str = "standard") -> str:
    """Return the input kind expected by the selected processing mode."""
    default = default_input_kind(processing_mode)
    if kind in {None, ""}:
        return default
    if not isinstance(kind, str) or kind not in INPUT_KINDS:
        return ""
    return kind
