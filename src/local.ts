/**
 * Local Project: two files with different lives.
 *
 * `AGF.md` is the contract. Humans write it, it belongs in version control, and
 * it changes when the project changes shape.
 *
 * `.agf/log.md` is the round log. `agf log` writes it, the agent reads it, and it
 * is git-ignored — a ledger that dirties every commit is a ledger people stop
 * reading. `.agf/` ignores itself through its own `.gitignore`, so no project
 * root file has to be edited.
 *
 * `agf prompt local` returns both, joined, because together they are one block.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProject, resolveRoot } from "./check.js";
import { loadManifest } from "./manifest.js";
import type { CheckResult, Manifest } from "./types.js";

export const AGF_FILE = "AGF.md";
export const LOG_DIR = ".agf";
export const LOG_FILE = ".agf/log.md";

/** Rounds kept in the log before older ones are folded away. */
export const LOG_KEEP = 12;

const TEMPLATE = fileURLToPath(new URL("../prompts/local.md", import.meta.url));

export interface LocalInitResult {
  ok: boolean;
  message: string;
  contractPath: string;
  logPath: string;
}

export interface LogInput {
  root?: string;
  /** What this round did, one line. */
  task: string;
  /** Files or entity IDs touched. */
  changed?: string[];
  /** What the next round should do. */
  next?: string;
  /**
   * A decision made without asking, with its cost if wrong. Recorded so a later
   * session can see why the code looks the way it does.
   */
  ruling?: string;
}

export interface LogResult {
  ok: boolean;
  message: string;
  path: string;
  entry?: string;
  check?: CheckResult;
}

/** Read the shipped contract template. */
export async function readTemplate(): Promise<string> {
  return readFile(TEMPLATE, "utf8");
}

export async function renderLocal(manifest: Manifest): Promise<string> {
  const template = await readTemplate();
  return template
    .replaceAll("{{NAME}}", manifest.name)
    .replaceAll("{{ENTRY}}", manifest.entry)
    .replaceAll("{{ENGINE}}", "pixi")
    .replaceAll("{{TARGET}}", "desktop")
    .replaceAll("{{ART}}", "unspecified");
}

/** Read the project's AGF.md, or null when it does not exist yet. */
export async function readLocal(rootInput?: string): Promise<string | null> {
  const root = resolveRoot(rootInput);
  return readFile(join(root, AGF_FILE), "utf8").catch(() => null);
}

/** Read the round log, or an empty string when no round has been recorded. */
export async function readLog(rootInput?: string): Promise<string> {
  const root = resolveRoot(rootInput);
  return readFile(join(root, LOG_FILE), "utf8").catch(() => "");
}

/**
 * Create AGF.md and the git-ignored log directory.
 * Never overwrites an existing contract.
 */
export async function initLocal(rootInput?: string): Promise<LocalInitResult> {
  const root = resolveRoot(rootInput);
  const contractPath = join(root, AGF_FILE);
  const logPath = join(root, LOG_FILE);

  const existing = await readFile(contractPath, "utf8").catch(() => null);
  if (existing !== null) {
    return {
      ok: false,
      message: `${AGF_FILE} already exists. Edit it directly; this command never overwrites.`,
      contractPath,
      logPath,
    };
  }

  const loaded = await loadManifest(root);
  if (!loaded.manifest) {
    return {
      ok: false,
      message: "manifest is unreadable or shape-invalid. Run agf check before agf init.",
      contractPath,
      logPath,
    };
  }

  await mkdir(dirname(contractPath), { recursive: true });
  await writeFile(contractPath, await renderLocal(loaded.manifest), "utf8");

  await mkdir(join(root, LOG_DIR), { recursive: true });
  // A directory that ignores itself needs no entry in the project's .gitignore.
  await writeFile(join(root, LOG_DIR, ".gitignore"), "*\n", "utf8");
  const log = await readFile(logPath, "utf8").catch(() => null);
  if (log === null) await writeFile(logPath, "", "utf8");

  return {
    ok: true,
    message: `Created ${AGF_FILE} and ${LOG_FILE} (git-ignored). Fill in engine, target and art direction under ## Contract.`,
    contractPath,
    logPath,
  };
}

/**
 * Append one round to the log.
 *
 * The check result is measured here and written into the entry, so a log can
 * never claim a clean run that did not happen.
 */
export async function appendLog(input: LogInput): Promise<LogResult> {
  const root = resolveRoot(input.root);
  const path = join(root, LOG_FILE);

  const check = await checkProject(root);
  if (check.diagnostics.some((d) => d.code === "AGF001")) {
    return {
      ok: false,
      message: "manifest is unreadable, so this round has no evidence to record. Fix AGF001 first.",
      path,
    };
  }

  const entry = formatEntry(input, check);
  await mkdir(join(root, LOG_DIR), { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => "");
  await writeFile(path, insertEntry(existing, entry), "utf8");

  return {
    ok: true,
    message: `Logged this round. Check at write time: ${check.summary.errors} error / ${check.summary.warnings} warning.`,
    path,
    entry,
    check,
  };
}

export function formatEntry(input: LogInput, check: CheckResult): string {
  const codes = uniqueCodes(check);
  const checkLine = `${check.summary.errors} error / ${check.summary.warnings} warning${codes ? ` (${codes})` : ""}`;
  const changed = input.changed && input.changed.length > 0 ? input.changed.join(", ") : "none";

  const lines = [
    `### ${new Date().toISOString()} — ${oneLine(input.task)}`,
    `- changed: ${oneLine(changed)}`,
    `- check: ${checkLine}`,
    `- next: ${oneLine(input.next ?? "none")}`,
  ];
  if (input.ruling) {
    lines.push(`- ruling: ${oneLine(input.ruling)}`);
  }
  return lines.join("\n");
}

/** Prepend the entry to a log file body, then fold rounds beyond LOG_KEEP. */
export function insertEntry(body: string, entry: string): string {
  const trimmed = body.trimStart();
  const merged = trimmed === "" ? `${entry}\n` : `${entry}\n\n${trimmed}`;
  return trimLog(merged);
}

/** Keep the newest LOG_KEEP entries; note the omission once. */
export function trimLog(body: string): string {
  const starts: number[] = [];
  const re = /^### /gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    starts.push(match.index);
  }
  if (starts.length <= LOG_KEEP) return body;

  const kept = body.slice(0, starts[LOG_KEEP]);
  const omitted = starts.length - LOG_KEEP;
  const note = `_${omitted} older round${omitted === 1 ? "" : "s"} omitted._`;
  // Drop any previous note first, so repeated trims do not stack stale counts.
  const cleaned = kept.replace(/\n*_\d+ older rounds? omitted\._\n*/g, "\n").trimEnd();
  return `${cleaned}\n\n${note}\n`;
}

/** Compose the Local Project block: contract first, then the log. */
export async function composeLocal(rootInput?: string): Promise<{ text: string; hasLog: boolean } | null> {
  const root = resolveRoot(rootInput);
  const contract = await readLocal(root);
  if (contract === null) return null;

  const log = (await readLog(root)).trim();
  if (log === "") {
    return { text: `${contract.trimEnd()}\n\n## Round Log\n\n(no rounds recorded yet)\n`, hasLog: false };
  }
  return { text: `${contract.trimEnd()}\n\n## Round Log\n\n${log}\n`, hasLog: true };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueCodes(check: CheckResult): string {
  return [...new Set(check.diagnostics.map((d) => d.code))].slice(0, 6).join(", ");
}
