"""
ipyforge-kernel-server
======================
FastAPI server that wraps jupyter_client.BlockingKernelClient.
Connects to an already-running IPython kernel via its kernel.json file.

Usage:
    cd /path/to/ipython_extension
    uv run python server/main.py

Config read from ./cfg.json (working directory at startup).
"""

from __future__ import annotations

import json
import os
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import uvicorn
import zmq
from fastapi import FastAPI, HTTPException
from jupyter_client import BlockingKernelClient, KernelManager
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_FILENAME = "cfg.json"


@dataclass
class ServerConfig:
    port: int = 9123
    kernel_connection_file: str = ""
    max_output_chars: int = 20000
    default_timeout_s: float = 30.0
    kernel_channel_timeout_s: float = 5.0


def load_config(cwd: str | None = None) -> ServerConfig:
    """Read cfg.json from working directory. Return defaults if missing."""
    cfg_file = Path(cwd or os.getcwd()) / CONFIG_FILENAME
    if not cfg_file.exists():
        print(f"[server] No {CONFIG_FILENAME} found at {cfg_file.parent}, using defaults")
        return ServerConfig()

    raw = json.loads(cfg_file.read_text(encoding="utf-8"))
    return ServerConfig(
        port=int(raw.get("port", 9123)),
        kernel_connection_file=str(raw.get("kernel_connection_file", "")),
        max_output_chars=int(raw.get("max_output_chars", 20000)),
        default_timeout_s=float(raw.get("default_timeout_s", 30.0)),
        kernel_channel_timeout_s=float(raw.get("kernel_channel_timeout_s", 5.0)),
    )


# ---------------------------------------------------------------------------
# Kernel connection helpers (fresh client per request)
# ---------------------------------------------------------------------------

def _load_connection_info(path: str) -> dict[str, Any]:
    kf = Path(path).expanduser().resolve()
    if not kf.exists():
        raise FileNotFoundError(f"Kernel connection file not found: {kf}")
    return json.loads(kf.read_text(encoding="utf-8"))


def _connect(path: str) -> BlockingKernelClient:
    """Create, connect, and verify a fresh BlockingKernelClient."""
    info = _load_connection_info(path)
    c = BlockingKernelClient()
    c.load_connection_info(info)
    channel_timeout = int(config.kernel_channel_timeout_s)
    c.start_channels()
    # Set timeouts on ZMQ channels so we don't hang on a dead kernel
    timeout_ms = channel_timeout * 1000
    for ch_name in ("shell", "control", "iopub", "stdin"):
        ch = getattr(c, f"{ch_name}_channel", None)
        if ch is not None:
            ch.socket.setsockopt(zmq.RCVTIMEO, timeout_ms)
            ch.socket.setsockopt(zmq.SNDTIMEO, timeout_ms)
    try:
        c.kernel_info()  # verify the kernel is alive
    except Exception as exc:
        c.stop_channels()
        raise RuntimeError(f"Kernel info failed — is the kernel running?\n{exc}") from exc
    return c


def _truncate(text: str, max_chars: int) -> str:
    if max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + "\n…(truncated)…"
    return text


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

config: ServerConfig = load_config()
_last_output_full: str = ""
_last_output_lock = threading.Lock()

app = FastAPI(title="ipyforge-kernel-server", version="0.1.0")

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ConnectRequest(BaseModel):
    connection_file: Optional[str] = None
    set_default: bool = True


class ConnectResponse(BaseModel):
    connected_file: str
    status: str


class RunCodeRequest(BaseModel):
    code: str
    timeout_s: Optional[float] = None


class RunCodeResponse(BaseModel):
    output: str
    truncated: bool


class EvalExprRequest(BaseModel):
    expr: str
    timeout_s: Optional[float] = None


class EvalExprResponse(BaseModel):
    result: str


class InterruptResponse(BaseModel):
    interrupted: bool


class ShutdownResponse(BaseModel):
    shutdown: bool
    pid_killed: bool = False


class GetOutputRequest(BaseModel):
    start: int = 0
    limit: int = 4000


class GetOutputResponse(BaseModel):
    output: str
    start: int
    end: int
    total: int


class StatusResponse(BaseModel):
    connected: bool
    connection_file: str
    port: int


class HealthResponse(BaseModel):
    status: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


