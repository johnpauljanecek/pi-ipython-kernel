# Workflow: Update Extension for Current pi Extension API

**Date**: 2026-08-28
**Status**: ✅ Done (Phase A + Phase B committed; see git log `dbeb441`, `e8d03e7`)
**Depends on**: Review of `docs/extensions.md`, `docs/packages.md`, and installed type defs in
`@earendil-works/pi-coding-agent` (dist/core/extensions/types.d.ts, pi-agent-core dist/types.d.ts)

## Goal

Bring `extensions/index.ts` (+ `server/main.py`) in line with the current pi extension API and fix
the issues identified in review. Two items are **breaking** (must-fix): error signaling via throw,
and the shared-bridge → **per-kernel-bridge** redesign (steps 2 + 17). The rest are correctness,
concurrency, security, and style.

Two additional requirements surfaced during review:

1. **Configurable Python for `kernel_start`** — the kernel must be startable with a chosen
   interpreter/environment, always via uv (steps 16).
2. **Named kernel registry + per-kernel bridge** — multiple concurrent pi sessions must not
   share a bridge port or state; kernels become **persistent named resources**, each with its
   own FastAPI bridge (companion process), that sessions attach to by name (steps 17–18).
   This supersedes parts of steps 2, 4, 6, 8, and 11.

## Step Summary

| Step | Description | Area | Priority |
|------|-------------|------|----------|
| 1 | Replace `return { isError: true }` with `throw` in all 8 tools | `extensions/index.ts` | 🔴 Breaking |
| 2 | Drop `session_shutdown` (no session-scoped resources; bridges are kernel-scoped) | `extensions/index.ts` | 🔴 Breaking |
| 3 | Wire `signal` into HTTP calls (fetch timeout tracks `timeout_s` + 15s; control calls 10s) | `extensions/index.ts` | 🟠 High |
| 4 | Make per-kernel bridge startup race-free (cache startup promise per kernel name) | `extensions/index.ts` | 🟠 High |
| 5 | Add `executionMode: "sequential"` to shared-state kernel tools | `extensions/index.ts` | 🟠 High |
| 6 | Remove `killStaleServer`/`lsof` entirely (superseded by step 17) | `extensions/index.ts` | 🟠 High |
| 7 | Add auth token to bridge (optional hardening) | `server/main.py`, `extensions/index.ts` | 🟡 Medium |
| 8 | Move runtime state to the kernel registry (`~/.ipy/kernels/<name>/`) | `extensions/index.ts` | 🟡 Medium |
| 9 | Fix per-message vs overall timeout in `/kernel/run-code` | `server/main.py` | 🟡 Medium |
| 10 | Safe `kernel_stop` — graceful shutdown, liveness-verified kill, unregister | `extensions/index.ts`, `server/main.py` | 🟡 Medium |
| 11 | `kernel_start` writes to registry; cfg `default_connect` for connect | `extensions/index.ts` | 🟡 Medium |
| 12 | Adopt `defineTool`, `Type` from `@earendil-works/pi-ai` (keep execa for detached spawns) | `extensions/index.ts` | 🟢 Style |
| 13 | Normalize leading `@` on `kernel_connect` path; use `onUpdate` for progress | `extensions/index.ts` | 🟢 Style |
| 14 | Fix docs inconsistencies (7→9 tools), redundant catch tuple, `_truncate` edge | README, server, extension header | 🟢 Low |
| 15 | Two-phase delivery: Phase A (API compat) → Phase B (registry/bridge), with automated tests | — | — |
| 16 | Configurable Python env for `kernel_start` via uv (`python` cfg field, spawn matrix) | `extensions/index.ts`, `cfg.json.example`, README | 🟡 Medium |
| 17 | Named kernel registry + per-kernel FastAPI bridge (`~/.ipy/kernels/<name>/`) | `extensions/index.ts`, `server/main.py` | 🔴 High |
| 18 | `kernel_list` + kernel lifecycle (persistent by default, detached spawn, bridge reaping, start-time liveness) | `extensions/index.ts`, docs, skill | 🟡 Medium |

---

## Step 1: Error signaling — throw instead of returning `isError`

**File**: `extensions/index.ts` (all 8 tool `execute` handlers)

**Why**: The current `AgentToolResult` type has no `isError` field
(pi-agent-core `dist/types.d.ts:316`), and the runner hardcodes `isError: !1` on any normal
return — only a **thrown** error sets `isError: true`. Every tool currently wraps its body in
`try/catch` and returns `{ content: [❌ …], details: {}, isError: true }`, so all failures are
reported to the LLM as **success**. Only the literal `❌` text leaks a hint.

