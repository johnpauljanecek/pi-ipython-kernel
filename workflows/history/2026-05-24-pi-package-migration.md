# Workflow: Convert ipython_extension to Pi Package

**Date**: 2026-05-24
**Status**: Completed ✅

## Goal

Convert the `ipython_extension` project into a [Pi package](https://pi.dev/packages) so it can be installed via `pi install` and shared with other Pi users.

## What We Did

### Step 1: Clone the repository

```bash
git clone ipython_extension ipython_package
```

Preserved full git history in a new directory.

### Step 2: Rename `extension/` → `extensions/`

Following Pi package convention — the `extensions/` directory is auto-discovered by Pi.

### Step 3: Create `package.json`

```json
{
  "name": "@johnjanecek/ipyforge-kernel",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "description": "Pi extension for controlling an IPython kernel via HTTP",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

### Step 4: Update `extensions/index.ts` comments

- Updated package name in header
- Fixed example kernel path (`agno-kernel.json` → `remote-kernel.json`)

### Step 5: Create `cfg.json.example`

Template config file for users to copy and customize.

### Step 6: Delete `install-extension.py`

No longer needed — `pi install` handles extension installation.

### Step 7: Rewrite `README.md`

New README with:
- Installation instructions (`pi install`)
- Server setup steps
- Kernel startup guide
- Tools overview
- Quick start guide

### Step 8: Remove `docs/`

Deleted unused HTML/CSS/JS files.

### Step 9: Commit

```bash
git add -A
git commit -m "restructure as pi package"
```

## Final Structure

```
ipython_package/
├── .git/
├── .gitignore
├── cfg.json
├── cfg.json.example
├── extensions/
│   ├── index.ts
│   └── README.md
├── package.json
├── pyproject.toml
├── README.md
├── server/
│   └── main.py
└── uv.lock
```

## Next Steps

1. **Test the package locally**:
   ```bash
   pi -e /path/to/ipython_package
   ```

2. **Publish to npm** (if desired):
   ```bash
   npm publish --access public
   ```

3. **Install from npm**:
   ```bash
   pi install npm:@johnjanecek/ipyforge-kernel
   ```

## Notes

- Git history preserved from the original `ipython_extension` repo
- Remote URL unchanged — push when ready: `git push`
- Package uses local path install for now; can be published to npm later
- Server still requires `uv sync` and manual startup (`uv run python server/main.py`)