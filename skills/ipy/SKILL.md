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

Configuration is in `cfg.json` in the package root:

```json
{
  "port": 9123,
  "kernel_connection_file": "/Users/johnjanecek/kernels/ipyforge-kernel.json",
  "default_cwd": "/Users/johnjanecek",
  "kernel_auto_created": false,
  "kernel_pid": null,
  "kernel_log_file": "/Users/johnjanecek/.ipy/kernel.log",
  "server_log_file": "/Users/johnjanecek/.ipy/server.log"
}
```

**Fields**:
- `port` — server port (default: 9123)
- `kernel_connection_file` — path to kernel connection file
- `default_cwd` — working directory for starting kernels
- `kernel_auto_created` — whether Pi created the kernel (true = can stop, false = user-created)
- `kernel_pid` — process ID if Pi created the kernel
- `kernel_log_file` — kernel stdout/stderr log
- `server_log_file` — server stdout/stderr log

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
kernel_get_output { "start": 4000, "limit": 4000 }
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
- Python packages: `fastapi`, `uvicorn`, `jupyter_client`, `pydantic`

Install IPython tool environment:

```bash
uv tool install ipython \
  --with ipykernel \
  --with jupyter-console
```

## Error Handling

If a tool fails:
1. Check `kernel_status` for server and kernel state
2. Check log files for errors
3. Ensure kernel is running (start with `kernel_start` or manually)
4. Verify connection file path in cfg.json