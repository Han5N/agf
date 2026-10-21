/**
 * MCP smoke test: drive the real stdio server with a real client.
 *
 * Verifies the tool list, a check round-trip, an inspect lookup, the Local
 * Project block, and a log append.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT = process.env.AGF_SMOKE_ROOT ?? "/root/agf/examples/minimal";

const transport = new StdioClientTransport({
  command: "node",
  args: ["/root/agf/dist/mcp.js"],
  cwd: "/root/agf",
  env: { ...process.env, AGF_ROOT: PROJECT },
  stderr: "pipe",
});

const client = new Client({ name: "agf-smoke", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);
console.log("connected");

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const check = await client.callTool({ name: "agf_check", arguments: {} });
console.log("agf_check ok:", check.isError !== true);
const parsed = JSON.parse(check.content[0].text);
console.log("errors:", parsed.summary.errors, "warnings:", parsed.summary.warnings);

const inspect = await client.callTool({ name: "agf_inspect", arguments: { kind: "widget", id: "hud" } });
const inspected = JSON.parse(inspect.content[0].text);
console.log("inspect hud usedBy:", JSON.stringify(inspected.usedBy));

const local = await client.callTool({ name: "agf_prompt", arguments: { size: "local" } });
console.log("prompt local source:", JSON.parse(local.structuredContent ? JSON.stringify(local.structuredContent) : local.content[0].text).source);

const audit = await client.callTool({ name: "agf_audit", arguments: {} });
const audited = JSON.parse(audit.content[0].text);
console.log("audit ok:", audit.isError !== true, "findings:", audited.findings.length, "metrics:", audited.metrics.length);

const logged = await client.callTool({
  name: "agf_log",
  arguments: { task: "mcp smoke round", changed: ["src/ui/hud.ts"], next: "none" },
});
console.log("agf_log ok:", logged.isError !== true);
console.log("entry:", JSON.parse(logged.content[0].text).entry.split("\n")[0]);

const resources = await client.listResources();
console.log("resources:", resources.resources.map((r) => r.uri).join(", "));

await client.close();
console.log("done");
