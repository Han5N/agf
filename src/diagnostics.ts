/**
 * Rule codes and diagnostic construction.
 *
 * Never renumber a released code: allowlists, CI ignore lists and historical
 * reports all reference codes. Append new codes; retire old ones by keeping the
 * number and ceasing to emit it.
 */
import type { Diagnostic, Severity } from "./types.js";

export const CODES = {
  /** manifest.json is unreadable or not valid JSON */
  MANIFEST_PARSE: "AGF001",
  /** manifest does not match the JSON Schema shape */
  MANIFEST_SHAPE: "AGF002",
  /** ID violates the naming grammar */
  ID_FORMAT: "AGF003",
  /** a reference points at an undeclared entity */
  REF_MISSING: "AGF004",
  /** an asset declaration points at a missing file */
  ASSET_FILE_MISSING: "AGF005",
  /** an asset is inlined as a data: URI */
  ASSET_INLINE_DATA: "AGF006",
  /** a module file is missing */
  MODULE_FILE_MISSING: "AGF007",
  /** a module exceeds the size ceiling */
  MODULE_TOO_LARGE: "AGF008",
  /** an asset is declared but no scene references it */
  ASSET_ORPHAN: "AGF009",
  /** an intent is declared but no widget consumes it */
  INTENT_UNUSED: "AGF010",
  /** a widget is declared but no scene mounts it */
  WIDGET_UNUSED: "AGF011",
  /** a scene references nothing and mounts nothing */
  SCENE_UNREACHABLE: "AGF012",
  /** a file exists under assets/ but is not declared */
  ASSET_UNDECLARED: "AGF013",
  /** an asset path escapes the project root */
  ASSET_PATH_ESCAPE: "AGF014",
  /** a widget declares no intent */
  WIDGET_NO_INTENT: "AGF015",
  /** prototype mode: the single file is large enough that splitting is due */
  PROTO_SIZE: "PRT001",
  /** prototype mode: assets are inlined into the file */
  PROTO_INLINE_ASSETS: "PRT002",
  /** prototype mode: no viewport meta, so phones render the desktop layout */
  PROTO_NO_VIEWPORT: "PRT003",
  /** prototype mode: no manifest and no HTML found */
  PROTO_NO_SOURCE: "PRT004",
} as const;

export type DiagnosticCode = (typeof CODES)[keyof typeof CODES];

export function diag(
  code: DiagnosticCode,
  severity: Severity,
  file: string,
  path: string,
  message: string,
  fix: string,
): Diagnostic {
  return { code, severity, file, path, message, fix };
}

/** Fold diagnostics into a readable block. Agents read JSON; humans read this. */
export function formatDiagnostics(diagnostics: Diagnostic[], colors: boolean): string {
  if (diagnostics.length === 0) {
    return colors ? "\u001b[32mNo issues found.\u001b[0m" : "No issues found.";
  }

  const lines: string[] = [];
  for (const d of diagnostics) {
    const label =
      d.severity === "error"
        ? colors
          ? "\u001b[31merror\u001b[0m"
          : "error"
        : colors
          ? "\u001b[33mwarn \u001b[0m"
          : "warn ";
    lines.push(`${label} ${d.code}  ${d.message}`);
    lines.push(d.path ? `       file: ${d.file}  path: ${d.path}` : `       file: ${d.file}`);
    lines.push(`       fix : ${d.fix}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Human-readable summary line. */
export function formatSummary(summary: {
  errors: number;
  warnings: number;
  scenes: number;
  assets: number;
  widgets: number;
  intents: number;
  modules: number;
  largestModule: { path: string; bytes: number } | null;
}): string {
  const size = summary.largestModule
    ? `${summary.largestModule.path} (${formatBytes(summary.largestModule.bytes)})`
    : "none";
  return [
    `${summary.errors} error / ${summary.warnings} warning`,
    `${summary.scenes} scene · ${summary.assets} asset · ${summary.widgets} widget · ${summary.intents} intent`,
    `${summary.modules} module · largest module ${size}`,
  ].join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
