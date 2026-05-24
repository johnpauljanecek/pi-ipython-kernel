# ipyforge-kernel

Pi extension for controlling an IPython kernel via HTTP. Communicates with a FastAPI server that wraps `jupyter_client.BlockingKernelClient`.

## Installation

### From npm (once published)
```bash
pi install npm:@johnjanecek/ipyforge-kernel
```

### From GitHub
```bash
pi install git:github.com/johnjanecek/ipyforge-kernel
```

### From local path
```bash
pi install /path/to/ipython_package
```

### Try without installing
```bash
pi -e npm:@johnjanecek/ipyforge-kernel
pi -e git:github.com/johnjanecek/ipyforge-kernel
```

## Tools

| Tool | Description |
|------|-------------|
| `kernel_start` | Start a new IPython kernel |
| `kernel_connect` | Connect to a kernel (path argument or cfg.json) |
| `kernel_run_python` | Execute Python code in the kernel |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt a stuck kernel |
| `kernel_get_output` | Retrieve cached output slices |
| `kernel_stop` | Stop a Pi-created kernel |
| `kernel_status` | Show server and kernel status |

## Quick Start

### 1. Install IPython tool

```bash
uv tool install ipython --with ipykernel --with jupyter-console
```

### 2. Install this package

```bash
pi install /path/to/ipython_package
```

### 3. Start a kernel

```
kernel_start
```

### 4. Connect and run code

```
kernel_connect
kernel_run_python { "code": "print('hello from kernel')" }
```

## Server Setup

The server starts internally on first tool call. Log output goes to:
- Kernel: `~/.ipy/kernel.log`
- Server: `~/.ipy/server.log`

Monitor with:
```bash
tail -f ~/.ipy/kernel.log
```

## Configuration

Create `cfg.json` in the package root (see `cfg.json.example`):

```json
{
  "port": 9123,
  "kernel_connection_file": "~/kernels/ipyforge-kernel.json",
  "default_cwd": "/Users/johnjanecek",
  "kernel_log_file": "~/.ipy/kernel.log",
  "server_log_file": "~/.ipy/server.log"
}
```

## Documentation

- [uv tool environment setup](docs/uv-tool-env-setup.md)
- [Kitty remote control](docs/useful_kitty.md)
- [ipy skill](skills/ipy/SKILL.md)

## Requirements

- `uv` installed
- `ipython` tool installed with `ipykernel` and `jupyter-console`
- Python: `fastapi`, `uvicorn`, `jupyter_client`, `pydantic`