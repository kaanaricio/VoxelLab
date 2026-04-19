"""Named ultrasound scan-conversion profiles."""

from __future__ import annotations

from typing import Any


DEFAULT_PROFILES = {
    "stacked-sector-default": {
        "mode": "stacked-sector",
        "probeGeometry": "sector",
        "scanConvertedShape": [128, 128],
        "scanConvertedSpacingMm": [0.8, 0.8],
    },
    "tracked-freehand-sector-default": {
        "mode": "tracked-freehand-sector",
        "probeGeometry": "sector",
        "scanConvertedShape": [128, 128],
        "scanConvertedSpacingMm": [0.8, 0.8],
    },
}


def default_profile_id(config: dict[str, Any]) -> str:
    mode = str(config.get("mode", "") or "")
    probe = str(config.get("probeGeometry", "") or "")
    if mode == "tracked-freehand-sector" and probe == "sector":
        return "tracked-freehand-sector-default"
    return "stacked-sector-default"


def resolve_ultrasound_profile(config: dict[str, Any]) -> dict[str, Any]:
    profile_id = str(config.get("profileId", "") or "") or default_profile_id(config)
    profile = dict(DEFAULT_PROFILES.get(profile_id, {}))
    merged = dict(profile)
    merged.update(config)
    merged["profileId"] = profile_id
    return merged
