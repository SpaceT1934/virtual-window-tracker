from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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

