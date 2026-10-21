/**
 * Source scanning primitives shared by audit.
 *
 * Deliberately regex-based, not a parser. The goal is a structural smell
 * detector that runs in milliseconds on an AI-generated project, not a compiler.
 * Every result derived here is labelled heuristic in the report so nobody treats
 * it as a resolved reference graph.
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, normalize, relative, dirname, extname } from "node:path";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

export interface SourceFile {
  /** Project-relative path, "/"-separated. */
  path: string;
  text: string;
  lines: string[];
  bytes: number;
}

/** Recursively list project-relative source files under a directory. */
export async function listSources(root: string, dir = "src"): Promise<string[]> {
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
      if (entry.isDirectory()) {
        await walk(child);
      } else if (SOURCE_EXT.has(extname(entry.name))) {
        out.push(child);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

export async function readSource(root: string, rel: string): Promise<SourceFile | null> {
  const text = await readFile(join(root, rel), "utf8").catch(() => null);
  if (text === null) return null;
  return { path: rel, text, lines: text.split(/\r?\n/), bytes: Buffer.byteLength(text, "utf8") };
}

/**
 * Extract runtime module specifiers.
 *
 * Type-only imports are excluded on purpose: they are erased at compile time and
 * cannot create a dependency cycle. Treating them as edges would flag the
 * perfectly normal pattern of a widget importing a scene's context type.
 */
export function parseImports(text: string): string[] {
  const specs = new Set<string>();

  const add = (regex: RegExp): void => {
    for (const match of text.matchAll(regex)) {
      if (match[1]) specs.add(match[1]);
    }
  };

  // import X from "y" and import { a, b } from "y" — but not `import type`.
  add(/(?:^|\n)\s*import\s+(?!type\b)[^'"]*?\sfrom\s+["']([^"']+)["']/g);
  // bare side-effect import
  add(/(?:^|\n)\s*import\s+["']([^"']+)["']/g);
  // export { a } from "y" — but not `export type`.
  add(/(?:^|\n)\s*export\s+(?!type\b)[^'"]*?\sfrom\s+["']([^"']+)["']/g);
  // dynamic import and require
  add(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g);
  add(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g);

  return [...specs];
}

/** Resolve a relative specifier to a project-relative path, or null for packages. */
export function resolveSpecifier(fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(join(dirname(fromRel), specifier)).replace(/\\/g, "/");
  if (base.startsWith("..")) return null;
  // Strip a trailing .js so TypeScript-style specifiers map back to .ts sources.
  return base.replace(/\.(m?js|jsx|tsx)$/, (ext) => (ext === ".js" || ext === ".mjs" ? "" : ext));
}

/** sha256 of file bytes, used to spot byte-identical assets. */
export async function hashFile(root: string, rel: string): Promise<string | null> {
  const bytes = await readFile(join(root, rel)).catch(() => null);
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

/** Export names declared by a source file. Heuristic: static export statements only. */
export function parseExports(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/** Named symbols pulled in by static imports. Used to spot dead exports. */
export function parseImportedNames(text: string): string[] {
  const names: string[] = [];
  const re = /\bimport\s*\{([^}]*)\}\s*from/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Strip blank lines and whole-line comments so duplication ignores formatting noise. */
export function codeLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
}

export { relative };
