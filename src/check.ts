/**
 * Check orchestration.
 *
 * Output order is fixed: errors first, warnings second, insertion order within a
 * severity. Agents work top-down, so the order is the priority list.
 */
import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import { loadManifest, MANIFEST_FILE } from "./manifest.js";
import { runRules } from "./rules.js";
import type { CheckResult, CheckSummary, Diagnostic, Manifest } from "./types.js";

export function resolveRoot(input?: string): string {
  return resolve(input ?? process.env.AGF_ROOT ?? process.cwd());
}

export async function checkProject(inputRoot?: string): Promise<CheckResult> {
  const root = resolveRoot(inputRoot);
  const loaded = await loadManifest(root);

  if (!loaded.manifest) {
    return {
      ok: false,
      manifestFile: join(root, MANIFEST_FILE),
      diagnostics: loaded.diagnostics,
      summary: emptySummary(),
    };
  }

  const diagnostics: Diagnostic[] = [...loaded.diagnostics];
  await runRules(root, loaded.manifest, (d) => diagnostics.push(d));

  const sorted = stableSort(diagnostics);
  const summary = withCounts(await summarize(root, loaded.manifest), sorted);
  return {
    ok: !sorted.some((d) => d.severity === "error"),
    manifestFile: join(root, MANIFEST_FILE),
    diagnostics: sorted,
    summary,
  };
}

function stableSort(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics
    .map((d, index) => ({ d, index }))
    .sort((a, b) => {
      const rank = (x: Diagnostic): number => (x.severity === "error" ? 0 : 1);
      const diff = rank(a.d) - rank(b.d);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((x) => x.d);
}

function emptySummary(): CheckSummary {
  return {
    errors: 0,
    warnings: 0,
    scenes: 0,
    assets: 0,
    widgets: 0,
    intents: 0,
    modules: 0,
    largestModule: null,
  };
}

export async function summarize(root: string, manifest: Manifest): Promise<CheckSummary> {
  const modules = new Set<string>();
  for (const scene of Object.values(manifest.scenes)) modules.add(scene.module);
  for (const widget of Object.values(manifest.widgets)) modules.add(widget.module);

  let largest: { path: string; bytes: number } | null = null;
  for (const module of modules) {
    const bytes = await stat(join(root, module))
      .then((s) => (s.isFile() ? s.size : 0))
      .catch(() => 0);
    if (bytes > 0 && (largest === null || bytes > largest.bytes)) {
      largest = { path: module, bytes };
    }
  }

  return {
    errors: 0,
    warnings: 0,
    scenes: Object.keys(manifest.scenes).length,
    assets: Object.keys(manifest.assets).length,
    widgets: Object.keys(manifest.widgets).length,
    intents: Object.keys(manifest.intents).length,
    modules: modules.size,
    largestModule: largest,
  };
}

/** Fold diagnostic counts into a summary. Kept separate so callers can reuse it. */
export function withCounts(summary: CheckSummary, diagnostics: Diagnostic[]): CheckSummary {
  return {
    ...summary,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };
}
