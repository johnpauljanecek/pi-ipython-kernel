---
name: ipy
description: Pi skill for controlling an IPython kernel via HTTP. Use to execute Python code in a persistent kernel, start/stop kernels, and manage kernel connections.
---

# ipy Skill

Pi skill for controlling an IPython kernel via HTTP. The extension communicates with a local FastAPI server that wraps `jupyter_client.BlockingKernelClient`.

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new IPython kernel via execa. Updates cfg.json with connection file and PID. |
| `kernel_connect` | Connect to a kernel. Use path argument or cfg.json. |
| `kernel_run_python` | Execute Python code in the kernel. Output may be truncated; use `kernel_get_output` for full output. |
| `kernel_eval_expr` | Evaluate a Python expression. Use for quick checks without polluting history. |
| `kernel_interrupt` | Interrupt a stuck kernel. |
| `kernel_get_output` | Retrieve cached output slices when truncated. |
| `kernel_stop` | Stop a Pi-created kernel. No-op for user-created kernels. |
| `kernel_status` | Show server and kernel connection status. |

## Configuration

Configuration is in `cfg.json` in the package root. Use `~/` paths — they are automatically expanded.

```json
{
  "port": 9123,
  "kernel_connection_file": "~/kernels/ipyforge-kernel.json",
  "max_output_chars": 20000,
  "default_timeout_s": 30,
  "kernel_channel_timeout_s": 5,
  "default_cwd": "~/",
  "kernel_auto_created": false,
  "kernel_pid": null,
  "kernel_log_file": "~/.ipy/kernel.log",
  "server_log_file": "~/.ipy/server.log"
}
```

**Fields**:
- `port` — server port (default: 9123)
- `kernel_connection_file` — path to kernel connection file (`~` expanded)
- `max_output_chars` — max chars before output truncation (default: 20000)
- `default_timeout_s` — default timeout for code execution (default: 30)
- `kernel_channel_timeout_s` — ZMQ socket timeout for kernel communication (default: 5)
- `default_cwd` — working directory for starting kernels (`~` expanded)
- `kernel_auto_created` — whether Pi created the kernel (true = can stop, false = user-created)
- `kernel_pid` — process ID if Pi created the kernel
- `kernel_log_file` — kernel stdout/stderr log (`~` expanded)
- `server_log_file` — server stdout/stderr log (`~` expanded)

## Workflow

### Start a new kernel

```
kernel_start
```

Or with a specific working directory:

```
kernel_start { "cwd": "/path/to/project" }
```

The kernel runs via execa with output written to `kernel_log_file`. Monitor with:

```bash
tail -f ~/.ipy/kernel.log
```

### Connect to existing kernel

**Option A**: Use cfg.json (kernel already configured):
```
kernel_connect
```

**Option B**: Provide path argument (user-created kernel):
```
kernel_connect { "path": "~/kernels/my-kernel.json" }
```

### Execute code

```
kernel_run_python { "code": "print('hello from kernel')" }
```

For large output:
```
kernel_run_python { "code": "..." }
kernel_get_output { "start": 0, "limit": 4000 }
```

**Example tool call:**
```
kernel_run_python {
  "code": "def hanoi(n, source=\"A\", target=\"C\", auxiliary=\"B\"):\n    if n == 1:\n        print(f\"Move disk 1 from {source} to {target}\")\n        return\n    hanoi(n - 1, source, auxiliary, target)\n    print(f\"Move disk {n} from {source} to {target}\")\n    hanoi(n - 1, auxiliary, target, source)\n\nprint(\"Towers of Hanoi - 3 disks:\")\nhanoi(3)"
}
```

### Quick expression eval

```
kernel_eval_expr { "expr": "len(data)" }
```

### Interrupt stuck execution

```
kernel_interrupt
```

### Check status

```
kernel_status
```

Shows:
- Server running/not running
- Kernel connected/not connected
- Connection file path
- Auto-created flag
- PID if Pi-created
- Log file paths

### Stop kernel

```
kernel_stop
```

Only works for Pi-created kernels. No-op for user-created kernels.

Shuts down in four stages:
1. Graceful Jupyter shutdown via control channel
2. Kill tracked kernel process
3. Kill process group (catches child Python processes)
4. Clean up kernel connection file

The shutdown method is reported in the output (`graceful shutdown` or `process kill`).

## Log Monitoring

Both kernel and server output are written to log files. Monitor with:

```bash
# Kernel logs
tail -f ~/.ipy/kernel.log

# Server logs
tail -f ~/.ipy/server.log
```

The user is responsible for monitoring logs. If execution fails, check the log files for errors.

## Requirements

- `uv` installed and available in PATH
- `ipython` tool installed via `uv tool install ipython --with ipykernel`
- Python packages: `fastapi`, `uvicorn`, `jupyter_client`, `ipykernel`, `jupyter_console`, `pydantic`, `pyzmq`

Install IPython tool environment:

```bash
uv tool install ipython \
  --with ipykernel \
  --with jupyter-console
```

## Timeout Protection

All HTTP requests to the server use a 10-second timeout via `AbortSignal`. If the server
is unreachable, tools fail fast instead of hanging indefinitely.

The server also sets ZMQ socket timeouts (`kernel_channel_timeout_s`, default 5s) on all
kernel channels, so a stuck kernel won't block subsequent operations.

## Error Handling

If a tool fails:
1. Check `kernel_status` for server and kernel state
2. Check log files for errors
3. Ensure kernel is running (start with `kernel_start` or manually)
4. Verify connection file path in cfg.json