**Change pattern** — replace the trailing catch of every handler:

```ts
} catch (err) {
  return {
    content: [{ type: "text", text: `❌ ${err}` }],
    details: {},
    isError: true,
  };
}
```

with:

```ts
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(msg);
}
```

Keep the ❌ prefix inside the thrown message if desired (`throw new Error(`❌ ${msg}`)`).

**Special cases** (do not blanket-throw):

- `kernel_start` — the `throw \`Kernel process exited during startup: ...\`` inside `execute`
  is already correct; leave it. Remove only the outer catch's `isError: true` return.
- `kernel_stop` — the "not auto-created" early-return is an informational no-op, NOT an error;
  return normally. The "pid is null" case should throw (it is a genuine inconsistency).
- `kernel_status` — currently returns `❌` on failure; the status probe failing is a legitimate
  result ("server not running"), not a tool failure. Return the status lines normally and put
  the error text in the content, or throw only for real config errors.

**Verify**: grep for `isError: true` in `extensions/index.ts` — should return zero matches
(after step 1). Each error path should be a `throw`.

---

## Step 2: No session-scoped resources → no `session_shutdown` cleanup needed

**File**: `extensions/index.ts`

**Why**: The docs mandate: *"Do not start background resources… from the factory. Defer…
until the command/tool/event that needs the resource. Register an idempotent `session_shutdown`
handler to close any session-scoped resources you start."*

**Lifecycle decision (confirmed)**: with the per-kernel bridge model (step 17), there are **no
session-scoped resources**. Both the kernel and its FastAPI bridge are companions owned by the
kernel, registered in `~/.ipy/kernels/<name>/meta.json`, and killed by `kernel_stop` (or reaped
by `kernel_list`). Sessions only hold an in-memory "connected kernel name" pointer — nothing to
clean up on `/quit`, `/reload`, `/new`, `/resume`, or `/fork`.

**Change**: remove the planned `session_shutdown` handler — or keep an empty one with a comment
explaining why (documents intent). Do NOT kill kernels or bridges on shutdown.

**Notes**:

