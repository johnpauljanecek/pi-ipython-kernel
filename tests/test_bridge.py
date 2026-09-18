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
import sys
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

    def __init__(self, tmpdir: Path, extra_bridge_args: list[str] | None = None):
        self.tmpdir = tmpdir
        self.kernel_file = tmpdir / "kernel.json"
        self.port = free_port()
        self.kernel_proc: subprocess.Popen | None = None
        self.bridge_proc: subprocess.Popen | None = None
        self.extra_bridge_args = extra_bridge_args or []

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
             "--port", str(self.port), "--token", TOKEN,
             *self.extra_bridge_args],
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


def test_kernel_python_returns_kernel_env(session):
    # /kernel/python must report the KERNEL's interpreter (queried via the
    # kernel), not the bridge's env.
    status, data = http("GET", url(session, "/kernel/python"), token=TOKEN)
    assert status == 200
    assert data["executable"] and Path(data["executable"]).is_file()
    assert data["executable"] != sys.executable  # kernel env ≠ pytest/bridge env
    assert isinstance(data["has_jupyter_console"], bool)
    # jupyter_bin is non-null only when jupyter-console is importable in the kernel
    if data["has_jupyter_console"]:
        assert data["jupyter_bin"] and Path(data["jupyter_bin"]).exists()
    else:
        assert data["jupyter_bin"] is None
    # endpoint is token-protected like the rest
    status_noauth, _ = http("GET", url(session, "/kernel/python"))
    assert status_noauth == 401


def test_no_socket_leak_under_sustained_use(session):
    # BUG-09 regression: a fresh client per request leaked ZMQ sockets and
    # failed after ~7 requests. A single long-lived client must serve many.
    for _ in range(20):
        status, data = http("POST", url(session, "/kernel/run-code"), {"code": "1"}, TOKEN)
        assert status == 200, f"request failed under sustained use: {data}"


def test_busy_request_fails_fast_with_409(session):
    # BUG-D regression: a request arriving while the kernel is executing used to
    # queue silently until the *caller's* HTTP timeout fired, which the extension
    # then reported as "cannot reach kernel bridge". It must instead be refused
    # immediately with 409 + a description of what is running.
    result: dict = {}

    def long_run():
        try:
            result["status"], result["data"] = http(
                "POST",
                url(session, "/kernel/run-code"),
                {"code": "import time; time.sleep(4); 'LONG_DONE'"},
                TOKEN,
                timeout=60,
            )
        except Exception as e:  # surfaced by the assertions below
            result["error"] = repr(e)

    t = threading.Thread(target=long_run)
    t.start()

    # Wait until the bridge reports itself busy.
    deadline = time.time() + 10
    busy = False
    while time.time() < deadline:
        status, data = http("GET", url(session, "/kernel/status"), token=TOKEN)
        assert status == 200
        if data.get("busy"):
            busy = True
            assert data.get("busy_s", 0) >= 0
            assert data.get("running"), "busy status must name what is running"
            break
        time.sleep(0.1)
    assert busy, "bridge never reported busy during a 4s run"

    # A second execution request must be refused, not queued.
    t0 = time.time()
    status, data = http("POST", url(session, "/kernel/run-code"), {"code": "1"}, TOKEN, timeout=30)
    elapsed = time.time() - t0
    assert status == 409, f"expected 409 while busy, got {status}: {data}"
    assert "busy" in str(data.get("detail", "")).lower(), data
    assert elapsed < 3.0, f"busy request took {elapsed:.1f}s — it queued instead of failing fast"

    # status must stay answerable while the kernel is occupied.
    status, data = http("GET", url(session, "/kernel/status"), token=TOKEN)
    assert status == 200 and data["busy"] is True

    t.join(timeout=60)
    assert result.get("error") is None, result
    assert result["status"] == 200, result
    assert "LONG_DONE" in result["data"]["output"], result

    # Once the run finishes the kernel accepts work again.
    status, data = http("POST", url(session, "/kernel/run-code"), {"code": "'after'"}, TOKEN)
    assert status == 200 and "after" in data["output"], data
    status, data = http("GET", url(session, "/kernel/status"), token=TOKEN)
    assert data["busy"] is False


def _start_standalone_bridge(tmp_path, watched_pid=None, stdin_watch=False, port=None, stdout=None):
    """Spawn a bridge directly (no kernel), watching an arbitrary pid."""
    port = port or free_port()
    args = ["uv", "run", "--with", "fastapi", "--with", "uvicorn",
            "--with", "jupyter_client", "--with", "pyzmq", "--with", "pydantic",
            "python", str(SERVER),
            "--kernel-file", str(tmp_path / "index.json"),
            "--port", str(port), "--token", TOKEN]
    if watched_pid is not None:
        args += ["--parent-pid", str(watched_pid)]
    if stdin_watch:
        args += ["--stdin-watch"]
    kwargs = {"cwd": PKG_ROOT, "start_new_session": True}
    if stdout is not None:
        kwargs["stdout"] = stdout
        kwargs["stderr"] = stdout
    else:
        log = open(tmp_path / "standalone-bridge.log", "wb")
        kwargs["stdout"] = log
        kwargs["stderr"] = subprocess.STDOUT
    proc = subprocess.Popen(args, **kwargs)
    wait_health(port)
    return proc, port


