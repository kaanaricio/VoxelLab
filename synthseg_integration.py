from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


SYNTHSEG_REPO_URL = "https://github.com/BBillot/SynthSeg.git"
DEFAULT_SYNTHSEG_VENV = Path("/tmp/synthseg_env")


def find_mri_synthseg() -> str | None:
    """Find mri_synthseg binary."""
    result = shutil.which("mri_synthseg")
    if result:
        return result
    for base in [
        os.environ.get("FREESURFER_HOME", ""),
        "/Applications/freesurfer/8.1.0",
        "/Applications/freesurfer/7.4.1",
        "/usr/local/freesurfer",
        os.path.expanduser("~/freesurfer"),
    ]:
        if not base:
            continue
        candidate = os.path.join(base, "bin", "mri_synthseg")
        if os.path.isfile(candidate):
            return candidate
    return None


def synthseg_runtime(root: Path, venv: Path | None = None) -> dict[str, Path | str]:
    # runtime shape: {"repo_url": "...", "repo_dir": Path(".../synthseg_repo"), "predict_script": Path(...), "models_dir": Path(...), "venv_dir": Path("/tmp/synthseg_env"), "venv_python": Path(...)}
    repo_dir = root / "synthseg_repo"
    venv_dir = (venv or DEFAULT_SYNTHSEG_VENV).expanduser()
    return {
        "repo_url": SYNTHSEG_REPO_URL,
        "repo_dir": repo_dir,
        "predict_script": repo_dir / "scripts" / "commands" / "SynthSeg_predict.py",
        "models_dir": repo_dir / "models",
        "utils_path": repo_dir / "ext" / "lab2im" / "utils.py",
        "venv_dir": venv_dir,
        "venv_python": venv_dir / "bin" / "python",
    }


def synthseg_repo_errors(root: Path, venv: Path | None = None) -> list[str]:
    runtime = synthseg_runtime(root, venv)
    errors: list[str] = []
    python = runtime["venv_python"]
    predict = runtime["predict_script"]
    models_dir = runtime["models_dir"]
    if not python.exists():
        errors.append(f"missing SynthSeg venv python: {python}")
    if not predict.exists():
        errors.append(f"missing SynthSeg predict script: {predict}")
    if not any(models_dir.glob("synthseg*.h5")):
        errors.append(f"missing SynthSeg model files in {models_dir}")
    if python.exists():
        code = (
            "import importlib.util, sys;"
            "mods=['tensorflow','nibabel','numpy','PIL','scipy'];"
            "missing=[m for m in mods if importlib.util.find_spec(m) is None];"
            "print('\\n'.join(missing));"
            "sys.exit(1 if missing else 0)"
        )
        result = subprocess.run([str(python), "-c", code], capture_output=True, text=True, timeout=30)
        for name in result.stdout.splitlines():
            if name:
                errors.append(f"missing SynthSeg venv module: {name}")
        if result.returncode and not result.stdout.strip():
            errors.append(f"SynthSeg venv module check failed: {result.stderr.strip() or result.returncode}")
    return errors


def synthseg_repo_ready(root: Path, venv: Path | None = None) -> bool:
    return not synthseg_repo_errors(root, venv)
