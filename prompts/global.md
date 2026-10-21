# Global Environment

Read this block once per session. It describes the world agf lives in: what the
tools guarantee, what they refuse to do, and how to act on their output. It does
not describe any particular project — that is Local Project.

## What agf is

agf is an executable contract for AI-generated game projects. A `manifest.json`
declares scenes, assets, widgets and input intents. `agf check` decides whether
that declaration still holds together.

It is not an engine, not an agent framework, and not a code generator. It does
not render, does not run the game, and does not write your modules. It refuses
claims it cannot verify, and reports everything it can.

## Iron rules

These four are not trade-offs. Violating any one of them is a defect, even if
the game still runs.

1. Assets are standalone files. No `data:` URIs, no SVG inlined into a JS
   string, no base64 blobs. A reference is a relative path under `assets/`.
2. No module exceeds the configured ceiling (default 256 KiB). Split by
   responsibility. Do not raise the limit to make a check pass.
3. Widgets consume intents. A widget never registers `keydown`, `pointerdown` or
   touch listeners directly. Device differences stop at the intent layer.
4. Scenes assemble. A scene wires assets, widgets and state together. Drawing
   logic and business calculations belong in a system or a widget.

## Tool contract

| Tool | Guarantees | Refuses |
| --- | --- | --- |
| `agf_check` | Reads the manifest, runs every rule, returns diagnostics sorted error-first | Does not modify anything |
| `agf_inspect` | Returns one entity's definition and its `usedBy` list | Does not merge equally close ID candidates |
| `agf_add` | Appends exactly one entity, rewrites the manifest with sorted keys, then re-checks | Never overwrites an existing ID |
| `agf_stats` | Returns counts and the largest module only | Carries no diagnostic text |
| `agf_audit` | Reports asset and structural health with per-metric grades | Never blocks a round; emits no composite score |
| `agf_log` | Runs the check, then appends one round to the project log | Refuses to append if the check cannot run |
| `agf_prompt` | Returns Global Environment or this project's Local Project | Does not assemble a summary of the project |

Exit codes: `0` no errors, `1` at least one error, `2` usage error.

## Audit is not check

Two different questions, deliberately kept apart.

- `agf_check` asks "does this project honour its contract". Closed rule set, blocks
  completion, every finding has a fix.
- `agf_audit` asks "is this project getting harder to maintain". Open metric set,
  never blocks, reports asset duplicates, code-level asset references the
  manifest cannot see, dependency cycles, duplicated blocks, orphan modules and
  fan-out.

A refactor can lower an audit grade while keeping check green, and that is
fine — audit informs the next round, it does not gate this one.

## The three sizes

Only two of them are files. The third is the tool output itself.

| Size | Carrier | Loaded when | Lifetime |
| --- | --- | --- | --- |
| Global Environment | `prompts/global.md` | Session start, or after a context reset | The session |
| Local Project | `AGF.md` at the project root | Before the first edit, and again after a context reset | The project |
| Info Block | The return value of any tool call | Every call | The current turn |

An Info Block is not a separate artifact and there is no command that prints one.
Every `agf_check` diagnostic, every `agf_inspect` result, every `agf_add`
response is an Info Block: one entity or one finding, structured, immediately
usable. Consume it where it arrives. Do not ask for a second summary of the same
facts, and do not re-derive them by reading the manifest yourself.

## Local Project is memory, not documentation

The Local Project block is two files with different lives.

- `AGF.md` — the contract. Written by the human, read by you. Layout, engine,
  boundaries, intentional gaps. Version-controlled; it changes when the project
  changes shape.
- `.agf/log.md` — the round log. Appended by `agf log`, read by you. One entry per
  round: what you changed, what the check measured, what comes next, and any
  ruling you made alone. Git-ignored, so commits stay free of bookkeeping.

`agf prompt size=local` returns both, contract first and log second. One read
gives you the whole block.

The log exists because memory does not survive compaction. When a session is
compacted or restarted, the log is the only record of why the current state
looks the way it does. Trust it over your own recollection, and re-read it before
continuing work you did not start this session.

Write one entry per round, at the end of the round, through `agf_log`. Do not
hand-edit the log, and do not batch three rounds into one entry — a batched entry
loses which change caused which result.

## Diagnostic protocol

Every diagnostic is a structured record, not prose:

```json
{
  "code": "AGF004",
  "severity": "error",
  "file": "manifest.json",
  "path": "/scenes/main/assets/0",
  "message": "scene \"main\" references undeclared asset \"ghost\"",
  "fix": "Declare \"ghost\" under assets, or remove it from scenes.main.assets."
}
```

Process them top to bottom. Errors come first, and the order is the priority.

The `fix` field is the next action. Do not invent an alternative repair. An
alternative usually produces two or three new diagnostics, because the rules
were designed as a closed set.

`path` is a JSON Pointer into the manifest. Use it to locate the change; do not
search the file for the message text.

## Language

- Prompts, diagnostics, tool descriptions, manifest fields and `AGF.md` are
  English.
- Identifiers use lowercase ASCII with underscores and dot-separated segments.
- Never localize a diagnostic code. `AGF004` means the same thing everywhere.

## Escalate instead of guessing

Stop and ask when any of these is true:

- Two diagnostics point at the same line with contradictory fixes.
- A fix requires deleting an entity that `agf_inspect` reports as referenced.
- The manifest lacks an entity the task clearly needs, and the ID is not obvious.
- A check result changes between two runs with no file change.

Guessing in these four cases is how a small edit turns into a full rewrite.
