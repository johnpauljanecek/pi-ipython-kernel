"""
pi-ipython-kernel-bridge
======================
FastAPI bridge that wraps jupyter_client.BlockingKernelClient for ONE kernel.

Each bridge is the companion of a single named kernel. It loads that kernel's
connection file at startup and keeps ONE long-lived client (no per-request
client — see BUG-09: a fresh client per request leaks ZMQ sockets). A per-kernel
output cache lives here too.

Usage:
    uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq \
        python server/main.py --kernel-file <path> --port <port> [--token <tok>]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import queue
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

import uvicorn
import zmq
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from jupyter_client import BlockingKernelClient
from pydantic import BaseModel

CONFIG_FILENAME = "cfg.json"


# ---------------------------------------------------------------------------
# Config (timeouts / limits only — kernel file, port, and token come from CLI)
# ---------------------------------------------------------------------------

@dataclass
class BridgeConfig:
    max_output_chars: int = 20000
    default_timeout_s: float = 60.0
    kernel_channel_timeout_s: float = 5.0


def load_config() -> BridgeConfig:
    pkg_root = Path(__file__).resolve().parent.parent
    cfg_file = pkg_root / CONFIG_FILENAME
    if not cfg_file.exists():
        return BridgeConfig()
    raw = json.loads(cfg_file.read_text(encoding="utf-8"))
    return BridgeConfig(
        max_output_chars=int(raw.get("max_output_chars", 20000)),
        default_timeout_s=float(raw.get("default_timeout_s", 60.0)),
        kernel_channel_timeout_s=float(raw.get("kernel_channel_timeout_s", 5.0)),
    )


config: BridgeConfig = load_config()

# Runtime state, populated from CLI args at startup.
kernel_file: str = ""
bridge_port: int = 0
auth_token: str | None = None
parent_pid: int = 0

client: BlockingKernelClient | None = None
_connected: bool = False
_shell_lock = threading.Lock()
_control_lock = threading.Lock()

# Busy tracking (BUG-D): what is occupying the shell channel right now.
# Read without a lock — GIL-atomic, and only used for diagnostics.
_busy_since: float | None = None
_busy_snippet: str | None = None

_last_output_full: str = ""
_last_output_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Kernel client (single, long-lived)
# ---------------------------------------------------------------------------

def _load_connection_info(path: str) -> dict[str, Any]:
    kf = Path(path).expanduser().resolve()
    if not kf.exists():
        raise FileNotFoundError(f"Kernel connection file not found: {kf}")
    return json.loads(kf.read_text(encoding="utf-8"))


def _start_client(path: str) -> BlockingKernelClient:
    """Create and start a single long-lived BlockingKernelClient."""
    info = _load_connection_info(path)
    c = BlockingKernelClient()
    c.load_connection_info(info)
    c.start_channels()
    timeout_ms = int(config.kernel_channel_timeout_s) * 1000
    for ch_name in ("shell", "control", "iopub", "stdin"):
        ch = getattr(c, f"{ch_name}_channel", None)
        if ch is not None:
            ch.socket.setsockopt(zmq.RCVTIMEO, timeout_ms)
            ch.socket.setsockopt(zmq.SNDTIMEO, timeout_ms)
    return c


def _connect_loop() -> None:
    """Verify the kernel is reachable, retrying in the background until ready."""
    global client, _connected
    assert client is not None
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        # Non-blocking: never sit on the shell channel waiting for a socket
        # reply, or a legitimate run request would be reported as "busy".
        if _shell_lock.acquire(blocking=False):
            try:
                client.kernel_info()
                _connected = True
                return
            except Exception:
                pass
            finally:
                _shell_lock.release()
        time.sleep(0.5)
    _connected = False


# ---------------------------------------------------------------------------
# Busy guard (BUG-D)
# ---------------------------------------------------------------------------

class KernelBusy(Exception):
    """Raised when a request arrives while another call owns the kernel."""

    def __init__(self, busy_s: float, snippet: str | None) -> None:
        self.busy_s = busy_s
        self.snippet = snippet
        who = f" (running: {snippet})" if snippet else ""
        super().__init__(
            f"Kernel is busy — a previous call has been running for {busy_s:.0f}s{who}. "
            "Wait for it to finish, call kernel_interrupt, or raise timeout_s."
        )


def _snippet(code: str, limit: int = 60) -> str | None:
    for line in code.splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return None


@contextmanager
def _exec_slot(code: str = "") -> Iterator[None]:
    """Own the shell channel for one execution, failing fast when busy.

    Previously a second request would block on `_shell_lock` until the caller's
    own HTTP timeout expired, which surfaced as a bogus "cannot reach bridge".
    Refusing immediately makes the real cause visible.
    """
    global _busy_since, _busy_snippet
    if not _shell_lock.acquire(blocking=False):
        since = _busy_since
        elapsed = time.monotonic() - since if since is not None else 0.0
        raise KernelBusy(elapsed, _busy_snippet)
    _busy_since = time.monotonic()
    _busy_snippet = _snippet(code)
    try:
        yield
    finally:
        _busy_since = None
        _busy_snippet = None
        _shell_lock.release()


# ---------------------------------------------------------------------------
# Blocking kernel operations (run via asyncio.to_thread)
# ---------------------------------------------------------------------------

def _truncate(text: str, max_chars: int) -> tuple[str, bool]:
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + "\n…(truncated)…", True
    return text, False


def _run_code_blocking(code: str, timeout: float) -> tuple[str, bool]:
    global client, _connected, _last_output_full
    if client is None:
        raise RuntimeError("Bridge has no kernel client")
    with _exec_slot(code):
        msg_id = client.execute(code, silent=False, store_history=True, allow_stdin=True)

        out: list[str] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Execution timed out")
            try:
                msg = client.get_iopub_msg(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue  # no message yet; keep waiting until the overall deadline
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue

            msg_type = msg.get("msg_type")
            content = msg.get("content", {}) or {}

            if msg_type == "stream":
                text = content.get("text", "")
                if text:
                    out.append(text)
            elif msg_type in ("display_data", "execute_result"):
                text = content.get("data", {}).get("text/plain", "")
                if text:
                    out.append(text)
            elif msg_type == "error":
                trace = "\n".join(content.get("traceback", []) or [])
                if trace:
                    out.append(trace)
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break

        full = "\n".join(out).strip() or "ok"
        with _last_output_lock:
            _last_output_full = full
        _connected = True
        truncated, was_truncated = _truncate(full, config.max_output_chars)
        return truncated, was_truncated


def _eval_expr_blocking(expr: str, timeout: float) -> str:
    global client, _connected
    if client is None:
        raise RuntimeError("Bridge has no kernel client")
    with _exec_slot(f"<eval> {expr}"):
        msg_id = client.execute(
            "",
            silent=True,
            store_history=False,
            user_expressions={"__X__": expr},
            allow_stdin=False,
        )

        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Expression eval timed out")
            try:
                reply = client.get_shell_msg(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            if reply.get("parent_header", {}).get("msg_id") != msg_id:
                continue

            content = reply.get("content", {}) or {}
            if content.get("status") == "error":
                return "\n".join(content.get("traceback", []) or []) or "error"

            ue = content.get("user_expressions", {}) or {}
            x = ue.get("__X__", None)
            if isinstance(x, dict):
                if x.get("status") == "error":
                    return "\n".join(x.get("traceback", []) or []) or "error"
                data = x.get("data", {}) or {}
                text = data.get("text/plain", "")
                return (text or "").strip()

            return "" if x is None else str(x).strip()


def _interrupt_blocking() -> None:
    global client, _connected
    if client is None:
        raise RuntimeError("Bridge has no kernel client")
    with _control_lock:
        msg = client.session.msg("interrupt_request")
        client.control_channel.send(msg)
    _connected = True


def _shutdown_blocking() -> None:
    global client, _connected
    if client is None:
        raise RuntimeError("Bridge has no kernel client")
    with _control_lock:
        msg = client.session.msg("shutdown_request", content={"restart": False})
        client.control_channel.send(msg)
    _connected = True


def _watch_parent(pid: int, interval: float = 5.0) -> None:
    """Exit when the process that owns this bridge disappears (BUG-10).

    The bridge is launched through a `uv run` wrapper. When pi dies the wrapper
    can be reparented to init and keep running, so the bridge (and its port)
    leaks permanently — observed as orphaned bridges hours old holding ports.
    Watching pi's pid directly is immune to that reparenting.
    """
    while True:
        time.sleep(interval)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            print(f"[bridge] parent process {pid} is gone — exiting", flush=True)
            os._exit(0)
        except PermissionError:
            continue  # exists, just not signalable by us


def _get_kernel_python_blocking() -> dict[str, Any]:
    """Return the kernel's own sys.executable (the bridge env may differ)."""
    global client, _connected
    if client is None:
        raise RuntimeError("Bridge has no kernel client")
    with _exec_slot("<probe sys.executable>"):
        msg_id = client.execute(
            "import sys, importlib.util; print(sys.executable); "
            "print('has_jupyter_console', importlib.util.find_spec('jupyter_console') is not None)",
            silent=False,
            store_history=False,
            allow_stdin=False,
        )
        out: list[str] = []
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Timed out determining kernel python")
            try:
                msg = client.get_iopub_msg(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            mt = msg.get("msg_type")
            content = msg.get("content", {}) or {}
            if mt == "stream":
                out.append(content.get("text", ""))
            elif mt == "error":
                raise RuntimeError("\n".join(content.get("traceback", []) or []) or "error")
            elif mt == "status" and content.get("execution_state") == "idle":
                break
        lines = [ln.strip() for ln in "".join(out).splitlines() if ln.strip()]
        if not lines:
            raise RuntimeError("Could not determine kernel python executable")
        executable = lines[0]
        has_jupyter_console = any(
            ln.startswith("has_jupyter_console") and ln.endswith("True") for ln in lines
        )
        jupyter_bin = str(Path(executable).parent / "jupyter")
        jupyter_ok = has_jupyter_console and Path(jupyter_bin).exists()
        return {
            "executable": executable,
            "jupyter_bin": jupyter_bin if jupyter_ok else None,
            "has_jupyter_console": has_jupyter_console,
        }


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class RunCodeRequest(BaseModel):
    code: str
    timeout_s: Optional[float] = None


class EvalExprRequest(BaseModel):
    expr: str
    timeout_s: Optional[float] = None


class GetOutputRequest(BaseModel):
    start: int = 0
    limit: int = 4000


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="pi-ipython-kernel-bridge", version="0.1.0")


