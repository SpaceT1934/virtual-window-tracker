from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pytest

from face_tracker.config import Settings
from face_tracker.yunet_tracker import YuNetPositionTracker


class _FakeDetector:
    """Mimics cv2.FaceDetectorYN.create(): stores input size and returns a
    fixed (N, 15) array of YuNet detections."""

    def __init__(self, faces):
        self._faces = faces
        self.last_input_size = (0, 0)

    def setInputSize(self, size):
        self.last_input_size = size

    def getInputSize(self):
        return self.last_input_size

    def detect(self, _frame):
        if self._faces is None or len(self._faces) == 0:
            return 0, None
        return 1, np.asarray(self._faces, dtype=np.float64)


def _yu_net_row(x, y, w, h, re_x, re_y, le_x, le_y, nose_x, nose_y, rmo_x, rmo_y, lmo_x, lmo_y, score=0.9):
    # Element order per OpenCV: bbox(4), right_eye(2), left_eye(2),
    # nose(2), right_mouth(2), left_mouth(2), score(1).
    return [x, y, w, h, re_x, re_y, le_x, le_y, nose_x, nose_y,
            rmo_x, rmo_y, lmo_x, lmo_y, score]


@pytest.fixture
def tracker(monkeypatch):
    # Build a tracker with a stubbed detector and real position filter, but no
    # Facemark (it must degrade to yunet keypoints).
    monkeypatch.setattr(
        "face_tracker.yunet_tracker.cv2.FaceDetectorYN",
        SimpleNamespace(create=lambda *a, **k: _FakeDetector(None)),
    )
    settings = Settings(camera_width=640, camera_height=480, camera_hfov_deg=70.0)
    return YuNetPositionTracker(
        settings, Path("models/yunet.onnx"), Path("models/does-not-exist.yaml")
    )


def _set_fake_faces(tracker, faces):
    tracker._detector = _FakeDetector(faces)


def test_no_face_degrades_and_resets(tracker):
    _set_fake_faces(tracker, [])
    frame = np.zeros((480, 640, 3), np.uint8)
    result = tracker.process(frame, 0)
    assert result["tracking"] is False
    assert result["face"] is None
    assert result["quality_reason"] == "face_not_found"
    # A blank frame must not raise; it is the degraded (lost) path.


def test_face_yields_position_with_yunet_keypoints(tracker):
    # A face near center: eyes at (300,240) and (340,240).
    row = _yu_net_row(220, 180, 200, 200,
                      re_x=300, re_y=240, le_x=340, le_y=240,
                      nose_x=320, nose_y=280, rmo_x=270, rmo_y=320,
                      lmo_x=370, lmo_y=320)
    _set_fake_faces(tracker, [row])
    frame = np.zeros((480, 640, 3), np.uint8)
    result = tracker.process(frame, 0)

    assert result["tracking"] is True
    assert result["tracker_backend"] == "yunet"
    face = result["face"]
    assert face["model"] == "opencv-yunet"
    assert face["eyes"]["source"] == "yunet-keypoints"
    # Eyes are at the fixed keypoint positions.
    assert face["eyes"]["left"]["pixel"] == {"x": 340.0, "y": 240.0}
    assert face["eyes"]["right"]["pixel"] == {"x": 300.0, "y": 240.0}
    assert face["eyes"]["distance_pixels"] == 40.0
    assert face["viewer_position_m"] is not None
    # At the optical center x, position x should be near 0 (given equal y).
    assert abs(face["viewer_position_m"]["raw"]["x"]) < 0.01
    # debug points include both eyes and nose.
    names = {p["name"] for p in face["debug_points"]}
    assert {"left_eye", "right_eye", "nose"} <= names
    # All five YuNet keypoints are exposed with a group marker.
    assert {"right_eye", "left_eye", "nose", "right_mouth", "left_mouth"} == names
    assert all(p["group"] == "yunet" for p in face["debug_points"])
    assert len(face["debug_points"]) == 5
    # Nose is at its keypoint position in normalized coords.
    nose = next(p for p in face["debug_points"] if p["name"] == "nose")
    assert nose["x"] == round(320 / 640, 6)


def test_detection_resizes_input_bbox(tracker):
    # Frame wider than the initial detector size -> setInputSize is called.
    row = _yu_net_row(100, 120, 300, 260,
                      re_x=200, re_y=230, le_x=260, le_y=230,
                      nose_x=230, nose_y=280, rmo_x=170, rmo_y=300,
                      lmo_x=290, lmo_y=300)
    _set_fake_faces(tracker, [row])
    frame = np.zeros((480, 800, 3), np.uint8)
    result = tracker.process(frame, 0)
    assert result["tracking"] is True
    # bbox normalized against the actual frame size (800x480).
    assert result["face"]["bbox"]["normalized"]["x"] == round(100 / 800, 6)
