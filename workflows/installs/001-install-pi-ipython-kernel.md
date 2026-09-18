# Workflow 001 — Install pi-ipython-kernel

**Kind:** install · **Version:** applies to `pi-ipython-kernel` 0.1.0+ (unscoped; formerly
`@johnjanecek/ipyforge-kernel`)
**Last verified:** 2026-09-18 on macOS 26 (Apple Silicon), pi 0.85.1, uv 0.12.15
**Audience:** whoever is deploying this on a machine — human or agent

**To have pi run this workflow:** point it at the file and say what "done" means. Every
prerequisite below has a check and the document ends in completion criteria, so the run is
auditable rather than a leap of faith:

```bash
pi -p "Read workflows/installs/001-install-pi-ipython-kernel.md and install pi-ipython-kernel on this machine, following its steps and reporting the completion criteria"
```

An agent should stop and ask rather than guess at two points: a missing `uv` on **pi's**
PATH (it needs the launcher fixed, not a workaround), and any request to delete
`~/.ipy/kernels/` while kernels are still running.

Background and rationale live in the [README](../../README.md); this document is the
procedure. Follow it in order; each step has a check, and the checks are the point.

---

## Purpose

Install the extension on a host so that pi can start, attach to, and stop persistent named
IPython kernels. It covers both halves of the job — preparing the **host** and installing the
**extension** — plus validation, upgrade, and rollback.

## Scope

**In scope:** a fresh install, a re-install after the package directory moved or was
re-cloned, and upgrading an existing install.

