"""Shared helpers for cloud/public series asset URLs."""

from __future__ import annotations

import copy
import urllib.parse
from typing import Any


def normalize_origin(value: str) -> str:
    parsed = urllib.parse.urlparse(str(value or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def apply_public_series_urls(
    entry: dict[str, Any],
    public_base: str,
    *,
    region_dir_name: str = "",
    region_meta_name: str = "",
) -> dict[str, Any]:
    out = copy.deepcopy(entry)
    slug = str(out.get("slug", "") or "")
    base = str(public_base or "").rstrip("/")
    if not base or not slug:
        return out
    out.setdefault("sliceUrlBase", f"{base}/data/{slug}")
    if out.get("hasRaw"):
        out.setdefault("rawUrl", f"{base}/{slug}.raw.zst")
    if out.get("hasRegions"):
        out.setdefault("regionUrlBase", f"{base}/data/{region_dir_name or f'{slug}_regions'}")
        out.setdefault("regionMetaUrl", f"{base}/data/{region_meta_name or f'{slug}_regions.json'}")
    return out


def validate_public_series_urls(entry: dict[str, Any], public_base: str) -> list[str]:
    base = str(public_base or "").rstrip("/")
    if not base:
        return []
    errors: list[str] = []
    slug = str(entry.get("slug", "") or "")
    trusted_origin = normalize_origin(base)
    expected = {
        "sliceUrlBase": f"{base}/data/{slug}",
        "rawUrl": f"{base}/{slug}.raw",
        "regionUrlBase": f"{base}/data/",
        "regionMetaUrl": f"{base}/data/",
    }
    for key, prefix in expected.items():
        value = entry.get(key)
        if not isinstance(value, str) or not value:
            continue
        if normalize_origin(value) != trusted_origin:
            errors.append(f"series.{key}: expected origin {trusted_origin}")
            continue
        if not value.startswith(prefix):
            if key == "rawUrl":
                errors.append("series.rawUrl: expected configured public base and slug path")
            elif key == "sliceUrlBase":
                errors.append("series.sliceUrlBase: expected configured public base and slug path")
            else:
                errors.append(f"series.{key}: expected configured public base and data path")
    return errors
