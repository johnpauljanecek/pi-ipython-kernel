# Open Bugs

## ~~BUG-01: `kernel_start` unawaited execa promise — errors silently swallowed~~ ✅ RESOLVED

**Severity:** Medium  
**File:** `extensions/index.ts` (kernel_start handler)  
**Commit:** `8392106`

`execa` returns a `ResultPromise`. The code reads `proc.pid` synchronously but
never `await`s the promise. If the kernel fails to launch, the error becomes an
unhandled promise rejection instead of being caught by the surrounding try/catch.

**Resolution:** Attached a `.catch()` handler to capture spawn errors in a
`spawnError` variable. After `waitForKernelFile` succeeds, the handler checks
`spawnError` and throws with a descriptive message if the process exited during
startup.

---

## ~~BUG-02: Server process is fire-and-forget — orphaned on reload~~ ✅ RESOLVED

**Severity:** Medium  
**File:** `extensions/index.ts` (`ensureServerRunning`)  
**Commit:** `1eba34e`

`ensureServerRunning()` spawns the FastAPI server with `execa` but never stores
the child process reference. If Pi restarts or the extension is reloaded:
- The old server continues running on port 9123
- A new server attempts to start, causing a port conflict
- There is no way to cleanly stop the server

**Resolution:** Three defenses:
1. `serverProcess` variable tracks the spawned child process
2. `killStaleServer()` kills the tracked process AND uses `lsof -ti :<port>` to find and kill any stale server from a previous session
3. `.catch()` on the server process auto-resets `serverStarted` if the server crashes

---

## ~~BUG-03: `kernel_stop` kills the `uv` wrapper, not the Python kernel~~ ✅ RESOLVED

**Severity:** Medium  
**File:** `extensions/index.ts` (kernel_stop handler), `server/main.py`  
**Commit:** `d824342`

`process.kill(cfg.kernel_pid)` sends SIGTERM to the `uv tool run` wrapper
process. The actual IPython kernel is a child Python process of `uv`. Killing
only the wrapper may leave:
- The Python kernel process orphaned and still running
- The `kernel.json` file dangling on disk

**Resolution:** Four-stage cleanup:
1. Graceful shutdown via `/kernel/shutdown` endpoint (Jupyter control channel)
2. Kill tracked `kernelProcess` (execa child)
3. Kill process group (`-pid`) to catch child Python process, with individual PID fallback
4. `unlinkSync()` the kernel.json connection file

---

## ~~BUG-04: User-provided `~` paths in cfg.json are never expanded~~ ✅ RESOLVED

**Severity:** Medium  
**File:** `extensions/index.ts` (`loadConfig`)  
**Commit:** `05f420c`

`loadConfig()` reads path fields (`kernel_connection_file`, `kernel_log_file`,
`server_log_file`, `default_cwd`) from JSON but never calls `expandUser()` on
them. The defaults work because `getDefaultConfig` uses `${homedir()}/...`, but
if a user writes `~/kernels/my-kernel.json` in `cfg.json`, the `~` is treated
literally as a filename character.

**Resolution:** `loadConfig()` now iterates over the four path fields and calls
`expandUser()` on each before passing to `getDefaultConfig()`.

---

## ~~BUG-05: `workflows/` gitignored but workflow files are tracked~~ ✅ RESOLVED

**Severity:** Low  
**File:** `.gitignore`  
**Commit:** `4af7d47`

`.gitignore` contains `workflows/` but workflow files are committed. They're
in a "tracked but gitignored" state — changes to existing tracked files are
seen by git, but new files won't be tracked. This is inconsistent.

**Resolution:** Removed `workflows/` from `.gitignore`. Workflow docs are
intended to be versioned.

---

## ~~BUG-06: `pydantic` missing from `pyproject.toml` dependencies~~ ✅ RESOLVED

**Severity:** Low  
**File:** `pyproject.toml`  
**Commit:** `03c2127`

`server/main.py` imports `from pydantic import BaseModel`, but `pydantic` is
not listed under `[project].dependencies`. It currently works because FastAPI
pulls it as a transitive dependency, but that's fragile — a FastAPI update
could change this.

**Resolution:** Added `pydantic>=2.0.0` and `pyzmq>=25.0.0` to dependencies.

---

## ~~BUG-07: Redundant kernel connection check in `kernel_status`~~ ✅ RESOLVED

**Severity:** Low  
**File:** `extensions/index.ts` (kernel_status handler)  
**Commit:** `5b3bcf1`

The extension's `kernel_status` tool called a separate `fetchWithTimeout("/health")`
before calling `serverGet("/kernel/status")`. Both checks hit the same server —
the health check was redundant. Also removed the now-unused `fetchWithTimeout`
helper.

