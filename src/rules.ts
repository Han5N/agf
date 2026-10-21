/**
 * Semantic rules.
 *
 * The schema owns shape; this layer owns meaning: whether a reference resolves,
 * whether the file exists, whether assets were inlined back into a single blob,
 * whether one module has grown past the point of being maintainable.
 *
 * Every rule must ship an actionable fix. A rule that only reports a problem
 * without naming the next action forces the agent to guess, and guessing is how
 * regressions get introduced.
 */
import { readdir, stat } from "node:fs/promises";
import { join, normalize, isAbsolute } from "node:path";
import { CODES, diag, formatBytes } from "./diagnostics.js";
import { isValidId, parseEntry, pointerFor } from "./ids.js";
import { DEFAULT_MAX_MODULE_BYTES } from "./schema.js";
import { MANIFEST_FILE } from "./manifest.js";
import type { Diagnostic, EntityKind, Manifest } from "./types.js";

export interface RuleContext {
  root: string;
  manifest: Manifest;
  emit(d: Diagnostic): void;
  /** File size in bytes; null when the file is absent. Stats each path once. */
  sizeOf(rel: string): Promise<number | null>;
  /** Every file under assets/, relative to the project root, "/"-separated. */
  assetFiles(): Promise<string[]>;
}

export async function runRules(root: string, manifest: Manifest, emit: (d: Diagnostic) => void): Promise<void> {
  const sizeCache = new Map<string, Promise<number | null>>();
  let assetCache: Promise<string[]> | null = null;

  const ctx: RuleContext = {
    root,
    manifest,
    emit,
    sizeOf(rel) {
      const key = normalize(rel);
      let cached = sizeCache.get(key);
      if (!cached) {
        cached = stat(join(root, key))
          .then((s) => (s.isFile() ? s.size : null))
          .catch(() => null);
        sizeCache.set(key, cached);
      }
      return cached;
    },
    assetFiles() {
      if (!assetCache) assetCache = listFiles(join(root, "assets"));
      return assetCache;
    },
  };

  // Fixed order so diagnostics are stable: agents work top-down, and the order
  // is the priority list.
  await checkIds(ctx);
  await checkEntry(ctx);
  await checkReferences(ctx);
  await checkAssets(ctx);
  await checkModules(ctx);
  await checkClosure(ctx);
}

/** Recursively list files under dir, returning "/"-separated paths relative to dir. */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)).map((p) => `${entry.name}/${p}`));
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

function sections(manifest: Manifest): Array<{ name: EntityKind | "scene"; ids: string[]; pointer: (id: string) => string }> {
  return [
    { name: "asset", ids: Object.keys(manifest.assets), pointer: (id) => pointerFor("assets", id) },
    { name: "intent", ids: Object.keys(manifest.intents), pointer: (id) => pointerFor("intents", id) },
    { name: "widget", ids: Object.keys(manifest.widgets), pointer: (id) => pointerFor("widgets", id) },
    { name: "scene", ids: Object.keys(manifest.scenes), pointer: (id) => pointerFor("scenes", id) },
  ];
}

/** ID grammar. */
async function checkIds(ctx: RuleContext): Promise<void> {
  for (const section of sections(ctx.manifest)) {
    for (const id of section.ids) {
      if (!isValidId(id)) {
        ctx.emit(
          diag(
            CODES.ID_FORMAT,
            "error",
            MANIFEST_FILE,
            section.pointer(id),
            `${section.name} ID "${id}" violates the ID grammar`,
            `Rename it to "${suggestId(id)}": lowercase letters, digits and underscores, dot-separated segments.`,
          ),
        );
      }
    }
  }
}

function suggestId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(?=\d)/, "s_");
  return cleaned || "item";
}

/** Entry format and existence. */
async function checkEntry(ctx: RuleContext): Promise<void> {
  const { manifest } = ctx;
  const sceneId = parseEntry(manifest.entry);
  if (sceneId === null) {
    ctx.emit(
      diag(
        CODES.REF_MISSING,
        "error",
        MANIFEST_FILE,
        "/entry",
        `entry "${manifest.entry}" is not in scene/<id> form`,
        'Rewrite entry as "scene/<declared scene ID>", for example "scene/main".',
      ),
    );
    return;
  }
  if (!manifest.scenes[sceneId]) {
    ctx.emit(
      diag(
        CODES.REF_MISSING,
        "error",
        MANIFEST_FILE,
        "/entry",
        `entry points at undeclared scene "${sceneId}"`,
        `Declare "${sceneId}" under scenes, or point entry at an existing scene ID.`,
      ),
    );
  }
}

