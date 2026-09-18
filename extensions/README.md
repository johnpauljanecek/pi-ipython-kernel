# pi-ipython-kernel — Pi Extension

This extension registers 10 custom tools that manage persistent, named IPython
kernels. Each kernel owns a companion FastAPI bridge (one per kernel, never
shared) wrapping `jupyter_client.BlockingKernelClient`, registered under
`~/.ipy/kernels/<name>/`.

## Installation

**The host comes first.** The extension needs a POSIX system (macOS/Linux) and `uv`
visible to the environment pi was launched from — no Python, Node, or Jupyter of your own.
The full host checklist (uv install + verification, writable directories, loopback, what uv
downloads on first run) is in [Part 1 of the main README](../README.md#part-1--the-host).

Then install the package:

```bash
pi install /path/to/pi-ipython-kernel
```

Or from npm (once published):

```bash
pi install npm:pi-ipython-kernel
```

Check the host in one line before blaming the extension:

```bash
command -v uv && uv --version
```

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new named IPython kernel (persistent) |
| `kernel_connect` | Attach to a kernel by name, or an external kernel by path |
| `kernel_run_python` | Execute Python code, return captured output |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt a stuck kernel |
| `kernel_get_output` | Retrieve cached output slices |
| `kernel_list` | List kernels in the registry (prunes dead entries) |
| `kernel_stop` | Stop a kernel and its bridge |
| `kernel_status` | Show the connected kernel + registry summary |
| `kernel_console_cmd` | One-line command to attach a Jupyter console to a kernel |

## Lifecycle

Kernels are persistent named resources (see `../README.md`). They survive pi
sessions and are stopped only by `kernel_stop`, a crash, or a reboot. No manual
server startup is needed — each kernel's bridge starts on demand and is stopped
with the kernel. Monitor logs with:

```bash
tail -f ~/.ipy/kernels/<name>/kernel.log
tail -f ~/.ipy/kernels/<name>/bridge.log
```
