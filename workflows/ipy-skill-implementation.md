# ipy Skill Implementation Workflow

## Step Summary

| Step | Description | Status |
|------|-------------|--------|
| 1 | Install `execa` dependency | Pending |
| 2 | Update `cfg.json.example` with new fields | Pending |
| 3 | Update `server/main.py` — read new config fields, internal startup | Pending |
| 4 | Update config handling in extension — read/write new fields | Pending |
| 5 | Add `kernel_start` tool — spawn kernel via execa, update cfg.json | Pending |
| 6 | Update `kernel_connect` tool — two modes (path arg or cfg.json) | Pending |
| 7 | Add `kernel_stop` tool — kill Pi-created kernel | Pending |
| 8 | Update `kernel_status` tool — show kernel + server + auto_created | Pending |
| 9 | Internal server startup with logging | Pending |
| 10 | Create `ipy` skill with all tools structured | Pending |
| 11 | Update `README.md` — reference skill docs | Pending |
| 12 | Test the complete workflow | Pending |
| 13 | Validate and commit | Pending |

---

## Dependencies

**npm packages**:
- `execa` — process spawning (promise-based, great streaming)

Install:
```bash
npm install execa
```

## Step 1: Install Dependencies

**Command**:
```bash
npm install execa
```

---

## cfg.json Fields (New)

```json
{
  "port": 9123,
  "kernel_connection_file": "/tmp/remote-kernel.json",
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
- `kernel_auto_created` — boolean, did Pi spawn the kernel?
- `kernel_pid` — process ID if Pi created the kernel (null otherwise)
- `kernel_log_file` — path to kernel stdout/stderr (user handles via `tail -f`, etc.)
- `server_log_file` — path to server stdout/stderr

---

## Step 1: Update `cfg.json.example`

**File**: `cfg.json.example`

Add the new fields to the template.

---

## Step 2: Update `server/main.py`

**File**: `server/main.py`

Changes:
1. Read `kernel_connection_file`, `port` from config
2. Add internal startup function (used by extension, not exposed as tool)
3. Ensure server validates connection file exists before starting

---

## Step 3: Update Config Handling in Extension

**File**: `extensions/index.ts`

Changes:
1. Add `kernelAutoCreated`, `kernelPid`, `defaultCwd` fields to config interface
2. Write `kernel_auto_created` and `kernel_pid` to `cfg.json` when starting kernel
3. Read `cfg.json` on extension load to get current state

---

## Step 4: Add `kernel_start` Tool

**File**: `extensions/index.ts`

Tool definition:
```typescript
{
  name: "kernel_start",
  description: "Start a new IPython kernel via execa. Logs written to kernel_log_file in cfg.json. User can tail -f the log file to monitor output.",
  input: {
    cwd?: string  // optional, defaults to cfg.json default_cwd
  }
}
```

Implementation:
1. Read `default_cwd` and `kernel_log_file` from `cfg.json`
2. Override `cwd` if provided
3. Generate kernel connection file path: `~/kernels/ipyforge-kernel.json`
4. Ensure log directory exists (`~/.ipy/`)
5. Spawn kernel using execa:
   ```typescript
   import { execa } from 'execa';

   const kernelFile = `${process.env.HOME}/kernels/ipyforge-kernel.json`;
   const logFile = cfg.kernel_log_file;

   const proc = execa('uv', ['tool', 'run', '--from', 'ipython', 'python', '-m', 'ipykernel', '-f', kernelFile], {
     cwd: workingDir,
     stdout: { file: logFile },
     stderr: { file: logFile },
   });

   const pid = proc.pid;
   ```
6. Wait briefly for kernel file to be created
7. Update `cfg.json`:
   - `kernel_connection_file` = `~/kernels/ipyforge-kernel.json`
   - `kernel_auto_created` = true
   - `kernel_pid` = pid
8. Return success to user, note log file location

**Note**: Process runs attached (not detached). User should `tail -f ~/.ipy/kernel.log` in another terminal to monitor output.

---

## Step 5: Update `kernel_connect` Tool

**File**: `extensions/index.ts`

Tool definition:
```typescript
{
  name: "kernel_connect",
  description: "Connect to an IPython kernel",
  input: {
    path?: string  // optional, uses cfg.json if not provided
  }
}
```

Implementation:
1. If `path` provided — connect to that kernel
2. Else — use `kernel_connection_file` from `cfg.json`
3. If `kernel_auto_created` is true AND `kernel_pid` exists — verify process is alive
4. Connect via HTTP server (server must be running internally)
5. Return connection status

---

## Step 6: Add `kernel_stop` Tool

**File**: `extensions/index.ts`

Tool definition:
```typescript
{
  name: "kernel_stop",
  description: "Stop a kernel that was created by Pi. No-op if kernel was not auto-created."
}
```

Implementation:
1. Check `kernel_auto_created` in `cfg.json`
2. If false — return message: "Kernel was not created by Pi. Use kernel_stop only for Pi-created kernels."
3. If true — kill process via `kernel_pid`
4. Update `cfg.json`:
   - `kernel_auto_created` = false
   - `kernel_pid` = null
5. Return success

---

## Step 7: Update `kernel_status` Tool

**File**: `extensions/index.ts`

Tool definition:
```typescript
{
  name: "kernel_status",
  description: "Show kernel and server connection status"
}
```

Implementation:
1. Check if server is running (internal)
2. Check if kernel connection file exists
3. Check `kernel_auto_created` — if true, verify process is alive
4. Return status object:
   ```
   Server: running/not running
   Kernel connection file: exists/missing
   Kernel auto-created: true/false
   Kernel process: alive/dead/not tracked
   ```

---

## Step 8: Internal Server Startup

**File**: `extensions/index.ts`

Implementation:
1. On first tool call (before any kernel operation):
   - Check if server is already running
   - If not, spawn server using execa:
     ```typescript
     import { execa } from 'execa';
     const proc = execa('uv', ['run', 'python', 'server/main.py'], {
       cwd: extensionDir,
       stdout: { file: cfg.server_log_file },
       stderr: { file: cfg.server_log_file },
     });
     ```
   - Wait for server to be ready (check port or health endpoint)
2. All other tools depend on this server being available
3. Server stays running for the session
4. User can `tail -f ~/.ipy/server.log` to monitor server output

**Note**: Log files are user-managed. User should monitor via `tail -f` or similar.

---

## Step 9: Create `ipy` Skill

**File**: `skills/ipy/SKILL.md`

Structure:
```markdown
# ipy Skill

