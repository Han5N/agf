/**
 * Single-file extraction planning.
 *
 * The reality this addresses: most models produce a working game far more
 * reliably as one HTML file than as fourteen coordinated modules. Splitting is a
 * refactor, and a refactor needs a runnable baseline plus a construction plan.
 *
 * This module produces the plan. It does not move code. Automatic splitting of a
 * closure-heavy single file cannot be made reliable by static analysis — one
 * misjudged boundary and the result does not run — so the output is a work order
 * for the model, ordered from low-coupling to high-coupling.
 */
import { readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";

// Kept local to avoid a cycle: check.ts imports this module.
function resolveRoot(input?: string): string {
  return resolve(input ?? process.env.AGF_ROOT ?? process.cwd());
}

export type Category = "input" | "loop" | "render" | "rules" | "ui" | "audio" | "storage" | "unknown";

export interface AssetHint {
  kind: "data-uri" | "inline-svg" | "external";
  mime?: string;
  bytes: number;
  suggestedPath: string;
  note: string;
}

export interface FunctionHint {
  name: string;
  line: number;
  category: Category;
  reason: string;
}

export interface StateHint {
  name: string;
  line: number;
}

export interface ListenerHint {
  event: string;
  count: number;
}

export interface ModuleHint {
  path: string;
  responsibility: string;
  symbols: string[];
}

export interface ExtractReport {
  source: string;
  bytes: number;
  lines: number;
  hasViewport: boolean;
  scripts: Array<{ inline: boolean; lines: number; src?: string }>;
  styles: Array<{ inline: boolean; lines: number; href?: string }>;
  assets: AssetHint[];
  functions: FunctionHint[];
  state: StateHint[];
  listeners: ListenerHint[];
  modules: ModuleHint[];
  order: string[];
  warnings: string[];
}

const MODULE_BY_CATEGORY: Record<Category, { path: string; responsibility: string }> = {
  input: { path: "src/core/input.js", responsibility: "translate key and touch events into intents" },
  loop: { path: "src/core/loop.js", responsibility: "frame timing and update/draw scheduling" },
  render: { path: "src/systems/renderer.js", responsibility: "draw state to the canvas" },
  rules: { path: "src/systems/rules.js", responsibility: "pure game rules and state transitions" },
  ui: { path: "src/ui/hud.js", responsibility: "DOM and HUD updates" },
  audio: { path: "src/systems/audio.js", responsibility: "sound synthesis" },
  storage: { path: "src/systems/save.js", responsibility: "persist and restore progress" },
  unknown: { path: "src/systems/game.js", responsibility: "unclassified logic; split further once a name exists" },
};

/** Low-coupling first. Each step can be verified before the next one starts. */
const ORDER = [
  "Extract assets into assets/ and replace every inline reference. Logic does not change; the page must still render.",
  "Move pure rule functions into src/systems/rules.js. No DOM, no canvas, no listeners.",
  "Move canvas drawing into src/systems/renderer.js, taking state as an argument.",
  "Move raw listeners into src/core/input.js and expose intents; nothing else may read key or touch events.",
  "Move DOM/HUD updates into src/ui/.",
  "Move audio and storage into src/systems/.",
  "Write manifest.json declaring the assets, intents, widgets and one scene, then run agf check.",
];

export async function extractProject(fileInput?: string, rootInput?: string): Promise<ExtractReport> {
  const root = resolveRoot(rootInput);
  const source = fileInput ?? (await findHtml(root));
  if (!source) throw new Error("No HTML file given and none found at the project root.");

  const { html, path } = await readHtml(root, source);

  const scripts = collectScripts(html);
  const styles = collectStyles(html);
  const assets = collectAssets(html);
  const inlineScript = scripts.map((script) => script.body ?? "").join("\n");

  const functions = collectFunctions(inlineScript);
  const state = collectState(inlineScript, functions);
  const listeners = collectListeners(inlineScript);
  const modules = groupModules(functions);
  const warnings = collectWarnings(html, scripts, assets, functions);

  return {
    source: path,
    bytes: Buffer.byteLength(html, "utf8"),
    lines: html.split(/\r?\n/).length,
    hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html),
    scripts: scripts.map((script) => ({
      inline: script.src === undefined,
      lines: (script.body ?? "").split(/\r?\n/).length,
      ...(script.src ? { src: script.src } : {}),
    })),
    styles,
    assets,
    functions,
    state,
    listeners,
    modules,
    order: ORDER,
    warnings,
  };
}

/* ------------------------------------------------------------------ parse */

interface RawScript {
  src?: string;
  body?: string;
}

function collectScripts(html: string): RawScript[] {
  const out: RawScript[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src) out.push({ src });
    else if (body.trim() !== "") out.push({ body });
  }
  return out;
}

