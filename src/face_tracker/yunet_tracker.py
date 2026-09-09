from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import cv2
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

# YuNet detect() returns an array with shape (N, 15):
#   [0:4]   bounding box       (x, y, width, height)
#   [4:6]   right eye          (x, y)
#   [6:8]   left eye           (x, y)
#   [8:10]  nose tip           (x, y)
#   [10:12] right mouth corner (x, y)
#   [12:14] left mouth corner  (x, y)
#   [14]    detection score
RIGHT_EYE = 4
LEFT_EYE = 6
NOSE = 8
RIGHT_MOUTH = 10
LEFT_MOUTH = 12
SCORE = 14


def _point_payload(point: Point2, width: int, height: int) -> dict[str, Any]:
    normalized = screen_normalized(point, width, height)
    return {
        "pixel": {"x": round(float(point.x), 3), "y": round(float(point.y), 3)},
        "screen_normalized": {
            "x": round(normalized.x, 6),
            "y": round(normalized.y, 6),
        },
    }


class YuNetPositionTracker:
    """OpenCV YuNet (FaceDetectorYN) face detection with landmark-driven eye
    geometry, casting the viewer position exactly like the BlazeFace backend.

    The detector exposes five facial keypoints natively (both eyes, nose tip,
    both mouth corners). Those keypoints are enough to reproduce the same
    `eyes_geometry` position estimate used by the default backend. An optional
    OpenCV Facemark LBF model can replace the eye keypoints with the more
    precise eye-centers of a 68-point landmark model; when unavailable the
    tracker falls back to the YuNet keypoints.
    """

    def __init__(self, settings: Settings, model_path: Path, lbf_path: Path | None) -> None:
        self.settings = settings
        self._detector = cv2.FaceDetectorYN.create(
            str(model_path),
            "",
            (settings.camera_width, settings.camera_height),
            settings.min_detection_confidence,
            0.3,
            5000,
        )
        self._position_filter = PositionFilter(
            settings.filter_min_cutoff,
            settings.filter_beta,
            settings.filter_derivative_cutoff,
        )
        self._last_timestamp_ms = -1
        self._facemark: Any | None = None
        # LBF is an optional enhancement. cv2.face is only present when the
        # opencv-contrib build is installed, so guard on both attributes and on
        # the model file actually being available.
        if (
            lbf_path is not None
            and lbf_path.is_file()
            and hasattr(cv2, "face")
            and hasattr(cv2.face, "createFacemarkLBF")
        ):
            try:
                facemark = cv2.face.createFacemarkLBF()
                facemark.loadModel(str(lbf_path))
                self._facemark = facemark
            except (cv2.error, OSError):
                self._facemark = None

    def close(self) -> None:
        self._detector = None

    def __enter__(self) -> "YuNetPositionTracker":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _load_facemark_eyes(self, frame_bgr: np.ndarray, box: np.ndarray) -> tuple[Point2, Point2] | None:
        """Return (right_eye, left_eye) from Facemark LBF if it is available and
        the fit succeeds, else None so the caller falls back to YuNet points."""
        if self._facemark is None:
            return None
        bbox = np.array([[int(box[0]), int(box[1]), int(box[2]), int(box[3])]], dtype=np.int32)
        ok, landmarks = self._facemark.fit(frame_bgr, bbox)
        if not ok or not landmarks or len(landmarks[0]) < 68:
            return None
        # LBF returns shape (1, 68, 1, 2). Flatten to (68, 2).
        pts = np.asarray(landmarks[0], dtype=np.float64).reshape(-1, 2)
        # LBF 68-point convention: right_eye = [36..41], left_eye = [42..47].
        right_eye = Point2(float(pts[36:42, 0].mean()), float(pts[36:42, 1].mean()))
        left_eye = Point2(float(pts[42:48, 0].mean()), float(pts[42:48, 1].mean()))
        return right_eye, left_eye

    def process(self, frame_bgr: np.ndarray, timestamp_ms: int) -> dict[str, Any]:
        height, width = frame_bgr.shape[:2]
        timestamp_ms = max(timestamp_ms, self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms

        if width != self._detector.getInputSize()[0] or height != self._detector.getInputSize()[1]:
            self._detector.setInputSize((width, height))
        _, faces = self._detector.detect(frame_bgr)

        if faces is None or len(faces) == 0:
            self._position_filter.reset()
            return {
                "tracking": False,
                "face": None,
                "tracker_backend": "yunet",
                "quality_reason": "face_not_found",
            }

        current = faces[0]
        box = current[:4]
        min_x, min_y, box_width, box_height = (
            float(box[0]), float(box[1]), float(box[2]), float(box[3])
        )

        right_eye_px = Point2(float(current[RIGHT_EYE]), float(current[RIGHT_EYE + 1]))
        left_eye_px = Point2(float(current[LEFT_EYE]), float(current[LEFT_EYE + 1]))

        # Optional: replace with Facemark LBF eye-centers when available and valid.
        facemark_eyes = self._load_facemark_eyes(frame_bgr, box)
        if facemark_eyes is not None:
            right_eye_px, left_eye_px = facemark_eyes

        eye_center = average_points([left_eye_px, right_eye_px])
        eye_distance = pixel_distance(left_eye_px, right_eye_px)

        intrinsics = CameraIntrinsics.from_horizontal_fov(
            width, height, self.settings.camera_hfov_deg
        )
        raw_position = estimate_viewer_position_m(
            eye_center, eye_distance, intrinsics, self.settings.assumed_ipd_m
        )
        timestamp_s = time.perf_counter()
        filtered_position = None
        if raw_position is not None:
            filtered_position = self._position_filter.apply(*raw_position, timestamp_s)

        return {
            "tracking": True,
            "tracker_backend": "yunet",
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
                    "left": _point_payload(left_eye_px, width, height),
                    "right": _point_payload(right_eye_px, width, height),
                    "center": _point_payload(eye_center, width, height),
                    "distance_pixels": round(eye_distance, 3),
                    "source": "facemark-lbf" if facemark_eyes is not None else "yunet-keypoints",
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
                "model": "opencv-yunet",
                "quality": {
                    "tracking_level": "eyes_geometry",
                    "valid_points": 2,
                    "eye_source": "facemark-lbf" if facemark_eyes is not None else "yunet-keypoints",
                },
                "debug_points": [
                    {
                        "name": "left_eye",
                        "x": round(left_eye_px.x / width, 6),
                        "y": round(left_eye_px.y / height, 6),
                        "pixel": {"x": left_eye_px.x, "y": left_eye_px.y},
                    },
                    {
                        "name": "right_eye",
                        "x": round(right_eye_px.x / width, 6),
                        "y": round(right_eye_px.y / height, 6),
                        "pixel": {"x": right_eye_px.x, "y": right_eye_px.y},
                    },
                    {
                        "name": "nose",
                        "x": round(current[NOSE] / width, 6),
                        "y": round(current[NOSE + 1] / height, 6),
                        "pixel": {"x": current[NOSE], "y": current[NOSE + 1]},
                    },
                ],
            },
        }