@app.post("/kernel/connect", response_model=ConnectResponse)
async def kernel_connect(req: ConnectRequest):
    """Connect to a kernel connection file and verify it."""
    global config

    path = req.connection_file or config.kernel_connection_file
    if not path:
        raise HTTPException(400, detail="No connection_file provided and none configured in cfg.json")

    try:
        client = _connect(path)
        client.stop_channels()
    except FileNotFoundError as e:
        raise HTTPException(400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(502, detail=str(e))
    except Exception as e:
        raise HTTPException(502, detail=f"Connection failed: {e}")

    if req.connection_file and req.set_default:
        config.kernel_connection_file = path

    return ConnectResponse(connected_file=str(Path(path).expanduser().resolve()), status="connected")


@app.post("/kernel/run-code", response_model=RunCodeResponse)
async def kernel_run_code(req: RunCodeRequest):
    """Execute Python code in the kernel and return captured output."""
    path = config.kernel_connection_file
    if not path:
        raise HTTPException(400, detail="No kernel connection file configured. Call /kernel/connect first.")

    try:
        client = _connect(path)
    except (FileNotFoundError, RuntimeError, Exception) as e:
        raise HTTPException(502, detail=str(e))

    try:
        timeout = req.timeout_s if req.timeout_s is not None else config.default_timeout_s
        msg_id = client.execute(req.code, silent=False, store_history=True, allow_stdin=True)

        out: list[str] = []
        while True:
            msg = client.get_iopub_msg(timeout=timeout)
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

        global _last_output_full
        with _last_output_lock:
            _last_output_full = full

        truncated = _truncate(full, config.max_output_chars)
        return RunCodeResponse(output=truncated, truncated=len(truncated) < len(full))
    except Exception as e:
        raise HTTPException(504, detail=f"Execution failed or timed out: {e}")
    finally:
        try:
            client.stop_channels()
        except Exception:
            pass


@app.post("/kernel/eval-expr", response_model=EvalExprResponse)
async def kernel_eval_expr(req: EvalExprRequest):
    """Evaluate a Python expression using user_expressions and return text/plain result."""
    path = config.kernel_connection_file
    if not path:
        raise HTTPException(400, detail="No kernel connection file configured. Call /kernel/connect first.")

    try:
        client = _connect(path)
    except (FileNotFoundError, RuntimeError, Exception) as e:
        raise HTTPException(502, detail=str(e))

    try:
        timeout = req.timeout_s if req.timeout_s is not None else config.default_timeout_s
        msg_id = client.execute(
            "",
            silent=True,
            store_history=False,
            user_expressions={"__X__": req.expr},
            allow_stdin=False,
        )

        while True:
            reply = client.get_shell_msg(timeout=timeout)
            if reply.get("parent_header", {}).get("msg_id") != msg_id:
                continue

            content = reply.get("content", {}) or {}
            if content.get("status") == "error":
                trace = "\n".join(content.get("traceback", []) or []) or "error"
                return EvalExprResponse(result=trace)

            ue = content.get("user_expressions", {}) or {}
            x = ue.get("__X__", None)
            if isinstance(x, dict):
                if x.get("status") == "error":
                    trace = "\n".join(x.get("traceback", []) or []) or "error"
                    return EvalExprResponse(result=trace)
                data = x.get("data", {}) or {}
                text = data.get("text/plain", "")
                return EvalExprResponse(result=(text or "").strip())

            return EvalExprResponse(result="" if x is None else str(x).strip())

    except Exception as e:
        raise HTTPException(504, detail=f"Expression eval failed or timed out: {e}")
    finally:
        try:
            client.stop_channels()
        except Exception:
            pass


@app.post("/kernel/interrupt", response_model=InterruptResponse)
async def kernel_interrupt():
    """Interrupt the running kernel (sends SIGINT via control channel)."""
    path = config.kernel_connection_file
    if not path:
        raise HTTPException(400, detail="No kernel connection file configured. Call /kernel/connect first.")

    try:
        client = _connect(path)
    except (FileNotFoundError, RuntimeError, Exception) as e:
        raise HTTPException(502, detail=str(e))

    try:
        # Use blocking client's session to construct interrupt message via control channel
        msg = client.session.msg("interrupt_request")
        client.control_channel.send(msg)
        return InterruptResponse(interrupted=True)
    except Exception as e:
        raise HTTPException(502, detail=f"Interrupt failed: {e}")
    finally:
        try:
            client.stop_channels()
        except Exception:
            pass


@app.post("/kernel/shutdown", response_model=ShutdownResponse)
async def kernel_shutdown():
    """Send a shutdown_request via the control channel to stop the kernel cleanly."""
    path = config.kernel_connection_file
    if not path:
        raise HTTPException(400, detail="No kernel connection file configured. Call /kernel/connect first.")

    try:
        client = _connect(path)
    except (FileNotFoundError, RuntimeError, Exception) as e:
        raise HTTPException(502, detail=str(e))

    try:
        client.shutdown(restart=False)
        return ShutdownResponse(shutdown=True)
    except Exception as e:
        raise HTTPException(502, detail=f"Shutdown failed: {e}")
    finally:
        try:
            client.stop_channels()
        except Exception:
            pass


@app.post("/kernel/get-output", response_model=GetOutputResponse)
async def kernel_get_output(req: GetOutputRequest):
    """Return a slice of the last captured full output from run-code."""
    with _last_output_lock:
        s = _last_output_full

    if not s:
        return GetOutputResponse(output="(no cached output)", start=0, end=0, total=0)

    start = max(0, int(req.start))
    limit = max(1, int(req.limit))
    end = min(len(s), start + limit)
    return GetOutputResponse(output=s[start:end], start=start, end=end, total=len(s))


@app.get("/kernel/status", response_model=StatusResponse)
async def kernel_status():
    """Return current connection and config status."""
    path = config.kernel_connection_file
    connected = False
    if path:
        try:
            client = _connect(path)
            client.stop_channels()
            connected = True
        except Exception:
            connected = False

    return StatusResponse(connected=connected, connection_file=path, port=config.port)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    print(f"[server] Starting on port {config.port}")
    print(f"[server] Kernel connection file: {config.kernel_connection_file or '(not set)'}")
    uvicorn.run(app, host="127.0.0.1", port=config.port, log_level="info")


if __name__ == "__main__":
    main()
