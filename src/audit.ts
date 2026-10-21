/**
 * Project audit: asset health and structural health.
 *
 * Deliberately separate from `check`. Check answers "does this project honour its
 * contract", is a closed rule set, and blocks completion. Audit answers "is this
 * project getting harder to maintain", is an open metric set, and never blocks.
 * Mixing them would make every refactor look like a defect.
 *
 * Metric selection follows the TIOBE maintainability model, which uses five
 * indicators and explicitly rejects raw size: cyclomatic complexity, compiler
 * warnings, standards compliance, duplication, and fan-out. Size shows up here as
 * a hard ceiling in `check`, not as a quality score.
 *
 * No composite score is produced. A single number invites optimising the number;
 * per-metric grades with visible thresholds do not.
 */
import { readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { resolveRoot } from "./check.js";
import { loadManifest } from "./manifest.js";
import { readLog } from "./local.js";
import {
  codeLines,
  hashFile,
  listSources,
  parseExports,
  parseImportedNames,
  parseImports,
  readSource,
  resolveSpecifier,
  type SourceFile,
} from "./scan.js";
import type { Manifest } from "./types.js";

export type Grade = "good" | "ok" | "bad";

export interface Metric {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** <= good is good, <= ok is ok, above is bad. null means no universal threshold. */
  good: number | null;
  ok: number | null;
  grade: Grade | null;
  note: string;
}

export interface AuditFinding {
  code: string;
  area: "asset" | "structure";
  level: "info" | "warn" | "bad";
  message: string;
  fix: string;
  detail?: string[];
}

export interface AssetAudit {
  declared: number;
  referenced: number;
  totalBytes: number;
  largest: { path: string; bytes: number } | null;
  duplicates: Array<{ hash: string; files: string[]; bytes: number }>;
  /** Asset IDs used by code strings but absent from the manifest. */
  undeclaredCodeRefs: Array<{ id: string; files: string[] }>;
  /** Declared assets no code string mentions. Heuristic. */
  unreferencedByCode: string[];
}

export interface StructureAudit {
  modules: number;
  sourceFiles: number;
  lines: number;
  averageFanOut: number;
  maxFanOut: { path: string; count: number } | null;
  cycles: string[][];
  duplicateBlocks: Array<{ files: string[]; lines: number; sample: string }>;
  orphanModules: string[];
  deadExports: Array<{ path: string; names: string[] }>;
}

export interface TrendPoint {
  at: string;
  task: string;
  errors: number;
  warnings: number;
}

export interface AuditReport {
  ok: boolean;
  root: string;
  metrics: Metric[];
  findings: AuditFinding[];
  assets: AssetAudit;
  structure: StructureAudit;
  trend: TrendPoint[];
}

const DUPLICATE_WINDOW = 6;

export async function auditProject(rootInput?: string): Promise<AuditReport> {
  const root = resolveRoot(rootInput);
  const loaded = await loadManifest(root);

  if (!loaded.manifest) {
    return {
      ok: false,
      root,
      metrics: [],
      findings: [
        {
          code: "AUD000",
          area: "structure",
          level: "bad",
          message: "manifest is unreadable or shape-invalid, so nothing can be audited",
          fix: "Run agf check and fix AGF001 / AGF002 first.",
        },
      ],
      assets: emptyAssets(),
      structure: emptyStructure(),
      trend: [],
    };
  }

  const manifest = loaded.manifest;
  const sources = await loadSources(root);
  const assetFiles = await listAssetFiles(root);

  const assets = await auditAssets(root, manifest, assetFiles, sources);
  const structure = auditStructure(manifest, sources, assetFiles);
  const trend = parseTrend(await readLog(root));

  const metrics = buildMetrics(assets, structure);
  const findings = [...assetFindings(assets), ...structureFindings(structure)];

  return {
    ok: !findings.some((f) => f.level === "bad"),
    root,
    metrics,
    findings,
    assets,
    structure,
    trend,
  };
}

/* ------------------------------------------------------------------ assets */

async function listAssetFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk("assets");
  return out.sort();
}

