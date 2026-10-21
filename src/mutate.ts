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
import type { AssetType, CheckResult, EntityKind, IntentType, Manifest } from "./types.js";

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
