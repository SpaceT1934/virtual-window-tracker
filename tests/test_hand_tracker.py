import math
from types import SimpleNamespace

import numpy as np
import pytest

from face_tracker.config import Settings
from face_tracker.hand_tracker import (
    HandOneEuroFilter,
    HandTracker,
    _PinchDebouncer,
    _unwrap_angle,
    extract_hand_features,
)


def test_hand_filter_settings_are_configurable(monkeypatch):
    monkeypatch.setenv("HAND_FILTER_ENABLED", "false")
    monkeypatch.setenv("HAND_FILTER_MIN_CUTOFF", "0.8")
    monkeypatch.setenv("HAND_FILTER_BETA", "3.5")
    monkeypatch.setenv("HAND_FILTER_DERIVATIVE_CUTOFF", "0.7")
    monkeypatch.setenv("HAND_FILTER_MAX_GAP_MS", "220")
    settings = Settings.from_env()
    assert settings.hand_filter_enabled is False
    assert settings.hand_filter_min_cutoff == pytest.approx(0.8)
    assert settings.hand_filter_beta == pytest.approx(3.5)
    assert settings.hand_filter_derivative_cutoff == pytest.approx(0.7)
    assert settings.hand_filter_max_gap_ms == pytest.approx(220.0)


def _landmarks():
    points = [SimpleNamespace(x=0.5, y=0.5, z=0.0) for _ in range(21)]
    # A frontal, open-ish palm in normalized image coordinates.
    points[0] = SimpleNamespace(x=0.50, y=0.70, z=0.0)
    points[5] = SimpleNamespace(x=0.38, y=0.50, z=0.0)
    points[9] = SimpleNamespace(x=0.50, y=0.45, z=0.0)
    points[13] = SimpleNamespace(x=0.62, y=0.50, z=0.0)
    points[17] = SimpleNamespace(x=0.70, y=0.58, z=0.0)
    points[4] = SimpleNamespace(x=0.47, y=0.51, z=0.0)
    points[8] = SimpleNamespace(x=0.50, y=0.50, z=0.0)
    return points


def test_extract_hand_features_contains_21_points_and_palm_rotation():
    payload = extract_hand_features(_landmarks(), 640, 480, handedness="Right", handedness_score=0.91, pinch_active=True)
    assert payload["landmark_count"] == 21
    assert len(payload["landmarks"]) == 21
    assert payload["palm_center"]["pixel"]["x"] == pytest.approx(345.6, abs=1)
    assert set(payload["palm_rotation_deg"]) == {"pitch", "yaw", "roll"}
    assert payload["pinch"]["active"] is True
    assert payload["handedness"] == "Right"


def test_extract_hand_features_rejects_short_input():
    with pytest.raises(ValueError):
        extract_hand_features(_landmarks()[:20], 640, 480)


def test_pinch_debouncer_requires_on_and_off_windows():
    debouncer = _PinchDebouncer(on_frames=2, off_frames=3)
    assert debouncer.update(0.40, 0.42, 0.52) is False
    assert debouncer.update(0.40, 0.42, 0.52) is True
    # A value in the hysteresis band must not release the gesture.
    assert debouncer.update(0.50, 0.42, 0.52) is True
    assert debouncer.update(0.60, 0.42, 0.52) is True
    assert debouncer.update(0.60, 0.42, 0.52) is True
    assert debouncer.update(0.60, 0.42, 0.52) is False


def test_lost_payload_preserves_configured_thresholds_and_resets_state():
    payload = HandTracker.lost(
        "detector_error", pinch_distance_on=0.31, pinch_distance_off=0.47
    )
    assert payload["tracking"] is False
    assert payload["tracking_lost"] is True
    assert payload["quality_reason"] == "detector_error"
    assert payload["pinch"]["threshold_on"] == pytest.approx(0.31)
    assert payload["pinch"]["threshold_off"] == pytest.approx(0.47)


def test_one_euro_filter_reduces_stationary_landmark_noise():
    rng = np.random.default_rng(20260910)
    values = 0.5 + rng.normal(0.0, 0.012, size=360)
    filt = HandOneEuroFilter(min_cutoff=1.2, beta=4.0, derivative_cutoff=1.0)
    filtered = np.asarray(
        [float(filt.filter(np.array([value]), index / 30.0)[0]) for index, value in enumerate(values)]
    )
    raw_spread = float(np.std(values[30:]))
    filtered_spread = float(np.std(filtered[30:]))
    assert filtered_spread < raw_spread * 0.65
    assert filtered_spread < 0.008


def test_one_euro_filter_tracks_motion_across_frame_rates():
    outputs: dict[int, list[float]] = {}
    for fps in (30, 60):
        filt = HandOneEuroFilter(min_cutoff=1.2, beta=4.0, derivative_cutoff=1.0)
        outputs[fps] = [
            float(filt.filter(np.array([min(1.0, index / fps)]), index / fps)[0])
            for index in range(fps + 1)
        ]
    assert outputs[30][-1] > 0.9
    assert outputs[60][-1] > 0.9
    assert abs(outputs[30][15] - outputs[60][30]) < 0.06