async function auditAssets(
  root: string,
  manifest: Manifest,
  assetFiles: string[],
  sources: SourceFile[],
): Promise<AssetAudit> {
  const declared = Object.keys(manifest.assets);
  const used = new Set<string>();
  for (const scene of Object.values(manifest.scenes)) {
    for (const id of scene.assets ?? []) used.add(id);
  }

  let totalBytes = 0;
  let largest: { path: string; bytes: number } | null = null;
  // Hash every file on disk, including undeclared ones. A duplicate hidden in an
  // undeclared file is exactly the copy that never gets updated.
  const hashes = new Map<string, { size: number; hash: string }>();

  for (const rel of assetFiles) {
    const info = await stat(join(root, rel)).catch(() => null);
    if (!info || !info.isFile()) continue;
    totalBytes += info.size;
    if (largest === null || info.size > largest.bytes) largest = { path: rel, bytes: info.size };
    const hash = await hashFile(root, rel);
    if (hash) hashes.set(rel, { size: info.size, hash });
  }

  const groups = new Map<string, { files: string[]; bytes: number }>();
  for (const [rel, { size, hash }] of hashes) {
    const entry = groups.get(hash) ?? { files: [], bytes: size };
    entry.files.push(rel);
    groups.set(hash, entry);
  }
  const duplicates = [...groups.entries()]
    .filter(([, group]) => group.files.length > 1)
    .map(([hash, group]) => ({ hash: hash.slice(0, 12), files: group.files, bytes: group.bytes }));

  const codeRefs = scanCodeAssetRefs(sources, new Set(declared), assetFiles);

  return {
    declared: declared.length,
    referenced: used.size,
    totalBytes,
    largest,
    duplicates,
    undeclaredCodeRefs: codeRefs.undeclared,
    unreferencedByCode: codeRefs.unreferenced,
  };
}

/**
 * Find asset IDs mentioned by code strings.
 *
 * This is the blind spot every naive asset audit has: a file loaded by a string
 * literal leaves no reference in the manifest. Unity tooling exists specifically
 * to close it. The pattern here covers the loader shapes this toolchain uses
 * plus a generic `loadAsset("...")` family, then falls back to matching asset
 * file stems. All results are heuristic; the report says so.
 */
