"""Backend selection: one default, three valid names, clear failure otherwise."""

import pytest

from face_tracker.config import Settings
from face_tracker.tracker_factory import create_tracker


def test_default_backend_is_yunet():
    """The default is part of the user-facing contract, not an accident."""
    assert Settings().tracker_backend == "yunet"
    assert Settings.from_env().tracker_backend == "yunet"


def test_environment_selects_every_supported_backend(monkeypatch):
    for name in ("yunet", "detector", "landmarker"):
        monkeypatch.setenv("FACE_TRACKER_BACKEND", name)
        assert Settings.from_env().tracker_backend == name


def test_unknown_backend_fails_before_loading_anything():
    with pytest.raises(ValueError, match="FACE_TRACKER_BACKEND"):
        create_tracker(Settings(tracker_backend="not-a-backend"))
