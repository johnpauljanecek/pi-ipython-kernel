# examples/

A real pi session, exported from pi's own session files, so you can see what using the
extension actually looks like — including the part that is hard to believe from prose.

| File | What happens in it |
|---|---|
| `session-01-start-and-load.jsonl` | *"Start a Python kernel named `demo`, load `examples/data/readings.json` into that kernel's namespace, and tell me how many readings there are and which sensors appear."* → then *"what is the average temperature per sensor?"* The tools pi picks on its own: `kernel_start`, `kernel_connect`, `kernel_run_python` — and it leaves `by_sensor`, a derived grouping, in the kernel. |
| `session-02-reconnect-and-stop.jsonl` | A **separate pi process**: *"Connect to the existing kernel named `demo` and tell me the per-sensor average temperatures again — from the data already in that kernel."* → `kernel_connect`, then a call that lists the namespace and finds `data`, `readings` **and `by_sensor`** — the grouping computed in session 01. Finally *"stop the demo kernel"* → `kernel_stop` ends in `no processes left`. |

`data/readings.json` is the fixture: 24 synthetic readings across 3 sensors, invented values,
no real data.

The second file is the interesting one: everything it touches was left in the kernel by a pi
process that had already exited, and it reuses the *derived* value rather than recomputing it.

## How these were produced

One pi process per file, run from this directory on 2026-09-18 (pi 0.85.1, model
`deepseek/deepseek-flash`), each against the local package path:

```bash
pi -ne -e "$PWD" --model deepseek/deepseek-flash \
  -p 'Start a Python kernel named demo, load examples/data/readings.json into that kernel'"'"'s namespace, and tell me how many readings there are and which sensors appear.' \
  -p 'From those readings in the kernel, what is the average temperature per sensor?'
```

`-ne` keeps other installed extensions out of the transcript, so the tool calls you see are
this package's; `-e "$PWD"` loads it from the working tree.

## What was changed before committing

The files are pi's session files from `~/.pi/agent/sessions/…` with exactly two substitutions —
nothing was added, dropped or reworded:

| Substitution | Why |
|---|---|
| `$HOME` in place of the absolute home directory (`cwd`, kernel path, log path) | keeps the machine it ran on out of the example |
| `thinkingSignature` values blanked | provider-internal artifacts with no value in a demo |

Everything else is what pi recorded: prompts, tool calls, tool results, thinking text, token
usage, timestamps.

## Reading, resuming, rendering

```bash
pi --resume examples/session-01-start-and-load.jsonl                              # continue it
pi --export examples/session-01-start-and-load.jsonl /tmp/session-01.html         # read-only render
```

Resuming **writes to the file** — pi continues the session in place. Work on a copy, or use
`pi --fork examples/session-01-start-and-load.jsonl`, if you want the example left alone.

Resuming does not bring back the kernel: the `demo` kernel is not in the transcript, so a
continued session that asks for the data again needs the kernel recreated and the fixture
reloaded. The recorded tool *results* remain readable regardless.