/** Every cross-entity reference resolves. */
async function checkReferences(ctx: RuleContext): Promise<void> {
  const { manifest } = ctx;

  for (const [sceneId, scene] of Object.entries(manifest.scenes)) {
    for (const [i, assetId] of (scene.assets ?? []).entries()) {
      if (!manifest.assets[assetId]) {
        ctx.emit(
          diag(
            CODES.REF_MISSING,
            "error",
            MANIFEST_FILE,
            `${pointerFor("scenes", sceneId)}/assets/${i}`,
            `scene "${sceneId}" references undeclared asset "${assetId}"`,
            `Declare "${assetId}" under assets, or remove it from scenes.${sceneId}.assets.`,
          ),
        );
      }
    }

    for (const [i, widgetId] of (scene.widgets ?? []).entries()) {
      if (!manifest.widgets[widgetId]) {
        ctx.emit(
          diag(
            CODES.REF_MISSING,
            "error",
            MANIFEST_FILE,
            `${pointerFor("scenes", sceneId)}/widgets/${i}`,
            `scene "${sceneId}" references undeclared widget "${widgetId}"`,
            `Declare "${widgetId}" under widgets, or remove it from scenes.${sceneId}.widgets.`,
          ),
        );
      }
    }
  }

  for (const [widgetId, widget] of Object.entries(manifest.widgets)) {
    for (const [i, intentId] of widget.intents.entries()) {
      if (!manifest.intents[intentId]) {
        ctx.emit(
          diag(
            CODES.REF_MISSING,
            "error",
            MANIFEST_FILE,
            `${pointerFor("widgets", widgetId)}/intents/${i}`,
            `widget "${widgetId}" consumes undeclared intent "${intentId}"`,
            `Declare "${intentId}" under intents, or remove it from widgets.${widgetId}.intents.`,
          ),
        );
      }
    }
  }
}

/** Asset declarations that cannot resolve on disk. */
async function checkAssets(ctx: RuleContext): Promise<void> {
  const { manifest } = ctx;

  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    const pointer = pointerFor("assets", assetId);

    if (asset.src.startsWith("data:")) {
      ctx.emit(
        diag(
          CODES.ASSET_INLINE_DATA,
          "error",
          MANIFEST_FILE,
          `${pointer}/src`,
          `asset "${assetId}" is inlined as a data: URI`,
          `Write the contents to a standalone file under assets/, then set src to that relative path, for example "assets/${assetId}.svg".`,
        ),
      );
      continue;
    }

    const normalized = normalize(asset.src).replace(/\\/g, "/");
    if (isAbsolute(asset.src) || normalized.startsWith("../") || normalized === "..") {
      ctx.emit(
        diag(
          CODES.ASSET_PATH_ESCAPE,
          "error",
          MANIFEST_FILE,
          `${pointer}/src`,
          `asset "${assetId}" resolves outside the project root`,
          `Use a path inside the project, for example "assets/${assetId}.svg".`,
        ),
      );
      continue;
    }

    if ((await ctx.sizeOf(normalized)) === null) {
      ctx.emit(
        diag(
          CODES.ASSET_FILE_MISSING,
          "error",
          MANIFEST_FILE,
          `${pointer}/src`,
          `asset "${assetId}" declares missing file "${normalized}"`,
          `Create ${normalized}, or set src to a file that exists.`,
        ),
      );
    }
  }
}

/** Module existence and size ceiling. */
async function checkModules(ctx: RuleContext): Promise<void> {
  const { manifest } = ctx;
  const limit = manifest.limits?.maxModuleBytes ?? DEFAULT_MAX_MODULE_BYTES;

  const seen = new Map<string, string>();
  for (const [sceneId, scene] of Object.entries(manifest.scenes)) {
    const key = scene.module.replace(/\\/g, "/");
    if (!seen.has(key)) seen.set(key, `scene "${sceneId}"`);
  }
  for (const [widgetId, widget] of Object.entries(manifest.widgets)) {
    const key = widget.module.replace(/\\/g, "/");
    if (!seen.has(key)) seen.set(key, `widget "${widgetId}"`);
  }

  for (const [module, owner] of seen) {
    const bytes = await ctx.sizeOf(module);
    if (bytes === null) {
      ctx.emit(
        diag(
          CODES.MODULE_FILE_MISSING,
          "error",
          MANIFEST_FILE,
          findModulePointer(manifest, module),
          `${owner} declares missing module "${module}"`,
          `Create ${module}, or point that module field at an existing file.`,
        ),
      );
      continue;
    }
    if (bytes > limit) {
      ctx.emit(
        diag(
          CODES.MODULE_TOO_LARGE,
          "error",
          module,
          "",
          `module "${module}" is ${formatBytes(bytes)}, over the ${formatBytes(limit)} limit`,
          `Split it by responsibility into smaller modules, then reference each one from the scene or widget that uses it. Do not raise the limit to make this pass.`,
        ),
      );
    }
  }
}

