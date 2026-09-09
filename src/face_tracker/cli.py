from __future__ import annotations

import argparse
import time
from dataclasses import replace

import cv2
import uvicorn

from .config import Settings
from .tracker import draw_debug_overlay
from .tracker_factory import create_tracker


def run_server(host: str, port: int, settings: Settings) -> None:
    from .api import create_app

    uvicorn.run(create_app(settings), host=host, port=port, reload=False)


def run_preview(settings: Settings) -> None:
    capture = cv2.VideoCapture(settings.opencv_camera_source)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, settings.camera_width)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, settings.camera_height)
    capture.set(cv2.CAP_PROP_FPS, settings.camera_fps)
    if not capture.isOpened():
        raise SystemExit(f"Cannot open camera {settings.camera_source!r}")

    started = time.perf_counter()
    previous = started
    fps = 0.0
    try:
        with create_tracker(settings) as tracker:
            while True:
                ok, frame = capture.read()
                if not ok:
                    raise SystemExit("Camera stopped returning frames")
                now = time.perf_counter()
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
    serve.add_argument("--tracker", choices=["detector", "landmarker", "yunet"])
    preview = subparsers.add_parser("preview", help="Open an annotated camera preview")
    preview.add_argument("--tracker", choices=["detector", "landmarker", "yunet"])

    args = parser.parse_args()
    settings = Settings.from_env()
    if args.tracker:
        settings = replace(settings, tracker_backend=args.tracker)
    if args.command == "serve":
        run_server(args.host, args.port, settings)
    else:
        run_preview(settings)