def test_one_euro_filter_resets_on_invalid_or_out_of_order_time():
    filt = HandOneEuroFilter(min_cutoff=0.2, beta=0.0)
    assert filt.filter(np.array([0.0]), 1.0)[0] == pytest.approx(0.0)
    assert filt.filter(np.array([1.0]), 1.1)[0] < 0.5
    # Older frames must not drag the state backwards or reuse future history.
    assert filt.filter(np.array([0.0]), 1.05)[0] == pytest.approx(0.0)
    # A long gap is a safe re-acquisition boundary as well.
    assert filt.filter(np.array([1.0]), 2.0)[0] == pytest.approx(1.0)


def test_rotation_unwrap_avoids_euler_branch_jump():
    assert _unwrap_angle(179.0, -179.0) == pytest.approx(181.0)
    assert _unwrap_angle(-179.0, 179.0) == pytest.approx(-181.0)


def _fake_tracker(results, **overrides):
    settings_values = {
        "hand_filter_enabled": True,
        "hand_filter_min_cutoff": 0.1,
        "hand_filter_beta": 0.0,
        "hand_filter_derivative_cutoff": 1.0,
        "hand_filter_max_gap_ms": 350.0,
        "hand_pinch_on_frames": 1,
        "hand_pinch_off_frames": 1,
        "hand_pinch_threshold": 0.42,
        "hand_pinch_release_threshold": 0.52,
    }
    settings_values.update(overrides)
    settings = SimpleNamespace(**settings_values)
    tracker = HandTracker.__new__(HandTracker)
    tracker.settings = settings
    tracker._init_temporal_state()
    tracker._detector_timestamp_ms = -1
    tracker._last_timestamp_s = None
    tracker._pinch = _PinchDebouncer(on_frames=1, off_frames=1)
    tracker._pinch_frames = (1, 1)
    tracker._pinches = {}
    tracker._last_payload = None
    iterator = iter(results)
    tracker._detect = lambda _frame, _timestamp: next(iterator)
    return tracker


def _shift(points, dx=0.0, dy=0.0, pinch=False):
    shifted = [SimpleNamespace(x=point.x + dx, y=point.y + dy, z=point.z) for point in points]
    if pinch:
        shifted[4] = SimpleNamespace(x=shifted[8].x, y=shifted[8].y, z=shifted[8].z)
    else:
        shifted[4] = SimpleNamespace(x=shifted[8].x + 0.25, y=shifted[8].y, z=shifted[8].z)
    return shifted


def _result(*hands):
    labels = [SimpleNamespace(category_name=label, score=0.95) for _, label, _ in hands]
    return SimpleNamespace(
        hand_landmarks=[points for points, _, _ in hands],
        hand_world_landmarks=None,
        handedness=[[category] for category in labels],
    )


def test_process_keeps_filter_state_with_handedness_when_detector_order_swaps():
    left = _shift(_landmarks(), dx=-0.25, pinch=True)
    right = _shift(_landmarks(), dx=0.20, pinch=False)
    tracker = _fake_tracker(
        [_result((left, "Left", None), (right, "Right", None)),
         _result((right, "Right", None), (left, "Left", None))]
    )
    frame = np.zeros((120, 160, 3), dtype=np.uint8)
    first = tracker.process(frame, 0)
    second = tracker.process(frame, 33)
    by_label = {hand["handedness"]: hand for hand in second["hands"]}
    assert by_label["Right"]["palm_center"]["x"] > 0.55
    assert by_label["Left"]["palm_center"]["x"] < 0.45
    assert first["hands"][0]["pinch"]["active"] is True
    assert second["hands"][1]["pinch"]["active"] is True
    assert second["hands"][0]["pinch"]["active"] is False


def test_process_reacquisition_starts_from_current_measurement_after_loss():
    first = _shift(_landmarks(), dx=-0.2)
    reacquired = _shift(_landmarks(), dx=0.2)
    tracker = _fake_tracker(
        [_result((first, "Right", None)), SimpleNamespace(hand_landmarks=[], handedness=[]),
         _result((reacquired, "Right", None))]
    )
    frame = np.zeros((120, 160, 3), dtype=np.uint8)
    tracker.process(frame, 0)
    lost = tracker.process(frame, 33)
    current = tracker.process(frame, 66)
    assert lost["tracking_lost"] is True
    assert current["palm_center"]["x"] > 0.6


def test_process_invalid_frame_clears_filter_history():
    previous = _shift(_landmarks(), dx=-0.25)
    current = _shift(_landmarks(), dx=0.25)
    tracker = _fake_tracker(
        [_result((previous, "Right", None)), _result((current, "Right", None))]
    )
    frame = np.zeros((120, 160, 3), dtype=np.uint8)
    tracker.process(frame, 0)
    invalid = tracker.process(None, 33)
    after = tracker.process(frame, 66)
    assert invalid["quality_reason"] == "invalid_frame"
    assert after["palm_center"]["x"] > 0.65