**Out of scope:** developing the package (see the README's Testing section), and Windows —
not supported, no plans to port it (POSIX process groups, `SIGKILL` stop paths, and the PID
start-time guard are all POSIX-specific).

## Prerequisites

| Prerequisite | Check | Why |
|---|---|---|
| pi installed | `pi --version` → ≥ 0.85.1 | the host application that loads the extension |
| `uv` on **pi's** PATH | `command -v uv && uv --version` | the extension's only hard dependency |
| POSIX userland with `ps` and `kill` | `ps -o pgid= -p $$ && kill -0 $$` | PID guards, group kills, stop paths |
| Writable package directory | filled in at step 4 | uv builds `.venv/` there for the bridge |
| Writable `~/.ipy/kernels/` | created on demand | the kernel registry |
| Loopback networking | nothing to open | bridges bind `127.0.0.1` on an ephemeral port |

No Python, no Jupyter, and no Node installation is required on the host: every Python
dependency is provisioned by `uv` at first use, and the extension runs inside pi's own Node.

> **The check that matters most:** `uv` must be visible to the environment *pi was launched
> from*. An interactive shell that finds `uv` proves nothing if pi is started from a GUI,
> an IDE task runner, or a different login shell.

## Paths affected

| Path | Written by | Notes |
|---|---|---|
| pi settings — `~/.pi/agent/settings.json` (or `.pi/settings.json` with `-l`) | `pi install` | records the package source |
| `~/.pi/agent/git/<host>/<path>` · `~/.pi/agent/npm/` · `.pi/git/…` · `.pi/npm/` | `pi install` | the package directory (project installs use the `.pi/…` form) |
| the package directory itself | `uv run` | `.venv/` for the bridge's runtime deps |
| `~/.ipy/kernels/<name>/` | the extension | `kernel.json`, `meta.json`, `kernel.log`, `bridge.log`, `console.sh` |
| `~/.cache/uv`, `~/.local/share/uv/tools`, `~/.local/share/uv/python` | `uv` | download caches and environments |

## Estimated disk usage

Measured on the verifying machine (observations, not floors):

| Item | Size |
|---|---|
| package `.venv/` (bridge runtime: fastapi, uvicorn, jupyter-client, ipykernel, jupyter-console, pydantic, pyzmq) | ~95 MB |
| uv tool envs for the kernel interpreter | ~320 MB total once populated |
| uv cache | grows with use; the machine measured had ~12 GB of unrelated history |
| a running kernel | tens to hundreds of MB of RAM, no disk beyond its logs |

Plan for **~0.5 GB** on a machine that has never used `uv`.

---

## Procedure

### Step 1 — host: `uv` present and visible to pi

```bash
command -v uv && uv --version
```

If that fails, install `uv` (`brew install uv`, or
`curl -LsSf https://astral.sh/uv/install.sh | sh`), then **restart pi** so it inherits the
new PATH. Do not continue until this check passes.

### Step 2 — host: userland and writable paths

```bash
ps -o pgid= -p $$ >/dev/null && echo "ps ok"
kill -0 $$ && echo "kill ok"
mkdir -p ~/.ipy/kernels && test -w ~/.ipy/kernels && echo "registry writable"
df -h ~ | tail -1
```

Disk: the checks above plus step 4's `.venv/` build need roughly 0.5 GB free.

### Step 3 — host (optional): pre-warm the caches

Makes the first `kernel_start` fast instead of a mystery wait. Run from the package
directory — for a fresh install that is step 4's location; for an existing install:

```bash
cd ~/.pi/agent/git/github.com/johnpauljanecek/pi-ipython-kernel   # or wherever it lives
uv run --with fastapi --with uvicorn --with jupyter_client --with pyzmq --with pydantic \
  python -c "import fastapi, uvicorn, jupyter_client, zmq, pydantic; print('bridge deps ok')"
uv tool run --from ipython --with ipykernel python -c "import ipykernel; print(ipykernel.__version__)"
```

Expect the first command to build `.venv/` next to the package and to be slow.

### Step 4 — install the extension

Pick one:

```bash
pi install git:github.com/johnpauljanecek/pi-ipython-kernel   # from GitHub (recommended)
pi install npm:pi-ipython-kernel                              # once published to npm
pi install /path/to/pi-ipython-kernel                         # from a local clone
pi install -l git:github.com/johnpauljanecek/pi-ipython-kernel  # project-scoped settings
```

Then confirm the package landed:

```bash
pi list
command -v uv >/dev/null && ls -d ~/.pi/agent/git/github.com/johnpauljanecek/pi-ipython-kernel
```

> **Do not use `pi -e …` for a real install.** `-e` materialises the package into a
> temporary directory for that run only, so every run re-provisions its environment. It is
> for trying the extension, not for using it.

### Step 5 — validate (this step is not optional)

In pi:

```
kernel_status
kernel_start { "name": "smoke" }
kernel_run_python { "code": "print(2 + 2)" }
kernel_stop { "name": "smoke" }
```

Expected: `kernel_status` reports no connected kernel and lists the registry; `kernel_start`
returns a PID, bridge port, and log path; `kernel_run_python` prints `4`; and `kernel_stop`
ends with **`no processes left`**.

---

## Validation procedure

| Check | Command | Pass condition |
|---|---|---|
| package registered | `pi list` | the package appears |
| host dependency visible | `command -v uv` | resolves |
| kernel starts | `kernel_start { "name": "smoke" }` | PID + bridge port returned |
| code runs | `kernel_run_python { "code": "print(2 + 2)" }` | `4` |
| state persists | `kernel_eval_expr { "expr": "1 + 1" }` then again | both return `2` |
| stop is clean | `kernel_stop { "name": "smoke" }` | "no processes left" |
| no orphans | `pgrep -fl "server/main.py"` | nothing for the stopped kernel |
| registry clean | `ls ~/.ipy/kernels/` | the stopped kernel is gone |

Completion evidence to record: the `kernel_start` output (PID, bridge port, log path), the
`2 + 2` result, and the final `kernel_stop` line.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Kernel process exited during startup: … uv …` | `uv` missing from **pi's** PATH | fix PATH for the way pi is launched, restart pi |
| `timed out waiting for the kernel connection file` with a slow first run | uv still downloading; or the package directory is read-only | read `~/.ipy/kernels/<name>/kernel.log`; re-run step 3; make the package directory writable |
| `Cannot reach kernel bridge for '<name>' — not accepting connections on port N` | the bridge died; the kernel is fine | retry the call — the bridge respawns on demand |
| `Kernel '<name>' is busy and refused the request` (HTTP 409) | another execution holds the kernel | wait, `kernel_interrupt`, or raise `timeout_s` |
| `did not stop cleanly — still alive: …` | a process survived SIGKILL | the registry entry is kept deliberately; retry `kernel_stop`, or kill the named pids explicitly |
| a kernel vanished from `kernel_list` while its process runs | pruned as dead after a start-time mismatch — the guard compares `ps -o lstart=` strings, so a locale/TZ change can make two readings of the same live process disagree | keep `LANG`/`TZ` stable for the pi profile that owns the kernel (open item; not yet in the ledger) |
| `pi -e …` works but is slow every time | `-e` re-provisions per run | install properly (step 4) |

## Upgrade

```bash
pi update --extensions      # reconcile clones; pinned git refs stay pinned
pi list
```

Pinned refs do not move. To move to a newer ref deliberately:
`pi install git:github.com/johnpauljanecek/pi-ipython-kernel@<ref>`.

After upgrading, re-run the validation table. **If the upgrade changed
`server/main.py`** (the bridge), long-lived bridges keep running the old code — a bridge
executes whatever existed when it was *spawned*, and nothing refreshes it. Restart each one:

```bash
# bridge pid from ~/.ipy/kernels/<name>/meta.json (bridge_pid)
kill -9 -- -<bridge_pid>          # group kill: uv wrapper + python child
```
```
kernel_connect { "name": "<name>" }     # respawns the bridge from current code
```

The kernel and its state survive that restart; only the proxy is replaced.

## Rollback / uninstall

Stop the kernels **first** — they are detached by design and outlive pi:

```
kernel_list
kernel_stop { "name": "<name>" }        # repeat per kernel
```

```bash
pi remove pi-ipython-kernel             # or the git:/path form as installed
rm -rf ~/.ipy/kernels                   # only once no kernels remain
```

Rolling back to a previous release is the same as installing one: `pi install
git:…@<older-ref>` and re-validate. Kernel state is not migrated between versions — a kernel
started by an older build keeps running until stopped.

Removing the extension does **not** stop running kernels. Their bridges die with the pi that
spawned them; the kernels do not. Find and stop them before deleting the registry:

```bash
pgrep -fl "ipykernel -f"                # list first — never kill by pattern
```

## Installation record

Record locally (do **not** commit machine-specific values to the public repository):

- date, host OS/arch, and who ran it;
- `pi --version`, `uv --version`, `command -v uv`;
- install type (`git` / `npm` / local path / project-scoped) and the resulting package
  directory;
- `.venv/` size and the uv cache/tool/env locations if they are non-default;
- the validation evidence from the table above.

In AI-Studio, this belongs in the host project's installation record alongside any other
local deployment notes.

## Completion criteria

- [ ] Step 1's `uv` check passes **from pi's environment**.
- [ ] `pi list` shows the package.
- [ ] `kernel_start` → `kernel_run_python` printing `4` → `kernel_stop` ending in
      `no processes left`.
- [ ] No `server/main.py` processes remain for the stopped kernel.
- [ ] `~/.ipy/kernels/` contains no entry for the stopped kernel.
- [ ] The record above is written down somewhere outside the repo.

## Related documents

- [README — Installation](../../README.md#installation) (Part 1 the host, Part 2 the extension)
- [Bug ledger](../open_bugs.md)
- [ipy skill](../../skills/ipy/SKILL.md) — what the agent does with the tools once installed
- [History](../history/) — superseded working notes (package migration, API updates)
