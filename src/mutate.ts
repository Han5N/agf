/**
 * Manifest mutation.
 *
 * Exists so an agent can change one record in one tool call instead of
 * rewriting the entire JSON document. A full-document rewrite is the largest
 * single source of regression: it silently reformats and reorders everything.
 *
 * Writes sort the four sections by key, so a diff lands only on the lines that
 * actually changed.
 */
import { rename, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { checkProject, resolveRoot } from "./check.js";
import { loadManifest, MANIFEST_FILE } from "./manifest.js";
import { isValidId } from "./ids.js";
import type { AssetType, CheckResult, Diagnostic, EntityKind, IntentType, Manifest } from "./types.js";

export interface AddInput {
  kind: EntityKind;
  id: string;
  root?: string;
  /** Required when kind=asset. */
  assetType?: AssetType;
  /** Required when kind=asset. Project-relative path. */
  src?: string;
  /** Required when kind=intent. */
  intentType?: IntentType;
  /** Required when kind=scene or widget. Module path. */
  module?: string;
  /** Used when kind=widget. */
  intents?: string[];
  /** Used when kind=scene. */
  assets?: string[];
  /** Used when kind=scene. */
  widgets?: string[];
  /**
   * When true and the ID already exists, merge the supplied fields instead of
   * skipping: list fields are unioned, scalar fields are replaced. Off by
   * default, because silent overwrites are how declarations get lost.
   */
  merge?: boolean;
}

export interface AddResult {
  ok: boolean;
  message: string;
  check?: CheckResult;
}

export async function addEntity(input: AddInput): Promise<AddResult> {
  const root = resolveRoot(input.root);

  if (!isValidId(input.id)) {
    return {
      ok: false,
      message: `ID "${input.id}" violates the ID grammar: start with a lowercase letter, then only a-z 0-9 _ and dot-separated segments.`,
    };
  }

  const loaded = await loadManifest(root);
  if (!loaded.manifest) {
    return {
      ok: false,
      message: "manifest is unreadable or shape-invalid. Run agf check and fix the existing state before adding anything.",
    };
  }
  const manifest = loaded.manifest;

  if (exists(manifest, input.kind, input.id)) {
    return {
      ok: false,
      message: `${input.kind} "${input.id}" already exists. Edit its manifest fields directly; this tool never overwrites an existing entry.`,
    };
  }

  const built = buildEntry(input);
  if (!built.ok) return { ok: false, message: built.message };

  applyEntry(manifest, input.kind, input.id, built.value);
  await writeManifest(root, manifest);

  const check = await checkProject(root);
  return {
    ok: true,
    message: `Added ${input.kind} "${input.id}". Post-write check: ${check.summary.errors} error / ${check.summary.warnings} warning.`,
    check,
  };
}

export interface AddManyResult {
  ok: boolean;
  /** "scene/main" style entries that were written. */
  added: string[];
  /** Entries that existed and were merged because merge was set. */
  updated: string[];
  failed: Array<{ id: string; message: string }>;
  errors: number;
  warnings: number;
  /** Error-level diagnostics only, capped. Full detail comes from agf_check. */
  diagnostics: Diagnostic[];
  message: string;
}

/**
 * Declare several entities in one call.
 *
 * Fourteen separate `agf add` calls means fourteen model round-trips and
 * fourteen full checks. This writes them in one pass and checks once.
 *
 * Partial success is deliberate: one bad entry does not discard the other
 * thirteen, and `failed` names exactly what was skipped.
 */
export async function addEntities(
  rootInput: string | undefined,
  inputs: AddInput[],
): Promise<AddManyResult> {
  const root = resolveRoot(rootInput);
  const loaded = await loadManifest(root);

  if (!loaded.manifest) {
    return {
      ok: false,
      added: [],
      updated: [],
      failed: [{ id: "-", message: "manifest is unreadable or shape-invalid; run agf check first" }],
      errors: 0,
      warnings: 0,
      diagnostics: [],
      message: "Cannot add entities: no readable manifest.",
    };
  }

  const manifest = loaded.manifest;
  const added: string[] = [];
  const updated: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];

  for (const input of inputs) {
    if (!isValidId(input.id)) {
      failed.push({
        id: `${input.kind}/${input.id}`,
        message: `ID "${input.id}" violates the grammar: lowercase, a-z 0-9 _, dot-separated.`,
      });
      continue;
    }
    if (exists(manifest, input.kind, input.id)) {
      if (input.merge) {
        mergeEntry(manifest, input);
        updated.push(`${input.kind}/${input.id}`);
      } else {
        failed.push({ id: `${input.kind}/${input.id}`, message: "already declared; pass merge to update it" });
      }
      continue;
    }
    const built = buildEntry(input);
    if (!built.ok) {
      failed.push({ id: `${input.kind}/${input.id}`, message: built.message });
      continue;
    }
    applyEntry(manifest, input.kind, input.id, built.value);
    added.push(`${input.kind}/${input.id}`);
  }

  if (added.length > 0 || updated.length > 0) await writeManifest(root, manifest);

  const check = await checkProject(root);
  const errors = check.diagnostics.filter((d) => d.severity === "error").slice(0, 20);

  return {
    ok: failed.length === 0 && check.summary.errors === 0,
    added,
    updated,
    failed,
    errors: check.summary.errors,
    warnings: check.summary.warnings,
    diagnostics: errors,
    message: `${updated.length > 0 ? `Added ${added.length}, updated ${updated.length}` : `Added ${added.length}`}, skipped ${failed.length}. Check: ${check.summary.errors} error / ${check.summary.warnings} warning.`,
  };
}

