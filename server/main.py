"""
ipyforge-kernel-bridge
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
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

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

client: BlockingKernelClient | None = None
_connected: bool = False
_shell_lock = threading.Lock()
_control_lock = threading.Lock()

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
        try:
            with _shell_lock:
                client.kernel_info()
            _connected = True
            return
        except Exception:
            time.sleep(0.5)
    _connected = False


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
    with _shell_lock:
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
    with _shell_lock:
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

app = FastAPI(title="ipyforge-kernel-bridge", version="0.2.0")


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
    return {
        "connected": _connected,
        "connection_file": kernel_file,
        "port": bridge_port,
    }


@kernel_router.post("/kernel/run-code")
async def kernel_run_code(req: RunCodeRequest):
    timeout = req.timeout_s if req.timeout_s is not None else config.default_timeout_s
    try:
        truncated, was_truncated = await asyncio.to_thread(_run_code_blocking, req.code, timeout)
        return {"output": truncated, "truncated": was_truncated}
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
    global kernel_file, bridge_port, auth_token, client

    parser = argparse.ArgumentParser(description="ipyforge-kernel-bridge")
    parser.add_argument("--kernel-file", required=True, help="Path to kernel.json")
    parser.add_argument("--port", type=int, required=True, help="HTTP port to bind")
    parser.add_argument("--token", default=None, help="Optional auth token")
    args = parser.parse_args()

    kernel_file = str(Path(args.kernel_file).expanduser().resolve())
    bridge_port = args.port
    auth_token = args.token or None

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
