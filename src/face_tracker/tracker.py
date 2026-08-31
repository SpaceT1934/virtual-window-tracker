from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
import numpy as np

from .config import Settings
from .filtering import PositionFilter
from .geometry import (
    CameraIntrinsics,
    Point2,
    average_points,
    estimate_viewer_position_m,
    pixel_distance,
    screen_normalized,
)

RIGHT_EYE_KEYPOINT = 0
LEFT_EYE_KEYPOINT = 1


def _point_payload(point: Point2, width: int, height: int) -> dict[str, Any]:
    normalized = screen_normalized(point, width, height)
    return {
        "pixel": {"x": round(point.x, 3), "y": round(point.y, 3)},
        "screen_normalized": {
            "x": round(normalized.x, 6),
            "y": round(normalized.y, 6),
        },
    }


class FacePositionTracker:
    def __init__(self, settings: Settings, model_path: Path) -> None:
        self.settings = settings
        base_options = mp.tasks.BaseOptions(
            model_asset_path=str(model_path),
            delegate=mp.tasks.BaseOptions.Delegate.CPU,
        )
        options = mp.tasks.vision.FaceDetectorOptions(
            base_options=base_options,
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            min_detection_confidence=settings.min_detection_confidence,
        )
        self._detector = mp.tasks.vision.FaceDetector.create_from_options(options)
        self._position_filter = PositionFilter(
            settings.filter_min_cutoff,
            settings.filter_beta,
            settings.filter_derivative_cutoff,
        )
        self._last_timestamp_ms = -1

    def close(self) -> None:
        self._detector.close()

    def __enter__(self) -> "FacePositionTracker":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def process(self, frame_bgr: np.ndarray, timestamp_ms: int) -> dict[str, Any]:
        height, width = frame_bgr.shape[:2]
        timestamp_ms = max(timestamp_ms, self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = self._detector.detect_for_video(image, timestamp_ms)

        if not result.detections:
            self._position_filter.reset()
            return {"tracking": False, "face": None}

        detection = result.detections[0]
        keypoints = detection.keypoints or []
        if len(keypoints) < 2:
            self._position_filter.reset()
            return {"tracking": False, "face": None}

        right_eye_keypoint = keypoints[RIGHT_EYE_KEYPOINT]
        left_eye_keypoint = keypoints[LEFT_EYE_KEYPOINT]
        if (
            right_eye_keypoint.x is None
            or right_eye_keypoint.y is None
            or left_eye_keypoint.x is None
            or left_eye_keypoint.y is None
        ):
            self._position_filter.reset()
            return {"tracking": False, "face": None}

        right_eye = Point2(right_eye_keypoint.x * width, right_eye_keypoint.y * height)
        left_eye = Point2(left_eye_keypoint.x * width, left_eye_keypoint.y * height)
        eye_center = average_points([left_eye, right_eye])
        eye_distance = pixel_distance(left_eye, right_eye)

        intrinsics = CameraIntrinsics.from_horizontal_fov(
            width, height, self.settings.camera_hfov_deg
        )
        raw_position = estimate_viewer_position_m(
            eye_center, eye_distance, intrinsics, self.settings.assumed_ipd_m
        )
        timestamp_s = time.monotonic()
        filtered_position = None
        if raw_position is not None:
            filtered_position = self._position_filter.apply(*raw_position, timestamp_s)

        bbox = detection.bounding_box
        min_x = float(bbox.origin_x)
        min_y = float(bbox.origin_y)
        box_width = float(bbox.width)
        box_height = float(bbox.height)

        return {
            "tracking": True,
            "face": {
                "bbox": {
                    "pixel": {
                        "x": round(min_x, 3),
                        "y": round(min_y, 3),
                        "width": round(box_width, 3),
                        "height": round(box_height, 3),
                    },
                    "normalized": {
                        "x": round(min_x / width, 6),
                        "y": round(min_y / height, 6),
                        "width": round(box_width / width, 6),
                        "height": round(box_height / height, 6),
                    },
                },
                "eyes": {
                    "left": _point_payload(left_eye, width, height),
                    "right": _point_payload(right_eye, width, height),
                    "center": _point_payload(eye_center, width, height),
                    "distance_pixels": round(eye_distance, 3),
                },
                "viewer_position_m": (
                    {
                        "raw": {
                            "x": round(raw_position[0], 6),
                            "y": round(raw_position[1], 6),
                            "z": round(raw_position[2], 6),
                        },
                        "filtered": {
                            "x": round(filtered_position[0], 6),
                            "y": round(filtered_position[1], 6),
                            "z": round(filtered_position[2], 6),
                        },
                        "coordinate_system": "x-right_y-up_z-toward-viewer",
                        "calibrated": intrinsics.calibrated,
                        "method": "assumed-horizontal-fov-and-ipd",
                    }
                    if raw_position is not None and filtered_position is not None
                    else None
                ),
                "head_rotation_deg": None,
                "facial_transformation_matrix": None,
            },
        }


def draw_debug_overlay(frame: np.ndarray, result: dict[str, Any], fps: float) -> None:
    face = result.get("face")
    if result.get("tracking") and face:
        bbox = face["bbox"]["pixel"]
        start = (int(bbox["x"]), int(bbox["y"]))
        end = (int(bbox["x"] + bbox["width"]), int(bbox["y"] + bbox["height"]))
        cv2.rectangle(frame, start, end, (80, 220, 80), 2)
        for key, color in (("left", (255, 160, 40)), ("right", (40, 160, 255))):
            point = face["eyes"][key]["pixel"]
            cv2.circle(frame, (int(point["x"]), int(point["y"])), 5, color, -1)
        center = face["eyes"]["center"]["pixel"]
        cv2.drawMarker(
            frame,
            (int(center["x"]), int(center["y"])),
            (50, 255, 255),
            cv2.MARKER_CROSS,
            18,
            2,
        )
        position = face.get("viewer_position_m")
        if position:
            p = position["filtered"]
            label = f"viewer x={p['x']:.3f} y={p['y']:.3f} z={p['z']:.3f} m"
            cv2.putText(frame, label, (20, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (50, 255, 255), 2)
    else:
        cv2.putText(frame, "face lost", (20, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (70, 70, 255), 2)
    cv2.putText(frame, f"FPS {fps:.1f}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 220, 80), 2)
