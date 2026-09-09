"""Launch the installed local services from the dedicated Conda environment."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
# Run directly from the repository checkout; editable installation is optional.
sys.path.insert(0, str(ROOT / "src"))
URL = "http://127.0.0.1:3000/"


def check_environment() -> str:
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("Use Python 3.12 in the virtual-window-tracker Conda environment.")
    for module in ("face_tracker", "cv2", "mediapipe", "fastapi", "uvicorn"):
        if importlib.util.find_spec(module) is None:
            raise RuntimeError(f"Missing backend dependency: {module}. Install the project dependencies first.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js was not found on PATH.")
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if tuple(map(int, version.lstrip("v").split("."))) < (22, 13, 0):
        raise RuntimeError("Node.js 22.13 or newer is required.")
    if not (ROOT / "web/node_modules/vinext/dist/cli.js").is_file():
        raise RuntimeError("Frontend dependencies are missing. Run npm ci in the web directory.")
    for port in (3000, 8765):
        with socket.socket() as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as error:
                raise RuntimeError(f"Port {port} is already in use. Stop the existing service first.") from error
    return node


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        # Vinext starts a workerd child; stop only the tree owned by this launcher.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser")
    args = parser.parse_args()
    processes: list[subprocess.Popen] = []
    try:
        node = check_environment()
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + environment.get("PYTHONPATH", "")
        environment.setdefault("FACE_CAMERA_WIDTH", "640")
        environment.setdefault("FACE_CAMERA_HEIGHT", "480")
        environment["CHOKIDAR_USEPOLLING"] = "true"
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        print("Starting backend and website...", flush=True)
        for command, directory in (
            ([sys.executable, "-m", "face_tracker", "serve", "--host", "127.0.0.1", "--port", "8765"], ROOT),
            ([node, "node_modules/vinext/dist/cli.js", "dev", "--host", "127.0.0.1", "--port", "3000", "--strictPort"], ROOT / "web"),
        ):
            processes.append(subprocess.Popen(command, cwd=directory, env=environment,
                                              stdin=subprocess.DEVNULL, creationflags=flags))

        # Bypass machine proxy settings for local readiness checks.
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        pending = {URL, "http://127.0.0.1:8765/api/v1/status"}
        deadline = time.monotonic() + 90
        camera_state = "starting"
        while pending:
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("A service exited during startup. See its output above.")
            if time.monotonic() > deadline:
                raise RuntimeError("Startup timed out. See the service output above.")
            for address in list(pending):
                try:
                    with client.open(address, timeout=2) as response:
                        if address != URL:
                            status = json.load(response)
                            camera_state = status["state"]
                            if camera_state == "error":
                                raise RuntimeError(f"Tracking service failed: {status.get('error')}")
                            if camera_state == "starting":
                                continue
                        pending.remove(address)
                except (urllib.error.URLError, TimeoutError):
                    pass
            time.sleep(0.25)

        print(f"\nReady: {URL}", flush=True)
        if camera_state != "running":
            print(f"Camera state: {camera_state}. Mouse mode is available while the camera reconnects.", flush=True)
        if not args.no_browser:
            webbrowser.open(URL)
        print("Press Enter or Ctrl+C here to stop both services.", flush=True)
        stopped = threading.Event()

        def read_exit() -> None:
            try:
                input()
            except EOFError:
                pass
            stopped.set()

        threading.Thread(target=read_exit, daemon=True).start()
        while not stopped.wait(0.5):
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("A service exited. Stopping the remaining service.")
        return 0
    except KeyboardInterrupt:
        return 0
    except (OSError, RuntimeError) as error:
        print(f"\nError: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        for process in reversed(processes):
            stop_process(process)
        if len(processes) == 2:
            lock = ROOT / "web/.vinext/dev/lock.json"
            try:
                if json.loads(lock.read_text(encoding="utf-8")).get("pid") == processes[1].pid:
                    lock.unlink()
            except (OSError, ValueError):
                pass
        if processes:
            print("Services stopped.", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
