# AGF — Local Project

<!--
Contract is written by humans and read by the agent.
Log is written by `agf log` and read by the agent.
Do not put rules here that already live in Global Environment.
-->

## Contract

- Name: `minimal`
- Entry: `scene/main`
- Engine: `pixi`
- Target: `desktop + touch`
- Art direction: `flat vector, dark palette`

### Four concepts

Only four. Before adding a fifth, prove it cannot be expressed with these.

| Concept | Meaning | Boundary |
| --- | --- | --- |
| `asset` | A standalone file: image, audio, video, font, JSON | Never inlined; path stays inside the project |
| `intent` | A device-independent input intention | Says what the player wants, not which key was pressed |
| `widget` | A control that consumes intents | Never reads the keyboard or pointer directly |
| `scene` | An assembly of assets, widgets and state | Never holds drawing code or business rules |

### Manifest contract

```jsonc
{
  "schemaVersion": 1,
  "name": "minimal",
  "entry": "scene/main",              // must be scene/<declared scene ID>
  "assets": {
    "bg_menu": { "type": "image", "src": "assets/bg_menu.svg" }
  },
  "intents": {
    "confirm": { "type": "button", "bindings": [{ "key": "Enter" }] }
  },
  "widgets": {
    "button.primary": { "intents": ["confirm"], "module": "src/ui/button.ts" }
  },
  "scenes": {
    "main": {
      "module": "src/scenes/main.ts",
      "assets": ["bg_menu"],
      "widgets": ["button.primary"]
    }
  },
  "limits": { "maxModuleBytes": 262144 }
}
```

- `asset.type`: `image | audio | video | font | json`
- `intent.type`: `axis2 | button | pointer | text`
- `scene.assets` and `scene.widgets` list declared IDs.
- `widget.intents` lists declared intent IDs. Empty means decorative; AGF015
  warns but does not fail.

The schema is closed. Any field not listed above is AGF002.

### ID grammar

```
^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$
```

Valid: `main`, `button.primary`, `bg_menu_01`
Invalid: `Main`, `button-primary`, `Background Menu`

### Layout

```
manifest.json      contract, the only source of truth
AGF.md             this file: the project contract, version-controlled
.agf/log.md        round log written by `agf log`, git-ignored
assets/            asset files, flat unless a subfolder earns its keep
src/scenes/        one file per scene
src/ui/            one file per widget
src/systems/       cross-scene logic (physics, audio, save)
src/core/          runtime plumbing: loop, input adapter, asset loader
```

Do not create `utils/` or `helpers/`. A file that fits nowhere means a
responsibility has not been named yet.

### Module boundaries

- A scene file stays under roughly 80 lines of assembly.
- A widget owns one interaction surface. Split it if it handles more than one
  intent family.
- Input adapters live in `src/core/` and translate raw events into intents.
- Rendering goes through the chosen engine. No main loop in application code.

### Commands

```bash
agf check                      # whole project, error-first
agf check --json               # machine-readable diagnostics
agf inspect <kind> <id>        # definition + usedBy
agf add <kind> <id> [options]  # atomic append, never overwrites
agf stats                      # counts and largest module
agf audit                      # asset health and structural health
agf log --task "<what>"        # append one round to .agf/log.md
```

### Known gaps

List anything intentionally skipped, one line each. Delete the section if empty.

- (none)

### About the round log

The round log is not part of this file. `agf log` appends to `.agf/log.md`, which
is git-ignored so commits stay free of bookkeeping. `agf prompt local` joins the
two back together, contract first and log second.

Each entry records what changed, what the check measured, and what comes next, so
a compacted session can resume without rereading the diff. The newest 12 rounds
are kept; older ones fold into one omitted line.