function scanCodeAssetRefs(
  sources: SourceFile[],
  declared: Set<string>,
  assetFiles: string[],
): { undeclared: Array<{ id: string; files: string[] }>; unreferenced: string[] } {
  const callPattern =
    /\b(?:assets?\.(?:image|audio|video|font|json|sound|texture|load)|(?:load|get|use)(?:Asset|Image|Audio|Texture|Sound))\s*\(\s*["'`]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)["'`]/g;

  const mentions = new Map<string, Set<string>>();
  const record = (id: string, file: string): void => {
    const set = mentions.get(id) ?? new Set<string>();
    set.add(file);
    mentions.set(id, set);
  };

  // Stems of files that actually exist, so a string can be traced to a real file.
  const stems = new Set(assetFiles.map((file) => basename(file, extname(file))));

  for (const source of sources) {
    let match: RegExpExecArray | null;
    callPattern.lastIndex = 0;
    while ((match = callPattern.exec(source.text)) !== null) {
      if (match[1]) record(match[1], source.path);
    }
    // Fallback: a bare string equal to an existing asset stem.
    const literal = /["'`]([a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*)["'`]/g;
    while ((match = literal.exec(source.text)) !== null) {
      const id = match[1];
      if (id && stems.has(id)) record(id, source.path);
    }
  }

  const undeclared: Array<{ id: string; files: string[] }> = [];
  for (const [id, files] of mentions) {
    if (!declared.has(id)) undeclared.push({ id, files: [...files].sort() });
  }

  const unreferenced = [...declared].filter((id) => !mentions.has(id));
  return { undeclared, unreferenced };
}

/* --------------------------------------------------------------- structure */

async function loadSources(root: string): Promise<SourceFile[]> {
  const paths = await listSources(root);
  const out: SourceFile[] = [];
  for (const path of paths) {
    const source = await readSource(root, path);
    if (source) out.push(source);
  }
  return out;
}

function auditStructure(manifest: Manifest, sources: SourceFile[], assetFiles: string[]): StructureAudit {
  const graph = new Map<string, string[]>();
  const exported = new Map<string, string[]>();
  const importedNames = new Set<string>();

  // TypeScript-style specifiers point at "./x.js" while the file on disk is
  // "./x.ts". Map extension-less paths back to the real source.
  const byStem = new Map<string, string>();
  for (const source of sources) {
    byStem.set(source.path.replace(/\.[^./]+$/, ""), source.path);
  }

  for (const source of sources) {
    const specs = parseImports(source.text);
    const deps: string[] = [];
    for (const spec of specs) {
      const resolved = resolveSpecifier(source.path, spec);
      if (!resolved) continue;
      deps.push(byStem.get(resolved) ?? resolved);
    }
    graph.set(source.path, [...new Set(deps)]);
    exported.set(source.path, parseExports(source.text));
    for (const name of parseImportedNames(source.text)) importedNames.add(name);
  }

  const fanOuts = [...graph.entries()].map(([path, deps]) => ({ path, count: deps.length }));
  const averageFanOut =
    fanOuts.length === 0 ? 0 : fanOuts.reduce((sum, item) => sum + item.count, 0) / fanOuts.length;
  const maxFanOut = fanOuts.reduce<{ path: string; count: number } | null>(
    (best, item) => (best === null || item.count > best.count ? item : best),
    null,
  );

  const manifestModules = new Set<string>();
  for (const scene of Object.values(manifest.scenes)) manifestModules.add(scene.module.replace(/\\/g, "/"));
  for (const widget of Object.values(manifest.widgets)) manifestModules.add(widget.module.replace(/\\/g, "/"));

  const imported = new Set<string>();
  for (const deps of graph.values()) for (const dep of deps) imported.add(dep);

  const entryCandidates = new Set(["src/main.ts", "src/main.js", "src/index.ts", "src/index.js"]);
  const orphanModules = sources
    .map((s) => s.path)
    .filter(
      (path) =>
        !manifestModules.has(path) &&
        !imported.has(path) &&
        !entryCandidates.has(path) &&
        !path.includes(".test.") &&
        !assetFiles.includes(path),
    );

  const deadExports: Array<{ path: string; names: string[] }> = [];
  for (const source of sources) {
    if (manifestModules.has(source.path) || entryCandidates.has(source.path)) continue;
    const unused = (exported.get(source.path) ?? []).filter((name) => !importedNames.has(name));
    if (unused.length > 0) deadExports.push({ path: source.path, names: unused });
  }

  return {
    modules: manifestModules.size,
    sourceFiles: sources.length,
    lines: sources.reduce((sum, s) => sum + codeLines(s.lines).length, 0),
    averageFanOut: round(averageFanOut, 2),
    maxFanOut,
    cycles: findCycles(graph),
    duplicateBlocks: findDuplicateBlocks(sources),
    orphanModules,
    deadExports,
  };
}

/** Back-edge detection with an explicit path stack, so each cycle is reported once. */
function findCycles(graph: Map<string, string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const key = [...cycle].sort().join(">");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
  return cycles;
}

/** Windows of DUPLICATE_WINDOW code lines appearing in two or more files. */
function findDuplicateBlocks(sources: SourceFile[]): Array<{ files: string[]; lines: number; sample: string }> {
  const windows = new Map<string, { files: Set<string>; sample: string }>();

  for (const source of sources) {
    const lines = codeLines(source.lines);
    for (let i = 0; i + DUPLICATE_WINDOW <= lines.length; i++) {
      const window = lines.slice(i, i + DUPLICATE_WINDOW);
      const key = window.join("\n");
      const entry = windows.get(key) ?? { files: new Set<string>(), sample: window.slice(0, 2).join(" / ") };
      entry.files.add(source.path);
      windows.set(key, entry);
    }
  }

  const blocks = [...windows.values()].filter((entry) => entry.files.size > 1);
  // Adjacent windows describe the same duplicated region; keep one per file pair.
  const seen = new Set<string>();
  const out: Array<{ files: string[]; lines: number; sample: string }> = [];
  for (const block of blocks) {
    const files = [...block.files].sort();
    const key = files.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ files, lines: DUPLICATE_WINDOW, sample: block.sample });
  }
  return out.slice(0, 10);
}

/* ----------------------------------------------------------------- metrics */

function buildMetrics(assets: AssetAudit, structure: StructureAudit): Metric[] {
  const duplicateBytes = assets.duplicates.reduce((sum, group) => sum + group.bytes * (group.files.length - 1), 0);
  const duplicateRatio = assets.totalBytes === 0 ? 0 : round(duplicateBytes / assets.totalBytes, 3);

  return [
    {
      key: "assetBytes",
      label: "Total asset bytes",
      value: assets.totalBytes,
      unit: "bytes",
      good: null,
      ok: null,
      grade: null,
      note: "No universal budget. Compare against your own download target per round.",
    },
    {
      key: "duplicateAssetRatio",
      label: "Byte-identical asset share",
      value: duplicateRatio,
      unit: "ratio",
      good: 0,
      ok: 0.05,
      grade: grade(duplicateRatio, 0, 0.05),
      note: "Same bytes under two paths means two places to update and one to forget.",
    },
    {
      key: "averageFanOut",
      label: "Average fan-out per module",
      value: structure.averageFanOut,
      unit: "imports",
      good: 3.04,
      ok: 6.44,
      grade: grade(structure.averageFanOut, 3.04, 6.44),
      note: "TIOBE maintainability thresholds: A <= 3.04, B <= 6.44, C <= 10.29.",
    },
    {
      key: "cycles",
      label: "Dependency cycles",
      value: structure.cycles.length,
      unit: "cycles",
      good: 0,
      ok: 0,
      grade: grade(structure.cycles.length, 0, 0),
      note: "A cycle means neither module can be read or tested alone.",
    },
    {
      key: "duplicateBlocks",
      label: `Duplicated ${DUPLICATE_WINDOW}-line blocks`,
      value: structure.duplicateBlocks.length,
      unit: "blocks",
      good: 0,
      ok: 2,
      grade: grade(structure.duplicateBlocks.length, 0, 2),
      note: "Duplication is the metric most correlated with a fix landing in one copy only.",
    },
    {
      key: "orphanModules",
      label: "Orphan modules",
      value: structure.orphanModules.length,
      unit: "files",
      good: 0,
      ok: 0,
      grade: grade(structure.orphanModules.length, 0, 0),
      note: "Files neither declared in the manifest nor imported by anything.",
    },
    {
      key: "undeclaredCodeRefs",
      label: "Asset IDs used in code but undeclared",
      value: assets.undeclaredCodeRefs.length,
      unit: "ids",
      good: 0,
      ok: 0,
      grade: grade(assets.undeclaredCodeRefs.length, 0, 0),
      note: "Heuristic string scan. This is the blind spot a manifest-only audit cannot see.",
    },
  ];
}

function grade(value: number, good: number, ok: number): Grade {
  if (value <= good) return "good";
  if (value <= ok) return "ok";
  return "bad";
}

/* ---------------------------------------------------------------- findings */

function assetFindings(assets: AssetAudit): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const group of assets.duplicates) {
    findings.push({
      code: "AUD001",
      area: "asset",
      level: "bad",
      message: `${group.files.length} byte-identical assets (${group.bytes} bytes each)`,
      fix: "Keep one file and point every reference at it. Delete the rest.",
      detail: group.files,
    });
  }

  for (const ref of assets.undeclaredCodeRefs) {
    findings.push({
      code: "AUD002",
      area: "asset",
      level: "bad",
      message: `code uses asset ID "${ref.id}" which the manifest does not declare`,
      fix: `Declare "${ref.id}" under assets, or correct the string in the file that uses it.`,
      detail: ref.files,
    });
  }

  return findings;
}