def require_token(
    x_ipy_token: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
) -> None:
    if not auth_token:
        return
    provided = x_ipy_token
    if authorization and authorization.startswith("Bearer "):
        provided = provided or authorization[7:]
    if not provided or provided != auth_token:
        raise HTTPException(401, detail="Invalid or missing token")


kernel_router = APIRouter(dependencies=[Depends(require_token)])


@app.get("/health")
def health():
    return {"status": "ok"}


@kernel_router.get("/kernel/status")
def kernel_status():
    since = _busy_since
    return {
        "connected": _connected,
        "connection_file": kernel_file,
        "port": bridge_port,
        "busy": since is not None,
        "busy_s": round(time.monotonic() - since, 1) if since is not None else 0.0,
        "running": _busy_snippet,
    }


@kernel_router.get("/kernel/python")
async def kernel_python():
    try:
        return await asyncio.to_thread(_get_kernel_python_blocking)
    except KernelBusy as e:
        raise HTTPException(409, detail=str(e))
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@kernel_router.post("/kernel/run-code")
async def kernel_run_code(req: RunCodeRequest):
    timeout = req.timeout_s if req.timeout_s is not None else config.default_timeout_s
    try:
        truncated, was_truncated = await asyncio.to_thread(_run_code_blocking, req.code, timeout)
        return {"output": truncated, "truncated": was_truncated}
    except KernelBusy as e:
        raise HTTPException(409, detail=str(e))
    except TimeoutError as e:
        raise HTTPException(504, detail=f"Execution failed or timed out: {e}")
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@kernel_router.post("/kernel/eval-expr")
async def kernel_eval_expr(req: EvalExprRequest):
    timeout = req.timeout_s if req.timeout_s is not None else config.default_timeout_s
    try:
        result = await asyncio.to_thread(_eval_expr_blocking, req.expr, timeout)
        return {"result": result}
    except KernelBusy as e:
        raise HTTPException(409, detail=str(e))
    except TimeoutError as e:
        raise HTTPException(504, detail=f"Expression eval failed or timed out: {e}")
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@kernel_router.post("/kernel/interrupt")
async def kernel_interrupt():
    try:
        await asyncio.to_thread(_interrupt_blocking)
        return {"interrupted": True}
    except Exception as e:
        raise HTTPException(502, detail=f"Interrupt failed: {e}")


