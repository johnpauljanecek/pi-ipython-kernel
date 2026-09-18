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
| `kernel_console_cmd` | One-line command to attach a Jupyter console (uses the kernel's own env). |

## Lifecycle

- **Kernels persist** across pi sessions, `/quit`, and terminal close (spawned detached).
- They are stopped **only** by `kernel_stop`, a crash, or a reboot — never by session end.
- **No idle timeout.** Clean up manually via `kernel_list` + `kernel_stop`.
- Each kernel has a **companion bridge** (its own port, its own output cache). It is
  session-scoped: when the pi process that spawned it exits, the bridge reaps itself
  (BUG-16) while the kernel keeps running. The next session respawns the bridge on
  demand — the kernel's state survives, the bridge's output cache does not.
- tmux is **not** required for persistence — it is only needed to keep *pi itself* alive across ssh disconnects.

## Busy kernels and timeouts

A kernel executes one thing at a time. While a call is running, another execution
request is refused immediately with **HTTP 409** (BUG-15) rather than queued:

- the error reads *"Kernel '<name>' is busy and refused the request"* and names the
  code that is running plus how long it has been running;
- `kernel_status` prints a `Busy:` line, and works *during* a run — as do
  `kernel_interrupt` and `kernel_get_output`;
- `kernel_get_output` can still return the previous call's full output after a
  client-side timeout (BUG-14), so a timeout is not data loss.

A message *"did not answer within Ns"* means the bridge is healthy and the kernel is
still working — raise `timeout_s`, or use `kernel_interrupt`. Only
*"not accepting connections on port N"* means the bridge itself is gone; retrying
the call respawns it.

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

### Attach a Jupyter console

```
kernel_console_cmd
```

Writes `~/.ipy/kernels/<name>/console.sh` and returns a short, copy-safe line
to paste (long one-liners get wrapped when copied):

```bash
bash ~/.ipy/kernels/<name>/console.sh
```

The script runs the kernel's own `jupyter console --existing <kernel.json>`
(the kernel's Python environment, not a hardcoded one).

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

Host side (README "Installation → Part 1 — the host" has the full checklist):

- `uv` installed and available in **pi's** PATH — the only hard dependency.
- A POSIX OS with `ps` and `kill` (macOS/Linux). Windows is not supported.
- Writable extension directory and `~/.ipy/kernels/`; loopback networking.
- Python packages are self-provisioned — nothing to install by hand: kernels use
  `uv tool run --from ipython --with ipykernel …`, the bridge uses
  `uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic …`.
  uv builds/uses an env for each (a `.venv/` in the package directory for the bridge, a tool
  env for the interpreter), so no venv is created manually — but the first run is slow while
  uv downloads them, and a missing `uv` surfaces as the kernel exiting during startup.

## Error Handling

If a tool fails:
1. Check `kernel_status` and `kernel_list` for state.
2. Check `~/.ipy/kernels/<name>/kernel.log` and `bridge.log`.
3. Ensure a kernel is connected (`kernel_start` or `kernel_connect` first).