function findModulePointer(manifest: Manifest, module: string): string {
  for (const [id, scene] of Object.entries(manifest.scenes)) {
    if (scene.module === module) return `${pointerFor("scenes", id)}/module`;
  }
  for (const [id, widget] of Object.entries(manifest.widgets)) {
    if (widget.module === module) return `${pointerFor("widgets", id)}/module`;
  }
  return "";
}

/** Closure: nothing declared but unused, nothing used but undeclared. */
async function checkClosure(ctx: RuleContext): Promise<void> {
  const { manifest } = ctx;

  const usedAssets = new Set<string>();
  const usedWidgets = new Set<string>();
  const usedIntents = new Set<string>();

  for (const scene of Object.values(manifest.scenes)) {
    for (const id of scene.assets ?? []) usedAssets.add(id);
    for (const id of scene.widgets ?? []) usedWidgets.add(id);
  }
  for (const widgetId of usedWidgets) {
    for (const id of manifest.widgets[widgetId]?.intents ?? []) usedIntents.add(id);
  }

  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    if (!usedAssets.has(assetId)) {
      ctx.emit(
        diag(
          CODES.ASSET_ORPHAN,
          "warning",
          MANIFEST_FILE,
          pointerFor("assets", assetId),
          `asset "${assetId}" is declared but no scene references it`,
          `Add "${assetId}" to a scene's assets list, or delete the declaration (file: ${asset.src}).`,
        ),
      );
    }
  }

  for (const widgetId of Object.keys(manifest.widgets)) {
    if (!usedWidgets.has(widgetId)) {
      ctx.emit(
        diag(
          CODES.WIDGET_UNUSED,
          "warning",
          MANIFEST_FILE,
          pointerFor("widgets", widgetId),
          `widget "${widgetId}" is declared but no scene mounts it`,
          `Add "${widgetId}" to a scene's widgets list, or delete the declaration.`,
        ),
      );
    }
    if ((manifest.widgets[widgetId]?.intents ?? []).length === 0) {
      ctx.emit(
        diag(
          CODES.WIDGET_NO_INTENT,
          "warning",
          MANIFEST_FILE,
          `${pointerFor("widgets", widgetId)}/intents`,
          `widget "${widgetId}" consumes no intent`,
          `If it accepts input, list the intents it consumes. A purely decorative control may ignore this warning.`,
        ),
      );
    }
  }

  for (const intentId of Object.keys(manifest.intents)) {
    if (!usedIntents.has(intentId)) {
      ctx.emit(
        diag(
          CODES.INTENT_UNUSED,
          "warning",
          MANIFEST_FILE,
          pointerFor("intents", intentId),
          `intent "${intentId}" is declared but no widget consumes it`,
          `Have the widget that handles this interaction consume "${intentId}", or delete the declaration.`,
        ),
      );
    }
  }

  for (const [sceneId, scene] of Object.entries(manifest.scenes)) {
    if ((scene.assets ?? []).length === 0 && (scene.widgets ?? []).length === 0) {
      ctx.emit(
        diag(
          CODES.SCENE_UNREACHABLE,
          "warning",
          MANIFEST_FILE,
          pointerFor("scenes", sceneId),
          `scene "${sceneId}" references no asset and mounts no widget`,
          `Fill in its assets or widgets, or delete the scene if it is abandoned.`,
        ),
      );
    }
  }

  const declared = new Set(Object.values(manifest.assets).map((a) => normalize(a.src).replace(/\\/g, "/")));
  for (const file of await ctx.assetFiles()) {
    const rel = `assets/${file}`;
    if (!declared.has(rel)) {
      ctx.emit(
        diag(
          CODES.ASSET_UNDECLARED,
          "warning",
          rel,
          "",
          `file "${rel}" exists but is not declared in the manifest`,
          `Declare it under assets if it is used; delete the file if it is stale.`,
        ),
      );
    }
  }
}
