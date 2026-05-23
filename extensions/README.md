# ipyforge-kernel — Pi Extension

This extension registers 6 custom tools (`kernel_connect`, `kernel_run_python`,
`kernel_eval_expr`, `kernel_interrupt`, `kernel_get_output`, `kernel_status`)
that communicate with the [ipyforge-kernel-server](../server/).

## Installation

Copy `index.ts` to one of these locations for Pi to auto-discover it:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/index.ts` | Global (all projects) |
| `~/.pi/agent/extensions/ipyforge-kernel/index.ts` | Global (subdirectory) |
| `.pi/extensions/index.ts` | Per-project |
| `.pi/extensions/ipyforge-kernel/index.ts` | Per-project (subdirectory) |

After copying, run `/reload` in Pi to pick it up.

## Prerequisites

The [kernel server](../server/) must be running:

```bash
cd /path/to/ipython_extension
uv run python server/main.py
```

## Tools

| Tool | Description |
|------|-------------|
| `kernel_connect` | Connect to a running kernel via kernel.json |
| `kernel_run_python` | Execute Python code, return captured output |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt the running kernel |
| `kernel_get_output` | Retrieve cached output from last run |
| `kernel_status` | Show server and connection state |
