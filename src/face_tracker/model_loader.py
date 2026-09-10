from __future__ import annotations

import shutil
import tempfile
import urllib.request
from pathlib import Path


def ensure_model(model_path: Path, model_url: str) -> Path:
    return _download(model_path, model_url)


def ensure_model_optional(model_path: Path, model_url: str) -> Path | None:
    """Download a model only if it is not present, never raising on failure.

    Used for optional models (e.g. Facemark LBF) where a missing file should
    degrade gracefully instead of preventing the tracker from starting.
    """
    try:
        return _download(model_path, model_url)
    except Exception:
        return None


def _download(model_path: Path, model_url: str) -> Path:
    if model_path.is_file() and model_path.stat().st_size > 0:
        return model_path

    model_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        model_url,
        headers={"User-Agent": "face-window-tracker/0.1"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        with tempfile.NamedTemporaryFile(
            dir=model_path.parent, delete=False, suffix=".download"
        ) as temporary:
            shutil.copyfileobj(response, temporary)
            temporary_path = Path(temporary.name)

    if temporary_path.stat().st_size == 0:
        temporary_path.unlink(missing_ok=True)
        raise RuntimeError("Downloaded MediaPipe model is empty")
    temporary_path.replace(model_path)
    return model_path


def ensure_optional_model(model_path: Path, model_url: str) -> Path | None:
    """Resolve an optional model without making hand tracking break startup.

    A missing model is returned as ``None`` so deployments can run the face
    tracker alone; callers may then expose a clear capability status and let
    clients fall back to the existing face stream.
    """
    if model_path.is_file() and model_path.stat().st_size > 0:
        return model_path
    try:
        return ensure_model(model_path, model_url)
    except Exception:
        return None

