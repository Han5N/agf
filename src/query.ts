/**
 * Entity lookup.
 *
 * `inspect` exists because an agent must know who references an entity before
 * changing it. A definition without its referrers invites an edit that breaks
 * a caller the agent never saw.
 */
import { resolveRoot } from "./check.js";
import { loadManifest } from "./manifest.js";
import type { EntityKind, Manifest } from "./types.js";

export interface InspectResult {
  kind: EntityKind;
  id: string;
  found: boolean;
  /** The manifest entry, verbatim. Absent when not found. */
  definition?: unknown;
  /** IDs of entities that reference this one. */
  usedBy: string[];
  /** Extra context: entry status, or why the lookup failed. */
  note?: string;
}

export async function inspectEntity(kind: EntityKind, id: string, rootInput?: string): Promise<InspectResult> {
  const root = resolveRoot(rootInput);
  const loaded = await loadManifest(root);

  if (!loaded.manifest) {
    return {
      kind,
      id,
      found: false,
      usedBy: [],
      note: "manifest is unreadable or shape-invalid. Run agf check and fix that first.",
    };
  }

  const manifest = loaded.manifest;
  const found = lookup(manifest, kind, id);

  if (!found.found) {
    return { kind, id, found: false, usedBy: [], note: missingHint(manifest, kind, id) };
  }

  return {
    kind,
    id,
    found: true,
    definition: found.definition,
    usedBy: referrers(manifest, kind, id),
    note: noteFor(manifest, kind, id),
  };
}

function lookup(manifest: Manifest, kind: EntityKind, id: string): { found: boolean; definition?: unknown } {
  switch (kind) {
    case "asset":
      return { found: id in manifest.assets, definition: manifest.assets[id] };
    case "intent":
      return { found: id in manifest.intents, definition: manifest.intents[id] };
    case "widget":
      return { found: id in manifest.widgets, definition: manifest.widgets[id] };
    case "scene":
      return { found: id in manifest.scenes, definition: manifest.scenes[id] };
  }
}

function referrers(manifest: Manifest, kind: EntityKind, id: string): string[] {
  switch (kind) {
    case "asset":
      return Object.entries(manifest.scenes)
        .filter(([, scene]) => (scene.assets ?? []).includes(id))
        .map(([sceneId]) => `scene/${sceneId}`);
    case "widget":
      return Object.entries(manifest.scenes)
        .filter(([, scene]) => (scene.widgets ?? []).includes(id))
        .map(([sceneId]) => `scene/${sceneId}`);
    case "intent":
      return Object.entries(manifest.widgets)
        .filter(([, widget]) => widget.intents.includes(id))
        .map(([widgetId]) => `widget/${widgetId}`);
    case "scene":
      return manifest.entry === `scene/${id}` ? ["entry"] : [];
  }
}

function noteFor(manifest: Manifest, kind: EntityKind, id: string): string | undefined {
  if (kind === "scene" && manifest.entry === `scene/${id}`) {
    return "This is the entry scene.";
  }
  if (kind === "asset" && manifest.assets[id]?.src.startsWith("data:")) {
    return "This asset is still a data: URI and must be split into a standalone file.";
  }
  return undefined;
}

function missingHint(manifest: Manifest, kind: EntityKind, id: string): string {
  const matched = nearest(manifest, kind, id);
  const base = `No ${kind} named "${id}" is declared in the manifest`;
  return matched
    ? `${base}. The closest declared ID is "${matched}".`
    : `${base}. Declare it first with agf add ${kind} ${id}.`;
}

/** Nearest declared ID by Levenshtein distance, used to correct typos. */
function nearest(manifest: Manifest, kind: EntityKind, id: string): string | null {
  const pool = Object.keys(
    kind === "asset"
      ? manifest.assets
      : kind === "intent"
        ? manifest.intents
        : kind === "widget"
          ? manifest.widgets
          : manifest.scenes,
  );
  let best: { id: string; distance: number } | null = null;
  for (const candidate of pool) {
    const distance = levenshtein(id, candidate);
    if (best === null || distance < best.distance) best = { id: candidate, distance };
  }
  if (best === null) return null;
  return best.distance <= Math.max(2, Math.floor(id.length / 3)) ? best.id : null;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}
