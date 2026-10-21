---
name: agf
description: Validate and restructure AI-generated game projects with agf. Use when a project root contains manifest.json, or when a task adds a scene, asset, widget or input intent, splits an HTML single-page game into maintainable modules, or checks whether generated game code is still maintainable. Skip agf for projects without a manifest and for questions that do not change project structure.
metadata:
  version: "3"
  tool_count: 8
---

# agf

agf is a contract, not a generator. It reads a manifest, checks whether the
project still honours it, and reports every violation with an executable fix.
This skill supplies the working method. The rules live in the prompt files and
in the checker, never in this file — a rule written only here is not enforced.

## Three sizes, two files

| Size | Carrier | Load when | Lifetime |
| --- | --- | --- | --- |
| Global Environment | `agf_prompt size=global` | Session start, or after a context reset | The session |
| Local Project | `agf_prompt size=local` → `AGF.md` + `.agf/log.md` | Before the first edit, and again after a reset | The project |
| Info Block | The return value of any tool call | Every call | The current turn |

An Info Block has no file and no command. Every diagnostic, every `agf_inspect`
result, every `agf_add` response is one. Consume it where it arrives. Never ask
for a second summary of the same facts, and never re-derive them by reading the
manifest yourself.

`agf_prompt size=local` returns the contract joined with the round log when
`AGF.md` exists, and the rendered template when it does not. If it returns a
template, run `agf_init` once, fill in engine, target and art direction, then
continue.

## Local Project is memory

The block is two files.

- `AGF.md` — the contract. Human-written: layout, engine, boundaries, intentional
  gaps. Version-controlled.
- `.agf/log.md` — the round log. Written by `agf_log`, read by you. One entry per
  round: what changed, what the check measured, what comes next, and any ruling
  you made alone. Git-ignored.

`agf_prompt size=local` joins them, contract first. The log exists because memory
does not survive compaction. A session that loses its place re-implements work
that already exists. Trust the log over your own recollection, and read it before
continuing work you did not start.

## Route the task first

Choose the first tool from the task, not from habit.

- New project, no manifest: write one HTML file first. Do not create a manifest,
  do not plan modules. `agf_check` reads it in prototype mode and only warns.
- Single file runs, and the next step is more features: `agf_extract`, then split
  one step at a time.
- Unsure what is broken, or starting any task: `agf_check`.
- About to change a declared entity: `agf_inspect`, then read `usedBy`.
- Adding an asset, scene, widget or intent: `agf_add`. Pass every entity in one
  `entities` array; one call, one check.
- Asked "is this getting worse?": `agf_stats` and compare counts.
- Need the rules: `agf_prompt size=global` or `size=local`.

## Work sequence

1. If `.agf/log.md` exists, read the newest entry first. It tells you where the
   last round stopped. If it does not exist and a manifest exists, `agf_init`,
   then read the Contract.
2. `agf_check` for the baseline. In prototype mode it only warns; in project mode
   fix errors before adding anything.
3. `agf_inspect` on each entity you intend to change. Verify every entry in
   `usedBy`, or change those call sites in the same edit.
4. `agf_add` to declare new entities. Do not hand-write `manifest.json`. Send one
   `entities` array rather than one call per entity — the round-trips are the cost,
   not the write.
5. Write the module file the manifest now points at. Respect the boundaries in
   the Contract: scenes assemble, widgets consume intents, input adapters stay in
   `src/core/`.
6. `agf_check` again. Errors must be zero.
7. `agf_audit` when the round changed structure — new files, new assets, moved
   code. Read the grades, not a score. A `bad` grade is the next refactor, not a
   reason to keep working now.
8. `agf_log` to close the round. It runs the check itself and records the
   measured result; you do not report the result to it.

## From one file to modules

A single HTML file is the shape most models produce reliably. Treat it as a valid
stage, not a mistake.

1. Get it running. `agf_check` in prototype mode warns about size, inline assets
   and a missing viewport; none of that blocks.
2. When the file passes roughly 600 lines, or the next feature would touch more
   than one concern, run `agf_extract`.
3. Work the plan in order: assets first, then pure rules, then rendering, then
   input, then UI, then audio and storage.
4. After each step, `agf_check`. If a step breaks the game, revert that step and
   keep the previous one — do not split the next module on a broken baseline.
5. Only after the modules exist, write `manifest.json` and a scene that assembles
   them.

## Closing a round

`agf_log` takes one task line, the changed files, the next step, and optionally a
ruling:

```bash
agf log --task "wire the confirm intent into the menu button" \
  --changed src/ui/button.ts,manifest.json \
  --next "verify the button is reachable from scene/main" \
  --ruling "kept the 128px icon — matches existing HUD scale — cost if wrong: one asset swap"
```

One entry per round, at the end of the round. Do not batch three rounds into one
entry: a batched entry loses which change caused which check result.

A ruling is a decision you took without asking, plus what it costs if wrong. It
is not a note that you skipped a polish item. Ledgered rulings are how a later
session learns why the code looks the way it does.

## Resuming after a reset

1. `agf_prompt size=local` and read the round log, newest first.
2. `agf_check` to see whether the recorded state still holds.
3. `agf_audit` if the last entry says the structure changed.
4. Read only the files the last entry says changed.
5. Continue from its `next:` line, not from your memory of the plan.

If the log and the files disagree, the files win — run the check and trust its
output. Then log the discrepancy so the next session does not repeat the work.

## Boundaries

- `agf_check`, `agf_stats` and `agf_inspect` read only.
- `agf_add` appends one entity and never overwrites an existing ID.
- `agf_init` never overwrites an existing `AGF.md`.
- `agf_log` refuses to write when the manifest is unreadable, because a round
  without evidence is not worth recording.
- agf does not run the game, capture screenshots or assert runtime behaviour.
  Runtime verification is out of scope for this version; do not claim it passed.

## Anti-patterns

**Rewriting the whole game.** This is the failure agf exists to prevent. If a
change touches one file, it touches one file.

**Inventing a repair instead of using `fix`.** The rules are a closed set. An
alternative repair usually produces two or three new diagnostics.

**Deleting a declaration to silence a warning.** AGF009 means "declare it on a
scene", not "delete it".

**Inlining assets as base64 to simplify deployment.** AGF006 blocks it.

**Listening for raw input inside a widget.** Device differences leak into game
logic. Declare an intent instead.

**Hand-editing the log, or writing it in a separate call from the work.** The
entry belongs to the round it describes; a detached edit is a note you will not
find when you need it.

**Reporting the check result to `agf_log`.** It measures the result itself. A
result you supply is a claim, and claims are what this toolchain replaces.

**Treating an audit grade as a gate.** Audit informs the next round. Blocking on
a `bad` fan-out grade mid-task leaves the work in a worse state than finishing the
task and refactoring once.

## Verify completion

Completion is not "the code is written". It is:

```bash
agf check    # errors: 0
```

plus a logged round whose `next:` line is either empty or a real remaining task.
