"""
Shared path resolution and manifest helpers for DICOM pipeline scripts.

Set the environment variable MRI_VIEWER_DICOM_ROOT to the directory that
contains your DICOM series folders, or pass --source / -s to scripts that
read DICOM files from disk.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ENV_DICOM_ROOT = "MRI_VIEWER_DICOM_ROOT"
DATA = Path(__file__).parent / "data"

SKIP_NAMES = {".DS_Store", "Thumbs.db", "DICOMDIR"}


def resolve_dicom_root(cli_path: Path | None) -> Path | None:
    """Return the DICOM root directory, or None if missing/invalid.

    Precedence: explicit ``cli_path`` (from --source), then MRI_VIEWER_DICOM_ROOT.
    """
    if cli_path is not None:
        p = cli_path.expanduser().resolve()
        return p if p.is_dir() else None
    env = os.environ.get(ENV_DICOM_ROOT)
    if env:
        p = Path(env).expanduser().resolve()
        return p if p.is_dir() else None
    return None


def slugify(text: str) -> str:
    """Convert text to a filesystem/URL-safe slug (lowercase, underscored)."""
    s = text.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = s.strip("_")
    return s or "unknown"


def candidate_dicom_files(folder: Path) -> list[Path]:
    """Return sorted candidate DICOM files in *folder*.

    Handles both classic .dcm files and extensionless Siemens DICOMs.
    Skips macOS resource forks, thumbnails, and common sidecar formats.
    """
    return sorted(
        path for path in folder.iterdir()
        if path.is_file()
        and path.name not in SKIP_NAMES
        and not path.name.startswith("._")
        and path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".txt", ".json"}
    )


def load_manifest(data_dir: Path | None = None) -> dict:
    """Load manifest.json, returning empty-state dict if missing."""
    path = (data_dir or DATA) / "manifest.json"
    if not path.exists():
        return {"patient": "anonymous", "studyDate": "", "series": []}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"manifest.json is malformed ({path}): {exc}") from exc
    if not isinstance(data.get("series"), list):
        data["series"] = []
    return data


def slug_source_map(data_dir: Path | None = None) -> dict[str, str]:
    """Return {slug: sourceFolder} from manifest.json."""
    m = load_manifest(data_dir)
    return {
        s["slug"]: s["sourceFolder"]
        for s in m.get("series", [])
        if s.get("sourceFolder")
    }


def series_by_modality(modality: str, data_dir: Path | None = None) -> list[str]:
    """Return list of slugs with the given modality (e.g. 'MR', 'CT')."""
    m = load_manifest(data_dir)
    return [s["slug"] for s in m.get("series", []) if s.get("modality") == modality]
