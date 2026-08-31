from __future__ import annotations

import shutil
import tempfile
import urllib.request
from pathlib import Path


def ensure_model(model_path: Path, model_url: str) -> Path:
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

