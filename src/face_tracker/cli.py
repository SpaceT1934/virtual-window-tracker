from __future__ import annotations

import argparse
import time

import cv2
import uvicorn

from .config import Settings
from .model_loader import ensure_model
from .tracker import FacePositionTracker, draw_debug_overlay


def run_server(host: str, port: int) -> None:
    uvicorn.run("face_tracker.api:app", host=host, port=port, reload=False)


def run_preview(settings: Settings) -> None:
    model_path = ensure_model(settings.model_path, settings.model_url)
    capture = cv2.VideoCapture(settings.opencv_camera_source)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, settings.camera_width)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, settings.camera_height)
    capture.set(cv2.CAP_PROP_FPS, settings.camera_fps)
    if not capture.isOpened():
        raise SystemExit(f"Cannot open camera {settings.camera_source!r}")

    started = time.monotonic()
    previous = started
    fps = 0.0
    try:
        with FacePositionTracker(settings, model_path) as tracker:
            while True:
                ok, frame = capture.read()
                if not ok:
                    raise SystemExit("Camera stopped returning frames")
                now = time.monotonic()
                instant_fps = 1.0 / max(now - previous, 1e-6)
                fps = instant_fps if fps == 0 else fps * 0.9 + instant_fps * 0.1
                previous = now
                result = tracker.process(frame, int((now - started) * 1000))
                draw_debug_overlay(frame, result, fps)
                cv2.imshow("Face Window Tracker - press Q to quit", frame)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
    finally:
        capture.release()
        cv2.destroyAllWindows()


def main() -> None:
    parser = argparse.ArgumentParser(description="Local face position tracker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Start REST and WebSocket API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    subparsers.add_parser("preview", help="Open an annotated camera preview")

    args = parser.parse_args()
    if args.command == "serve":
        run_server(args.host, args.port)
    else:
        run_preview(Settings.from_env())

