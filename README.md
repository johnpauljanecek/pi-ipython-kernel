# pi-ipython-kernel

Pi extension for controlling IPython kernels via HTTP. Each kernel is a **persistent named resource** with its own companion FastAPI bridge (one per kernel) that wraps `jupyter_client.BlockingKernelClient`. Kernels live in `~/.ipy/kernels/<name>/` and outlive pi sessions.

## Why

Coding agents execute Python through one-shot shell calls: every tool call is a
fresh process. Variables vanish, imports re-run, a 500 MB DataFrame is read
from disk again on the next step, and any iterative work gets squeezed into
monolithic scripts. Notebooks fix the state problem — but they are built for
humans clicking cells, not for an agent, and getting an LLM to reliably edit a
worksheet is a losing battle.

pi-ipython-kernel keeps the part of Jupyter that matters — **the live kernel** —
and drops the notebook UI. The result:

- **State persists across LLM calls.** Load data once, define helpers once,
  keep an authenticated API session open — every subsequent tool call is fast
  because nothing is reloaded.
- **It survives the session.** Kernels are detached processes: quit pi, close
  the terminal, come back tomorrow — connect by name and your objects are
  still there.
- **It doubles as a state machine.** Because every turn reads and mutates the
  same live namespace, multi-step workflows (staged pipelines, session-scoped
  caches, accumulators) become natural — something a stateless bash tool
  cannot express.
- **You can sit next to the agent.** `kernel_console_cmd` attaches a real
  Jupyter console to the *same* kernel: you and the agent share one namespace
  for pair debugging.
- **Parallel contexts by name.** Run `data`, `om`, and `experiments` kernels
  side by side, each with its own interpreter (uv-resolved), cwd, and state.

Typical uses: exploratory data analysis, API prototyping and
reverse-engineering, long computations you can poll and interrupt, and any
workflow where re-running setup on every step is the bottleneck.

## Installation

### From npm (once published)
```bash
pi install npm:pi-ipython-kernel
```

### From GitHub
```bash
pi install git:github.com/johnpauljanecek/pi-ipython-kernel
```

### From local path
```bash
pi install /path/to/pi-ipython-kernel
```

### Try without installing
```bash
pi -e npm:pi-ipython-kernel
pi -e git:github.com/johnpauljanecek/pi-ipython-kernel
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
| `kernel_console_cmd` | One-line command to attach a Jupyter console to a kernel |

## Quick Start

```bash
pi install /path/to/pi-ipython-kernel
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

## Architecture

```
pi (extension tools)                    kernel registry (per user)
  kernel_start ─┐                         ~/.ipy/kernels/<name>/
                │ spawn (execa, detached)   ├── kernel.json   # ipykernel connection file
                ▼                           ├── meta.json     # pids, bridge port, python, cwd, token…
  ipykernel process ◄──ZMQ channels──┐      ├── kernel.log
  (your Python, persistent state)    │      └── bridge.log
                                     │
  FastAPI bridge process ◄───────────┘  jupyter_client.BlockingKernelClient
       ▲  HTTP 127.0.0.1:<free port>
       │  (X-IPY-TOKEN auth header)
  pi tool call (run/eval/interrupt/…)
```

Three moving parts per kernel:

1. **The kernel** — a real `ipykernel` process (IPython underneath). All your
   state lives here: variables, imports, loaded data, open sessions. Spawned
   **detached** (own process group) with stdout/stderr teed to `kernel.log`,
   which is why kernels survive pi quitting, `/quit`, and terminal close.

2. **The bridge** — a small FastAPI process (one per kernel, never shared) that
   owns a `jupyter_client.BlockingKernelClient` and translates plain HTTP calls
   into Jupyter ZMQ channels. It provides:
   - `/kernel/run-code` (execute code, overall-deadline timeout), `/kernel/eval-expr`
     (expression → value), `/kernel/interrupt` (ZMQ `interrupt_request`),
     `/kernel/get-output` (cached output slices), `/kernel/status`,
     `/kernel/python` (report the kernel's interpreter), and `/shutdown`.
   - An **output cache**: long runs stream updates; `kernel_get_output` slices
     what was captured without re-executing anything.
   - **Auth**: a per-kernel random token (generated at start) required as the
     `X-IPY-TOKEN` header on every request.

3. **The extension** (TypeScript, running inside pi) — registers the 10
   `kernel_*` tools, resolves interpreters through `uv`, spawns kernel + bridge,
   and manages the registry at `~/.ipy/kernels/` (`kernel_list` prunes dead
   entries and reaps orphaned bridges; a PID **start-time guard** prevents
   signaling a recycled PID).

Why this shape:

- **HTTP, not stdio** — the bridge is language-agnostic plumbing: any pi
  session (or a plain `curl`) can attach to the same kernel by name; two pi
  sessions can share one kernel's state.
- **jupyter_client, not raw ZMQ** — the bridge gets Jupyter's protocol handling
  (execute replies, stdin, interrupts) for free and stays in sync with the
  official ipykernel behavior.
- **Everything through `uv`** — no project installs; interpreters and bridge
  deps are resolved on demand and cached by uv.
- **Detached by design** — kernels are resources, not children of a pi session.
  They die only via `kernel_stop`, a crash, or a reboot.

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

As of now:

- **pi** (the coding agent) — the host application that loads this extension. Verified compatible through pi 0.85.1.
- **`uv`** available in `PATH` — the only hard dependency. Nothing else is installed by hand:
  - Default interpreter: `uv tool run --from ipython --with ipykernel python -m ipykernel …` (uv fetches IPython + ipykernel into its tool env on first start).
  - `"python": "project"`: `uv run --with ipykernel …` inside the project's env.
  - Version spec or venv path (e.g. `"3.11"`, a `.venv` path): `uv run --no-project --python <spec> --with ipykernel …`.
  - The bridge self-provisions (`uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic …`); no `.venv` required.
- A POSIX-style OS. **Windows is not supported and there are no plans to port it** — the author has no Windows machine. Blockers: `detached` process-group semantics, `SIGKILL`-based stop paths, and the PID start-time guard are all POSIX-specific (the bridge, jupyter_client, and ipykernel themselves are Windows-capable, so a port would be a moderate effort limited to process management).
- Writable `~/.ipy/kernels/` (the registry) and loopback networking (the bridge binds `127.0.0.1` on a free port).
- Optional: `jupyter-console` in the kernel's environment, only for `kernel_console_cmd` interactive handoff.
- Optional: a `cfg.json` in the package root (see `cfg.json.example`); without one, sane defaults apply.

Note: the first `kernel_start` on a fresh machine is slower while uv downloads IPython/ipykernel/FastAPI into its cache; subsequent starts are near-instant.

Dev-only requirements (not needed to run the extension):

- Node ≥ 22.6 for `npm test` (native TS); TypeScript for `npm run typecheck`.
- `uv sync --group dev` once, for `npm run test:bridge` (pytest).

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
