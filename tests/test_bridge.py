"""
Integration tests for the per-kernel bridge (server/main.py).

Spawns a real IPython kernel + its companion bridge (exactly as the extension
does), then exercises every endpoint and the key invariants:

  - run-code / eval-expr + state persistence
  - overall-deadline timeout (not per-message)
  - interrupt during a long run (event loop stays free via asyncio.to_thread)
  - auth token (401 without, 200 with)
  - get-output cache
  - no ZMQ socket leak under sustained use (BUG-09 regression)

Run with:  uv run pytest tests/test_bridge.py -v
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

PKG_ROOT = Path(__file__).resolve().parent.parent
SERVER = PKG_ROOT / "server" / "main.py"
TOKEN = "test-token-123"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method: str, url: str, body=None, token: str | None = None, timeout: float = 120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-IPY-TOKEN", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"detail": raw}


def wait_health(port: int, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            http("GET", f"http://127.0.0.1:{port}/health", timeout=2)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"bridge on port {port} never became healthy")


class Session:
    """A running kernel + bridge pair."""

    def __init__(self, tmpdir: Path):
        self.tmpdir = tmpdir
        self.kernel_file = tmpdir / "kernel.json"
        self.port = free_port()
        self.kernel_proc: subprocess.Popen | None = None
        self.bridge_proc: subprocess.Popen | None = None

    def start(self) -> None:
        self.kernel_proc = subprocess.Popen(
            ["uv", "tool", "run", "--from", "ipython", "--with", "ipykernel",
             "python", "-m", "ipykernel", "-f", str(self.kernel_file)],
            cwd=PKG_ROOT,
            stdout=open(self.tmpdir / "kernel.log", "wb"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 60
        while time.time() < deadline and not self.kernel_file.exists():
            time.sleep(0.2)
        assert self.kernel_file.exists(), "kernel.json never created"

        self.bridge_proc = subprocess.Popen(
            ["uv", "run", "--with", "fastapi", "--with", "uvicorn",
             "--with", "jupyter_client", "--with", "pyzmq", "--with", "pydantic",
             "python", str(SERVER),
             "--kernel-file", str(self.kernel_file),
             "--port", str(self.port), "--token", TOKEN],
            cwd=PKG_ROOT,
            stdout=open(self.tmpdir / "bridge.log", "wb"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        wait_health(self.port)

    def stop(self) -> None:
        try:
            http("POST", f"http://127.0.0.1:{self.port}/shutdown", token=TOKEN, timeout=5)
        except Exception:
            pass
        time.sleep(0.5)
        for p in (self.bridge_proc, self.kernel_proc):
            if p and p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except Exception:
                    p.kill()


@pytest.fixture(scope="module")
def session(tmp_path_factory):
    s = Session(tmp_path_factory.mktemp("bridge"))
    s.start()
    yield s
    s.stop()


def url(s: Session, path: str) -> str:
    return f"http://127.0.0.1:{s.port}{path}"


# ---------------------------------------------------------------------------
# Tests (run in definition order against one shared kernel)
# ---------------------------------------------------------------------------

def test_health_needs_no_token(session):
    status, _ = http("GET", url(session, "/health"))
    assert status == 200


def test_auth_required(session):
    status, _ = http("POST", url(session, "/kernel/run-code"), {"code": "1+1"})
    assert status == 401


def test_run_code(session):
    status, data = http("POST", url(session, "/kernel/run-code"), {"code": "x = 41; x + 1"}, TOKEN)
    assert status == 200
    assert data["output"] == "42"


def test_eval_expr_persists_state(session):
    http("POST", url(session, "/kernel/run-code"), {"code": "x = 41"}, TOKEN)
    status, data = http("POST", url(session, "/kernel/eval-expr"), {"expr": "x + 1"}, TOKEN)
    assert status == 200
    assert data["result"] == "42"


def test_timeout_is_an_overall_deadline(session):
    # Emits output every 0.5s for 15s. A per-message timeout would let it run
    # to completion; the overall deadline must cut it at ~2s.
    code = "import time\nfor i in range(30):\n    print(i)\n    time.sleep(0.5)"
    t0 = time.time()
    status, _ = http("POST", url(session, "/kernel/run-code"), {"code": code, "timeout_s": 2}, TOKEN)
    elapsed = time.time() - t0
    assert status == 504
    assert elapsed < 8, f"overall deadline not enforced (took {elapsed:.1f}s)"


def test_chatty_computation_completes(session):
    code = "import time\nfor i in range(5):\n    print('n', i)\n    time.sleep(0.05)"
    status, data = http("POST", url(session, "/kernel/run-code"), {"code": code, "timeout_s": 20}, TOKEN)
    assert status == 200
    assert "n 4" in data["output"]


def test_interrupt_during_run(session):
    result: dict = {}

    def run():
        s, d = http("POST", url(session, "/kernel/run-code"),
                    {"code": "import time; time.sleep(30); print('done')", "timeout_s": 40}, TOKEN)
        result["status"], result["data"] = s, d

    t = threading.Thread(target=run)
    t.start()
    time.sleep(3)  # let it start executing

    t0 = time.time()
    status, _ = http("POST", url(session, "/kernel/interrupt"), {}, TOKEN)
    interrupt_elapsed = time.time() - t0
    assert status == 200
    assert interrupt_elapsed < 5, "interrupt blocked by a long run (event loop not free)"

    t.join(timeout=15)
    assert not t.is_alive(), "run-code did not return after interrupt"
    assert result["status"] == 200
    assert "KeyboardInterrupt" in result["data"]["output"]


def test_get_output_cache(session):
    http("POST", url(session, "/kernel/run-code"), {"code": "print('cache-me')"}, TOKEN)
    status, data = http("POST", url(session, "/kernel/get-output"), {"start": 0, "limit": 200}, TOKEN)
    assert status == 200
    assert "cache-me" in data["output"]


def test_no_socket_leak_under_sustained_use(session):
    # BUG-09 regression: a fresh client per request leaked ZMQ sockets and
    # failed after ~7 requests. A single long-lived client must serve many.
    for _ in range(20):
        status, data = http("POST", url(session, "/kernel/run-code"), {"code": "1"}, TOKEN)
        assert status == 200, f"request failed under sustained use: {data}"
