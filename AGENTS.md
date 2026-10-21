# AGENTS.md

This repository builds agf: an executable contract for AI-generated game
projects. Read this file when working **on** agf. If you are working **with**
agf inside a game project, read `prompts/global.md` and `prompts/local.md`
instead — this file describes the tool's own development rules.

## Layout

```
src/            Core: schema, rules, check, query, mutate, prompt, local, audit, scan, CLI, MCP
prompts/        global.md and the AGF.md template
skills/agf/     the agent-facing skill entry point
test/           rule, CLI, ledger and audit regression tests
examples/       a clean reference project
```

## Prompt sizes

Two files, three sizes. The third size is not a file and must never become one.

| Carrier | Size | Belongs in a project? |
| --- | --- | --- |
| `prompts/global.md` | Global Environment | No. Session-wide, shipped with agf. |
| `prompts/local.md` | Local Project template | Copied to the project root as `AGF.md` by `agf init`. |
| Any tool return value | Info Block | No file. Diagnostics and inspect results are the block. |

The Local Project block is two files. `AGF.md` is the human-maintained contract
and belongs in version control. `.agf/log.md` is the round log, written by
`agf log` with the check result measured at write time, and git-ignored through
`.agf/.gitignore`. `agf prompt local` joins them.

Do not add a `prompts/info.md`: an Info Block that can be printed separately
would be a second source of the same facts.

Do not duplicate rule text across sizes. A rule lives in exactly one place:

- Shape of the manifest → `src/schema.ts`
- Meaning of a violation → `src/rules.ts`
- How to work → `prompts/*.md` and `skills/agf/SKILL.md`
- How to install and wire it → `README.md`

If two of those disagree, the code wins and the prose gets fixed.

## Development rules

- Every rule change ships with a test in `test/check.test.ts`. A rule that has
  never fired in a test is a rule that has never been proven to fire at all.
- Diagnostic `code` values are stable. Append new codes; never renumber or reuse.
- Diagnostics, tool descriptions and prompt blocks are English. Chinese appears
  only in human-facing conversation, never in agent-facing text.
- Every diagnostic needs a `fix`. A rule that reports without naming the next
  action forces a guess, and guessing causes regressions.
- `agf add` and any future writer must stay atomic: write to a temporary file in
  the same directory, then rename.
- State that must survive a session goes in the project directory, never in a
  server process.
- Do not add a fifth concept to the manifest vocabulary without proving it
  cannot be expressed with asset, intent, widget and scene.

## Commands

```bash
npm run build        # tsc to dist/
npm run typecheck    # src + test, no emit
npm test             # rule, CLI, ledger and audit regression
node dist/cli.js check examples/minimal
node dist/cli.js audit examples/minimal
node dist/cli.js init <project>
node dist/cli.js log --root <project> --task "..." --changed a.ts --next "..."
node dist/cli.js prompt local --root <project>
node scripts/mcp-smoke.mjs   # real stdio client round-trip
```

## Ledger invariants

- The check result in a log entry is measured by `agf_log`, never passed in by
  the caller. A log that can claim a clean run is not evidence.
- One entry per round. Never batch, never hand-edit.
- Keep the newest 12 rounds; older rounds fold into one omitted line.
- `agf_init` never overwrites an existing `AGF.md`.

## Audit invariants

- Audit never blocks a round. Only `check` gates completion.
- No composite score. Each metric shows its value and its threshold, because a
  single number invites optimising the number.
- Every metric that carries a grade cites where the threshold came from
  (TIOBE fan-out bands, "must be zero" for cycles and orphan modules).
- Size is not a maintainability grade. The 256 KiB ceiling lives in `check` as a
  regression guard; the audit reports bytes without scoring them.
- Code-string asset references are heuristic and labelled as such. Never present
  them as a resolved reference graph.

## Out of scope for version one

Runtime snapshots, headless assertions and screenshot diffing are not
implemented. Do not describe them as working. When they arrive, their baselines
go under `.agf/` in the project directory.
