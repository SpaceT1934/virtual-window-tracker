"""MediaPipe Hand Landmarker features for first-phase hand gestures.

The tracker deliberately keeps the public payload independent from the
MediaPipe Python object model.  A packet contains 21 normalized/pixel points,
the palm centre and orientation, and a debounced thumb/index pinch signal.
The implementation is usable with MediaPipe Tasks 0.10.x and is lazy about
the MediaPipe import so API/schema tests do not need a model or camera.
"""
from __future__ import annotations

import math
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import cv2
import numpy as np


HAND_LANDMARK_NAMES: tuple[str, ...] = (
    "wrist",
    "thumb_cmc",
    "thumb_mcp",
    "thumb_ip",
    "thumb_tip",
    "index_mcp",
    "index_pip",
    "index_dip",
    "index_tip",
    "middle_mcp",
    "middle_pip",
    "middle_dip",
    "middle_tip",
    "ring_mcp",
    "ring_pip",
    "ring_dip",
    "ring_tip",
    "pinky_mcp",
    "pinky_pip",
    "pinky_dip",
    "pinky_tip",
)

_WRIST = 0
_THUMB_TIP = 4
_INDEX_MCP = 5
_INDEX_TIP = 8
_MIDDLE_MCP = 9
_RING_MCP = 13
_PINKY_MCP = 17
_PINKY_TIP = 20
_MAX_HANDS = 2


