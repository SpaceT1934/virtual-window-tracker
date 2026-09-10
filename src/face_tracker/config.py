from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
)

LANDMARK_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
YUNET_MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
LBF_MODEL_URL = "https://raw.githubusercontent.com/kurnianggoro/GSOC2017/master/data/lbfmodel.yaml"

HAND_LANDMARK_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on", "enabled"}:
        return True
    if normalized in {"0", "false", "no", "off", "disabled"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _env_floats(name: str, default: tuple[float, ...]) -> tuple[float, ...]:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        parsed = json.loads(value) if value.strip().startswith("[") else value.split(",")
        values = tuple(float(item) for item in parsed)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"{name} must be a comma-separated list of numbers") from error
    if not values:
        raise ValueError(f"{name} must contain at least one number")
    return values


def _env_crop(name: str = "FACE_CAMERA_CROP") -> tuple[int, int, int, int] | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    try:
        values = tuple(int(item.strip()) for item in value.split(","))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be x,y,width,height") from error
    if len(values) != 4:
        raise ValueError(f"{name} must be x,y,width,height")
    if values[0] < 0 or values[1] < 0 or values[2] <= 0 or values[3] <= 0:
        raise ValueError(f"{name} must contain a positive crop")
    return values


@dataclass(frozen=True, slots=True)
class Settings:
    tracker_backend: str = "yunet"
    landmark_model_path: Path = Path("models/face_landmarker.task")
    yunet_model_path: Path = Path("models/face_detection_yunet_2023mar.onnx")
    lbf_model_path: Path = Path("models/lbfmodel.yaml")
    calibration_path: Path | None = None
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
    filter_beta: float = 4.0
    filter_derivative_cutoff: float = 1.0
    # ``auto`` is intentionally neutral.  Ace processing is opt-in because a
    # USB capture does not identify its lens or output resolution reliably.
    camera_profile: str = "auto"
    camera_center_crop_fraction: float = 1.0
    camera_roi_scales: tuple[float, ...] = (1.0,)
    camera_roi_offset_x: float = 0.0
    camera_roi_offset_y: float = 0.0
    camera_distortion: tuple[float, ...] = ()
    camera_undistort: bool = True
    # Optional physical crop applied before detector/geometry.  ROI zooms do
    # not need this flag because their coordinates are mapped back to source.
    camera_apply_center_crop: bool = False
    camera_crop: tuple[int, int, int, int] | None = None
    long_range_fallback: bool = False
    body_fallback: bool = False
    fallback_scales: tuple[float, ...] = (1.0, 1.5, 2.0)
    fallback_min_head_px: float = 18.0
    fallback_min_body_px: float = 42.0
    hand_tracking_enabled: bool = True
    hand_model_path: Path = Path("models/hand_landmarker.task")
    hand_model_url: str = HAND_LANDMARK_MODEL_URL
    hand_min_detection_confidence: float = 0.55
    hand_min_presence_confidence: float = 0.55
    hand_min_tracking_confidence: float = 0.55
    hand_pinch_threshold: float = 0.42
    hand_pinch_release_threshold: float = 0.52
    hand_pinch_on_frames: int = 2
    hand_pinch_off_frames: int = 3
    # One Euro hand smoothing keeps stationary landmarks quiet while raising
    # the cutoff during fast motion.  The gap is a hard temporal reset.
    hand_filter_enabled: bool = True
    hand_filter_min_cutoff: float = 1.2
    hand_filter_beta: float = 4.0
    hand_filter_derivative_cutoff: float = 1.0
    hand_filter_max_gap_ms: float = 350.0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            tracker_backend=os.getenv("FACE_TRACKER_BACKEND", "yunet"),
            landmark_model_path=Path(
                os.getenv("FACE_LANDMARK_MODEL_PATH", "models/face_landmarker.task")
            ),
            yunet_model_path=Path(os.getenv("FACE_YUNET_MODEL_PATH", "models/face_detection_yunet_2023mar.onnx")),
            lbf_model_path=Path(os.getenv("FACE_LBF_MODEL_PATH", "models/lbfmodel.yaml")),
            calibration_path=(
                Path(os.environ["FACE_CALIBRATION_PATH"])
                if os.getenv("FACE_CALIBRATION_PATH")
                else None
            ),
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
            filter_beta=_env_float("FACE_FILTER_BETA", 4.0),
            filter_derivative_cutoff=_env_float(
                "FACE_FILTER_DERIVATIVE_CUTOFF", 1.0
            ),
            camera_profile=os.getenv("FACE_CAMERA_PROFILE", "auto"),
            camera_center_crop_fraction=_env_float(
                "FACE_CAMERA_CENTER_CROP_FRACTION", 1.0
            ),
            camera_roi_scales=_env_floats("FACE_CAMERA_ROI_SCALES", (1.0,)),
            camera_roi_offset_x=_env_float("FACE_CAMERA_ROI_OFFSET_X", 0.0),
            camera_roi_offset_y=_env_float("FACE_CAMERA_ROI_OFFSET_Y", 0.0),
            camera_distortion=_env_floats("FACE_CAMERA_DISTORTION", ()),
            camera_undistort=_env_bool("FACE_CAMERA_UNDISTORT", True),
            camera_apply_center_crop=_env_bool("FACE_CAMERA_APPLY_CENTER_CROP", False),
            camera_crop=_env_crop(),
            long_range_fallback=_env_bool("FACE_LONG_RANGE_FALLBACK", False),
            body_fallback=_env_bool("FACE_BODY_FALLBACK", False),
            fallback_scales=_env_floats("FACE_FALLBACK_SCALES", (1.0, 1.5, 2.0)),
            fallback_min_head_px=_env_float("FACE_FALLBACK_MIN_HEAD_PX", 18.0),
            fallback_min_body_px=_env_float("FACE_FALLBACK_MIN_BODY_PX", 42.0),
            hand_tracking_enabled=_env_bool("HAND_TRACKING_ENABLED", True),
            hand_model_path=Path(os.getenv("HAND_MODEL_PATH", "models/hand_landmarker.task")),
            hand_model_url=os.getenv("HAND_MODEL_URL", HAND_LANDMARK_MODEL_URL),
            hand_min_detection_confidence=_env_float("HAND_MIN_DETECTION_CONFIDENCE", 0.55),
            hand_min_presence_confidence=_env_float("HAND_MIN_PRESENCE_CONFIDENCE", 0.55),
            hand_min_tracking_confidence=_env_float("HAND_MIN_TRACKING_CONFIDENCE", 0.55),
            hand_pinch_threshold=_env_float("HAND_PINCH_THRESHOLD", 0.42),
            hand_pinch_release_threshold=_env_float("HAND_PINCH_RELEASE_THRESHOLD", 0.52),
            hand_pinch_on_frames=_env_int("HAND_PINCH_ON_FRAMES", 2),
            hand_pinch_off_frames=_env_int("HAND_PINCH_OFF_FRAMES", 3),
            hand_filter_enabled=_env_bool("HAND_FILTER_ENABLED", True),
            hand_filter_min_cutoff=_env_float("HAND_FILTER_MIN_CUTOFF", 1.2),
            hand_filter_beta=_env_float("HAND_FILTER_BETA", 4.0),
            hand_filter_derivative_cutoff=_env_float(
                "HAND_FILTER_DERIVATIVE_CUTOFF", 1.0
            ),
            hand_filter_max_gap_ms=_env_float("HAND_FILTER_MAX_GAP_MS", 350.0),
        )

    @property
    def opencv_camera_source(self) -> int | str:
        try:
            return int(self.camera_source)
        except ValueError:
            return self.camera_source

    @property
    def center_crop_fraction(self) -> float:
        return self.camera_center_crop_fraction

    @property
    def roi_scales(self) -> tuple[float, ...]:
        return self.camera_roi_scales
