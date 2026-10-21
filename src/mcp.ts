#!/usr/bin/env node
/**
 * MCP adapter.
 *
 * Wrapper only: no validation logic lives here. Everything delegates to
 * check / query / mutate / prompt / local, so swapping the agent protocol means
 * rewriting this file and nothing else.
 *
 * Under stdio transport, stdout is the protocol channel. Any diagnostic output
 * must go to stderr.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkProject, resolveRoot } from "./check.js";
import { inspectEntity } from "./query.js";
import { addEntities, type AddInput } from "./mutate.js";
import { loadPrompt } from "./prompt.js";
import { appendLog } from "./local.js";
import { initProject } from "./init.js";
import { auditProject } from "./audit.js";
import { extractProject, formatExtract } from "./extract.js";
import { MANIFEST_FILE } from "./manifest.js";

const INSTRUCTIONS = [
  "agf is an executable contract for AI-generated game projects.",
  "",
  "Load two blocks as files. Load the third by doing work — it has no file.",
  "- Global Environment: agf_prompt size=global, once per session. Tool guarantees and iron rules.",
  "- Local Project: agf_prompt size=local, once before the first edit and again after a context reset. It is the project's AGF.md joined with the round log from .agf/log.md, which agf_log writes and which stays out of version control.",
  "- Info Block: the return value of any tool call. Every diagnostic, every inspect result, every add response is one. Consume it where it arrives; do not ask for a summary of the same facts.",
  "",
  "Two stages, different rules:",
  "- prototype: no manifest, one HTML file. agf_check warns about size, inline assets and viewport, and never blocks. Do not add a manifest at this stage.",
  "- project: a manifest exists. The full rule set applies.",
  "The transition is agf_extract: it returns a split plan and never moves code. Split one step at a time, and run agf_check after each step.",
  "",
  "Work in this order:",
  "1. agf_check to establish the baseline. Fix existing errors before adding anything.",
  "2. agf_inspect before changing a declared entity; usedBy names every referrer to verify.",
  "3. agf_add to declare new assets, scenes, widgets or intents. Do not hand-write manifest.json.",
  "4. agf_audit when the round changed structure: it reports asset health and maintainability signals. It never blocks a round; a bad finding is a reason to refactor, not to stop.",
  "5. agf_log at the end of the round. It runs the check itself and records the measured result, so the log cannot claim a clean run that did not happen. One entry per round; never batch two rounds into one.",
  "6. agf_check again. Stop only when the error count is zero.",
  "",
  "The log is memory, not a report. After compaction or in a new session, read AGF.md before continuing work you did not start. Trust the log over your own recollection.",
  "",
  "Diagnostics are structured records. The fix field is the next action; do not invent an alternative repair. path is a JSON Pointer into manifest.json. Codes such as AGF004 are stable and must not be renamed or localized.",
  "",
  "Iron rules: never inline an asset as a data: URI; never exceed the module size ceiling; widgets consume intents and never read raw input events; scenes assemble and never hold drawing or business logic.",
].join("\n");

const server = new McpServer({ name: "agf", version: "0.1.0" }, { instructions: INSTRUCTIONS });

const ROOT = z.string().describe("Absolute project root path. Defaults to the server process working directory.");

server.registerTool(
  "agf_check",
  {
    title: "Validate the project",
    description:
      "Validate the bound project against every agf rule. Returns diagnostics sorted error-first, each carrying file, JSON Pointer path, message and an executable fix, plus structural counts. Reads files only and never writes.",
    inputSchema: { root: ROOT.optional() },
  },
  async ({ root }) => {
    const result = await checkProject(root);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

server.registerTool(
  "agf_inspect",
  {
    title: "Inspect one entity",
    description:
      "Return one entity's manifest definition, every referrer that lists it, and the nearest declared ID when the requested one is absent. Does not merge equally-close candidates and does not modify the manifest.",
    inputSchema: {
      kind: z.enum(["scene", "widget", "intent", "asset"]).describe("Entity kind."),
      id: z.string().describe('Declared entity ID, for example "main" or "button.primary".'),
      root: ROOT.optional(),
    },
  },
  async ({ kind, id, root }) => {
    const result = await inspectEntity(kind, id, root);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
      ...(result.found ? {} : { isError: true }),
    };
  },
);

server.registerTool(
  "agf_add",
  {
    title: "Declare manifest entities",
    description:
      "Declare one or many entities in a single call, rewrite manifest.json with section keys sorted, then check once. Prefer the entities array: fourteen separate calls cost fourteen round-trips. Existing IDs are skipped, never overwritten; the failed list names each skip.",
    inputSchema: {
      root: ROOT.optional(),
      entities: z
        .array(
          z.object({
            kind: z.enum(["scene", "widget", "intent", "asset"]),
            id: z.string(),
            assetType: z.enum(["image", "audio", "video", "font", "json"]).optional(),
            src: z.string().optional(),
            intentType: z.enum(["axis2", "button", "pointer", "text"]).optional(),
            module: z.string().optional(),
            intents: z.array(z.string()).optional(),
            assets: z.array(z.string()).optional(),
            widgets: z.array(z.string()).optional(),
            merge: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("Batch form. Each item uses the same fields as the single form."),
      kind: z.enum(["scene", "widget", "intent", "asset"]).optional().describe("Single form. Prefer entities for more than one."),
      id: z.string().optional().describe("Single form: new entity ID."),
      assetType: z.enum(["image", "audio", "video", "font", "json"]).optional().describe("Required when kind=asset."),
      src: z.string().optional().describe('Required when kind=asset. Project-relative path, for example "assets/bg_menu.svg".'),
      intentType: z.enum(["axis2", "button", "pointer", "text"]).optional().describe("Required when kind=intent."),
      module: z.string().optional().describe("Required when kind=scene or widget. Module path, for example src/scenes/main.ts."),
      intents: z.array(z.string()).optional().describe("When kind=widget: declared intent IDs this widget consumes."),
      assets: z.array(z.string()).optional().describe("When kind=scene: declared asset IDs this scene references."),
      widgets: z.array(z.string()).optional().describe("When kind=scene: declared widget IDs this scene mounts."),
    },
  },
  async (input) => {
    const list: AddInput[] =
      input.entities && input.entities.length > 0
        ? (input.entities as AddInput[])
        : input.kind && input.id
          ? [
              {
                kind: input.kind,
                id: input.id,
                ...(input.assetType ? { assetType: input.assetType } : {}),
                ...(input.src ? { src: input.src } : {}),
                ...(input.intentType ? { intentType: input.intentType } : {}),
                ...(input.module ? { module: input.module } : {}),
                ...(input.intents ? { intents: input.intents } : {}),
                ...(input.assets ? { assets: input.assets } : {}),
                ...(input.widgets ? { widgets: input.widgets } : {}),
              },
            ]
          : [];

    if (list.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, message: "Pass entities[], or kind plus id." }, null, 2),
          },
        ],
        isError: true,
      };
    }

    const result = await addEntities(input.root, list);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

server.registerTool(
  "agf_stats",
  {
    title: "Structural counts",
    description:
      "Return scene, asset, widget, intent and module counts plus the largest module path and size. Carries no diagnostics; use agf_check to learn why a count changed.",
    inputSchema: { root: ROOT.optional() },
  },
  async ({ root }) => {
    const result = await checkProject(root);
    const payload = { ok: result.ok, summary: result.summary };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  },
);

server.registerTool(
  "agf_audit",
  {
    title: "Audit asset and structural health",
    description:
      "Report asset health and maintainability signals: byte-identical assets, asset IDs used by code but absent from the manifest, dependency cycles, duplicated code blocks, orphan modules, average fan-out and the trend from the round log. Never blocks a round; produces per-metric grades with visible thresholds instead of a composite score.",
    inputSchema: { root: ROOT.optional() },
  },
  async ({ root }) => {
    const report = await auditProject(root);
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      structuredContent: report as unknown as Record<string, unknown>,
      ...(report.ok ? {} : { isError: true }),
    };
  },
);

server.registerTool(
  "agf_extract",
  {
    title: "Plan the split of a single-file game",
    description:
      "Analyse one HTML file and return a split plan: inline assets to externalise, top-level functions classified into input/loop/render/rules/ui/audio/storage, suggested module paths, and an order that goes from low to high coupling. Does not modify any file, and does not split automatically — a misjudged closure boundary produces code that does not run.",
    inputSchema: {
      file: z.string().optional().describe("HTML file, relative to root. Defaults to index.html."),
      root: ROOT.optional(),
    },
  },
  async ({ file, root }) => {
    try {
      const report = await extractProject(file, root);
      return {
        content: [{ type: "text", text: formatExtract(report) }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "agf_prompt",
  {
    title: "Load Global Environment or Local Project",
    description:
      "Return one of the two prompt files. global carries session rules and the tool contract. local returns the project's AGF.md, or the rendered template when it does not exist yet. There is no info size: tool return values are the Info Block.",
    inputSchema: {
      size: z.enum(["global", "local"]).describe("Block to load."),
      root: ROOT.optional(),
    },
  },
  async ({ size, root }) => {
    try {
      const block = await loadPrompt(size, root);
      return {
        content: [{ type: "text", text: block.text }],
        structuredContent: block as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, message }, null, 2) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "agf_init",
  {
    title: "Bootstrap the project",
    description:
      "Works in an empty directory. Creates manifest.json, a minimal scene module, AGF.md and the git-ignored .agf/ log, producing a project that already passes check. Existing files are never overwritten.",
    inputSchema: { root: ROOT.optional() },
  },
  async ({ root }) => {
    const result = await initProject(root);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

server.registerTool(
  "agf_log",
  {
    title: "Record one round in the project log",
    description:
      "Run the check, then prepend one entry to AGF.md's Log section with the measured result, the changed files and the next step. The check is performed here, not supplied by the caller, so the log cannot claim a clean run that did not happen. Keeps the newest 12 rounds; older rounds fold into a single omitted line.",
    inputSchema: {
      task: z.string().describe("One line: what this round did."),
      changed: z.array(z.string()).optional().describe("Files or entity IDs this round touched."),
      next: z.string().optional().describe("What the next round should do."),
      ruling: z.string().optional().describe("A decision you made alone, formatted as <decision> — <why> — <cost if wrong>."),
      root: ROOT.optional(),
    },
  },
  async ({ task, changed, next, ruling, root }) => {
    const result = await appendLog({
      ...(root ? { root } : {}),
      task,
      ...(changed ? { changed } : {}),
      ...(next ? { next } : {}),
      ...(ruling ? { ruling } : {}),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
      ...(result.ok ? {} : { isError: true }),
    };
  },
);

// Expose the manifest as a resource so agents read it directly instead of
// reconstructing the path themselves.
server.registerResource(
  "manifest",
  "agf://manifest",
  {
    title: "Current project manifest",
    description: "The manifest.json text from the bound project root.",
    mimeType: "application/json",
  },
  async (uri) => {
    const root = resolveRoot();
    const text = await readFile(join(root, MANIFEST_FILE), "utf8").catch(
      () => `// Cannot read ${join(root, MANIFEST_FILE)}`,
    );
    return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("agf MCP server listening on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`agf MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
