from pathlib import Path

from synthseg_integration import DEFAULT_SYNTHSEG_VENV, synthseg_repo_errors, synthseg_runtime


def test_synthseg_runtime_exposes_single_checkout_shape(tmp_path: Path) -> None:
    runtime = synthseg_runtime(tmp_path)

    assert runtime["repo_dir"] == tmp_path / "synthseg_repo"
    assert runtime["predict_script"] == tmp_path / "synthseg_repo" / "scripts" / "commands" / "SynthSeg_predict.py"
    assert runtime["models_dir"] == tmp_path / "synthseg_repo" / "models"
    assert runtime["venv_dir"] == DEFAULT_SYNTHSEG_VENV


def test_synthseg_repo_errors_report_missing_runtime_paths(tmp_path: Path) -> None:
    venv = tmp_path / "venv"

    errors = synthseg_repo_errors(tmp_path, venv)

    assert any(str(venv / "bin" / "python") in error for error in errors)
    assert any("SynthSeg_predict.py" in error for error in errors)
    assert any("model files" in error for error in errors)
