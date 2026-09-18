# workflows/

Operational documents for this package.

| Path | What it holds | Who reads it |
|---|---|---|
| [`installs/`](installs/) | numbered procedures: install, validate, upgrade, roll back | anyone deploying this on a machine |
| [`open_bugs.md`](open_bugs.md) | the bug ledger — every defect, its evidence, the commit that fixed it, and the corrections when an entry was wrong | maintainers |
| [`history/`](history/) | dated, superseded working notes (package migration, pi API updates, plan critiques, the skill's first implementation). Kept for context; **not maintained** and not a description of current behaviour | maintainers |

Numbered workflows use a three-digit execution order, so `installs/001-…` runs before
`002-…`. Every install workflow carries the same sections: purpose, scope, prerequisites,
paths affected, estimated disk usage, procedure, validation, failure modes, upgrade,
rollback, installation record, completion criteria.

Two things worth knowing before trusting anything here:

- **`open_bugs.md` is the authority on defects**, including entries that were later found to
  be wrong — corrections are recorded in place rather than edited away, so a wrong claim
  stays traceable to why it was wrong.
- **`history/` describes the past.** Where it disagrees with the README or a workflow, the
  README and the workflows win.
