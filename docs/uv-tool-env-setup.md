# Using `uv tool` for One Shared IPython/Jupyter Environment

## Goal

Create ONE managed `uv` tool environment containing:

* IPython
* JupyterLab
* Notebook server
* Jupyter console
* Kernels
* Extra Python libraries

Instead of managing many virtualenvs manually.

---

# Basic Install

```bash
uv tool install ipython \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel
```

This creates:

* one isolated tool environment
* centered around `ipython`
* with all additional packages installed into the same environment

---

# Install With Python 3.13

First make sure uv can use Python 3.13:

```bash
uv python install 3.13
```

Then install the tool environment using Python 3.13:

```bash
uv tool install ipython \
  --python 3.13 \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel
```

Check the Python version used by the tool environment:

```bash
uv tool run ipython python --version
```

You should see something like:

```text
Python 3.13.x
```

You can also check from IPython:

```bash
ipython
```

Then inside IPython:

```python
import sys
sys.version
```

---

# What Gets Installed

The environment now contains:

* `ipython`
* `jupyter`
* `jupyter-lab`
* `jupyter-notebook`
* `jupyter-console`
* `ipykernel`

All available as shell commands.

---

# Running the Tools

Run them normally:

```bash
ipython
```

```bash
jupyter lab
```

```bash
jupyter notebook
```

```bash
jupyter console
```

---

# PATH Setup

uv installs wrappers into:

```bash
~/.local/bin
```

Ensure it is in your PATH:

```bash
echo $PATH
```

If necessary:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to:

* `~/.bashrc`
* `~/.zshrc`
* or your shell config

---

# Listing Installed uv Tools

```bash
uv tool list
```

---

# Upgrading

Upgrade the entire environment:

```bash
uv tool upgrade ipython
```

---

# Adding More Packages Later

Run `uv tool install` again with more `--with` options.

Example:

```bash
uv tool install ipython \
  --with pandas \
  --with matplotlib \
  --with rich
```

uv updates the existing environment.

---

# Scientific/Data Stack Example

```bash
uv tool install ipython \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel \
  --with numpy \
  --with pandas \
  --with matplotlib \
  --with scipy \
  --with rich \
  --with textual
```

Now inside IPython/Jupyter:

```python
import numpy
import pandas
import rich
```

---

# Where the Environment Lives

Usually:

```bash
~/.local/share/uv/tools/ipython/
```

You normally do NOT activate it manually.

uv manages it automatically.

---

# Running Commands Inside the Tool Environment

Very useful feature:

```bash
uv tool run ipython python
```

Run arbitrary commands inside the environment.

Examples:

```bash
uv tool run ipython pip list
```

```bash
uv tool run ipython python -c "import pandas; print(pandas.__version__)"
```

```bash
uv tool run ipython jupyter kernelspec list
```

Think of it as:

> Execute this command inside the ipython tool environment.

---

# Removing the Tool Environment

```bash
uv tool uninstall ipython
```

---

# Recommended Stack for Your Workflow

Given an IPython + Jupyter + kernel + agent workflow:

```bash
uv tool install ipython \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel \
  --with numpy \
  --with pandas \
  --with rich \
  --with textual \
  --with ptpython
```

This gives:

* IPython REPL
* JupyterLab
* notebook server
* kernel support
* scientific libraries
* rich terminal output
* advanced REPL tools

all managed together.

---

# Difference Between `uv tool` and Projects

## `uv tool`

Best for:

* reusable CLI tools
* editors
* Jupyter
* linters
* terminal applications
* globally available commands

Managed automatically.

Examples:

* ipython
* jupyter
* ruff
* black
* mypy
* yt-dlp

---

## `uv init` / project virtualenvs

Best for:

* application development
* pinned dependencies
* project-specific environments
* reproducible builds

Equivalent to traditional Python project virtualenvs.

---

# Useful Pattern

Many people use:

* `uv tool` for global utilities
* project virtualenvs for actual app development

Example:

Global:

```bash
uv tool install ipython --with jupyterlab
```

Per-project:

```bash
uv init
uv add fastapi
```

---

# Starting an IPython Kernel Manually

You can start a standalone IPython kernel without launching JupyterLab first.

Run:

```bash
uv tool run ipython python -m ipykernel
```

This starts a kernel and prints a connection file path, usually something like:

```text
To connect another client to this kernel, use:
    --existing kernel-12345.json
```

The connection file is commonly stored under a Jupyter runtime directory, such as:

```bash
~/.local/share/jupyter/runtime/kernel-12345.json
```

