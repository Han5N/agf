/**
 * Bootstrap and batch-declaration tests.
 *
 * These cover the two places where the toolchain used to cost the agent extra
 * model round-trips: needing a manifest before `init` could run, and needing one
 * call per entity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/init.js";
import { addEntities } from "../src/mutate.js";
import { checkProject } from "../src/check.js";

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agf-init-"));
}

test("init works in an empty directory and produces a passing project", async () => {
  const root = await emptyDir();
  try {
    const result = await initProject(root);
    assert.equal(result.ok, true);
    assert.ok(result.created.includes("manifest.json"));
    assert.ok(result.created.includes("AGF.md"));

    const check = await checkProject(root);
    assert.equal(check.summary.errors, 0, JSON.stringify(check.diagnostics));
    // An empty scene is honest and warns, but must not fail.
    assert.equal(check.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init is idempotent and never overwrites", async () => {
  const root = await emptyDir();
  try {
    await initProject(root);
    const manifestBefore = await readFile(join(root, "manifest.json"), "utf8");

    const second = await initProject(root);
    assert.equal(second.created.length, 0);
    assert.ok(second.skipped.includes("manifest.json"));

    assert.equal(await readFile(join(root, "manifest.json"), "utf8"), manifestBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addEntities writes many entries in one pass", async () => {
  const root = await emptyDir();
  try {
    await initProject(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "bg.svg"), "<svg/>", "utf8");

    const result = await addEntities(root, [
      { kind: "asset", id: "bg", assetType: "image", src: "assets/bg.svg" },
      { kind: "intent", id: "confirm", intentType: "button" },
      { kind: "intent", id: "cancel", intentType: "button" },
    ]);

    assert.equal(result.added.length, 3);
    assert.deepEqual(result.failed, []);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
      assets: Record<string, unknown>;
      intents: Record<string, unknown>;
    };
    assert.ok(manifest.assets.bg);
    assert.ok(manifest.intents.confirm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addEntities keeps going after one bad entry and reports it", async () => {
  const root = await emptyDir();
  try {
    await initProject(root);
    const result = await addEntities(root, [
      { kind: "intent", id: "Bad ID", intentType: "button" },
      { kind: "intent", id: "confirm", intentType: "button" },
      { kind: "intent", id: "confirm", intentType: "button" },
    ]);

    assert.deepEqual(result.added, ["intent/confirm"]);
    assert.equal(result.failed.length, 2);
    assert.match(result.failed[0]?.message ?? "", /grammar/);
    assert.match(result.failed[1]?.message ?? "", /already declared/);  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addEntities returns error diagnostics only, not the full report", async () => {
  const root = await emptyDir();
  try {
    await initProject(root);
    const result = await addEntities(root, [
      { kind: "asset", id: "ghost", assetType: "image", src: "assets/ghost.svg" },
    ]);

    assert.deepEqual(result.added, ["asset/ghost"]);
    assert.ok(result.diagnostics.length > 0, "a missing asset file is an error");
    assert.ok(result.diagnostics.every((d) => d.severity === "error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge updates an existing scene instead of skipping it", async () => {
  const root = await emptyDir();
  try {
    await initProject(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "bg.svg"), "<svg/>", "utf8");

    await addEntities(root, [
      { kind: "asset", id: "bg", assetType: "image", src: "assets/bg.svg" },
      { kind: "intent", id: "confirm", intentType: "button" },
      { kind: "widget", id: "hud", module: "src/scenes/main.js", intents: ["confirm"] },
    ]);

    const result = await addEntities(root, [
      { kind: "scene", id: "main", assets: ["bg"], widgets: ["hud"], merge: true },
    ]);

    assert.deepEqual(result.updated, ["scene/main"]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
      scenes: Record<string, { assets?: string[]; widgets?: string[]; module: string }>;
    };
    assert.deepEqual(manifest.scenes.main?.assets, ["bg"]);
    assert.deepEqual(manifest.scenes.main?.widgets, ["hud"]);
    assert.equal(manifest.scenes.main?.module, "src/scenes/main.js", "module is preserved when not supplied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
