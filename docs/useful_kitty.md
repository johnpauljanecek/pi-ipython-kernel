# Useful Kitty Commands

Kitty remote control commands for scripting and automation.

## Open a New Tab

```bash
kitty @ launch --type=tab --tab-title "My Title" zsh -lc 'command; exec zsh'
```

- `--type=tab` — opens a new tab in the current window
- `--tab-title` — sets the tab title
- `zsh -lc '...'` — runs the command in a login zsh shell
- `exec zsh` — keeps the tab open with an interactive shell after the command runs

## Examples

### Run a command and keep the tab open

```bash
kitty @ launch --type=tab --tab-title "uv tools" zsh -lc 'uv tool list; exec zsh'
```

### Run a command without switching focus

```bash
kitty @ launch --type=tab --keep-focus zsh -lc 'uv tool list; exec zsh'
```

Use `--keep-focus` to run a command in a new tab without stealing focus from the current terminal.

### Open IPython in a new tab

```bash
kitty @ launch --type=tab --tab-title "IPython" zsh -lc 'ipython; exec zsh'
```

### Start a kernel in a new tab

```bash
mkdir -p ~/kernels

kitty @ launch --type=tab --keep-focus zsh -lc 'uv tool run --from ipython python -m ipykernel -f ~/kernels/dev-kernel.json; exec zsh'
```

### Connect to a kernel in a new tab

```bash
kitty @ launch --type=tab --keep-focus zsh -lc '
uv tool run --from jupyter-console jupyter console --existing ~/kernels/dev-kernel.json
exec zsh
'
```

Note: `jupyter console` is provided by `jupyter-console`, not `ipython`.

### Open JupyterLab in a new tab

```bash
kitty @ launch --type=tab --keep-focus zsh -lc 'uv tool run --from ipython jupyter lab; exec zsh'
```

## Reference

- `kitty @ launch` — launch a new kitty process
- `--type=tab` — create a new tab in the current OS window
- `--type=window` — create a new OS window
- `--keep-focus` — don't transfer focus to the new process
- `--location=<position>` — place window relative to current (default, after, before, split, vsplit, hsplit)
- `--tab-title <title>` — set the tab title
- `--cwd <path>` — set the working directory for the new process