function structureFindings(structure: StructureAudit): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const cycle of structure.cycles) {
    findings.push({
      code: "AUD005",
      area: "structure",
      level: "bad",
      message: `dependency cycle: ${cycle.join(" -> ")}`,
      fix: "Move the shared part into a module both sides can import, or invert one edge with a callback.",
    });
  }

  for (const block of structure.duplicateBlocks) {
    findings.push({
      code: "AUD006",
      area: "structure",
      level: "warn",
      message: `the same ${block.lines} code lines appear in ${block.files.length} files`,
      fix: "Extract the shared block into one module and import it from both places.",
      detail: [...block.files, `sample: ${block.sample}`],
    });
  }

  for (const path of structure.orphanModules) {
    findings.push({
      code: "AUD007",
      area: "structure",
      level: "bad",
      message: `"${path}" is neither declared in the manifest nor imported by anything`,
      fix: "Wire it into a scene or widget, or delete it.",
    });
  }

  for (const entry of structure.deadExports) {
    findings.push({
      code: "AUD008",
      area: "structure",
      level: "info",
      message: `"${entry.path}" exports names nothing imports`,
      fix: "Remove the exports, or wire them up. Heuristic: dynamic imports are not seen here.",
      detail: entry.names,
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ trend */

/** Read the round log's measured check lines, newest first. */
export function parseTrend(log: string): TrendPoint[] {
  const points: TrendPoint[] = [];
  const blocks = log.split(/^### /m).slice(1);
  for (const block of blocks) {
    const [firstLine = "", ...rest] = block.split("\n");
    const header = firstLine.match(/^(\S+)\s+—\s+(.*)$/);
    if (!header) continue;
    const checkLine = rest.find((line) => line.trimStart().startsWith("- check:"));
    const counts = checkLine?.match(/(\d+)\s+error\s*\/\s*(\d+)\s+warning/);
    if (!counts) continue;
    points.push({
      at: header[1] ?? "",
      task: (header[2] ?? "").trim(),
      errors: Number(counts[1] ?? 0),
      warnings: Number(counts[2] ?? 0),
    });
  }
  return points;
}

/* ------------------------------------------------------------------ helpers */

function emptyAssets(): AssetAudit {
  return {
    declared: 0,
    referenced: 0,
    totalBytes: 0,
    largest: null,
    duplicates: [],
    undeclaredCodeRefs: [],
    unreferencedByCode: [],
  };
}

function emptyStructure(): StructureAudit {
  return {
    modules: 0,
    sourceFiles: 0,
    lines: 0,
    averageFanOut: 0,
    maxFanOut: null,
    cycles: [],
    duplicateBlocks: [],
    orphanModules: [],
    deadExports: [],
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
