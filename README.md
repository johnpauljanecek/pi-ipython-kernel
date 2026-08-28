# ipyforge-kernel

Pi extension for controlling IPython kernels via HTTP. Each kernel is a **persistent named resource** with its own companion FastAPI bridge (one per kernel) that wraps `jupyter_client.BlockingKernelClient`. Kernels live in `~/.ipy/kernels/<name>/` and outlive pi sessions.

## Installation

### From npm (once published)
```bash
pi install npm:@johnjanecek/ipyforge-kernel
```

### From GitHub
```bash
pi install git:github.com/johnjanecek/ipyforge-kernel
```

### From local path
```bash
pi install /path/to/ipython_package
```

### Try without installing
```bash
pi -e npm:@johnjanecek/ipyforge-kernel
pi -e git:github.com/johnjanecek/ipyforge-kernel
```

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new named IPython kernel (persistent) |
| `kernel_connect` | Attach to a kernel by name, or an external kernel by path |
| `kernel_run_python` | Execute Python code in the connected kernel |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt a stuck kernel |
| `kernel_get_output` | Retrieve cached output slices |
| `kernel_list` | List kernels in the registry (prunes dead entries) |
| `kernel_stop` | Stop a kernel and its bridge |
| `kernel_status` | Show the connected kernel + registry summary |

## Quick Start

```bash
pi install /path/to/ipython_package
```

```
kernel_start { "name": "data" }
kernel_run_python { "code": "print('hello from kernel')" }
kernel_eval_expr { "expr": "1 + 1" }
kernel_list
kernel_stop { "name": "data" }
```

## Lifecycle

- **Kernels are persistent named resources.** They survive pi sessions, `/quit`, and terminal close — they are spawned detached (own process group).
- A kernel is stopped **only** by `kernel_stop`, a crash, or a reboot. Pi session end never kills kernels.
- **No idle timeout** — cleanup is manual via `kernel_list` + `kernel_stop` (everything is indexed in one place: `~/.ipy/kernels/`).
- Each kernel has a **companion bridge** (its own free port, its own output cache) that lives and dies with it. Two pi sessions can attach to the same kernel by name.
- **tmux is not required for kernel persistence.** It is only useful for keeping *pi itself* running across ssh disconnects / terminal closes.

## Registry

```
~/.ipy/kernels/<name>/
├── kernel.json    # ipykernel connection file
├── meta.json      # kernel_pid, bridge_port, python, cwd, started_at, …
├── kernel.log     # kernel stdout/stderr
└── bridge.log     # bridge stdout/stderr
```

`kernel_list` prunes dead kernels and reaps their orphaned bridges.

## Configuration

User preferences live in `cfg.json` in the package root (see `cfg.json.example`):

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

- `python` — interpreter for `kernel_start`: `""` (default uv ipython tool), `"project"` (project env), a version spec (`"3.11"`), or an interpreter/venv path. Always resolved via uv.
- `default_connect` — kernel name or path used by `kernel_connect` with no args.
- `auth_token` — optional bridge auth token (auto-generated per kernel if empty).

## Known limitations

- The bridge binds `127.0.0.1` with no auth by default (a per-kernel token is generated unless `auth_token` is set). Any local process can reach a bridge if it knows the token and port.
- The registry is per-user at `~/.ipy/kernels/`.

## Requirements

- `uv` installed and available in PATH.
- The bridge self-provisions its dependencies (`uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic`); no `.venv` required.
- Kernels run via uv (`uv tool run --from ipython --with ipykernel …` for the default interpreter).

## Testing

Two suites cover the bridge and the extension's pure logic.

### Node — extension logic (`npm test`)

Unit tests for the pure helpers in `extensions/lib.ts`: the `kernel_start`
spawn-command matrix, registry read/write/list/find, and PID liveness (including
the start-time guard that prevents signaling a recycled PID).

```bash
npm test          # node --test "tests/*.test.ts"  (Node >= 22.6 for native TS)
npm run typecheck # tsc --noEmit
```

### Python — bridge integration (`npm run test:bridge`)

Spawns a real IPython kernel + its companion bridge and exercises every endpoint:
run-code / eval-expr state persistence, the overall-deadline timeout, interrupt
during a long run, the auth token, the output cache, and a BUG-09 socket-leak
regression (many rapid requests on a single long-lived client).

```bash
uv sync --group dev      # once, to install pytest
npm run test:bridge      # uv run pytest tests/test_bridge.py -v
```

## Documentation

- [uv tool environment setup](docs/uv-tool-env-setup.md)
- [Kitty remote control](docs/useful_kitty.md)
- [ipy skill](skills/ipy/SKILL.md)
