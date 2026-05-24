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

## BUG-08: `cfg.json` still referenced in `server/main.py` main() startup message

**Severity:** Low  
**File:** `server/main.py` (`main()`)

The server's startup message prints the kernel connection file path, which is
sourced from `cfg.json` at the server's working directory. If the server is
started by the extension (cwd = package root), it reads the right config. But
if someone starts the server manually from a different directory, the config
won't be found and the server will use defaults with no kernel connection file
— all kernel operations will fail with a confusing error.

**Fix:** Accept a `--config` CLI argument or use the package directory as the
config search path.

---

## Resolved (for reference)

| Bug | Resolution | Commit |
|-----|-----------|--------|
| `cfg.json` leaked to git | Added to `.gitignore`, `git rm --cached` | `8265476` |
| `node_modules/` / `.pi/` not gitignored | Added to `.gitignore` | `8265476` |
| `extensions/README.md` stale (6→8 tools, old install) | Rewritten with all 8 tools + pi package install | `8265476` |
| No timeouts — hangs in kernel_status and all tools | `AbortSignal.timeout()` on fetch, ZMQ socket timeouts, health polling | `859aa46` |