def _finite(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _point(point: Any) -> tuple[float, float, float]:
    """Read a NormalizedLandmark or a simple x/y/z test double."""
    if isinstance(point, Mapping):
        return (
            _finite(point.get("x")),
            _finite(point.get("y")),
            _finite(point.get("z")),
        )
    if isinstance(point, np.ndarray) or (
        hasattr(point, "__getitem__") and not isinstance(point, (str, bytes))
    ):
        try:
            return (_finite(point[0]), _finite(point[1]), _finite(point[2]))
        except (IndexError, KeyError, TypeError):
            pass
    return (
        _finite(getattr(point, "x", None)),
        _finite(getattr(point, "y", None)),
        _finite(getattr(point, "z", None)),
    )


def _pinch_thresholds(on: Any = 0.42, off: Any = 0.52) -> tuple[float, float]:
    """Return finite, ordered pinch thresholds for the state machine."""
    on_value = max(0.0, _finite(on, 0.42))
    off_value = max(on_value, max(0.0, _finite(off, 0.52)))
    return on_value, off_value


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        parsed = default
    return max(1, parsed)


def _confidence(value: Any, default: float = 0.55) -> float:
    return max(0.0, min(1.0, _finite(value, default)))


class HandOneEuroFilter:
    """Low-latency, velocity-adaptive filter for hand landmark arrays."""

    def __init__(
        self,
        min_cutoff: float = 1.2,
        beta: float = 4.0,
        derivative_cutoff: float = 1.0,
        max_gap_s: float = 0.35,
    ) -> None:
        self.min_cutoff = max(1e-3, _finite(min_cutoff, 1.2))
        self.beta = max(0.0, _finite(beta, 4.0))
        self.derivative_cutoff = max(1e-3, _finite(derivative_cutoff, 1.0))
        self.max_gap_s = max(1e-3, _finite(max_gap_s, 0.35))
        self.reset()

    @staticmethod
    def _alpha(cutoff: np.ndarray | float, dt: float) -> np.ndarray | float:
        return 1.0 / (1.0 + 1.0 / (2.0 * math.pi * cutoff * dt))

    @property
    def initialized(self) -> bool:
        return self._value is not None

    def reset(self) -> None:
        self._value: np.ndarray | None = None
        self._raw: np.ndarray | None = None
        self._derivative: np.ndarray | None = None
        self._timestamp_s: float | None = None

    def filter(self, value: Any, timestamp_s: float) -> np.ndarray:
        sample = np.asarray(value, dtype=float)
        if sample.size == 0:
            self.reset()
            return sample.copy()
        if not np.all(np.isfinite(sample)):
            sample = np.nan_to_num(sample, nan=0.0, posinf=0.0, neginf=0.0)
            self.reset()
        timestamp = _finite(timestamp_s, math.nan)
        previous_timestamp = self._timestamp_s
        if (
            not math.isfinite(timestamp)
            or previous_timestamp is None
            or self._value is None
            or self._raw is None
            or self._derivative is None
            or self._value.shape != sample.shape
        ):
            self._value = sample.copy()
            self._raw = sample.copy()
            self._derivative = np.zeros_like(sample)
            self._timestamp_s = timestamp if math.isfinite(timestamp) else None
            return sample.copy()
        dt = timestamp - previous_timestamp
        if not math.isfinite(dt) or dt <= 0.0 or dt > self.max_gap_s:
            self._value = sample.copy()
            self._raw = sample.copy()
            self._derivative = np.zeros_like(sample)
            self._timestamp_s = timestamp if math.isfinite(timestamp) else None
            return sample.copy()
        raw_derivative = (sample - self._raw) / dt
        derivative_alpha = float(self._alpha(self.derivative_cutoff, dt))
        self._derivative += derivative_alpha * (raw_derivative - self._derivative)
        cutoff = self.min_cutoff + self.beta * np.abs(self._derivative)
        position_alpha = self._alpha(cutoff, dt)
        self._value += position_alpha * (sample - self._value)
        self._raw = sample.copy()
        self._timestamp_s = timestamp
        return self._value.copy()

    update = filter


@dataclass(slots=True)
class _HandFilterState:
    normalized: HandOneEuroFilter
    world: HandOneEuroFilter
    last_rotation: dict[str, float] | None = None

    def reset(self) -> None:
        self.normalized.reset()
        self.world.reset()
        self.last_rotation = None


def _unwrap_angle(previous: float, current: float) -> float:
    if not math.isfinite(previous) or not math.isfinite(current):
        return current
    delta = (current - previous + 180.0) % 360.0 - 180.0
    return previous + delta


def _unwrap_rotation(
    rotation: Mapping[str, Any], previous: Mapping[str, float] | None
) -> dict[str, float]:
    if previous is None:
        return {key: _finite(value) for key, value in rotation.items()}
    return {
        key: _unwrap_angle(_finite(previous.get(key)), _finite(value))
        for key, value in rotation.items()
    }


def _normal(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    return vector / length if length > 1e-9 and np.isfinite(length) else np.zeros(3, dtype=float)


def _mean(points: np.ndarray) -> np.ndarray:
    return np.mean(points, axis=0) if len(points) else np.zeros(3, dtype=float)


def _rotation_from_points(points: np.ndarray) -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    """Return display-friendly Euler angles, palm normal, and palm axes.

    The x-axis follows index MCP -> pinky MCP, the y-axis follows wrist ->
    middle MCP, and the normal is their cross product.  The returned angles
    are camera-oriented degrees (pitch/yaw/roll), with a frontal open palm
    close to zero.  A 2-D landmark set is supported by its z=0 plane.
    """
    if points.shape[0] <= _PINKY_MCP:
        zero = {"pitch": 0.0, "yaw": 0.0, "roll": 0.0}
        return zero, {"x": 0.0, "y": 0.0, "z": 1.0}, {"x": 1.0, "y": 0.0, "z": 0.0}
    wrist = points[_WRIST]
    x_axis = _normal(points[_PINKY_MCP] - points[_INDEX_MCP])
    y_hint = _normal(points[_MIDDLE_MCP] - wrist)
    normal = _normal(np.cross(x_axis, y_hint))
    if not np.any(normal):
        normal = np.array([0.0, 0.0, 1.0], dtype=float)
    # Keep the normal facing the camera for a stable sign across handedness.
    if normal[2] < 0:
        normal = -normal
    y_axis = _normal(np.cross(normal, x_axis))
    if not np.any(y_axis):
        y_axis = y_hint if np.any(y_hint) else np.array([0.0, 1.0, 0.0], dtype=float)
    roll = math.degrees(math.atan2(float(x_axis[1]), float(x_axis[0])))
    pitch = math.degrees(math.atan2(float(y_axis[2]), math.hypot(float(y_axis[0]), float(y_axis[1]))))
    yaw = math.degrees(math.atan2(float(normal[0]), max(abs(float(normal[2])), 1e-9)))
    angles = {"pitch": pitch, "yaw": yaw, "roll": roll}
    normal_payload = {"x": float(normal[0]), "y": float(normal[1]), "z": float(normal[2])}
    axis_payload = {"x": float(x_axis[0]), "y": float(x_axis[1]), "z": float(x_axis[2])}
    return angles, normal_payload, axis_payload


def _handedness(result: Any, index: int = 0) -> tuple[str | None, float]:
    """Read the handedness category for one result slot.

    MediaPipe returns a list of category lists, one list per detected hand.
    Older test doubles often expose only the first list, so the lookup stays
    deliberately defensive for backwards compatibility.
    """
    try:
        categories = result.handedness[index]
        category = categories[0]
        name = getattr(category, "category_name", None) or getattr(category, "display_name", None)
        score = _clamp(_finite(getattr(category, "score", 0.0)))
        return (str(name) if name else None), score
    except (AttributeError, IndexError, TypeError):
        # A few MediaPipe-compatible backends return a flat category list.
        if index != 0:
            return None, 0.0
        try:
            category = result.handedness[0]
            name = getattr(category, "category_name", None) or getattr(category, "display_name", None)
            score = _clamp(_finite(getattr(category, "score", 0.0)))
            return (str(name) if name else None), score
        except (AttributeError, IndexError, TypeError):
            return None, 0.0


def _landmark_payload(point: tuple[float, float, float], width: int, height: int,
                      world: tuple[float, float, float] | None = None) -> dict[str, Any]:
    x, y, z = point
    item: dict[str, Any] = {
        "x": round(_clamp(x), 6),
        "y": round(_clamp(y), 6),
        "z": round(z, 6),
        "pixel": {"x": round(_clamp(x) * width, 3), "y": round(_clamp(y) * height, 3)},
    }
    if world is not None:
        item["world"] = {"x": round(world[0], 6), "y": round(world[1], 6), "z": round(world[2], 6)}
    return item


def extract_hand_features(
    landmarks: Sequence[Any],
    width: int,
    height: int,
    *,
    world_landmarks: Sequence[Any] | None = None,
    handedness: str | None = None,
    handedness_score: float = 0.0,
    pinch_active: bool = False,
    pinch_distance_on: float = 0.42,
    pinch_distance_off: float = 0.52,
) -> dict[str, Any]:
    """Build a serializable hand feature payload from 21 landmarks.

    ``pinch_active`` is supplied by :class:`HandTracker` after temporal
    hysteresis.  This function remains pure and is convenient for unit tests
    and alternate MediaPipe-compatible backends.
    """
    if len(landmarks) < 21 or width <= 0 or height <= 0:
        raise ValueError("Hand landmarks must contain 21 points and a positive frame size")
    normalized = np.asarray([_point(item) for item in landmarks[:21]], dtype=float)
    world = None
    if world_landmarks is not None and len(world_landmarks) >= 21:
        world = np.asarray([_point(item) for item in world_landmarks[:21]], dtype=float)
    geometry_points = world if world is not None else normalized
    palm_indices = (_WRIST, _INDEX_MCP, _MIDDLE_MCP, _RING_MCP, _PINKY_MCP)
    palm_center = _mean(normalized[list(palm_indices)])
    palm_center_world = _mean(world[list(palm_indices)]) if world is not None else None
    rotation, normal, x_axis = _rotation_from_points(geometry_points)
    palm_size = float(np.linalg.norm(geometry_points[_WRIST] - geometry_points[_MIDDLE_MCP]))
    if palm_size <= 1e-9:
        palm_size = float(np.linalg.norm(geometry_points[_INDEX_MCP] - geometry_points[_PINKY_MCP]))
    pinch_distance = float(np.linalg.norm(geometry_points[_THUMB_TIP] - geometry_points[_INDEX_TIP]))
    pinch_ratio = pinch_distance / max(palm_size, 1e-9)
    # World landmarks are in metres and normalized landmarks are unit-ish;
    # ratios remain scale independent.  Include both names for consumers that
    # prefer a direct normalized distance or a palm-relative ratio.
    pinch_distance_on, pinch_distance_off = _pinch_thresholds(
        pinch_distance_on, pinch_distance_off
    )
    pinch_strength = _clamp(
        (pinch_distance_off - pinch_ratio) / max(pinch_distance_off, 1e-6)
    )
    points = [
        _landmark_payload(tuple(normalized[index]), width, height,
                          tuple(world[index]) if world is not None else None)
        for index in range(21)
    ]
    center_payload: dict[str, Any] = {
        "x": round(_clamp(float(palm_center[0])), 6),
        "y": round(_clamp(float(palm_center[1])), 6),
        "z": round(float(palm_center[2]), 6),
        "pixel": {"x": round(_clamp(float(palm_center[0])) * width, 3),
                  "y": round(_clamp(float(palm_center[1])) * height, 3)},
        "screen_normalized": {
            "x": round(float(palm_center[0]) * 2.0 - 1.0, 6),
            "y": round(1.0 - float(palm_center[1]) * 2.0, 6),
        },
    }
    if palm_center_world is not None:
        center_payload["world"] = {"x": round(float(palm_center_world[0]), 6),
                                    "y": round(float(palm_center_world[1]), 6),
                                    "z": round(float(palm_center_world[2]), 6)}
    return {
        "tracking": True,
        "tracking_lost": False,
        "handedness": handedness,
        "handedness_score": round(_clamp(handedness_score), 6),
        "landmarks": points,
        "landmark_count": len(points),
        "palm_center": center_payload,
        "palm_normal": normal,
        "palm_axis": x_axis,
        "palm_rotation_deg": {key: round(float(value), 3) for key, value in rotation.items()},
        "palm_rotation": {key: round(float(value), 3) for key, value in rotation.items()},
        "rotation": {key: round(float(value), 3) for key, value in rotation.items()},
        "pinch": {
            "active": bool(pinch_active),
            "distance": round(pinch_distance, 6),
            "ratio": round(pinch_ratio, 6),
            "strength": round(pinch_strength, 6),
            "threshold_on": pinch_distance_on,
            "threshold_off": pinch_distance_off,
        },
        "quality": {"confidence": round(_clamp(handedness_score), 6),
                    "palm_size": round(palm_size, 6)},
    }


@dataclass(slots=True)
class _PinchDebouncer:
    active: bool = False
    on_count: int = 0
    off_count: int = 0
    on_frames: int = 2
    off_frames: int = 3

    def __post_init__(self) -> None:
        self.on_frames = _positive_int(self.on_frames, 2)
        self.off_frames = _positive_int(self.off_frames, 3)

    def update(self, ratio: float, on_threshold: float, off_threshold: float) -> bool:
        on_threshold, off_threshold = _pinch_thresholds(on_threshold, off_threshold)
        ratio = _finite(ratio, math.inf)
        if not math.isfinite(ratio):
            self.active = False
            self.on_count = self.off_count = 0
            return False
        if self.active:
            if ratio > off_threshold:
                self.off_count += 1
                self.on_count = 0
                if self.off_count >= self.off_frames:
                    self.active = False
                    self.off_count = 0
            else:
                self.off_count = 0
        elif ratio <= on_threshold:
            self.on_count += 1
            self.off_count = 0
            if self.on_count >= self.on_frames:
                self.active = True
                self.on_count = 0
        else:
            self.on_count = 0
        return self.active


class HandTracker:
    """Video-mode MediaPipe Hand Landmarker with adaptive temporal filtering.

    MediaPipe can return up to two hands.  ``process`` keeps the historical
    single-hand feature object as its return shape and adds a ``hands`` array
    containing all valid detections.  The service unwraps that array onto the
    packet while retaining ``hand`` for older clients.  Filter and pinch state
    is keyed by the detector's handedness label and is never shared between
    hands.
    """

    def __init__(self, settings: Any, model_path: Path) -> None:
        import mediapipe as mp

        self.settings = settings
        self._mp = mp
        self._detector_timestamp_ms = -1
        self._last_timestamp_s: float | None = None
        self._init_temporal_state()
        pinch_on_frames = _positive_int(getattr(settings, "hand_pinch_on_frames", 2), 2)
        pinch_off_frames = _positive_int(getattr(settings, "hand_pinch_off_frames", 3), 3)
        # Keep ``_pinch`` as a compatibility alias for integrations that used
        # the original one-hand implementation.  New detections use the
        # handedness/slot keyed map below so the two hands do not share state.
        self._pinch = _PinchDebouncer(on_frames=pinch_on_frames, off_frames=pinch_off_frames)
        self._pinch_frames = (pinch_on_frames, pinch_off_frames)
        self._pinches: dict[str, _PinchDebouncer] = {}
        self._last_payload: dict[str, Any] | None = None
        options = mp.tasks.vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_hands=_MAX_HANDS,
            min_hand_detection_confidence=_confidence(
                getattr(settings, "hand_min_detection_confidence", 0.55)
            ),
            min_hand_presence_confidence=_confidence(
                getattr(settings, "hand_min_presence_confidence", 0.55)
            ),
            min_tracking_confidence=_confidence(
                getattr(settings, "hand_min_tracking_confidence", 0.55)
            ),
        )
        self.detector = mp.tasks.vision.HandLandmarker.create_from_options(options)

    def _init_temporal_state(self) -> None:
        self._hand_filter_enabled = bool(
            getattr(self.settings, "hand_filter_enabled", True)
        )
        self._hand_filter_kwargs = {
            "min_cutoff": getattr(self.settings, "hand_filter_min_cutoff", 1.2),
            "beta": getattr(self.settings, "hand_filter_beta", 4.0),
            "derivative_cutoff": getattr(
                self.settings, "hand_filter_derivative_cutoff", 1.0
            ),
            "max_gap_s": max(
                1e-3,
                _finite(getattr(self.settings, "hand_filter_max_gap_ms", 350.0), 350.0)
                / 1000.0,
            ),
        }
        self._hand_filters: dict[str, _HandFilterState] = {}
        self._last_input_timestamp_ms: float | None = None

    def _new_hand_filter_state(self) -> _HandFilterState:
        return _HandFilterState(
            normalized=HandOneEuroFilter(**self._hand_filter_kwargs),
            world=HandOneEuroFilter(**self._hand_filter_kwargs),
        )

    def _hand_filter_for(self, key: str) -> _HandFilterState:
        state = self._hand_filters.get(key)
        if state is None:
            state = self._new_hand_filter_state()
            self._hand_filters[key] = state
        return state

    def _reset_temporal_state(self) -> None:
        self._reset_pinch()
        for state in self._hand_filters.values():
            state.reset()
        self._hand_filters.clear()
        self._last_input_timestamp_ms = None

    def _filter_timestamp(self, timestamp_ms: Any) -> float:
        timestamp = _finite(timestamp_ms, math.nan)
        if not math.isfinite(timestamp):
            self._reset_temporal_state()
            self._last_input_timestamp_ms = None
            return time.monotonic()
        if (
            self._last_input_timestamp_ms is not None
            and timestamp <= self._last_input_timestamp_ms
        ):
            self._reset_temporal_state()
            return timestamp / 1000.0
        self._last_input_timestamp_ms = timestamp
        return timestamp / 1000.0

    def __enter__(self) -> "HandTracker":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        detector = getattr(self, "detector", None)
        if detector is not None and hasattr(detector, "close"):
            detector.close()
        self.detector = None

    @staticmethod
    def lost(
        reason: str = "hand_not_found",
        pinch_distance_on: float = 0.42,
        pinch_distance_off: float = 0.52,
    ) -> dict[str, Any]:
        pinch_distance_on, pinch_distance_off = _pinch_thresholds(
            pinch_distance_on, pinch_distance_off
        )
        return {
            "tracking": False,
            "tracking_lost": True,
            "handedness": None,
            "handedness_score": 0.0,
            "landmarks": [],
            "landmark_count": 0,
            "palm_center": None,
            "palm_normal": None,
            "palm_axis": None,
            "palm_rotation_deg": None,
            "palm_rotation": None,
            "rotation": None,
            "pinch": {"active": False, "distance": None, "ratio": None,
                      "strength": 0.0, "threshold_on": pinch_distance_on,
                      "threshold_off": pinch_distance_off},
            "quality": {"confidence": 0.0},
            "quality_reason": reason,
            "hands": [],
            "hand_count": 0,
        }

    def _reset_pinch(self) -> None:
        self._pinch.active = False
        self._pinch.on_count = self._pinch.off_count = 0
        for debouncer in self._pinches.values():
            debouncer.active = False
            debouncer.on_count = debouncer.off_count = 0
        self._pinches.clear()

    def _pinch_for(self, key: str) -> _PinchDebouncer:
        debouncer = self._pinches.get(key)
        if debouncer is None:
            on_frames, off_frames = self._pinch_frames
            debouncer = _PinchDebouncer(on_frames=on_frames, off_frames=off_frames)
            self._pinches[key] = debouncer
        return debouncer

    def _thresholds(self) -> tuple[float, float]:
        return _pinch_thresholds(
            getattr(self.settings, "hand_pinch_threshold", 0.42),
            getattr(self.settings, "hand_pinch_release_threshold", 0.52),
        )

    def _detect(self, frame_bgr: np.ndarray, timestamp_ms: int) -> Any:
        stamp = max(
            int(_finite(timestamp_ms, time.monotonic() * 1000)),
            self._detector_timestamp_ms + 1,
        )
        self._detector_timestamp_ms = stamp
        if frame_bgr.ndim == 2:
            image_data = cv2.cvtColor(frame_bgr, cv2.COLOR_GRAY2RGB)
        elif frame_bgr.ndim == 3 and frame_bgr.shape[2] == 4:
            image_data = cv2.cvtColor(frame_bgr, cv2.COLOR_BGRA2RGB)
        elif frame_bgr.ndim == 3 and frame_bgr.shape[2] == 3:
            image_data = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        else:
            raise ValueError("Hand tracker expects a 1-, 3- or 4-channel image")
        image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB,
            data=image_data,
        )
        return self.detector.detect_for_video(image, stamp)

    def process(self, frame_bgr: np.ndarray, timestamp_ms: int) -> dict[str, Any]:
        # A few integrations construct a lightweight ``HandTracker`` test
        # double with ``__new__`` and patch ``_detect``.  Initialize the new
        # temporal fields lazily so that compatibility path keeps working.
        if not hasattr(self, "_hand_filter_enabled"):
            self._init_temporal_state()
        if not hasattr(self, "_pinches") or not hasattr(self, "_pinch"):
            on_frames = _positive_int(getattr(self.settings, "hand_pinch_on_frames", 2), 2)
            off_frames = _positive_int(getattr(self.settings, "hand_pinch_off_frames", 3), 3)
            self._pinch = _PinchDebouncer(on_frames=on_frames, off_frames=off_frames)
            self._pinch_frames = (on_frames, off_frames)
            self._pinches = {}
        on_threshold, off_threshold = self._thresholds()
        if frame_bgr is None or not hasattr(frame_bgr, "shape") or frame_bgr.ndim < 2:
            self._reset_temporal_state()
            return self.lost(
                "invalid_frame",
                pinch_distance_on=on_threshold,
                pinch_distance_off=off_threshold,
            )
        height, width = frame_bgr.shape[:2]
        if width <= 0 or height <= 0:
            self._reset_temporal_state()
            return self.lost(
                "invalid_frame",
                pinch_distance_on=on_threshold,
                pinch_distance_off=off_threshold,
            )
        filter_timestamp_s = self._filter_timestamp(timestamp_ms)
        try:
            result = self._detect(frame_bgr, timestamp_ms)
        except Exception:
            self._reset_temporal_state()
            raise
        hands = getattr(result, "hand_landmarks", None)
        if not hands:
            self._reset_temporal_state()
            self._last_payload = None
            return self.lost(
                "hand_not_found",
                pinch_distance_on=on_threshold,
                pinch_distance_off=off_threshold,
            )
        world_hands = getattr(result, "hand_world_landmarks", None)
        valid_payloads: list[dict[str, Any]] = []
        seen_keys: set[str] = set()
        for index, points in enumerate(hands[:_MAX_HANDS]):
            if not points or len(points) < 21:
                continue
            world_values = None
            try:
                candidate = world_hands[index] if world_hands is not None else None
                if candidate is not None and len(candidate) >= 21:
                    world_values = candidate
            except (IndexError, TypeError):
                world_values = None
            raw_normalized = np.asarray([_point(item) for item in points[:21]], dtype=float)
            state_name, score = _handedness(result, index)
            # MediaPipe's handedness category is the identity contract.  It
            # remains untouched by filtering, so mirrored camera placement
            # cannot cause left/right histories to be exchanged.  Detector
            # order remains the documented fallback when a category is absent.
            key = (
                f"handedness:{state_name.strip().casefold()}"
                if state_name and state_name.strip()
                else f"slot:{index}"
            )
            if key in seen_keys:
                # Duplicate labels are unusual, but sharing one filter would
                # be worse than a short independent track for that frame.
                key = f"{key}:slot:{index}"
            seen_keys.add(key)
            if self._hand_filter_enabled:
                state = self._hand_filter_for(key)
                filtered_normalized = state.normalized.filter(
                    raw_normalized, filter_timestamp_s
                )
                if world_values is not None:
                    raw_world = np.asarray(
                        [_point(item) for item in world_values[:21]], dtype=float
                    )
                    filtered_world = state.world.filter(raw_world, filter_timestamp_s)
                else:
                    state.world.reset()
                    filtered_world = None
            else:
                state = None
                filtered_normalized = raw_normalized
                filtered_world = (
                    np.asarray([_point(item) for item in world_values[:21]], dtype=float)
                    if world_values is not None
                    else None
                )
            geometry_values = (
                filtered_world if filtered_world is not None else filtered_normalized
            )
            raw = np.asarray(geometry_values, dtype=float)
            palm_size = float(np.linalg.norm(raw[_WRIST] - raw[_MIDDLE_MCP]))
            if palm_size <= 1e-9:
                palm_size = float(np.linalg.norm(raw[_INDEX_MCP] - raw[_PINKY_MCP]))
            ratio = float(np.linalg.norm(raw[_THUMB_TIP] - raw[_INDEX_TIP])) / max(palm_size, 1e-9)
            pinch_active = self._pinch_for(key).update(ratio, on_threshold, off_threshold)
            payload = extract_hand_features(
                filtered_normalized, width, height, world_landmarks=filtered_world,
                handedness=state_name, handedness_score=score,
                pinch_active=pinch_active, pinch_distance_on=on_threshold,
                pinch_distance_off=off_threshold,
            )
            if state is not None:
                rotation = payload.get("palm_rotation_deg")
                if isinstance(rotation, Mapping):
                    continuous_rotation = _unwrap_rotation(rotation, state.last_rotation)
                    state.last_rotation = continuous_rotation
                    for rotation_key in ("palm_rotation_deg", "palm_rotation", "rotation"):
                        payload[rotation_key] = {
                            axis: round(float(value), 3)
                            for axis, value in continuous_rotation.items()
                        }
                payload["quality"]["filter"] = "one_euro"
            else:
                payload["quality"]["filter"] = "disabled"
            payload["hand_index"] = index
            payload["tracking_lost"] = False
            payload["quality_reason"] = "accepted"
            now = time.perf_counter()
            payload["captured_at_monotonic_ms"] = round(now * 1000, 3)
            valid_payloads.append(payload)

        # A hand that disappeared must not retain an active pinch when it
        # re-enters the frame in a later slot.
        for key in tuple(self._pinches):
            if key not in seen_keys:
                self._pinches.pop(key).active = False
        for key in tuple(self._hand_filters):
            if key not in seen_keys:
                self._hand_filters.pop(key).reset()

        if not valid_payloads:
            self._reset_temporal_state()
            self._last_payload = None
            return self.lost(
                "hand_not_found",
                pinch_distance_on=on_threshold,
                pinch_distance_off=off_threshold,
            )

        # ``hands`` is a deep-copied snapshot so adding it to the primary
        # object cannot create a self-referential JSON structure.
        primary = valid_payloads[0]
        primary["hands"] = deepcopy(valid_payloads)
        primary["hand_count"] = len(valid_payloads)
        self._last_payload = primary
        self._last_timestamp_s = time.perf_counter()
        return primary


__all__ = [
    "HAND_LANDMARK_NAMES",
    "HandOneEuroFilter",
    "HandTracker",
    "extract_hand_features",
]
