/**
 * Client setup: register the MCP server and install the skill.
 *
 * Mirrors the shape REA uses, because it is the shape that survives contact with
 * real users: plan first, show every path and backup, write only on --yes, and be
 * idempotent on a second run.
 *
 * Two facts drive the implementation:
 * - OpenCode and Pi both discover skills under ~/.agents/skills/, so the skill is
 *   installed once for all clients.
 * - Each client has its own MCP config file and format, so those are written
 *   separately.
 */
import { readFile, writeFile, mkdir, copyFile, cp, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type ClientId = "opencode" | "pi" | "claude-code";

export const CLIENTS: ClientId[] = ["opencode", "pi", "claude-code"];

/** Package root from both dist/ and src/. */
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MCP_ENTRY = join(PACKAGE_ROOT, "dist", "mcp.js");
const SKILL_SOURCE = join(PACKAGE_ROOT, "skills", "agf");

/** Cross-client skill location: OpenCode and Pi both read it. */
const SHARED_SKILL_DIR = join(homedir(), ".agents", "skills", "agf");

export interface SetupChange {
  /** Absolute path this change touches. */
  path: string;
  action: "create" | "update" | "copy" | "skip";
  /** One line describing the effect. */
  summary: string;
  /** Excerpt of what will be written, for the dry-run review. */
  preview?: string;
  /** Where the previous content is saved, when this is an update. */
  backup?: string;
}

export interface SetupPlan {
  client: ClientId;
  changes: SetupChange[];
  warnings: string[];
  /** MCP config file for the client, or null when the client needs another route. */
  mcpConfig: string | null;
}

export interface ApplyResult {
  ok: boolean;
  applied: string[];
  skipped: string[];
  message: string;
}

function skillInstalledAt(): string {
  return join(SHARED_SKILL_DIR, "SKILL.md");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function backupPath(path: string): string {
  return `${path}.bak-agf-${timestamp()}`;
}

/* ------------------------------------------------------------ opencode */

function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function opencodeEntry(): Record<string, unknown> {
  return { type: "local", command: ["node", MCP_ENTRY], enabled: true };
}

async function planOpencode(): Promise<SetupPlan> {
  const path = opencodeConfigPath();
  const warnings: string[] = [];
  const changes: SetupChange[] = [];

  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    const config = { $schema: "https://opencode.ai/config.json", mcp: { agf: opencodeEntry() } };
    changes.push({
      path,
      action: "create",
      summary: "create opencode.json with the agf local MCP server",
      preview: JSON.stringify(config, null, 2),
    });
    return { client: "opencode", changes, warnings, mcpConfig: path };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    warnings.push(
      `opencode.json is not plain JSON (${(error as Error).message}). It may be JSONC with comments; merge the entry by hand.`,
    );
    return { client: "opencode", changes, warnings, mcpConfig: path };
  }

  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  const existing = mcp.agf as Record<string, unknown> | undefined;
  if (existing && JSON.stringify(existing) === JSON.stringify(opencodeEntry())) {
    changes.push({
      path,
      action: "skip",
      summary: "mcp.agf already points at this installation",
      preview: JSON.stringify(existing),
    });
    return { client: "opencode", changes, warnings, mcpConfig: path };
  }

  mcp.agf = opencodeEntry();
  config.mcp = mcp;
  changes.push({
    path,
    action: "update",
    summary: existing ? "replace the existing mcp.agf entry" : "add mcp.agf",
    preview: JSON.stringify({ mcp: { agf: opencodeEntry() } }, null, 2),
    backup: backupPath(path),
  });
  return { client: "opencode", changes, warnings, mcpConfig: path };
}

async function applyOpencode(change: SetupChange): Promise<void> {
  if (change.action === "skip") return;
  const path = change.path;
  const raw = await readFile(path, "utf8").catch(() => null);
  const config = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  mcp.agf = opencodeEntry();
  config.mcp = mcp;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ pi */

function piConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "mcp.json");
}

function piEntry(): Record<string, unknown> {
  return {
    command: "node",
    args: [MCP_ENTRY],
    description: "Executable contract for AI-generated game projects: validate, audit and keep a round log.",
  };
}

async function planPi(): Promise<SetupPlan> {
  const path = piConfigPath();
  const warnings: string[] = [];
  const changes: SetupChange[] = [];

  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    const config = { mcpServers: { agf: piEntry() } };
    changes.push({
      path,
      action: "create",
      summary: "create Pi's mcp.json with the agf stdio server",
      preview: JSON.stringify(config, null, 2),
    });
    return { client: "pi", changes, warnings, mcpConfig: path };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    warnings.push(`Pi mcp.json is not valid JSON (${(error as Error).message}); merge the entry by hand.`);
    return { client: "pi", changes, warnings, mcpConfig: path };
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers.agf as Record<string, unknown> | undefined;
  if (existing && JSON.stringify(existing) === JSON.stringify(piEntry())) {
    changes.push({
      path,
      action: "skip",
      summary: "mcpServers.agf already points at this installation",
      preview: JSON.stringify(existing),
    });
    return { client: "pi", changes, warnings, mcpConfig: path };
  }

  servers.agf = piEntry();
  config.mcpServers = servers;
  changes.push({
    path,
    action: "update",
    summary: existing ? "replace the existing mcpServers.agf entry" : "add mcpServers.agf",
    preview: JSON.stringify({ mcpServers: { agf: piEntry() } }, null, 2),
    backup: backupPath(path),
  });
  return { client: "pi", changes, warnings, mcpConfig: path };
}