@kernel_router.post("/kernel/shutdown")
async def kernel_shutdown():
    try:
        await asyncio.to_thread(_shutdown_blocking)
        return {"shutdown": True}
    except Exception as e:
        raise HTTPException(502, detail=f"Shutdown failed: {e}")


@kernel_router.post("/kernel/get-output")
async def kernel_get_output(req: GetOutputRequest):
    with _last_output_lock:
        s = _last_output_full
    if not s:
        return {"output": "(no cached output)", "start": 0, "end": 0, "total": 0}
    start = max(0, int(req.start))
    limit = max(1, int(req.limit))
    end = min(len(s), start + limit)
    return {"output": s[start:end], "start": start, "end": end, "total": len(s)}


@kernel_router.post("/shutdown")
def shutdown_bridge():
    """Stop this bridge process (kernel is stopped separately via /kernel/shutdown)."""

    def _exit():
        time.sleep(0.2)
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()
    return {"shutdown": True}


app.include_router(kernel_router)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    global kernel_file, bridge_port, auth_token, parent_pid, client

    parser = argparse.ArgumentParser(description="pi-ipython-kernel-bridge")
    parser.add_argument("--kernel-file", required=True, help="Path to kernel.json")
    parser.add_argument("--port", type=int, required=True, help="HTTP port to bind")
    parser.add_argument("--token", default=None, help="Optional auth token")
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="Owning process (pi); when it exits, so does this bridge",
    )
    args = parser.parse_args()

    kernel_file = str(Path(args.kernel_file).expanduser().resolve())
    bridge_port = args.port
    auth_token = args.token or None
    parent_pid = args.parent_pid or 0

    if parent_pid:
        threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True).start()

    try:
        client = _start_client(kernel_file)
        threading.Thread(target=_connect_loop, daemon=True).start()
    except Exception as e:
        print(f"[bridge] failed to start kernel client: {e}", file=sys.stderr)
        client = None

    print(f"[bridge] kernel_file={kernel_file} port={bridge_port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=bridge_port, log_level="info")


if __name__ == "__main__":
    main()
