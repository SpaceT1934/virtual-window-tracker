from __future__ import annotations

import threading
import time
from copy import deepcopy
from typing import Any

import cv2

from .config import Settings
from .model_loader import ensure_model
from .tracker import FacePositionTracker


class TrackingService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._latest: dict[str, Any] | None = None
        self._status: dict[str, Any] = {
            "state": "stopped",
            "error": None,
            "camera_source": settings.camera_source,
        }

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="face-tracking-camera", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        with self._lock:
            self._status["state"] = "stopped"

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            return deepcopy(self._latest)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._status)

    def _set_status(self, state: str, error: str | None = None, **extra: Any) -> None:
        with self._lock:
            self._status = {
                **self._status,
                "state": state,
                "error": error,
                **extra,
            }

    def _run(self) -> None:
        try:
            self._set_status("starting")
            model_path = ensure_model(self.settings.model_path, self.settings.model_url)
            sequence = 0
            fps = 0.0
            with FacePositionTracker(self.settings, model_path) as tracker:
                while not self._stop_event.is_set():
                    capture = None
                    try:
                        capture = self._open_camera()
                        actual_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
                        actual_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
                        self._set_status(
                            "running",
                            error=None,
                            width=actual_width,
                            height=actual_height,
                            requested_fps=self.settings.camera_fps,
                        )

                        consecutive_read_failures = 0
                        previous_frame_time = time.monotonic()
                        started = previous_frame_time
                        while not self._stop_event.is_set():
                            ok, frame = capture.read()
                            if not ok:
                                consecutive_read_failures += 1
                                if consecutive_read_failures < 4:
                                    self._stop_event.wait(0.05)
                                    continue
                                raise RuntimeError("Camera stopped returning frames")

                            consecutive_read_failures = 0
                            now = time.monotonic()
                            instant_fps = 1.0 / max(now - previous_frame_time, 1e-6)
                            fps = (
                                instant_fps
                                if fps == 0
                                else fps * 0.9 + instant_fps * 0.1
                            )
                            previous_frame_time = now
                            tracking = tracker.process(
                                frame, int((now - started) * 1000)
                            )
                            sequence += 1
                            packet = {
                                "protocol_version": "1.0",
                                "type": "face_tracking",
                                "sequence": sequence,
                                "captured_at_unix_ms": int(time.time() * 1000),
                                "frame": {
                                    "width": int(frame.shape[1]),
                                    "height": int(frame.shape[0]),
                                    "fps": round(fps, 2),
                                },
                                **tracking,
                            }
                            with self._lock:
                                self._latest = packet
                    except Exception as exc:
                        if self._stop_event.is_set():
                            break
                        self._set_status(
                            "reconnecting", f"{type(exc).__name__}: {exc}"
                        )
                        self._stop_event.wait(1.0)
                    finally:
                        if capture is not None:
                            capture.release()
        except Exception as exc:
            self._set_status("error", f"{type(exc).__name__}: {exc}")

    def _open_camera(self) -> cv2.VideoCapture:
        capture = cv2.VideoCapture(self.settings.opencv_camera_source)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.settings.camera_width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.settings.camera_height)
        capture.set(cv2.CAP_PROP_FPS, self.settings.camera_fps)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not capture.isOpened():
            capture.release()
            raise RuntimeError(
                f"Cannot open camera source {self.settings.camera_source!r}"
            )
        return capture
