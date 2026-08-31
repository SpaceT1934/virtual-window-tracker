import math

import pytest

from face_tracker.geometry import (
    CameraIntrinsics,
    Point2,
    estimate_viewer_position_m,
    screen_normalized,
)


def test_screen_normalized_origin_and_edges() -> None:
    assert screen_normalized(Point2(640, 360), 1280, 720) == Point2(0, 0)
    assert screen_normalized(Point2(0, 0), 1280, 720) == Point2(-1, 1)
    assert screen_normalized(Point2(1280, 720), 1280, 720) == Point2(1, -1)


def test_position_estimate_at_optical_center() -> None:
    intrinsics = CameraIntrinsics.from_horizontal_fov(1280, 720, 70)
    position = estimate_viewer_position_m(
        Point2(640, 360), intrinsics.fx * 0.063 / 0.6, intrinsics, 0.063
    )
    assert position is not None
    assert position[0] == pytest.approx(0)
    assert position[1] == pytest.approx(0)
    assert position[2] == pytest.approx(0.6)


def test_intrinsics_from_fov() -> None:
    intrinsics = CameraIntrinsics.from_horizontal_fov(1280, 720, 70)
    recovered_fov = 2 * math.degrees(math.atan(1280 / (2 * intrinsics.fx)))
    assert recovered_fov == pytest.approx(70)