function collectStyles(html: string): Array<{ inline: boolean; lines: number; href?: string }> {
  const out: Array<{ inline: boolean; lines: number; href?: string }> = [];
  const inline = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = inline.exec(html)) !== null) {
    out.push({ inline: true, lines: (match[1] ?? "").split(/\r?\n/).length });
  }
  const links = /<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = links.exec(html)) !== null) {
    const href = match[1] ?? "";
    if (/\.css(\?|$)/i.test(href)) out.push({ inline: false, lines: 0, href });
  }
  return out;
}

function collectAssets(html: string): AssetHint[] {
  const out: AssetHint[] = [];
  let index = 0;

  const dataUri = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = dataUri.exec(html)) !== null) {
    index += 1;
    const mime = match[1] ?? "application/octet-stream";
    const bytes = Math.floor(((match[2] ?? "").length * 3) / 4);
    out.push({
      kind: "data-uri",
      mime,
      bytes,
      suggestedPath: `assets/asset_${index}.${extensionFor(mime)}`,
      note: "inline base64; decode to a real file and replace the attribute with a relative path",
    });
  }

  const svg = /<svg\b[\s\S]*?<\/svg>/gi;
  while ((match = svg.exec(html)) !== null) {
    const text = match[0] ?? "";
    if (text.includes("width=\"0\"") && text.includes("height=\"0\"")) continue;
    index += 1;
    out.push({
      kind: "inline-svg",
      mime: "image/svg+xml",
      bytes: Buffer.byteLength(text, "utf8"),
      suggestedPath: `assets/asset_${index}.svg`,
      note: "inline SVG markup; move the element into its own .svg file",
    });
  }

  const external = /<(?:script|link|img)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  while ((match = external.exec(html)) !== null) {
    const url = match[1] ?? "";
    if (url.startsWith("data:")) continue;
    if (/^https?:\/\//i.test(url)) {
      out.push({
        kind: "external",
        bytes: 0,
        suggestedPath: url,
        note: "remote dependency; a mobile build should vendor it or remove it",
      });
    }
  }

  return out;
}

function extensionFor(mime: string): string {  if (mime.includes("svg")) return "svg";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("json")) return "json";
  if (mime.includes("audio")) return "mp3";
  return "bin";
}

/* ------------------------------------------------------------------ symbols */

interface RawFunction {
  name: string;
  start: number;
  body: string;
}

function collectFunctions(text: string): FunctionHint[] {
  const starts: Array<{ name: string; index: number }> = [];
  const re =
    /(?:^|\n)\s*(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1] ?? match[2];
    if (name) starts.push({ name, index: match.index });
  }

  const out: FunctionHint[] = [];
  for (let i = 0; i < starts.length; i++) {
    const current = starts[i];
    const next = starts[i + 1];
    if (!current) continue;
    const body = text.slice(current.index, next ? next.index : text.length);
    const verdict = classify(body);
    out.push({
      name: current.name,
      line: lineOf(text, current.index),
      category: verdict.category,
      reason: verdict.reason,
    });
  }
  return out;
}