async function applyPi(change: SetupChange): Promise<void> {
  if (change.action === "skip") return;
  const path = change.path;
  const raw = await readFile(path, "utf8").catch(() => null);
  const config = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.agf = piEntry();
  config.mcpServers = servers;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/* ---------------------------------------------------------- claude code */

function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

async function planClaude(): Promise<SetupPlan> {
  const path = claudeConfigPath();
  const warnings: string[] = [];
  const changes: SetupChange[] = [];

  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    warnings.push(
      "No ~/.claude.json found. Run `claude mcp add agf -- node <install>/dist/mcp.js` inside Claude Code instead.",
    );
    return { client: "claude-code", changes, warnings, mcpConfig: null };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    warnings.push(`~/.claude.json is not valid JSON (${(error as Error).message}); register the server by hand.`);
    return { client: "claude-code", changes, warnings, mcpConfig: null };
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers.agf as Record<string, unknown> | undefined;
  const entry = { command: "node", args: [MCP_ENTRY] };

  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    changes.push({ path, action: "skip", summary: "mcpServers.agf already points at this installation" });
    return { client: "claude-code", changes, warnings, mcpConfig: path };
  }

  servers.agf = entry;
  config.mcpServers = servers;
  changes.push({
    path,
    action: "update",
    summary: existing ? "replace the existing mcpServers.agf entry" : "add mcpServers.agf",
    preview: JSON.stringify({ mcpServers: { agf: entry } }, null, 2),
    backup: backupPath(path),
  });
  return { client: "claude-code", changes, warnings, mcpConfig: path };
}

async function applyClaude(change: SetupChange): Promise<void> {
  if (change.action === "skip") return;
  const path = change.path;
  const raw = await readFile(path, "utf8").catch(() => null);
  const config = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.agf = { command: "node", args: [MCP_ENTRY] };
  config.mcpServers = servers;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/* ---------------------------------------------------------------- shared */

/** Plan the MCP entry plus the shared skill installation. */
export async function planSetup(client: ClientId): Promise<SetupPlan> {
  const base =
    client === "opencode" ? await planOpencode() : client === "pi" ? await planPi() : await planClaude();

  const skillExists = await exists(skillInstalledAt());
  base.changes.push({
    path: SHARED_SKILL_DIR,
    action: skillExists ? "update" : "copy",
    summary: skillExists
      ? "replace the installed skill with this version"
      : "install skills/agf into ~/.agents/skills so OpenCode and Pi both discover it",
    preview: "SKILL.md + references",
    ...(skillExists ? { backup: backupPath(SHARED_SKILL_DIR) } : {}),
  });

  if (!base.warnings.some((w) => w.includes("dist/mcp.js")) && !(await exists(MCP_ENTRY))) {
    base.warnings.push(`${MCP_ENTRY} does not exist. Run the build before registering the server.`);
  }

  return base;
}

export async function applySetup(plan: SetupPlan): Promise<ApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const change of plan.changes) {
    if (change.action === "skip") {
      skipped.push(change.path);
      continue;
    }

    if (change.backup) {
      if (change.path === SHARED_SKILL_DIR) {
        await cp(SHARED_SKILL_DIR, change.backup, { recursive: true }).catch(() => undefined);
      } else {
        await copyFile(change.path, change.backup).catch(() => undefined);
      }
    }

    if (change.path === SHARED_SKILL_DIR) {
      await rm(SHARED_SKILL_DIR, { recursive: true, force: true });
      await mkdir(dirname(SHARED_SKILL_DIR), { recursive: true });
      await cp(SKILL_SOURCE, SHARED_SKILL_DIR, { recursive: true });
      applied.push(change.path);
      continue;
    }

    if (plan.client === "opencode") await applyOpencode(change);
    else if (plan.client === "pi") await applyPi(change);
    else await applyClaude(change);
    applied.push(change.path);
  }

  return {
    ok: applied.length > 0,
    applied,
    skipped,
    message:
      applied.length === 0
        ? "Nothing to change; the configuration already matches this installation."
        : `Updated ${applied.length} path(s). Restart the client to pick up the new MCP server.`,
  };
}

/* ---------------------------------------------------------------- doctor */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function diagnose(client?: ClientId): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    name: "node",
    ok: major >= 20,
    detail: `Node ${process.versions.node}`,
    ...(major >= 20 ? {} : { fix: "Install Node.js 20 or newer." }),
  });

  const mcpExists = await exists(MCP_ENTRY);
  checks.push({
    name: "mcp entry",
    ok: mcpExists,
    detail: MCP_ENTRY,
    ...(mcpExists ? {} : { fix: "Run the install script again, or `npm run build` in the agf directory." }),
  });

  const skillExists = await exists(skillInstalledAt());
  checks.push({
    name: "skill",
    ok: skillExists,
    detail: skillInstalledAt(),
    ...(skillExists ? {} : { fix: "Run: agf setup --client <opencode|pi> --yes" }),
  });

  const targets: ClientId[] = client ? [client] : CLIENTS;
  for (const id of targets) {
    const path = id === "opencode" ? opencodeConfigPath() : id === "pi" ? piConfigPath() : claudeConfigPath();
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw === null) {
      checks.push({
        name: `${id} config`,
        ok: false,
        detail: `${path} not found`,
        fix: `Run: agf setup --client ${id} --yes`,
      });
      continue;
    }
    const registered = raw.includes("dist/mcp.js") && raw.includes("agf");
    checks.push({
      name: `${id} config`,
      ok: registered,
      detail: registered ? `${path} registers agf` : `${path} has no agf entry`,
      ...(registered ? {} : { fix: `Run: agf setup --client ${id} --yes` }),
    });
  }

  return checks;
}

export { MCP_ENTRY, SHARED_SKILL_DIR };