/** Union list fields, replace scalar fields. Only the supplied fields move. */
function mergeEntry(manifest: Manifest, input: AddInput): void {
  switch (input.kind) {
    case "scene": {
      const scene = manifest.scenes[input.id];
      if (!scene) return;
      if (input.module) scene.module = input.module;
      if (input.assets) scene.assets = union(scene.assets, input.assets);
      if (input.widgets) scene.widgets = union(scene.widgets, input.widgets);
      return;
    }
    case "widget": {
      const widget = manifest.widgets[input.id];
      if (!widget) return;
      if (input.module) widget.module = input.module;
      if (input.intents) widget.intents = union(widget.intents, input.intents);
      return;
    }
    case "asset":
      if (input.assetType && input.src) {
        manifest.assets[input.id] = { type: input.assetType, src: input.src };
      }
      return;
    case "intent":
      if (input.intentType) {
        manifest.intents[input.id] = { type: input.intentType, bindings: [] };
      }
      return;
  }
}

function union(base: string[] | undefined, extra: string[]): string[] {
  return [...new Set([...(base ?? []), ...extra])];
}

function exists(manifest: Manifest, kind: EntityKind, id: string): boolean {
  switch (kind) {
    case "asset":
      return id in manifest.assets;
    case "intent":
      return id in manifest.intents;
    case "widget":
      return id in manifest.widgets;
    case "scene":
      return id in manifest.scenes;
  }
}

type BuildResult = { ok: true; value: unknown } | { ok: false; message: string };

function buildEntry(input: AddInput): BuildResult {
  switch (input.kind) {
    case "asset":
      if (!input.assetType) {
        return { ok: false, message: "Adding an asset requires assetType: image | audio | video | font | json." };
      }
      if (!input.src) {
        return { ok: false, message: `Adding an asset requires src, for example "assets/${input.id}.svg".` };
      }
      return { ok: true, value: { type: input.assetType, src: input.src } };

    case "intent":
      if (!input.intentType) {
        return { ok: false, message: "Adding an intent requires intentType: axis2 | button | pointer | text." };
      }
      return { ok: true, value: { type: input.intentType, bindings: [] } };

    case "widget":
      if (!input.module) {
        return { ok: false, message: `Adding a widget requires module, for example "src/ui/${input.id.replace(/\./g, "_")}.ts".` };
      }
      return { ok: true, value: { intents: input.intents ?? [], module: input.module } };

    case "scene":
      if (!input.module) {
        return { ok: false, message: `Adding a scene requires module, for example "src/scenes/${input.id}.ts".` };
      }
      return {
        ok: true,
        value: {
          module: input.module,
          ...(input.assets ? { assets: input.assets } : {}),
          ...(input.widgets ? { widgets: input.widgets } : {}),
        },
      };
  }
}

function applyEntry(manifest: Manifest, kind: EntityKind, id: string, value: unknown): void {
  switch (kind) {
    case "asset":
      manifest.assets[id] = value as Manifest["assets"][string];
      break;
    case "intent":
      manifest.intents[id] = value as Manifest["intents"][string];
      break;
    case "widget":
      manifest.widgets[id] = value as Manifest["widgets"][string];
      break;
    case "scene":
      manifest.scenes[id] = value as Manifest["scenes"][string];
      break;
  }
}

/** Stable serialization: keys sorted per section, two-space indent, trailing newline. */
export function serializeManifest(manifest: Manifest): string {
  const sorted: Manifest = {
    ...manifest,
    assets: sortKeys(manifest.assets),
    intents: sortKeys(manifest.intents),
    widgets: sortKeys(manifest.widgets),
    scenes: sortKeys(manifest.scenes),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const target = join(root, MANIFEST_FILE);
  const temp = join(dirname(target), `.${MANIFEST_FILE}.tmp`);
  await writeFile(temp, serializeManifest(manifest), "utf8");
  // A same-directory rename is atomic on POSIX, so an interrupted write cannot
  // leave a half-written manifest behind.
  await rename(temp, target);
}
