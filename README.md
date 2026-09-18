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

Two halves, and only one of them is a package install:

| Half | What it is | Installed |
|---|---|---|
| **Host** | a POSIX userland plus `uv` on `PATH` — no Python, no Node, no Jupyter | once per machine (Part 1) |
| **Extension** | the 10 kernel tools pi loads | per pi profile (Part 2) |

### Part 1 — the host

Nothing here needs a Python environment, a Jupyter install, or Node: the extension runs
inside pi's own Node, and every Python dependency is provisioned by `uv` at first use.

- **pi** — the host application that loads this extension. Verified compatible through
  pi 0.85.1.
- **`uv` on `PATH`** — the only hard dependency. It must be visible to the environment
  *pi was launched from*, not merely to an interactive shell:

  ```bash
  command -v uv && uv --version    # must resolve, e.g. uv 0.12.15
  ```

  Install with `brew install uv` (macOS), `curl -LsSf https://astral.sh/uv/install.sh | sh`,
  or the [uv docs](https://docs.astral.sh/uv/). A pi started from a GUI, an IDE task, or a
  different login shell can see a different `PATH` — that is the most common host-side
  failure, and it surfaces as `Kernel process exited during startup: … uv …`.
- **A POSIX-style OS with `ps` and `kill`** — macOS or Linux. Used for the PID guards
  (`ps -o lstart= -p <pid>`, `ps -o pgid= -p <pid>`), process-group kills, and the
  `SIGKILL` stop paths. No GNU-only long options are used, so BSD and GNU userlands both
  work.
- **A writable extension directory.** The bridge is started with `uv run` *inside the
  package directory*, which contains a `pyproject.toml`, so uv creates `.venv/` there on
  the first bridge start (≈95 MB: fastapi, uvicorn, jupyter-client, ipykernel,
  jupyter-console, pydantic, pyzmq). Where that is depends on how you installed it:

  | Install | Package directory |
  |---|---|
  | `pi install git:…` | `~/.pi/agent/git/<host>/<path>` (project installs: `.pi/git/<host>/<path>`) |
  | `pi install npm:…` | `~/.pi/agent/npm/` (project installs: `.pi/npm/`) |
  | `pi install /local/path` | the path you named |
  | `pi -e …` | a **temporary directory**, discarded at the end of the run |

  None of these may be read-only. The `-e` case is worth knowing about: it re-provisions
  into a fresh temp directory every run, so it is a way to *try* the extension, not to use
  it daily.
- **A writable `~/.ipy/kernels/`** — the registry, created on demand: `kernel.json`,
  `meta.json`, `kernel.log`, `bridge.log`, plus `console.sh` written by `kernel_console_cmd`.
- **Loopback networking** — each bridge binds `127.0.0.1` on a free ephemeral port. No
  inbound firewall rule, no external exposure, nothing to open.
- **Disk and network for the first run** — uv downloads the tool env and interpreters into
  `~/.cache/uv` (cache), `~/.local/share/uv/tools` (tool envs, ≈320 MB for the IPython tool
  on one populated machine), and `~/.local/share/uv/python` (interpreters). Afterwards,
  starts are local and near-instant. Those sizes are observations, not a floor.
- **Optional** — `jupyter-console` in the *kernel's* environment, only for the
  `kernel_console_cmd` handoff; a `cfg.json` in the package root (see `cfg.json.example`).
- **Windows is not supported and there are no plans to port it** — the author has no
  Windows machine. Blockers: `detached` process-group semantics, `SIGKILL` stop paths, and
  the PID start-time guard are all POSIX-specific. The bridge, jupyter_client and ipykernel
  are themselves Windows-capable, so a port would be a moderate effort limited to process
  management.

How uv is invoked (all four interpreter modes, always through uv):

| `python` setting | Command |
|---|---|
| `""` (default) | `uv tool run --from ipython --with ipykernel python -m ipykernel -f <file>` |
| `"project"` | `uv run --with ipykernel python -m ipykernel -f <file>` |
| `"3.11"` (version) | `uv run --isolated --python 3.11 --with ipykernel python -m ipykernel -f <file>` |
| `"/path/to/.venv"` | `uv run --no-project --python <path> --with ipykernel python -m ipykernel -f <file>` |
| bridge (always) | `uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic python server/main.py …` |

**Pre-warm the host** (optional — makes the first `kernel_start` fast). Run the two
commands the extension will run itself, from the package directory:

```bash
cd /path/to/pi-ipython-kernel    # for a git install: pi's extension directory
uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic \
  python -c "import fastapi, uvicorn, jupyter_client, zmq, pydantic; print('bridge deps ok')"
uv tool run --from ipython --with ipykernel python -c "import ipykernel; print(ipykernel.__version__)"
```

**One operational caution.** The PID-reuse guard records the kernel's start time as a
string (`ps -o lstart=`) and compares that string later. A changed locale or timezone
between sessions can make two readings of the same live process disagree; keep `LANG`/`TZ`
stable for the pi profiles that own long-lived kernels. (Tracked as a parked defect in
`workflows/open_bugs.md` follow-up work.)

### Part 2 — the extension

```bash
pi install npm:pi-ipython-kernel                                  # once published to npm
pi install git:github.com/johnpauljanecek/pi-ipython-kernel       # from GitHub
pi install /path/to/pi-ipython-kernel                            # from a local clone
```

Try it without installing anything:

```bash
pi -e git:github.com/johnpauljanecek/pi-ipython-kernel
```

`-e` installs into a temporary directory for that run only, and every run provisions a
fresh copy — fine for a look, wasteful as a daily driver. Install it instead.

**Verify the install.** In pi:

```
kernel_status                              # "no kernel connected" + registry summary
kernel_start { "name": "smoke" }
kernel_run_python { "code": "print(2 + 2)" }
kernel_stop { "name": "smoke" }
```

`kernel_stop` waits for the process group to disappear before reporting success, so a
clean run ends with `no processes left`. If it instead says *"did not stop cleanly — still
alive: …"*, the registry entry is deliberately kept so the stop can be retried — see
`kernel_status` and the pid it names.

### Uninstall and cleanup

Stop the kernels first — they are detached and outlive pi by design:

```
kernel_list
kernel_stop { "name": "<name>" }        # repeat per kernel
```

```bash
pi remove pi-ipython-kernel              # or: pi remove git:github.com/johnpauljanecek/pi-ipython-kernel
rm -rf ~/.ipy/kernels                    # registry — only once no kernels remain
```

Removing the extension does **not** stop running kernels. A kernel's bridge dies when its
owning pi exits, but the kernel does not:

```bash
pgrep -fl "ipykernel -f"                 # list first, never kill by pattern
```

Then stop each one from a pi with the extension loaded (`kernel_stop { "name": … }`), or by
explicit pid. Deleting `~/.ipy/kernels/` while a kernel is alive only makes it harder to
find — the process keeps its ports and state.

Dev-only requirements (not needed to run the extension):

- Node ≥ 22.6 for `npm test` (native TS type-stripping); TypeScript for `npm run typecheck`.
- `uv sync --group dev` once, for `npm run test:bridge` (pytest).

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

See **Installation → Part 1 — the host** above for the full list and how to verify each
item. Short version: pi ≥ 0.85.1; `uv` visible to pi's environment; a POSIX OS with `ps`
and `kill`; a writable extension directory and `~/.ipy/kernels/`; loopback networking.
Dev-only, for the test suites: Node ≥ 22.6 and `uv sync --group dev`.

## Testing

Two suites cover the bridge and the extension's pure logic.

### Node — extension logic (`npm test`)

Unit tests for the pure helpers in `extensions/lib.ts`: the `kernel_start`
spawn-command matrix, registry read/write/list/find, PID liveness (including the
start-time guard that prevents signaling a recycled PID), detached spawning (that
it does not hold pi's event loop open, with pre-fix controls), and process-group
kills (`killTree` reaps a leader and its grandchild; a non-leader is signalled by
pid only, so a sibling in the shared group survives).

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
- [Bug ledger](workflows/open_bugs.md) — every defect, with the commit that fixed it
