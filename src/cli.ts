#!/usr/bin/env node
/**
 * agf CLI — the single source of truth for Core.
 *
 * Constraint: every capability must be available here. MCP is only a wrapper.
 * A feature reachable only through MCP is a feature locked to MCP-capable agents.
 */
import { checkProject } from "./check.js";
import { formatDiagnostics, formatSummary } from "./diagnostics.js";
import { inspectEntity } from "./query.js";
import { addEntity } from "./mutate.js";
import { loadPrompt, type PromptSize } from "./prompt.js";
import { appendLog, initLocal } from "./local.js";
import { auditProject } from "./audit.js";
import { formatAudit } from "./audit-format.js";
import { applySetup, diagnose, planSetup, CLIENTS, type ClientId, type SetupPlan } from "./setup.js";
import type { AssetType, EntityKind, IntentType } from "./types.js";

const KINDS: readonly EntityKind[] = ["scene", "widget", "intent", "asset"];
const SIZES: readonly PromptSize[] = ["global", "local"];

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const json = flags.json === true;
  const rootFlag = typeof flags.root === "string" ? flags.root : undefined;

  // check / stats accept a positional root (agf check examples/minimal).
  // inspect / add / prompt require --root, or they would compete with IDs.
  switch (command) {
    case "check":
      return runCheck(rootFlag ?? positional[0], json);
    case "stats":
      return runStats(rootFlag ?? positional[0], json);
    case "audit":
      return runAudit(rootFlag ?? positional[0], json);
    case "inspect":
      return runInspect(positional, rootFlag ?? positional[2], json);
    case "add":
      return runAdd(positional, flags, rootFlag, json);
    case "prompt":
      return runPrompt(positional, rootFlag, json);
    case "init":
      return runInit(rootFlag ?? positional[0], json);
    case "log":
      return runLog(flags, rootFlag, json);
    case "setup":
      return runSetup(flags, json);
    case "doctor":
      return runDoctor(flags, json);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case undefined:
      printHelp();
      return 2;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n`);
      printHelp();
      return 2;
  }
}

async function runCheck(root: string | undefined, json: boolean): Promise<number> {
  const result = await checkProject(root);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDiagnostics(result.diagnostics, useColor())}\n\n${formatSummary(result.summary)}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runStats(root: string | undefined, json: boolean): Promise<number> {
  const result = await checkProject(root);

  // Without this, a wrong path reads as an empty project instead of an error.
  const fatal = result.diagnostics.filter((d) => d.code === "AGF001" || d.code === "AGF002");
  if (fatal.length > 0) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, diagnostics: fatal }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatDiagnostics(fatal, useColor())}\n`);
    }
    return 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, summary: result.summary }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(result.summary)}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runAudit(root: string | undefined, json: boolean): Promise<number> {
  const report = await auditProject(root);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAudit(report, useColor())}\n`);
  }
  // Audit never blocks on warnings; only a bad finding fails the run.
  return report.ok ? 0 : 1;
}

async function runInspect(positional: string[], root: string | undefined, json: boolean): Promise<number> {
  const [kindRaw, id] = positional;
  if (!kindRaw || !id) {
    process.stderr.write("Usage: agf inspect <scene|widget|intent|asset> <id> [root] [--json]\n");
    return 2;
  }
  const kind = parseKind(kindRaw);
  if (!kind) return 2;

  const result = await inspectEntity(kind, id, root);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${describeInspect(result)}\n`);
  }
  return result.found ? 0 : 1;
}

