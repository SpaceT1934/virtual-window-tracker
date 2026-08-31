from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True, slots=True)
class Point2:
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class CameraIntrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    calibrated: bool = False

    @classmethod
    def from_horizontal_fov(
        cls, width: int, height: int, horizontal_fov_deg: float
    ) -> "CameraIntrinsics":
        fx = width / (2.0 * math.tan(math.radians(horizontal_fov_deg) / 2.0))
        return cls(fx=fx, fy=fx, cx=width / 2.0, cy=height / 2.0)


def average_points(points: Sequence[Point2]) -> Point2:
    if not points:
        raise ValueError("At least one point is required")
    return Point2(
        x=sum(point.x for point in points) / len(points),
        y=sum(point.y for point in points) / len(points),
    )


def pixel_distance(a: Point2, b: Point2) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def screen_normalized(point: Point2, width: int, height: int) -> Point2:
    """Map pixels to x/y in [-1, 1], with origin at center and y pointing up."""
    return Point2(
        x=2.0 * point.x / width - 1.0,
        y=1.0 - 2.0 * point.y / height,
    )


def estimate_viewer_position_m(
    eye_center_px: Point2,
    eye_distance_px: float,
    intrinsics: CameraIntrinsics,
    assumed_ipd_m: float,
) -> tuple[float, float, float] | None:
    """Estimate eye midpoint in camera space: x right, y up, z toward viewer."""
    if eye_distance_px <= 1e-6:
        return None
    z = intrinsics.fx * assumed_ipd_m / eye_distance_px
    x = (eye_center_px.x - intrinsics.cx) * z / intrinsics.fx
    y = -(eye_center_px.y - intrinsics.cy) * z / intrinsics.fy
    return x, y, z


def euler_degrees_from_rotation_matrix(matrix: Sequence[Sequence[float]]) -> dict[str, float]:
    """Return display-oriented pitch/yaw/roll from a 3x3 rotation matrix."""
    r00, _, _ = matrix[0][:3]
    r10, r11, r12 = matrix[1][:3]
    r20, r21, r22 = matrix[2][:3]
    sy = math.sqrt(r00 * r00 + r10 * r10)
    singular = sy < 1e-6
    if not singular:
        pitch = math.atan2(r21, r22)
        yaw = math.atan2(-r20, sy)
        roll = math.atan2(r10, r00)
    else:
        pitch = math.atan2(-r12, r11)
        yaw = math.atan2(-r20, sy)
        roll = 0.0
    return {
        "pitch": math.degrees(pitch),
        "yaw": math.degrees(yaw),
        "roll": math.degrees(roll),
    }