Pi skill for controlling an IPython kernel via HTTP.

## Tools

| Tool | Description |
|------|-------------|
| kernel_start | Start a new IPython kernel via execa |
| kernel_connect | Connect to a kernel |
| kernel_run_python | Execute Python code |
| kernel_interrupt | Interrupt the kernel |
| kernel_get_output | Retrieve cached output |
| kernel_stop | Stop a Pi-created kernel |
| kernel_status | Show kernel and server status |

## Configuration

cfg.json fields:
- `port` — server port (default: 9123)
- `kernel_connection_file` — path to kernel connection file
- `default_cwd` — default working directory for starting kernels
- `kernel_auto_created` — whether Pi created the kernel
- `kernel_pid` — process ID if Pi created the kernel
- `kernel_log_file` — path to kernel stdout/stderr
- `server_log_file` — path to server stdout/stderr

## Workflow

### Start a new kernel
...

### Connect to existing kernel
...

### Execute code
...
```

---

## Step 10: Update `README.md`

**File**: `README.md`

Changes:
1. Add section referencing `skills/ipy/SKILL.md`
2. Update installation to mention `pi install`
3. Add workflow examples using the new tools

---

## Step 11: Test the Complete Workflow

Test cases:

### Test A: Start new kernel and execute code
1. `kernel_start`
2. `kernel_connect`
3. `kernel_run_python` (e.g., `print("hello")`)
4. `kernel_status`
5. `kernel_stop`

### Test B: Connect to user-created kernel
1. User manually starts kernel: `uv tool run --from ipython python -m ipykernel -f ~/kernels/my-kernel.json`
2. User updates `cfg.json` with path and `kernel_auto_created: false`
3. `kernel_connect`
4. `kernel_run_python`
5. `kernel_stop` should return no-op message

### Test C: Connect with path argument
1. User starts kernel manually
2. `kernel_connect` with `path: "~/kernels/my-kernel.json"`
3. `kernel_run_python`

---

## Step 12: Validate and Commit

1. Run `clj_validate_file` on any Clojure files
2. Review all changes
3. Commit with descriptive message
4. Document any issues found during testing