function classify(body: string): { category: Category; reason: string } {
  if (/addEventListener\s*\(\s*["'](?:key|pointer|touch|mouse)/.test(body)) {
    return { category: "input", reason: "registers raw input listeners" };
  }
  if (body.includes("requestAnimationFrame") || body.includes("setInterval")) {
    return { category: "loop", reason: "drives a frame or interval loop" };
  }
  if (body.includes("getContext") || body.includes("ctx.") || body.includes("fillRect") || body.includes("drawImage")) {
    return { category: "render", reason: "draws through a canvas context" };
  }
  if (body.includes("AudioContext") || body.includes("OscillatorNode")) {
    return { category: "audio", reason: "creates audio nodes" };
  }
  if (body.includes("localStorage") || body.includes("sessionStorage")) {
    return { category: "storage", reason: "reads or writes storage" };
  }
  if (body.includes("querySelector") || body.includes("textContent") || body.includes("innerHTML") || body.includes("classList")) {
    return { category: "ui", reason: "mutates DOM nodes" };
  }
  // No DOM, canvas, audio or storage access: it is game logic, even when it
  // mutates module state rather than returning a value.
  return { category: "rules", reason: "no DOM, canvas, audio or storage access" };
}

function collectState(text: string, functions: FunctionHint[]): StateHint[] {
  const names = new Set(functions.map((fn) => fn.name));
  const declarations = [...text.matchAll(/^([ \t]*)(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((match) => ({
    indent: (match[1] ?? "").length,
    name: match[2] ?? "",
    index: match.index ?? 0,
  }));

  if (declarations.length === 0) return [];
  // Only the least-indented declarations are top level; the rest live inside
  // functions and are not state the scene owns.
  const baseIndent = Math.min(...declarations.map((item) => item.indent));

  return declarations
    .filter((item) => item.indent === baseIndent && item.name !== "" && !names.has(item.name))
    .map((item) => ({ name: item.name, line: lineOf(text, item.index) }));
}

function collectListeners(text: string): ListenerHint[] {
  const counts = new Map<string, number>();
  const re = /addEventListener\s*\(\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const event = match[1];
    if (!event) continue;
    counts.set(event, (counts.get(event) ?? 0) + 1);
  }
  return [...counts.entries()].map(([event, count]) => ({ event, count }));
}

function groupModules(functions: FunctionHint[]): ModuleHint[] {
  const groups = new Map<string, { symbols: string[]; responsibility: string; category: Category }>();

  for (const fn of functions) {
    const spec = MODULE_BY_CATEGORY[fn.category];
    const entry = groups.get(spec.path) ?? { symbols: [], responsibility: spec.responsibility, category: fn.category };
    entry.symbols.push(fn.name);
    groups.set(spec.path, entry);
  }

  return [...groups.entries()]
    .map(([path, entry]) => ({
      path,
      responsibility: entry.responsibility,
      symbols: entry.symbols.sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function collectWarnings(
  html: string,
  scripts: RawScript[],
  assets: AssetHint[],
  functions: FunctionHint[],
): string[] {
  const warnings: string[] = [];
  const lines = html.split(/\r?\n/).length;

  if (lines > 600) warnings.push(`the file is ${lines} lines; splitting is worth doing before the next feature`);
  if (!/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html)) {
    warnings.push("no viewport meta tag; the page will not scale correctly on a phone");
  }
  const inlineAssets = assets.filter((asset) => asset.kind !== "external");
  if (inlineAssets.length > 0) {
    warnings.push(`${inlineAssets.length} inline asset(s); every one of them blocks diffing and caching`);
  }
  const bigScript = scripts.find((script) => (script.body ?? "").split(/\r?\n/).length > 400);
  if (bigScript) warnings.push("one script block is over 400 lines; it holds more than one responsibility");
  if (functions.length > 25) warnings.push(`${functions.length} top-level functions; expect several modules, not one`);

  return warnings;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Resolve the file against the cwd first, then against the project root. */
async function readHtml(root: string, source: string): Promise<{ path: string; html: string }> {
  const candidates = isAbsolute(source) ? [source] : [resolve(source), join(root, source)];
  for (const candidate of candidates) {
    const html = await readFile(candidate, "utf8").catch(() => null);
    if (html !== null) return { path: candidate, html };
  }
  throw new Error(`Cannot read ${source}. Tried: ${candidates.join(", ")}`);
}

/** Prefer index.html, then the first HTML file at the root. */
export async function findHtml(root: string): Promise<string | null> {
  const direct = await readFile(join(root, "index.html"), "utf8").catch(() => null);
  if (direct !== null) return "index.html";

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".html")) return entry.name;
  }
  return null;
}

/* ----------------------------------------------------------------- render */

export function formatExtract(report: ExtractReport): string {
  const lines: string[] = [];
  lines.push(`# Extract plan: ${report.source}`);
  lines.push("");
  lines.push(
    `${report.lines} lines · ${report.bytes} bytes · ${report.scripts.length} script block(s) · ${report.styles.length} style block(s)`,
  );
  lines.push(`${report.functions.length} top-level functions · ${report.state.length} state bindings`);

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  if (report.assets.length > 0) {
    lines.push("");
    lines.push("## Assets");
    lines.push("| kind | bytes | suggested path | note |");
    lines.push("| --- | --- | --- | --- |");
    for (const asset of report.assets) {
      lines.push(`| ${asset.kind} | ${asset.bytes} | \`${asset.suggestedPath}\` | ${asset.note} |`);
    }
  }

  if (report.listeners.length > 0) {
    lines.push("");
    lines.push("## Raw listeners");
    for (const listener of report.listeners) lines.push(`- \`${listener.event}\` × ${listener.count}`);
    lines.push("");
    lines.push("These must end up behind intents; nothing outside `src/core/input.js` may keep them.");
  }

  if (report.modules.length > 0) {
    lines.push("");
    lines.push("## Suggested modules");
    lines.push("| path | responsibility | symbols |");
    lines.push("| --- | --- | --- |");
    for (const module of report.modules) {
      lines.push(`| \`${module.path}\` | ${module.responsibility} | ${module.symbols.join(", ")} |`);
    }
  }

  if (report.state.length > 0) {
    lines.push("");
    lines.push("## State");
    lines.push(report.state.map((item) => `\`${item.name}\``).join(", "));
    lines.push("");
    lines.push("State moves last: keep it in the scene and pass it in, instead of exporting a global.");
  }

  lines.push("");
  lines.push("## Order");
  report.order.forEach((step, index) => lines.push(`${index + 1}. ${step}`));

  lines.push("");
  lines.push("Do not split everything in one pass. One step, then `agf check`, then the next.");
  return lines.join("\n");
}
