from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings
from .service import TrackingService


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or Settings.from_env()
    tracking_service = TrackingService(active_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        tracking_service.start()
        yield
        tracking_service.stop()

    app = FastAPI(
        title="Face Window Tracker",
        version="0.1.0",
        description="Local face/eye position stream for head-coupled 3D rendering.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    app.state.tracking_service = tracking_service

    @app.get("/api/v1/status")
    def status() -> dict:
        return tracking_service.status()

    async def _mjpeg_frames() -> AsyncIterator[bytes]:
        boundary = b"frame"
        last_sent: bytes | None = None
        while True:
            jpeg = tracking_service.latest_jpeg()
            if jpeg is not None and jpeg is not last_sent:
                last_sent = jpeg
                yield (
                    b"--" + boundary + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
            await asyncio.sleep(1 / 30)

    @app.get("/api/v1/debug/stream")
    def debug_stream() -> StreamingResponse:
        return StreamingResponse(
            _mjpeg_frames(),
            media_type="multipart/x-mixed-replace; boundary=frame",
        )

    @app.get("/api/v1/tracking/latest")
    def latest() -> dict:
        packet = tracking_service.latest()
        if packet is None:
            return {
                "protocol_version": "1.0",
                "type": "face_tracking",
                "tracking": False,
                "face": None,
                "service": tracking_service.status(),
            }
        return packet

    @app.websocket("/ws/v1/tracking")
    async def tracking_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        last_sequence = -1
        try:
            while True:
                packet = tracking_service.latest()
                if packet is not None and packet["sequence"] != last_sequence:
                    await websocket.send_json(packet)
                    last_sequence = packet["sequence"]
                await asyncio.sleep(1 / 120)
        except WebSocketDisconnect:
            pass

    return app


app = create_app()

