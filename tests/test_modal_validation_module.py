from __future__ import annotations

import importlib
import sys
import types


class FakeRetries:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def import_modal_validation():
    sys.modules["modal"] = types.SimpleNamespace(Retries=FakeRetries)
    _ = sys.modules.pop("modal_validation", None)
    return importlib.import_module("modal_validation")


def test_modal_validation_env_helpers_are_bounded(monkeypatch):
    module = import_modal_validation()
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "L4,A10G")
    monkeypatch.setenv("TEST_INT", "999")
    monkeypatch.setenv("TEST_FLOAT", "-5")

    assert module.env_int("TEST_INT", 10, max_value=64) == 64
    assert module.env_float("TEST_FLOAT", 1.5, min_value=0.5) == 0.5
    assert module.env_gpu("MRI_VIEWER_MODAL_GPU") == ["L4", "A10G"]


def test_modal_validation_upload_items_and_auth(monkeypatch):
    module = import_modal_validation()
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    items, error = module.normalize_upload_items({
        "items": [
            {"upload_id": "f000001", "filename": "IM0001"},
            {"upload_id": "f000002", "filename": "IM0001"},
        ]
    })

    assert error is None
    assert items[1]["upload_id"] == "f000002"
    assert items[1]["content_type"] == "application/dicom"
    assert module.auth_error("secret-token") == ""
    assert module.auth_error("wrong-token") == "unauthorized"
