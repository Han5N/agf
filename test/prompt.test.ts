/**
 * Prompt and ledger tests.
 *
 * Two prompt files: global (shipped) and local (the project's AGF.md joined with
 * its git-ignored round log). The Info Block has no file, so there is nothing
 * here to test for it beyond the absence of an info size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompt } from "../src/prompt.js";
import {
  appendLog,
  composeLocal,
  initLocal,
  insertEntry,
  trimLog,
  LOG_KEEP,
  AGF_FILE,
  LOG_FILE,
} from "../src/local.js";

const ROOT = join(import.meta.dirname, "..");
const CJK = /[\u4e00-\u9fff]/;

const MANIFEST = {
  schemaVersion: 1,
  name: "ledger-case",
  entry: "scene/main",
  assets: {},
  intents: {},
  widgets: {},
  scenes: { main: { module: "src/main.ts" } },
};

async function makeProject(manifest: unknown = MANIFEST): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agf-local-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(root, "src", "main.ts"), "export {};\n", "utf8");
  return root;
}

test("global block is English and scoped to session rules", async () => {
  const block = await loadPrompt("global");
  assert.equal(block.size, "global");
  assert.equal(block.source, "builtin");
  assert.match(block.text, /Global Environment/);
  assert.match(block.text, /Iron rules/);
  assert.doesNotMatch(block.text, CJK);
});

test("every shipped prompt file is English", async () => {
  for (const name of ["global.md", "local.md"]) {
    const text = await readFile(join(ROOT, "prompts", name), "utf8");
    assert.doesNotMatch(text, CJK, `${name} contains non-English text`);
  }
});

test("there is no info prompt file", async () => {
  const text = await readFile(join(ROOT, "prompts", "info.md"), "utf8").catch(() => null);
  assert.equal(text, null, "prompts/info.md should not exist; tool output is the Info Block");
});

test("local returns the rendered template when AGF.md is absent", async () => {
  const root = await makeProject();
  try {
    const block = await loadPrompt("local", root);
    assert.equal(block.source, "template");
    assert.match(block.text, /ledger-case/);
    assert.match(block.text, /scene\/main/);
    assert.doesNotMatch(block.text, /\{\{/, "template placeholders must be substituted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init creates the contract, the log and a self-ignoring directory", async () => {
  const root = await makeProject();
  try {
    const result = await initLocal(root);
    assert.equal(result.ok, true);

    const contract = await readFile(join(root, AGF_FILE), "utf8");
    const log = await readFile(join(root, LOG_FILE), "utf8");
    const ignore = await readFile(join(root, ".agf", ".gitignore"), "utf8");

    assert.match(contract, /## Contract/);
    assert.doesNotMatch(contract, /^### \d{4}-\d{2}-\d{2}T/m, "the contract must not carry round entries");
    assert.equal(log, "");
    assert.equal(ignore, "*\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init refuses to overwrite an existing contract", async () => {
  const root = await makeProject();
  try {
    await initLocal(root);
    await writeFile(join(root, AGF_FILE), "hand-written\n", "utf8");
    const second = await initLocal(root);
    assert.equal(second.ok, false);
    assert.match(second.message, /already exists/);
    assert.equal(await readFile(join(root, AGF_FILE), "utf8"), "hand-written\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local joins contract and log, newest round visible", async () => {
  const root = await makeProject();
  try {
    await initLocal(root);
    await appendLog({ root, task: "first round" });
    const block = await loadPrompt("local", root);
    assert.equal(block.source, "project");
    assert.match(block.text, /## Round Log/);
    assert.match(block.text, /first round/);
    // Contract comes first, log second.
    assert.ok(block.text.indexOf("## Contract") < block.text.indexOf("## Round Log"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composeLocal marks an empty log instead of staying silent", async () => {
  const root = await makeProject();
  try {
    await initLocal(root);
    const composed = await composeLocal(root);
    assert.ok(composed);
    assert.equal(composed.hasLog, false);
    assert.match(composed.text, /no rounds recorded yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log writes to the ignored file, never to the contract", async () => {
  const root = await makeProject();
  try {
    await initLocal(root);
    await appendLog({ root, task: "touch the hud" });

    const contract = await readFile(join(root, AGF_FILE), "utf8");
    const log = await readFile(join(root, LOG_FILE), "utf8");
    assert.doesNotMatch(contract, /touch the hud/);
    assert.match(log, /touch the hud/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log records the measured check result, not a claimed one", async () => {
  const root = await makeProject({
    ...MANIFEST,
    scenes: { main: { module: "src/main.ts", assets: ["ghost"] } },
  });
  try {
    const result = await appendLog({ root, task: "wire the ghost asset", changed: ["manifest.json"] });
    assert.equal(result.ok, true);
    assert.match(result.entry ?? "", /1 error/);
    assert.match(result.entry ?? "", /AGF004/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log works without a contract file and creates the directory", async () => {
  const root = await makeProject();
  try {
    const result = await appendLog({ root, task: "first round before init" });
    assert.equal(result.ok, true);
    assert.match(await readFile(join(root, LOG_FILE), "utf8"), /first round before init/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log prepends, so the newest round reads first", async () => {
  const root = await makeProject();
  try {
    await appendLog({ root, task: "first round" });
    await appendLog({ root, task: "second round" });
    const log = await readFile(join(root, LOG_FILE), "utf8");
    const second = log.indexOf("second round");
    const first = log.indexOf("first round");
    assert.ok(second !== -1 && first !== -1);
    assert.ok(second < first, "the newest entry must come before the older one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log carries a ruling when one is supplied", async () => {
  const root = await makeProject();
  try {
    const result = await appendLog({
      root,
      task: "pick a target frame rate",
      ruling: "fixed at 60 — matches existing scenes — cost if wrong: one constant change",
    });
    assert.match(result.entry ?? "", /ruling: fixed at 60/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("log refuses when the manifest cannot be read at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "agf-local-"));
  try {
    const result = await appendLog({ root, task: "nothing to record" });
    assert.equal(result.ok, false);
    assert.match(result.message, /AGF001/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trim keeps the newest LOG_KEEP rounds and notes the omission", () => {
  const entries = Array.from({ length: LOG_KEEP + 3 }, (_, i) => `### round ${i}\n- check: 0 error / 0 warning`).join("\n");
  const trimmed = trimLog(`${entries}\n`);

  const remaining = (trimmed.match(/^### /gm) ?? []).length;
  assert.equal(remaining, LOG_KEEP);
  assert.match(trimmed, /3 older rounds omitted/);
  // Log entries are newest-first, so the tail is what gets folded away.
  assert.match(trimmed, /round 11\n/);
  assert.doesNotMatch(trimmed, /round 12\n/);
  assert.doesNotMatch(trimmed, /round 14\n/);
});

test("trim leaves a short log untouched", () => {
  const body = "### only round\n- check: 0 error / 0 warning\n";
  assert.equal(trimLog(body), body);
});

test("insertEntry starts a fresh body cleanly", () => {
  assert.equal(insertEntry("", "### round"), "### round\n");
  assert.equal(insertEntry("### older\n", "### round"), "### round\n\n### older\n");
});
