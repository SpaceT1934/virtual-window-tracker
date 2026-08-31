from face_tracker.api import create_app
from face_tracker.config import Settings


def test_versioned_api_routes_are_exposed() -> None:
    app = create_app(Settings())
    routes = {route.path for route in app.routes}
    assert "/api/v1/status" in routes
    assert "/api/v1/tracking/latest" in routes
    assert "/ws/v1/tracking" in routes


def test_openapi_metadata() -> None:
    schema = create_app(Settings()).openapi()
    assert schema["info"]["title"] == "Face Window Tracker"
    assert schema["info"]["version"] == "0.1.0"

