from __future__ import annotations

import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

import cv2

from .config import Settings
from .capture import LatestCamera
from .tracker_factory import create_tracker


class TrackingService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._latest: dict[str, Any] | None = None
        self._latest_jpeg: bytes | None = None
        self._published_monotonic = 0.0
        self._fps_samples: list[float] = []
        self._status: dict[str, Any] = {
            "state": "stopped",
            "error": None,
            "camera_source": settings.camera_source,
            "tracker_backend": settings.tracker_backend,
            "capture_mode": "latest-frame",
            # Geometry the reported positions were derived from, so a client can
            # reinterpret them without guessing what the process was started with.
            "camera_hfov_deg": settings.camera_hfov_deg,
            "assumed_ipd_m": settings.assumed_ipd_m,
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
            self._latest = None

    def latest(self) -> dict[str, Any] | None:
        with self._lock:
            if time.perf_counter() - self._published_monotonic > 0.5:
                return None
            return deepcopy(self._latest)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._status)

    def latest_jpeg(self):
        with self._lock:
            return self._latest_jpeg

    def _set_status(self, state: str, error: str | None = None, **extra: Any) -> None:
        with self._lock:
            if state != "running":
                self._latest = None
            self._status = {
                **self._status,
                "state": state,
                "error": error,
                **extra,
            }

    def _run(self) -> None:
        try:
            self._set_status("starting")
            sequence = 0
            source = self.settings.opencv_camera_source
            pace_file = isinstance(source, str) and Path(self.settings.camera_source).is_file()
            with create_tracker(self.settings) as tracker, LatestCamera(
                self._open_camera,
                self._stop_event,
                self._set_status,
                pace_file=pace_file,
            ) as camera:
                while not self._stop_event.is_set():
                    sample = camera.slot.take()
                    if sample is None:
                        continue
                    started = time.perf_counter()
                    if started - sample.monotonic_s > 0.25:
                        continue
                    tracking = tracker.process(
                        sample.image, int(sample.monotonic_s * 1000)
                    )
                    finished = time.perf_counter()
                    ok, encoded = cv2.imencode('.jpg', sample.image)
                    self._fps_samples.append(sample.fps)
                    self._fps_samples = self._fps_samples[-30:]
                    if (
                        not camera.is_current(sample)
                        or finished - sample.monotonic_s > 0.25
                    ):
                        continue
                    sequence += 1
                    packet = {
                        "protocol_version": "1.0",
                        "type": "face_tracking",
                        "sequence": sequence,
                        "tracker_backend": self.settings.tracker_backend,
                        "camera_hfov_deg": self.settings.camera_hfov_deg,
                        "assumed_ipd_m": self.settings.assumed_ipd_m,
                        "captured_at_unix_ms": sample.unix_ms,
                        "published_at_unix_ms": int(time.time() * 1000),
                        "processing_ms": round((finished - started) * 1000, 2),
                        "queue_age_ms": round(
                            (started - sample.monotonic_s) * 1000, 2
                        ),
                        "capture_dropped_frames": camera.slot.dropped,
                        "frame": {
                            "width": int(sample.image.shape[1]),
                            "height": int(sample.image.shape[0]),
                            "fps": round(sample.fps, 2),
                            "fps_window": round(sum(self._fps_samples) / len(self._fps_samples), 2),
                        },
                        **tracking,
                    }
                    with self._lock:
                        if (
                            self._stop_event.is_set()
                            or self._status["state"] != "running"
                            or not camera.is_current(sample)
                        ):
                            continue
                        self._latest = packet
                        if ok: self._latest_jpeg = encoded.tobytes()
                        self._published_monotonic = finished
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
