---
layout: default
---

# pi-ipython-kernel

Persistent IPython kernels for the [pi](https://github.com/earendil-works/pi) coding agent.
Every kernel is a named resource with its own companion bridge process, and it
outlives the pi session that started it — start one in one session, find your variables still
there in the next.

An agent executing Python through one-shot shell calls starts from zero every time: variables
vanish, imports re-run, a 500 MB DataFrame is read from disk again on the next step. A kernel
makes the namespace the thing that persists, instead of the script.

## See it work

This is a real session, exported by pi rather than written for the docs. A **second** pi
process — the first has already exited — reattaches to a running kernel, finds `data`,
`readings` and `by_sensor` waiting in its namespace, and averages from the grouping the
*first* session derived instead of recomputing it.

- **[Reconnect to a running kernel](examples/session-02-reconnect-and-stop.html)** — the interesting one
- [Start a kernel and load data](examples/session-01-start-and-load.html)

Both pages are self-contained, and both have viewer filters — **Default / No-tools / User /
Labeled / All** — so you can hide the tool traffic or read every call.

## Install

```bash
pi install git:github.com/johnpauljanecek/pi-ipython-kernel   # from GitHub
```

Or try it without installing anything: `pi -e git:github.com/johnpauljanecek/pi-ipython-kernel`

The only hard host prerequisite is [`uv`](https://docs.astral.sh/uv/) on `PATH` — no Python
environment, no Jupyter install, no Node. Every Python dependency is provisioned by `uv` on
first use.

## Documentation

- [README](https://github.com/johnpauljanecek/pi-ipython-kernel/blob/main/README.md) — why, install,
  tools, lifecycle, architecture, registry, configuration, testing *(on GitHub: Pages serves
  README-style files as raw markdown rather than rendering them)*
- [Install workflow](workflows/installs/001-install-pi-ipython-kernel.md) — the same install as a
  checked, auditable procedure, written to be handed to an agent
- [examples/](examples/) — the two sessions above, and exactly what was changed before committing them