or on macOS sometimes under:

```bash
~/Library/Jupyter/runtime/kernel-12345.json
```

---

# Start a Kernel With a Known Connection File

For your workflow, it is often better to choose the connection file yourself.

Create a directory:

```bash
mkdir -p ~/kernels
```

Start a kernel with a fixed connection file:

```bash
uv tool run ipython python -m ipykernel \
  -f ~/kernels/dev-kernel.json
```

Leave that terminal running.

That process is now the live Python kernel.

---

# Connect to the Running Kernel With Jupyter Console

From another terminal:

```bash
jupyter console --existing ~/kernels/dev-kernel.json
```

Or using uv explicitly:

```bash
uv tool run --from jupyter-console jupyter console --existing ~/kernels/dev-kernel.json
```

Now the console is attached to the already-running kernel.

Multiple frontends can connect to the same kernel.

---

# Connect to the Running Kernel With IPython

Modern usage is usually through `jupyter console`:

```bash
jupyter console --existing ~/kernels/dev-kernel.json
```

Older IPython-style command:

```bash
ipython console --existing ~/kernels/dev-kernel.json
```

If that older command is unavailable, use `jupyter console`.

---

# Show Connection Info From Inside a Kernel

Inside IPython or a notebook, run:

```python
%connect_info
```

This prints the command needed to connect another frontend, usually:

```bash
jupyter console --existing kernel-xxxxx.json
```

This is useful when the kernel was started by JupyterLab or Notebook and you want to attach a console to it.

---

# Register This Python 3.13 Environment as a Jupyter Kernel

This lets JupyterLab/Notebook show the environment as a selectable kernel.

Run:

```bash
uv tool run ipython python -m ipykernel install \
  --user \
  --name py313-uv-ipython \
  --display-name "Python 3.13 uv-ipython"
```

Then start JupyterLab:

```bash
jupyter lab
```

or:

```bash
uv tool run ipython jupyter lab
```

In JupyterLab, select:

```text
Python 3.13 uv-ipython
```

as the notebook kernel.

---

# List Available Jupyter Kernels

```bash
jupyter kernelspec list
```

or:

```bash
uv tool run ipython jupyter kernelspec list
```

---

# Remove the Registered Kernel

If you registered a kernelspec and want to remove it:

```bash
jupyter kernelspec uninstall py313-uv-ipython
```

or:

```bash
uv tool run ipython jupyter kernelspec uninstall py313-uv-ipython
```

This removes the Jupyter menu entry, not necessarily the uv tool environment itself.

---

# Important Distinction

## Manual live kernel connection

Use this when you want one kernel process shared by multiple frontends:

```bash
uv tool run ipython python -m ipykernel -f ~/kernels/dev-kernel.json
```

Then connect:

```bash
jupyter console --existing ~/kernels/dev-kernel.json
```

Best for:

* agent workflows
* attaching and detaching consoles
* keeping state alive
* connecting multiple clients to one process

---

## Registered kernelspec

Use this when you want JupyterLab to launch the kernel for you:

```bash
uv tool run ipython python -m ipykernel install \
  --user \
  --name py313-uv-ipython \
  --display-name "Python 3.13 uv-ipython"
```

Best for:

* normal notebooks
* JupyterLab launcher menu
* reproducible kernel choices

---

# Quick Reference

## Install with Python 3.13

```bash
uv python install 3.13

uv tool install ipython \
  --python 3.13 \
  --with jupyterlab \
  --with notebook \
  --with jupyter-console \
  --with ipykernel
```

## Verify Python version

```bash
uv tool run ipython python --version
```

## Run IPython

```bash
ipython
```

## Run JupyterLab

```bash
jupyter lab
```

## Start a live kernel

```bash
mkdir -p ~/kernels

uv tool run --from ipython \
  python -m ipykernel \
  -f ~/kernels/dev-kernel.json
```

## Connect to that kernel

```bash
uv tool run --from jupyter-console jupyter console --existing ~/kernels/dev-kernel.json
```

Note: `jupyter console` is provided by `jupyter-console`, not `ipython`.

## Register as a JupyterLab kernel

```bash
uv tool run --from ipython \
  python -m ipykernel install \
  --user \
  --name py313-uv-ipython \
  --display-name "Python 3.13 uv-ipython"
```

## List tools

```bash
uv tool list
```

## Upgrade

```bash
uv tool upgrade ipython
```

## Remove

```bash
uv tool uninstall ipython
```

## Run inside tool env

```bash
uv tool run ipython python
```