- Kernels started by this session persist after shutdown (that's the point — see step 18).
  `meta.json` records `started_by_session` for attribution; `kernel_list` surfaces stragglers.
- Because there is no per-session server, there is no server adoption on hot-reload — a reloaded
  extension simply re-reads the registry and reconnects by name.

**Verify**: start a kernel, `/quit` (or Ctrl+C twice) → `ps aux | grep -E "server/main.py|ipykernel"`
shows both bridge and kernel still running, reconnectable via `kernel_connect {name}`. Same
after `/reload`.

---

## Step 3: Wire `signal` + fix fetch-vs-kernel timeout mismatch

**File**: `extensions/index.ts` (`serverPost`, `serverGet`, and callers)

**Why**: Two problems. (1) `execute(toolCallId, params, signal, …)` receives an `AbortSignal`;
the extension ignores it (`_signal`) and only uses `AbortSignal.timeout(10_000)`, so Esc can't
cancel an in-flight call. (2) The fixed 10s fetch timeout is **shorter** than the kernel
execution timeout (`default_timeout_s`), so any run/eval longer than 10s aborts the fetch even
though the kernel finishes (critique #5a).

**Decision (confirmed)**: default execution timeout **60s**; the client fetch timeout must
**track** the tool's `timeout_s`, not be a fixed 10s.

**Change**:

```ts
const CONTROL_TIMEOUT_MS = 10_000;
const TIMEOUT_MARGIN_S = 15;

function executionHttpMs(timeoutS: number | undefined): number {
  return ((timeoutS ?? 60) + TIMEOUT_MARGIN_S) * 1000;
}

function httpSignal(timeoutS: number | undefined, signal?: AbortSignal): AbortSignal {
  const ms = timeoutS !== undefined ? executionHttpMs(timeoutS) : CONTROL_TIMEOUT_MS;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function serverPost(
  endpoint: string,
  body: Record<string, unknown> = {},
  opts?: { signal?: AbortSignal; timeoutS?: number },
): Promise<Record<string, unknown>> {
  const port = await ensureBridgeRunning(name);       // name → registry → bridge port (step 4)
  const base = `http://127.0.0.1:${port}`;
  // …
  res = await fetch(`${base}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: httpSignal(opts?.timeoutS, opts?.signal),
  });
  // …
}
```

Rules:

- `kernel_run_python` / `kernel_eval_expr` → pass `timeoutS: params.timeout_s` (default 60).
- Control endpoints (`connect`, `interrupt`, `shutdown`, `status`, `get_output`, `health`) → no
  `timeoutS` → 10s control timeout.
- `cfg.json` and `cfg.json.example` set `default_timeout_s: 60` (the example currently says 30).

**Notes**: `AbortSignal.any` requires Node ≥ 20.3 / 18.17 — fine for pi's runtime. If the fetch
aborts, the thrown `AbortError` lands in the step-1 catch and surfaces as a clean error. This
reconciles with step 9 (server-side overall deadline) — the client now waits long enough to see
it.

**Verify**: `time.sleep(60)` with default timeout → completes (no 10s client abort); a
`time.sleep(120)` with `timeout_s: 60` → clean timeout ~75s (60 + margin); Esc during a long
run aborts promptly.

---

## Step 4: Make per-kernel bridge startup race-free

**File**: `extensions/index.ts`

**Why**: Tools run in parallel by default. Two concurrent tool calls against the same kernel can
both decide to spawn its bridge (e.g. an external kernel's on-demand bridge, or a bridge that
died and needs restarting) → port conflict / double spawn.

**Change** — cache the startup promise **per kernel name** instead of a boolean:

```ts
const bridgeStartPromises = new Map<string, Promise<number>>(); // name -> port

async function ensureBridgeRunning(name: string): Promise<number> {
  const meta = readMeta(name);
  if (meta && (await bridgeHealthy(meta.bridge_port))) return meta.bridge_port;

  const pending = bridgeStartPromises.get(name);
  if (pending) return pending;

  const p = (async () => {
    const port = await findFreePort();
    await spawnBridge({ kernelFile: meta.kernel_file, port });   // detached, file-logged
    await waitForHealth(port);
    meta.bridge_port = port;
    writeMeta(name, meta);                                       // atomic: temp + rename
    return port;
  })().finally(() => bridgeStartPromises.delete(name));

  bridgeStartPromises.set(name, p);
  return p;
}
```

Each tool resolves `name` → `ensureBridgeRunning(name)` → port → HTTP base URL. No module-level
`serverStarted` flag, no `killStaleServer` (step 6).

**Verify**: two `kernel_run_python` calls against the same kernel in one turn both succeed;
bridge log shows a single startup.

---

## Step 5: `executionMode: "sequential"` on shared-state tools

**File**: `extensions/index.ts`

**Why**: `kernel_run_python`, `kernel_eval_expr`, `kernel_interrupt`, `kernel_get_output`,
`kernel_stop` mutate shared server state (the output cache, connection file, kernel process).
Running them concurrently can interleave wrongly (e.g., `get-output` reading the cache while
`run-code` replaces it).

**Change** — add to each of those tool definitions:

```ts
executionMode: "sequential",
```

**Verify**: docs/type defs accept the value (`ToolExecutionMode = "sequential" | "parallel"`).

---

## Step 6: Remove `killStaleServer` entirely

> ⚠️ Step 17 supersedes this: each bridge gets its own free port (bind 0), recorded in
> `meta.json`, so there is no shared port to sweep and no stale-server scenario — remove
> `killStaleServer`/`lsof` entirely. Bridge orphans are handled by `kernel_list` reaping
> (step 18), not by killing anything on a fixed port.

**File**: `extensions/index.ts`

**Why**: The `lsof -ti :<port>` sweep SIGKILLs **any** process on port 9123 — potentially an
unrelated user process or another pi session's server. With step 2 + step 4, the tracked
process is the only one we need to manage.

**Change**:

- Keep killing the tracked `serverProcess`.
- Verify it actually died (poll `/health` briefly) before spawning a replacement.
- Drop the `lsof` sweep entirely, or gate it behind a config flag (`force_kill_stale: false`
  default) so users can opt into the old behavior when they truly have an orphaned server
  from a crashed session.

**Verify**: start another service on 9123, call any kernel tool → error message about the
port being in use (not a silent kill of the service).

---

## Step 7: (Optional) Auth token on the bridge

**Files**: `server/main.py`, `extensions/index.ts`

**Why**: The bridge binds `127.0.0.1` with no auth. Any local process can POST arbitrary
Python to the kernel, and the bridge never exits on its own. Jupyter kernels at least ship a
token file.

**Change**:

- `cfg.json`: `auth_token` (generated at `kernel_start`/first use if absent, stored with
  `0600` perms in `~/.ipy/kernels/<name>/meta.json` — see steps 8 and 17).
- Extension: send `Authorization: Bearer <token>` (or `X-IPY-TOKEN`) on every request to the
  kernel's bridge.
- Bridge: FastAPI dependency that rejects requests without a matching token. After step 17,
  the token lives in `meta.json` and the port comes from `meta.json` too, not a fixed 9123.

**Verify**: `curl -X POST http://127.0.0.1:<bridge_port>/kernel/run-code -d '{"code":"1+1"}'` → 401;
with the token header → 200.

---

## Step 8: Move runtime state to the kernel registry

**Files**: `extensions/index.ts` (`loadConfig`/`saveConfig`), `cfg.json.example`

**Why**: For a local-path install (current setup) `cfg.json` next to the extension works and
is gitignored. If published to npm/git, pi installs the package under
`~/.pi/agent/npm/<pkg>/` where `pi update` can wipe it, and the file is **shared across all
projects and concurrent sessions** — two pi sessions would clobber each other's
`kernel_pid`/`kernel_auto_created`.

**Change** — the registry (step 17) replaces shared state entirely:

1. **Kernel registry** (`~/.ipy/kernels/<name>/meta.json`) holds all runtime state:
   `kernel_pid`, `bridge_port`, `kernel_file`, python spec, `cwd`, `started_at`,
   `started_by_session`. Written atomically (temp + rename). One file per kernel → no
   cross-session clobbering.
2. **`cfg.json` keeps only user preferences**: `python`, `default_cwd`, timeouts, optional
   `auth_token`, log paths. Remove `kernel_auto_created` / `kernel_pid` /
   `kernel_connection_file`.
3. **In-memory only**: the "connected kernel name" for the current session lives in the
   extension's memory (optionally mirrored to `cfg.json` `default_connect` — a preference, not
   state).

**Verify**: `pi install` the package from a git/npm source, run `kernel_start`, confirm
state is written under `~/.ipy/kernels/<name>/meta.json`, and that `pi update` does not reset
it. Two concurrent pi sessions never clobber each other's state (step 17).

---

## Step 9: Fix timeout semantics in `/kernel/run-code`

**File**: `server/main.py` (`kernel_run_code`)

**Why**: `client.get_iopub_msg(timeout=timeout)` applies the **entire** timeout to each
message wait. A computation that runs longer than `timeout` with no iopub traffic (e.g.
`time.sleep(60)` with `default_timeout_s: 60`) raises `queue.Empty` → spurious 504.

**Change** — overall deadline, per-poll budget:

```python
deadline = time.monotonic() + timeout
while True:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Execution timed out")
    try:
        msg = client.get_iopub_msg(timeout=min(remaining, 1.0))
    except queue.Empty:
        continue  # no message yet, keep waiting until the overall deadline
    # … existing message filtering …
```

(Import `queue` and `time`; re-check `remaining` before each poll so the total wait never
exceeds `timeout`.)

- Default `default_timeout_s` = **60** (decision 2, aligned with step 3): set in both `cfg.json`
  and `cfg.json.example`. The client fetch timeout is `timeout_s + 15s` margin (step 3), so the
  client always waits past this server-side deadline.

**Verify**: `time.sleep(5)` with `timeout_s: 2` → clean timeout error at ~2s; a chatty
computation that emits a message every second with `timeout_s: 60` completes.

---

## Step 10: Safe `kernel_stop` — graceful shutdown, kill bridge + kernel, no PID-reuse

**File**: `extensions/index.ts` (`kernel_stop`), `server/main.py`

**Why**: Stopping must never signal an unrelated process. `meta.json` holds both `kernel_pid`
and `bridge_port`, but PIDs can be recycled after death, and `uv run` may place the python
child in a new session so a `-pid` group kill may not reach it anyway.

**Change**:

1. Resolve the target kernel: explicit `path`, or registry name → `~/.ipy/kernels/<name>/meta.json`.
2. Graceful shutdown first: `POST /kernel/shutdown` to the kernel's **own bridge** (which knows
   its kernel — no explicit `connection_file` param needed) → control channel `shutdown_request`.
3. Stop the bridge: `POST /shutdown` (or `SIGTERM`) to the bridge; kill `bridge_pid` with a
   liveness check.
4. Only if the kernel is still alive, kill it — verify liveness: `process.kill(pid, 0)` **plus**
   compare `started_at` against the PID's start time (`ps -o lstart= -p <pid>`) so a recycled
   PID can never be signaled.
5. Unregister: delete the `~/.ipy/kernels/<name>/` dir. If this was the session's connected
   kernel, clear the in-memory pointer.

**Verify**: `kernel_start` → `kernel_stop` → neither `ipykernel` nor `server/main.py` remains
and the registry entry is gone; a manual kill of the kernel followed by `kernel_stop` does not
signal any unrelated process.

---

## Step 11: `kernel_start` writes to the registry; cfg default is for connect

**File**: `extensions/index.ts` (`kernel_start`, `kernel_connect`)

**Why**: With the registry model (steps 17–18), `kernel_start` no longer hardcodes
`~/kernels/ipyforge-kernel.json` or writes into the shared `cfg.json`. Each kernel owns its
own connection file.

**Change**:

- `kernel_start` always writes the connection file to
  `~/.ipy/kernels/<name>/kernel.json` (name = `params.name` or auto-generated), spawns the
  kernel's bridge, and registers `meta.json` (kernel pid + bridge port + python spec + cwd +
  timestamps).
