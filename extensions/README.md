# ipyforge-kernel — Pi Extension

This extension registers 8 custom tools that communicate with the
[ipyforge-kernel-server](../server/), a FastAPI server wrapping
`jupyter_client.BlockingKernelClient`.

## Installation

Install as a Pi package:

```bash
pi install /path/to/ipython_package
```

Or from npm (once published):

```bash
pi install npm:@johnjanecek/ipyforge-kernel
```

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new IPython kernel |
| `kernel_connect` | Connect to a kernel via kernel.json or cfg.json |
| `kernel_run_python` | Execute Python code, return captured output |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt a stuck kernel |
| `kernel_get_output` | Retrieve cached output slices |
| `kernel_stop` | Stop a Pi-created kernel |
| `kernel_status` | Show server and kernel connection state |

## Prerequisites

The server is started internally on first tool call. No manual server startup
is needed. Monitor logs with:

```bash
tail -f ~/.ipy/kernel.log
tail -f ~/.ipy/server.log
```
