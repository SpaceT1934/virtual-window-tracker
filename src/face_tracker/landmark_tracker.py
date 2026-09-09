from __future__ import annotations

from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np

from .calibration import CalibrationProvider
from .config import Settings
from .geometry import Point2, average_points, pixel_distance
from .head_pose import HeadPoseEstimator, LANDMARK_IDS
from .stabilization import StablePositionTracker
from .tracker import _point_payload


class LandmarkPositionTracker:
    """Single-viewer experimental head pose; no frames or landmark histories saved."""
    def __init__(self, settings: Settings, model_path: Path):
        self.camera = CalibrationProvider(settings.camera_hfov_deg, settings.calibration_path)
        self.pose = HeadPoseEstimator(settings.assumed_ipd_m)
        self.stable = StablePositionTracker(settings.filter_min_cutoff, settings.filter_beta,
                                           settings.filter_derivative_cutoff)
        self.detector = mp.tasks.vision.FaceLandmarker.create_from_options(
            mp.tasks.vision.FaceLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
                running_mode=mp.tasks.vision.RunningMode.VIDEO, num_faces=1,
                min_face_detection_confidence=settings.min_detection_confidence,
                min_face_presence_confidence=settings.min_presence_confidence,
                min_tracking_confidence=settings.min_tracking_confidence,
                output_face_blendshapes=False, output_facial_transformation_matrixes=False))
        self.last_timestamp = -1

    def __enter__(self):
        return self

    def close(self):
        self.detector.close()

    def __exit__(self, *_):
        self.close()

    def process(self, frame_bgr: np.ndarray, timestamp_ms: int) -> dict:
        height, width = frame_bgr.shape[:2]
        timestamp_ms = max(timestamp_ms, self.last_timestamp + 1)
        self.last_timestamp = timestamp_ms
        result = self.detector.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,
            data=cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)), timestamp_ms)
        lost = {'tracking': False, 'track_id': self.stable.track_id, 'face': None,
                'tracker_backend': 'landmarker', 'calibration_ready': False}
        if not result.face_landmarks:
            return {**lost, 'quality_reason': 'face_not_found'}
        landmarks = result.face_landmarks[0]
        if len(landmarks) <= max(LANDMARK_IDS):
            return {**lost, 'quality_reason': 'insufficient_landmarks'}
        pixels = np.array([[p.x * width, p.y * height] for p in landmarks])
        camera = self.camera.at(width, height)
        pose = self.pose.solve(pixels[LANDMARK_IDS], camera, width, timestamp_ms / 1000)
        if pose is None:
            return {**lost, 'quality_reason': 'pose_rejected'}
        accepted = self.stable.update([pose.position], timestamp_ms / 1000)
        if accepted is None:
            return {**lost, 'quality_reason': 'motion_outlier'}
        _, filtered = accepted
        right, left = (Point2(*pixels[ids].mean(axis=0)) for ids in ([33, 133], [362, 263]))
        center = average_points([left, right])
        min_x, min_y = pixels.min(axis=0)
        max_x, max_y = pixels.max(axis=0)
        return {'tracking': True, 'track_id': self.stable.track_id, 'tracker_backend': 'landmarker',
                'calibration_ready': pose.calibration_ready, 'quality_reason': 'accepted',
                'face': {
                    'bbox': {'pixel': {'x': float(min_x), 'y': float(min_y),
                                      'width': float(max_x - min_x), 'height': float(max_y - min_y)},
                             'normalized': {'x': float(min_x / width), 'y': float(min_y / height),
                                            'width': float((max_x - min_x) / width),
                                            'height': float((max_y - min_y) / height)}},
                    'eyes': {'left': _point_payload(left, width, height), 'right': _point_payload(right, width, height),
                             'center': _point_payload(center, width, height), 'distance_pixels': pixel_distance(left, right)},
                    'viewer_position_m': {'raw': dict(zip('xyz', pose.position)), 'filtered': dict(zip('xyz', filtered)),
                        'coordinate_system': 'x-right_y-up_z-toward-viewer',
                        'calibrated': False, 'intrinsics_calibrated': camera.intrinsics.calibrated,
                        'method': 'canonical-face-pnp-assumed-ipd'},
                    'head_rotation_deg': pose.angles,
                    'facial_transformation_matrix': None,
                    'model': 'mediapipe-face-landmarker',
                    'debug_points': [{'index': int(i), 'x': float(landmarks[i].x), 'y': float(landmarks[i].y), 'z': (float(getattr(landmarks[i], 'z')) if getattr(landmarks[i], 'z', None) is not None else None)} for i in range(len(landmarks))],
                    'quality': {'reprojection_error_px': round(pose.reprojection_px, 3),
                                'inlier_ratio': pose.inlier_ratio, 'pose_solver': pose.solver,
                                'stationary': self.stable.stationary},
                }}