def test_reaper_survives_a_failing_log_write(tmp_path):
    # Regression: the exit path logged *before* calling os._exit(). When the log
    # write raised (pipe closed by the dead owner), the exception killed the
    # watchdog thread and the bridge kept serving forever — a leak that looks
    # exactly like the original bug and left no trace in the log.
    owner = subprocess.Popen(["sleep", "300"], start_new_session=True)
    read_fd, write_fd = os.pipe()
    proc = None
    try:
        proc, _ = _start_standalone_bridge(
            tmp_path, watched_pid=owner.pid, stdout=write_fd
        )
        os.close(write_fd)
        write_fd = None
        os.close(read_fd)  # every further write by the bridge now raises EPIPE
        read_fd = None

        owner.kill()
        owner.wait()

        deadline = time.time() + 30
        while time.time() < deadline and proc.poll() is None:
            time.sleep(0.5)
        assert proc.poll() is not None, (
            "bridge outlived its owner because it could not log the reason"
        )
    finally:
        for fd in (read_fd, write_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except Exception:
                    pass
        if owner.poll() is None:
            owner.kill()
        if proc is not None and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                proc.kill()


def test_stdin_watch_exits_when_owner_closes_the_pipe(tmp_path):
    # The fast path: pi holds the write end of the bridge's stdin, so EOF is an
    # immediate death signal — no polling, no log write, nothing to go wrong.
    proc = subprocess.Popen(
        ["uv", "run", "--with", "fastapi", "--with", "uvicorn",
         "--with", "jupyter_client", "--with", "pyzmq", "--with", "pydantic",
         "python", str(SERVER),
         "--kernel-file", str(tmp_path / "index.json"),
         "--port", str(free_port()), "--token", TOKEN, "--stdin-watch"],
        cwd=PKG_ROOT,
        stdin=subprocess.PIPE,
        stdout=open(tmp_path / "stdin-watch.log", "wb"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        proc.stdin.close()  # simulate pi exiting
        deadline = time.time() + 30
        while time.time() < deadline and proc.poll() is None:
            time.sleep(0.5)
        assert proc.poll() is not None, "bridge ignored stdin EOF"
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                proc.kill()


def test_bad_kernel_file_reports_error_instead_of_crashing(tmp_path):
    # Regression: main() wrote the startup error to sys.stderr without importing
    # sys, so a bridge whose kernel client could not start died with NameError
    # before uvicorn came up — the caller saw only a health-check timeout, and
    # the real cause (missing/invalid kernel file) was lost entirely.
    port = free_port()
    log = tmp_path / "bad-kernel-bridge.log"
    missing = tmp_path / "missing-kernel.json"
    proc = subprocess.Popen(
        ["uv", "run", "--with", "fastapi", "--with", "uvicorn",
         "--with", "jupyter_client", "--with", "pyzmq", "--with", "pydantic",
         "python", str(SERVER),
         "--kernel-file", str(missing), "--port", str(port), "--token", TOKEN],
        cwd=PKG_ROOT,
        stdout=open(log, "wb"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        wait_health(port)  # the bridge must still come up and serve
        status, data = http("POST", f"http://127.0.0.1:{port}/kernel/run-code", {"code": "1"}, TOKEN)
        assert status == 502, data
        assert any("no kernel client" in str(v).lower() for v in data.values()), data

        text = log.read_text(errors="replace")
        assert "NameError" not in text, text
        assert "failed to start kernel client" in text, text
        assert "connection file not found" in text.lower(), text
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            proc.kill()


def test_bridge_exits_when_parent_dies(tmp_path):
    # BUG-16 regression: a bridge outlives its pi session, leaking a port and
    # ~5 ZMQ sockets forever (observed: orphaned bridges hours old on a machine
    # with no live session). With --parent-pid the bridge watches the owner.
    owner = subprocess.Popen(["sleep", "300"], start_new_session=True)
    s = Session(tmp_path, extra_bridge_args=["--parent-pid", str(owner.pid)])
    try:
        s.start()
        assert s.bridge_proc is not None and s.bridge_proc.poll() is None

        owner.kill()
        owner.wait()

        deadline = time.time() + 30
        while time.time() < deadline and s.bridge_proc.poll() is None:
            time.sleep(0.5)
        assert s.bridge_proc.poll() is not None, "bridge outlived its owner"
    finally:
        if owner.poll() is None:
            owner.kill()
        s.stop()