**Resolution:** Single `serverGet("/kernel/status")` call derives both
`serverRunning` and `kernelConnected`.

---

## ~~BUG-08: Server cwd-dependent config loading~~ ✅ RESOLVED

**Severity:** Low  
**File:** `server/main.py`  
**Commit:** `e2fa931`

The server's `load_config()` used `os.getcwd()` to find `cfg.json`. If the
server was started from a different directory, it wouldn't find the config
and would use defaults with no kernel connection file.

**Resolution:** Config path now derived from `__file__`
(`Path(__file__).resolve().parent.parent`) — always the package root,
regardless of cwd.

---

## BUG-09: Fresh `BlockingKernelClient` per request leaks ZMQ sockets

**Severity:** High (blocks long-lived per-kernel bridge in step 17)
**File:** `server/main.py` (`_connect` + every endpoint's `finally: client.stop_channels()`)
**Status:** Open — fix in Phase B

Every endpoint calls `_connect()` which creates a **new** `BlockingKernelClient`
(`start_channels()` → 5 channel threads each with a ZMQ socket), and cleans up
with `client.stop_channels()`. `stop_channels()` stops the channel **threads**
but does **not** close their sockets (`close()` is never called, and the shared
`zmq.Context.instance()` is not destroyed because `_created_context` is False).

Result: each request leaks ~5 ZMQ sockets. Under sustained use (≈7+ rapid
requests, observed empirically) channel threads fail with
`zmq.error.ZMQError: Too many open files`. The current server survives only
because it is short-lived and traffic is bursty.

**Fix (Phase B):** the per-kernel bridge owns **one** `BlockingKernelClient`
created at startup and reused across all requests (close it on bridge
`/shutdown`). This is the natural per-kernel-bridge design — the bridge knows
its kernel's connection file at spawn — and it eliminates the create/stop cycle
entirely. If a fresh-client pattern is ever needed, call `client.close()`
(channel sockets) in the `finally`, not just `stop_channels()`.

---

## BUG-10: An **aborted** cell is reported as success — `"ok"` from `run-code`, `""` from `eval-expr`

**Severity:** Medium (silent data loss: a cell that never ran looks like a clean success)
**File:** `server/main.py` (`_run_code_blocking` L133–172, `_eval_expr_blocking` L176–214)
**Status:** Open

### What happens

The two execution paths each read **one** channel and never look at the execution outcome:

| Function | Reads | Ignores | Renders an aborted reply as |
|---|---|---|---|
| `_run_code_blocking` | **iopub** only (`stream`, `display_data`, `execute_result`, `error`), breaks on `status: idle` | the **shell** reply, i.e. `execute_reply.content.status` | `full = "\n".join(out).strip() or "ok"` → **`"ok"`** |
| `_eval_expr_blocking` | **shell** only (checks `status == "error"`) | — (`aborted` is not `error`) | falls through to `return ""` → **`""`** |

The kernel protocol's outcome lives in the shell reply: `execute_reply.content.status ∈ {ok, error, aborted}`. Neither function tests it, so **a cell that never executed is indistinguishable from a cell that executed and printed nothing.**

### How it was found (AI-Studio Windows node, 2026-09-16)

After `kernel_interrupt`, the *next* `kernel_run_python` returned the bare string `ok` while the code in that cell demonstrably never ran (a module-level marker it would have set stayed unset, and `cfx.status()` still reported the pre-cell state).

The cell was not lost in transit — it was **aborted by design**. When an `interrupt_request` arrives, ipykernel sets an *aborting* flag and answers execute requests already queued behind the running cell with `_send_abort_reply` (`Kernel.dispatch_shell`, `kernelbase.py`). Standard Jupyter behaviour; the bug is only in how this bridge renders it. Because `_run_code_blocking` never reads the shell reply, it sees no output, hits `or "ok"`, and reports success.

This matters most on hosts where interrupts were previously a no-op (ipykernel has no message-mode interrupt on Windows), because that is exactly when an operator starts firing cells right after an interrupt to see whether the kernel recovered — and gets `ok` for cells that were dropped. Full context: AI-Studio `WebScrapping/knowledge/windows-problems.md` §3.2 and §7.

### Fix

Make the outcome explicit instead of inferred:

1. `_run_code_blocking`: after the iopub loop breaks on `idle`, drain the **shell** channel for the matching `msg_id` (`client.get_shell_msg(timeout=…)`, skipping other parents) and read `content.status`:
   * `aborted` → **not** a success. Return a distinguishable signal (e.g. `{"output": …, "status": "aborted"}`) or an HTTP 409-style error; at minimum never the text `"ok"`.
   * `error` with no `error` message captured from iopub → surface `content.ename` / `content.evalue` so the failure is not reported as empty output.
   * `ok` → success. Keep `"ok"` as the *text* for a no-output success if backwards compatibility matters, but carry `status` alongside it so callers can tell the two apart.
2. `_eval_expr_blocking`: same treatment — check `status == "aborted"` **before** falling through to the `user_expressions` branch, and return an explicit "aborted" rather than `""`.
3. Consider exposing `status` in the response bodies (`RunCodeResponse`, `EvalExprResponse`) rather than only in the text — the text channel cannot express the distinction.

### Test to add

`tests/test_bridge.py` already has `test_interrupt_during_run`; extend it (or add a sibling) to submit a **second** run-code immediately after the interrupt and assert the response is not reported as a plain success — that reproduces the abort window deterministically.

---

## BUG-11: One bad reply can wedge the whole bridge — no timeout on the shell lock

**Severity:** High (the bridge looks dead; only killing it recovers; the kernel is fine)
**File:** `server/main.py` (`_eval_expr_blocking`, `_run_code_blocking`, the `_shell_lock` in both)
**Status:** Open — found 2026-09-16 while driving a live kernel

### Symptom

Every tool call then fails with **"Cannot reach kernel bridge for '<kernel>'. fetch failed"** / "operation
aborted due to timeout" — for `kernel_eval_expr` *and*, once the lock is held, for `kernel_run_python`. But
the kernel is perfectly healthy: an independent client answers immediately.

```
# pi tools:                     ❌ Cannot reach kernel bridge for 'marie'  (repeated)
# independent console, same kernel:
$ jupyter console --existing ~/.ipy/kernels/marie/kernel.json --simple-prompt
  KERNEL-ALIVE https://search.yahoo.com/search?q=myanimelist+fall+2026+anime+lineup   ✅
```

### Cause (reproduced)

`_eval_expr_blocking` executes with `user_expressions={"__X__": expr}` and waits for the shell reply **with no
overall bound on how long it will hold `_shell_lock`**. If the reply cannot be serialised normally the request
never completes, the lock is never released, and every later request queues behind it forever. The trigger in
this instance was mine:

```
kernel_eval_expr: __import__("cfx_kernel").status() and "alive"
                  ^^^ an un-awaited coroutine -- not serialisable as a user_expression
```

Every subsequent call (including `kernel_run_python`) then timed out, while the kernel itself stayed responsive.

### Fix

1. **Bound the wait** in both `_eval_expr_blocking` and `_run_code_blocking`: an overall deadline on the shell
   reply, releasing `_shell_lock` on expiry and returning a clear error ("no shell reply in N s — the bridge
   is still usable"). A lock that can be held forever by one malformed reply is the whole bug.
2. Detect the dead-end early: if the reply carries `status: error`, or `user_expressions.__X__` is missing or
   not a dict, return that error instead of falling through.
3. Cheap hardening: `repr()`/`str()` the user_expression result server-side and refuse to wait on anything the
   kernel cannot echo back (a coroutine/generator is the common case).
4. In the bridge's own log, record each `/kernel/run-code` and `/kernel/eval-expr` with its msg_id so a held
   lock is visible rather than inferred (uvicorn only logged `/health` during the incident, which is what made
   the diagnosis slow).

### Recovery as it stands today

Kill the per-kernel bridge and let the pi tool respawn it — the **kernel and browser survive** (they are
separate processes; only the proxy is lost):

```bash
lsof -tiTCP:<bridge_port> -sTCP:LISTEN | xargs kill      # port from ~/.ipy/kernels/<name>/meta.json or bridge.log
# then in pi: kernel_connect(name="<kernel>")
```

`kernel_interrupt` did **not** clear it — the interrupt goes through the same wedged client. In the observed
case the kernel had also queued the earlier request, so an interrupt *was* worth sending once, but it was the
bridge restart that actually recovered the session.

---

## Resolved (for reference)

| Bug | Resolution | Commit |
|-----|-----------|--------|
| `cfg.json` leaked to git | Added to `.gitignore`, `git rm --cached` | `8265476` |
| `node_modules/` / `.pi/` not gitignored | Added to `.gitignore` | `8265476` |
| `extensions/README.md` stale (6→8 tools, old install) | Rewritten with all 8 tools + pi package install | `8265476` |
| No timeouts — hangs in kernel_status and all tools | `AbortSignal.timeout()` on fetch, ZMQ socket timeouts, health polling | `859aa46` |