- `cfg.kernel_connection_file` (rename: `default_connect`) becomes the *connect* default —
  a kernel name or path that `kernel_connect` uses when neither `name` nor `path` is given.
- Remove `kernel_auto_created` / `kernel_pid` from `cfg.json` (registry + in-memory pointer
  replace them).

**Verify**: `kernel_start` with no args → `~/.ipy/kernels/kernel-*/kernel.json` appears and
`kernel_list` shows it; `kernel_connect` with no args reconnects to the `default_connect`.

---

## Step 12: Adopt current tool-definition style

**Files**: `extensions/index.ts`

**Why**: Current examples use `defineTool()` with `Type` from `@earendil-works/pi-ai`
(see `examples/extensions/hello.ts`). `typebox` still works (peer dep), so this is
stylistic — but it also enables exporting tools for testing and makes `isError`-free
signatures obvious.

**Changes**:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const kernelStartTool = defineTool({
  name: "kernel_start",
  // …same body…
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(kernelStartTool);
  // …
}
```

- **Keep `execa`** for the kernel and bridge spawns — they are long-lived, detached
  (`detached: true` → own process group) and file-logged (stdout/stderr → `kernel.log` /
  `bridge.log`), which `pi.exec` (collect-and-return stdout/stderr for short commands) cannot
  do. **Decision:** do NOT replace execa with pi.exec; keep it in `dependencies`.
- Optionally use `pi.exec` for trivial one-shot calls (e.g. the `ps -o lstart=` liveness check
  in steps 10/18) — signal-aware and dependency-free, but not required.

**Verify**: `npx tsc --noEmit` passes; `execa` remains in `dependencies`.

---

## Step 13: `@`-path normalization + `onUpdate` progress

**File**: `extensions/index.ts`

- `kernel_connect`'s `path` param: normalize a leading `@` (docs: *"Some models are idiots
  and include the @ prefix in tool path arguments"*). For an external path (not in the
  registry), spawn an on-demand bridge and register it under an auto name (step 17):

  ```ts
  const connectionFile = params.path?.replace(/^@/, "");
  // name → registry lookup; path → external (on-demand bridge); neither → default_connect
  ```

- `kernel_run_python`: call `onUpdate?.({ content: [{ type: "text", text: "⏳ Executing in kernel…" }] })`
  before the HTTP call so the TUI shows progress during long executions.

**Verify**: call `kernel_connect` with `path: "@~/kernels/ipyforge-kernel.json"` — connects.

---

## Step 14: Documentation and small fixes

- **Header count**: `extensions/index.ts` top comment says "7 custom tools"; the final set
  is **9** (step 18 adds `kernel_list`). Update to "9 custom tools" and align
  `extensions/README.md` / `README.md` tables and the tool list.
- **`server/main.py`**: `except (FileNotFoundError, RuntimeError, Exception)` is a redundant
  catch-all tuple → collapse to `except Exception`. Import `queue`/`time` if step 9 applied.
- **`_truncate` edge**: appending `…(truncated)…` can make `len(truncated) >= len(full)` for
  outputs within ~17 chars of the limit, so `truncated=False` is reported even though output
  changed. Return the truncated flag from `_truncate` (or compare `len(full) > max_chars`).
- **README.md**: add a "Lifecycle" section (persistent named kernels, per-kernel bridge, when
  they are killed, tmux note from step 18) and a "Known limitations" section (no auth by
  default, per-user registry location).
- **Skill**: update `skills/ipy/SKILL.md` for the new tool set (9 tools), lifecycle, and
  `kernel_list`.

**Verify**: `grep -n "7 custom" extensions/index.ts` → no match; docs tables match the 9
registered tools.

---

## Step 15: Two-phase delivery with automated tests

**Decision (confirmed)**: ship API-compat first, then the registry/bridge redesign — not one
big-bang commit.

### Phase A — API compatibility (steps 1, 3, 5, 9, 10, 12, 13, 14)

Land and commit a known-good baseline before touching the architecture. Steps 2, 4, 6, 8, 11,
16–18 (the architecture change) go in Phase B.

```bash
npx tsc --noEmit
uv run python -c "import server.main"
# …manual smoke: kernel_start → run_python → eval_expr → get_output → interrupt → status → stop
git add -A
git commit -m "update extension for current pi API: throw-based errors, timeout tracking, sequential tools"
```

### Phase B — registry + per-kernel bridge (steps 2, 4, 6, 8, 11, 16–18)

The architecture change, plus **automated tests** for the invariants that are hard to eyeball:

- **Cross-session isolation** — two concurrent sessions attach to the same kernel by name and
  share it; neither sees another's default.
- **Lifecycle** — kernel + bridge survive pi exit; `kernel_stop` kills both; `kernel_list` reaps
  a dead kernel's bridge.
- **Timeout** — a run longer than 10s but shorter than `timeout_s` completes (no client abort);
  `timeout_s` is honored end-to-end.
- **No PID-reuse kill** — `kernel_stop` after a kernel died externally signals nothing.
- **Name collision** — `kernel_start {name}` on a live name attaches; on a dead name replaces.

```bash
npx tsc --noEmit
uv run python -c "import server.main"
pi -e .
# …full end-to-end: kernel_start {name} → run → list → connect from 2nd session → stop
git add -A
git commit -m "per-kernel bridge + named kernel registry, persistent kernels, kernel_list"
```

> ⚠️ The earlier single-commit plan is replaced by this two-phase split.

## Step 16: Configurable Python environment for `kernel_start` (uv-based)

**Files**: `extensions/index.ts` (`kernel_start`), `cfg.json.example`, `README.md`, skill

**Why**: `kernel_start` currently always runs the kernel in the default `ipython` uv tool
environment (uv-managed Python 3.12.8 here) — the user cannot choose an interpreter or bring
project dependencies into the kernel.

**Config** — new `cfg.json` field (default empty):

```json
{
  "python": "",
  "default_cwd": "/path/to/project"
}
```

**Spawn matrix** (all through uv; verified on this machine):

| `python` value | cwd has project | Command | Effect |
|---|---|---|---|
| `""` (default) | any | `uv tool run --from ipython --with ipykernel python -m ipykernel -f <file>` | Reuses installed `ipython` tool env if present (current behavior); `--with ipykernel` makes it self-contained instead of relying on `uv tool install … --with ipykernel` |
| `"3.11"`, `">=3.10"`, `"pypy3.10"` | any | `uv run --isolated --python <spec> --with ipykernel python -m ipykernel -f <file>` | Ephemeral env on the requested interpreter (verified: 3.11.16 + ipykernel 7.3.0) |
| `"/abs/path/to/python"` or `"/abs/path/to/venv"` | any | `uv run --isolated --python <path> --with ipykernel python -m ipykernel -f <file>` | Uses that interpreter/env (verified with miniforge python and a `.venv` dir) |
| `"project"` | yes (`pyproject.toml`/`.python-version`) | `uv run --with ipykernel python -m ipykernel -f <file>` (cwd = `default_cwd`) | Uses the project's interpreter + dependencies (verified: project `.venv` 3.12.8); ipykernel overlaid via `--with` |

**Implementation**:

- `kernel_start` accepts an optional `name` (auto `kernel-<timestamp>` fallback); names must
  be path-safe (no `/`). Builds the command from `cfg.python` + `cfg.default_cwd` (see matrix).
- Record the resolved spawn spec in the kernel's `meta.json` (step 17) so `kernel_list`/
  `kernel_status` can report which interpreter the kernel uses.
- `kernel_connect` is unaffected — the Python is whatever the kernel was started with.

**Verify**: start kernels with `python: "3.11"`, `python: "project"`, and a venv path;
`kernel_run_python` reports the expected `sys.version`/`sys.executable` for each.

---

## Step 17: Named kernel registry + per-kernel FastAPI bridge

**Files**: `extensions/index.ts`, `server/main.py`

**Why**: The current single bridge (fixed port 9123) shares two mutable globals across all
sessions — `config.kernel_connection_file` (the default) and `_last_output_full` (output
cache) — plus a `killStaleServer` that kills whatever holds the port. Result: sessions get
confused about which kernel they're talking to, and one session can kill another's server.

**Decision (confirmed)**: **one FastAPI bridge per kernel**, not per session and not shared.
The bridge becomes a companion of the kernel — it knows its kernel's `kernel.json` at spawn, so
there is no per-request `connection_file` and no shared default; the output cache is naturally
per-kernel; and it lives/dies with the kernel.

**Layout**:

```
~/.ipy/kernels/<name>/          # ONE dir per kernel — the resource (lives until kernel_stop)
├── kernel.json                 #   ipykernel connection file
├── meta.json                   #   {name, kernel_pid, bridge_port, kernel_file, python spec,
│                               #    cwd, started_at, started_by_session, auth_token}
├── kernel.log                  #   kernel stdout/stderr
└── bridge.log                  #   FastAPI bridge stdout/stderr
```

No `~/.ipy/sessions/` dir — sessions hold only an in-memory "connected kernel name".

**Bridge** (`server/main.py`):

- CLI: `python server/main.py --kernel-file <path> --port <port> [--token <tok>]`. The bridge
  loads that one kernel's connection file at startup; all endpoints use it (no global default).
- **One `BlockingKernelClient` per bridge** (BUG-09): create it once at startup and reuse it
  across requests; close it on bridge `/shutdown`. Do NOT create a fresh client per request —
  `stop_channels()` stops threads but leaks ZMQ sockets (`close()` is never called), which
  exhausts sockets under sustained use.
- Self-provisioning (no `.venv` needed for a distributed install — critique #3):
  `uv run --with fastapi --with jupyter_client --with pyzmq python server/main.py --kernel-file … --port …`
- Output cache (`_last_output_full`) is per-bridge = per-kernel.
- `POST /kernel/shutdown` and `/kernel/interrupt` target the bridge's own kernel (no explicit
  `connection_file` param needed).
- Optional `POST /shutdown` endpoint so `kernel_stop` can stop the bridge itself cleanly.

**Extension** (`extensions/index.ts`):

- `kernel_start` (step 16): resolve name → `~/.ipy/kernels/<name>/` → pick a free port
  (`bind(0)` → grab → release) → spawn kernel detached → spawn bridge detached (file logs) →
  poll `/health` → write `meta.json` atomically (temp + rename). Connect the session to it.
- `ensureBridgeRunning(name)` (step 4): resolve the bridge port from `meta.json`, health-check,
  restart if dead — cache the startup promise per name. `SERVER` becomes a per-call base URL
  built from `meta.bridge_port`.
- `kernel_connect`: `name` → registry lookup; `path` → external kernel.json (spawn an
  on-demand bridge, register under an auto name); neither → session default (`default_connect`
  cfg or in-memory). Updates the in-memory connected name on success.
- `kernel_stop` (step 10) and `kernel_list` (step 18) operate on the registry.
- Remove `killStaleServer`/`lsof` (step 6).

**External kernels** (decision): `kernel_connect {path}` to a kernel we didn't start spawns an
on-demand bridge for that path and registers it under an auto name (e.g. `ext-<slug>`).
`kernel_stop` on it removes **our bridge only** — it does not kill the external kernel unless a
`kill_external: true` flag is passed.

**Edge cases to document**:

- Bridge dies but kernel lives → next tool call restarts the bridge via `ensureBridgeRunning`.
- Kernel dies but bridge lives → `kernel_list` reaps both (step 18).
- Two sessions attach to the same kernel by name → shared kernel, shared bridge (deliberate;
  the kernel serializes executions).
- Fixed `cfg.port` override: no longer used — each bridge gets a free port from the OS.
- **Name collision (decision 5)**: `kernel_start {name}` where the name already exists →
  **attach** if the kernel is alive (report "attached to existing '<name>'"), **replace** if
  dead (delete the dir, start fresh). Never silently clobber a live kernel.

**Verify**: `kernel_start {name:"data"}` → one bridge + one kernel, port in `meta.json`;
a second pi session `kernel_connect {name:"data"}` runs code in the same kernel; killing
session B does not touch A's kernel or bridge; `kernel_stop {name:"data"}` stops both.

---

## Step 18: `kernel_list` and the kernel lifecycle model

**File**: `extensions/index.ts`, `README.md`, skill

**Lifecycle (confirmed with user)**:

- **Kernel = persistent named resource (decision 1).** Created by `kernel_start`, killed ONLY by:
  1. explicit `kernel_stop {name|path}` (graceful `shutdown_request` → liveness-verified PID
     kill → unregister),
  2. process crash / machine reboot.
  - Pi session end never kills kernels; pi sessions attach and detach freely.
  - **No idle timeout.** Persistence is the default; cleanup is manual via `kernel_list` +
    `kernel_stop`. The registry is the single indexed place to purge from — document this
    tradeoff in the README.
- **Bridge = per-kernel companion.** Spawned with the kernel, dies with `kernel_stop`; any
  session reconnects to it by name. Orphaned bridges (kernel dead, bridge alive) are reaped by
  `kernel_list`.

**`kernel_list`** (new tool, no parameters):

1. Scan `~/.ipy/kernels/*/meta.json`.
2. Per entry: liveness = `process.kill(kernel_pid, 0)` **plus** start-time comparison against
   `meta.started_at` (`ps -o lstart= -p <pid>`) so a recycled PID never shows a dead kernel as
   alive (decision 4 — same check as step 10). If the kernel is dead, kill the bridge
   (`bridge_pid`) if still alive, then **prune** the entry (dir removed; report "pruned").
3. Return a table: `name`, `python` (spec from meta.json), `cwd`, `kernel_pid`, `bridge_port`,
   `started_at`, `started_by` (session slug), and mark the kernel this session is connected to.

**Tool set (9 total, confirmed)**: `kernel_start {name?, python?, cwd?}` ·
`kernel_connect {name?|path?}` · `kernel_run_python` · `kernel_eval_expr` ·
`kernel_interrupt` · `kernel_get_output` · `kernel_list` · `kernel_stop {name?|path?}` ·
`kernel_status`.

**tmux note (document in README)**: tmux is *not* required for kernel persistence — the
kernel is spawned detached (`execa detached: true` → own session/process group), so it
survives pi exit and terminal death. tmux is only for keeping *pi itself* running across
ssh disconnects / terminal closes.

**Verify**: start two kernels, kill one via OS, `kernel_list` → live one listed, dead one
pruned; reconnect to the live one after a pi restart; `kernel_stop` removes the entry.

---

## Acceptance Checklist

- [x] Zero `isError: true` returns in `extensions/index.ts`; all failures throw
- [x] No `session_shutdown` cleanup needed — no session-scoped resources (steps 2 + 17)
- [x] Esc aborts in-flight kernel calls via `signal`; fetch timeout tracks `timeout_s` + 15s (60s default), control calls 10s (step 3)
- [x] Concurrent tool calls don't double-start the bridge (step 4)
- [x] Shared-state kernel tools are `executionMode: "sequential"` (step 5)
- [x] `killStaleServer`/`lsof` removed entirely (steps 6 + 17)
- [x] Server timeout is an overall deadline, not per-message (step 9)
- [x] `kernel_stop` never signals a reused PID (graceful + liveness-verified, step 10)
- [x] State lives in the kernel registry `~/.ipy/kernels/<name>/meta.json` (steps 8 + 17)
- [x] `kernel_start` supports `python: "" | "project" | <spec> | <path>` via uv and an optional `name` (step 16)
- [x] Kernels are detached/persistent; bridge + kernel survive pi exit and terminal death (step 18)
- [x] Two concurrent pi sessions attach to the same kernel by name via its bridge (step 17)
- [x] `kernel_list` lists live kernels, reaps orphaned bridges, prunes dead entries (step 18)
- [x] `kernel_connect {name}` / `{path}` attach to registered or external kernels (on-demand bridge)
- [x] `kernel_start` name collision: attach if live, replace if dead (step 17)
- [x] Bridge self-provisions via `uv run --with …` (no `.venv` required, step 17)
- [x] `npx tsc --noEmit` clean (against both local 0.75.5 and runtime 0.84.3 types); end-to-end smoke test passes; no leaked bridges/kernels
- [x] Header/README/skill tool counts consistent (9)