async function runAdd(
  positional: string[],
  flags: Record<string, string | true>,
  root: string | undefined,
  json: boolean,
): Promise<number> {
  const [kindRaw, id] = positional;
  if (!kindRaw || !id) {
    process.stderr.write("Usage: agf add <scene|widget|intent|asset> <id> --root <path> [options]\n");
    return 2;
  }
  const kind = parseKind(kindRaw);
  if (!kind) return 2;

  const result = await addEntity({
    kind,
    id,
    ...(root ? { root } : {}),
    ...(typeof flags["asset-type"] === "string" ? { assetType: flags["asset-type"] as AssetType } : {}),
    ...(typeof flags.src === "string" ? { src: flags.src } : {}),
    ...(typeof flags["intent-type"] === "string" ? { intentType: flags["intent-type"] as IntentType } : {}),
    ...(typeof flags.module === "string" ? { module: flags.module } : {}),
    ...(typeof flags.intents === "string" ? { intents: splitList(flags.intents) } : {}),
    ...(typeof flags.assets === "string" ? { assets: splitList(flags.assets) } : {}),
    ...(typeof flags.widgets === "string" ? { widgets: splitList(flags.widgets) } : {}),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
    if (result.check && result.check.diagnostics.length > 0) {
      process.stdout.write(`\n${formatDiagnostics(result.check.diagnostics, useColor())}\n`);
    }
  }
  return result.ok && (result.check?.ok ?? true) ? 0 : 1;
}

async function runSetup(
  flags: Record<string, string | true>,
  json: boolean,
): Promise<number> {
  const raw = typeof flags.client === "string" ? flags.client : undefined;
  if (!raw) {
    process.stderr.write(
      `Usage: agf setup --client <${CLIENTS.join("|")}> [--dry-run] [--yes]\n\n` +
        "Without --yes the command only prints the plan.\n",
    );
    return 2;
  }
  if (!(CLIENTS as string[]).includes(raw)) {
    process.stderr.write(`Unknown client "${raw}". Expected one of: ${CLIENTS.join(", ")}.\n`);
    return 2;
  }

  const plan = await planSetup(raw as ClientId);

  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPlan(plan)}\n`);
  }

  if (flags["dry-run"] === true || flags.yes !== true) {
    if (!json) process.stdout.write("\nDry run. Re-run with --yes to apply these changes.\n");
    return 0;
  }

  const result = await applySetup(plan);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${result.message}\n`);
    for (const path of result.applied) process.stdout.write(`  wrote ${path}\n`);
    for (const path of result.skipped) process.stdout.write(`  kept  ${path}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runDoctor(flags: Record<string, string | true>, json: boolean): Promise<number> {
  const raw = typeof flags.client === "string" ? flags.client : undefined;
  if (raw && !(CLIENTS as string[]).includes(raw)) {
    process.stderr.write(`Unknown client "${raw}". Expected one of: ${CLIENTS.join(", ")}.\n`);
    return 2;
  }

  const checks = await diagnose(raw as ClientId | undefined);

  if (json) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const label = check.ok ? (useColor() ? "\u001b[32mPASS\u001b[0m" : "PASS") : useColor() ? "\u001b[31mFAIL\u001b[0m" : "FAIL";
      process.stdout.write(`${label}  ${check.name.padEnd(16)} ${check.detail}\n`);
      if (check.fix) process.stdout.write(`      fix: ${check.fix}\n`);
    }
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function formatPlan(plan: SetupPlan): string {
  const lines = [`Client: ${plan.client}`];
  for (const change of plan.changes) {
    const action = change.action.padEnd(6);
    lines.push(`  ${action} ${change.path}`);
    lines.push(`         ${change.summary}`);
    if (change.backup) lines.push(`         backup: ${change.backup}`);
    if (change.preview && change.action !== "skip") {
      for (const line of change.preview.split("\n").slice(0, 12)) {
        lines.push(`         | ${line}`);
      }
    }
  }
  for (const warning of plan.warnings) {
    lines.push(`  warn   ${warning}`);
  }
  return lines.join("\n");
}

async function runPrompt(
  positional: string[],
  root: string | undefined,
  json: boolean,
): Promise<number> {
  const sizeRaw = positional[0];
  if (!sizeRaw || !(SIZES as readonly string[]).includes(sizeRaw)) {
    process.stderr.write("Usage: agf prompt <global|local> [--root <path>] [--json]\n");
    return 2;
  }

  const block = await loadPrompt(sizeRaw as PromptSize, root);
  if (json) {
    process.stdout.write(`${JSON.stringify(block, null, 2)}\n`);
  } else {
    process.stdout.write(`${block.text}\n`);
  }
  return 0;
}

async function runInit(root: string | undefined, json: boolean): Promise<number> {
  const result = await initLocal(root);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }
  return result.ok ? 0 : 1;
}

async function runLog(
  flags: Record<string, string | true>,
  root: string | undefined,
  json: boolean,
): Promise<number> {
  const task = typeof flags.task === "string" ? flags.task : undefined;
  if (!task) {
    process.stderr.write('Usage: agf log --task "<what this round did>" [--changed a,b] [--next "..."] [--ruling "..."]\n');
    return 2;
  }

  const result = await appendLog({
    ...(root ? { root } : {}),
    task,
    ...(typeof flags.changed === "string" ? { changed: splitList(flags.changed) } : {}),
    ...(typeof flags.next === "string" ? { next: flags.next } : {}),
    ...(typeof flags.ruling === "string" ? { ruling: flags.ruling } : {}),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
    if (result.entry) process.stdout.write(`\n${result.entry}\n`);
  }
  return result.ok ? 0 : 1;
}

function describeInspect(result: Awaited<ReturnType<typeof inspectEntity>>): string {
  if (!result.found) {
    return `${result.kind} "${result.id}" not found${result.note ? `\n${result.note}` : ""}`;
  }
  return [
    `${result.kind} "${result.id}"`,
    `Definition: ${JSON.stringify(result.definition, null, 2)}`,
    result.usedBy.length > 0 ? `Referenced by: ${result.usedBy.join(", ")}` : "Referenced by: none",
    result.note ? `Note: ${result.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseKind(raw: string): EntityKind | null {
  if ((KINDS as readonly string[]).includes(raw)) return raw as EntityKind;
  process.stderr.write(`Unknown entity kind "${raw}". Expected one of: ${KINDS.join(" | ")}.\n`);
  return null;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function printHelp(): void {
  process.stdout.write(
    [
      "agf — executable contract for AI-generated game projects.",
      "",
      "  agf check [root] [--json]          Validate the whole project.",
      "  agf stats [root] [--json]          Counts and largest module only.",
      "  agf audit [root] [--json]          Asset health and structural health.",
      "  agf inspect <kind> <id> [root]     Definition, usedBy, nearest match.",
      "  agf add <kind> <id> --root <p>     Append one entity atomically.",
      "  agf init [root]                    Create AGF.md from the template.",
      "  agf log --task \"<what>\"             Append one round to the AGF.md log.",
      "  agf prompt <global|local>          Print one prompt block.",
      "  agf setup --client <id> [--yes]    Register the MCP server and install the skill.",
      "  agf doctor [--client <id>]         Check installation and registration.",
      "",
      "  client: opencode | pi | claude-code",
      "",
      "  kind: scene | widget | intent | asset",
      "",
      "  add options:",
      "    --asset-type image|audio|video|font|json   required for asset",
      "    --src assets/x.svg                         required for asset",
      "    --intent-type axis2|button|pointer|text    required for intent",
      "    --module src/scenes/main.ts                required for scene / widget",
      "    --intents confirm,cancel                   optional for widget",
      "    --assets bg_menu                           optional for scene",
      "    --widgets hud,button.primary               optional for scene",
      "",
      "  log options:",
      "    --task \"<what this round did>\"            required",
      "    --changed a.ts,b.ts                       files or entity IDs touched",
      "    --next \"<next step>\"                      what the next round should do",
      "    --ruling \"<decision> — <why> — <cost>\"    a call you made alone",
      "",
      "  prompt: local prints the project AGF.md, or the template when absent.",
      "          There is no info size: tool output is the Info Block.",
      "",
      "  Exit codes: 0 no errors, 1 errors found, 2 usage error.",
      "  AGF_ROOT sets the default project root.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
