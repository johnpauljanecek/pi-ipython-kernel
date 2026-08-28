---
name: ipy
description: Pi skill for controlling IPython kernels via HTTP. Use to execute Python code in persistent named kernels, start/stop kernels, and manage the kernel registry.
---

# ipy Skill

Pi skill for controlling IPython kernels. Each kernel is a **persistent named resource** with its own companion FastAPI bridge (one bridge per kernel, never shared). Kernels are registered under `~/.ipy/kernels/<name>/` and outlive pi sessions.

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new named IPython kernel (persistent). Optional `name`, `python` env, `cwd`. |
| `kernel_connect` | Attach to a kernel by `name`, or an external kernel via `path`. |
| `kernel_run_python` | Execute Python code in the connected kernel. Output may be truncated; use `kernel_get_output`. |
| `kernel_eval_expr` | Evaluate a Python expression. Quick checks without polluting history. |
| `kernel_interrupt` | Interrupt a stuck kernel (control channel — works mid-execution). |
| `kernel_get_output` | Retrieve cached output slices when truncated. |
| `kernel_list` | List all kernels in the registry; prunes dead entries. |
| `kernel_stop` | Stop a kernel (and its bridge) by name/path, or the connected one. |
| `kernel_status` | Show the connected kernel + registry summary. |

## Lifecycle

- **Kernels persist** across pi sessions, `/quit`, and terminal close (spawned detached).
- They are stopped **only** by `kernel_stop`, a crash, or a reboot — never by session end.
- **No idle timeout.** Clean up manually via `kernel_list` + `kernel_stop`.
- Each kernel has a **companion bridge** (its own port, its own output cache) that lives and dies with it.
- tmux is **not** required for persistence — it is only needed to keep *pi itself* alive across ssh disconnects.

## Configuration

User preferences live in `cfg.json` in the package root. `~/` paths are auto-expanded.

```json
{
  "python": "",
  "default_cwd": "~/",
  "max_output_chars": 20000,
  "default_timeout_s": 60,
  "kernel_channel_timeout_s": 5,
  "default_connect": "",
  "auth_token": ""
}
```

**Fields**:
- `python` — default interpreter for `kernel_start`: `""` (default uv ipython tool), `"project"` (project env), a version spec (e.g. `"3.11"`), or an interpreter/venv path.
- `default_cwd` — working directory for new kernels (`~` expanded).
- `max_output_chars` — output truncation limit (default: 20000).
- `default_timeout_s` — default code-execution timeout (default: 60).
- `kernel_channel_timeout_s` — ZMQ socket timeout (default: 5).
- `default_connect` — kernel name or path used by `kernel_connect` with no args.
- `auth_token` — optional bridge auth token (auto-generated per kernel if empty).

## Workflow

### Start a kernel

```
kernel_start
```

With a name and a Python interpreter:

```
kernel_start { "name": "data", "python": "3.11", "cwd": "/path/to/project" }
```

Kernel logs: `tail -f ~/.ipy/kernels/<name>/kernel.log`.

### List / attach / connect

```
kernel_list
kernel_connect { "name": "data" }
```

External kernel (we didn't start it — only a bridge is added):

```
kernel_connect { "path": "~/kernels/my-kernel.json" }
```

### Execute code

```
kernel_run_python { "code": "print('hello from kernel')" }
```

Large output — fetch in slices:

```
kernel_get_output { "start": 0, "limit": 4000 }
```

### Quick expression eval

```
kernel_eval_expr { "expr": "len(data)" }
```

### Interrupt / stop / status

```
kernel_interrupt
kernel_status
kernel_stop                 # stops the connected kernel
kernel_stop { "name": "data" }
```

## Registry

Kernel state lives at `~/.ipy/kernels/<name>/`:

```
~/.ipy/kernels/<name>/
├── kernel.json    # ipykernel connection file
├── meta.json      # kernel_pid, bridge_port, python, cwd, started_at, …
├── kernel.log     # kernel stdout/stderr
└── bridge.log     # bridge stdout/stderr
```

`kernel_list` reaps dead kernels (and their orphaned bridges) automatically.

## Requirements

- `uv` installed and available in PATH.
- The bridge self-provisions its deps via `uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic` — no `.venv` needed.
- Kernels use `uv` too: default `uv tool run --from ipython --with ipykernel …` (self-contained).

## Error Handling

If a tool fails:
1. Check `kernel_status` and `kernel_list` for state.
2. Check `~/.ipy/kernels/<name>/kernel.log` and `bridge.log`.
3. Ensure a kernel is connected (`kernel_start` or `kernel_connect` first).
