from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
)


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


@dataclass(frozen=True, slots=True)
class Settings:
    camera_source: str = "0"
    camera_width: int = 1280
    camera_height: int = 720
    camera_fps: int = 30
    camera_hfov_deg: float = 70.0
    assumed_ipd_m: float = 0.063
    model_path: Path = Path("models/blaze_face_short_range.tflite")
    model_url: str = DEFAULT_MODEL_URL
    min_detection_confidence: float = 0.6
    min_presence_confidence: float = 0.6
    min_tracking_confidence: float = 0.6
    filter_min_cutoff: float = 1.2
    filter_beta: float = 0.035
    filter_derivative_cutoff: float = 1.0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            camera_source=os.getenv("FACE_CAMERA_SOURCE", "0"),
            camera_width=_env_int("FACE_CAMERA_WIDTH", 1280),
            camera_height=_env_int("FACE_CAMERA_HEIGHT", 720),
            camera_fps=_env_int("FACE_CAMERA_FPS", 30),
            camera_hfov_deg=_env_float("FACE_CAMERA_HFOV_DEG", 70.0),
            assumed_ipd_m=_env_float("FACE_ASSUMED_IPD_M", 0.063),
            model_path=Path(
                os.getenv("FACE_MODEL_PATH", "models/blaze_face_short_range.tflite")
            ),
            model_url=os.getenv("FACE_MODEL_URL", DEFAULT_MODEL_URL),
            min_detection_confidence=_env_float(
                "FACE_MIN_DETECTION_CONFIDENCE", 0.6
            ),
            min_presence_confidence=_env_float(
                "FACE_MIN_PRESENCE_CONFIDENCE", 0.6
            ),
            min_tracking_confidence=_env_float(
                "FACE_MIN_TRACKING_CONFIDENCE", 0.6
            ),
            filter_min_cutoff=_env_float("FACE_FILTER_MIN_CUTOFF", 1.2),
            filter_beta=_env_float("FACE_FILTER_BETA", 0.035),
            filter_derivative_cutoff=_env_float(
                "FACE_FILTER_DERIVATIVE_CUTOFF", 1.0
            ),
        )

    @property
    def opencv_camera_source(self) -> int | str:
        try:
            return int(self.camera_source)
        except ValueError:
            return self.camera_source
