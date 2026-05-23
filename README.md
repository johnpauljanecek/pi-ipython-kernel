# @johnjanecek/ipyforge-kernel

Pi extension for controlling an IPython kernel via HTTP. Execute Python code remotely and interact with a persistent kernel session.

## Prerequisites

This package uses `uv` to manage Python tools. See [docs/uv-tool-env-setup.md](docs/uv-tool-env-setup.md) for a comprehensive guide to setting up a unified IPython/Jupyter environment with `uv tool`.

Quick setup:

```bash
uv tool install ipython \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel
```

## Installation

### 1. Install the Pi package

```bash
pi install /path/to/ipython_package
```

Or for development:

```bash
pi -e /path/to/ipython_package
```

### 2. Install server dependencies

```bash
cd /path/to/ipython_package
uv sync
```

### 3. Configure the server

Copy the example config:

```bash
cp cfg.json.example cfg.json
```

Edit `cfg.json` to point to your kernel connection file:

```json
{
  "port": 9123,
  "kernel_connection_file": "/tmp/remote-kernel.json"
}
```

### 4. Start the kernel (remote access)

Create an IPython profile (one time):

```bash
uv run ipython profile create pi-dev
```

Start the kernel, binding to all interfaces:

```bash
uv run ipython kernel --profile=pi-dev --ip=0.0.0.0 -f /tmp/remote-kernel.json
```

Copy the connection file (`/tmp/remote-kernel.json`) to the machine running the server, then update `cfg.json` with the path.

### 5. Start the server

```bash
cd /path/to/ipython_package
uv run python server/main.py
```

### 6. Reload Pi

Run `/reload` in Pi to pick up the new extension.

## Available Tools

| Tool | Description |
|------|-------------|
| `kernel_connect` | Connect to a kernel via its connection file |
| `kernel_run_python` | Execute Python code in the kernel |
| `kernel_eval_expr` | Evaluate a Python expression |
| `kernel_interrupt` | Interrupt a running kernel |
| `kernel_get_output` | Retrieve cached output (when truncated) |
| `kernel_status` | Show connection and server status |

## Quick Start

1. Start the server: `uv run python server/main.py`
2. In Pi, use `kernel_connect` to connect to the kernel
3. Use `kernel_run_python` to execute Python code

## Connect with jupyter console

On the same machine as the kernel:

```bash
uv run jupyter console --existing /tmp/remote-kernel.json
```

From a different machine, edit the `ip` field in the copied `kernel.json` first.

## Uninstall

```bash
pi remove /path/to/ipython_package
```