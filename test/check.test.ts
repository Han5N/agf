/**
 * Core regression tests.
 *
 * The point is not coverage. It is proof that every rule actually fires. The
 * worst failure mode for a checker is silent pass — a rule that exists but has
 * never been observed to trigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkProject } from "../src/check.js";
import { addEntity } from "../src/mutate.js";
import { inspectEntity } from "../src/query.js";
import type { Manifest } from "../src/types.js";

const BASE: Manifest = {
  schemaVersion: 1,
  name: "case",
  entry: "scene/main",
  assets: { bg: { type: "image", src: "assets/bg.svg" } },
  intents: { confirm: { type: "button", bindings: [] } },
  widgets: { hud: { intents: ["confirm"], module: "src/hud.ts" } },
  scenes: { main: { module: "src/main.ts", assets: ["bg"], widgets: ["hud"] } },
};

const BASE_FILES: Record<string, string> = {
  "assets/bg.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>",
  "src/main.ts": "export const scene = 'main';\n",
  "src/hud.ts": "export const hud = true;\n",
};

async function makeProject(
  manifest: unknown = BASE,
  files: Record<string, string> = BASE_FILES,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agf-"));
  const all: Record<string, string> = { "manifest.json": JSON.stringify(manifest, null, 2), ...files };
  for (const [rel, content] of Object.entries(all)) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

function codes(diagnostics: Array<{ code: string }>): string[] {
  return diagnostics.map((d) => d.code);
}

test("a clean project produces no diagnostics", async () => {
  const root = await makeProject();
  try {
    const result = await checkProject(root);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.ok, true);
    assert.equal(result.summary.modules, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an undeclared asset reference reports AGF004 with a pointer", async () => {
  const manifest = structuredClone(BASE);
  manifest.scenes.main = { module: "src/main.ts", assets: ["ghost"], widgets: ["hud"] };
  const root = await makeProject(manifest);
  try {
    const result = await checkProject(root);
    assert.ok(codes(result.diagnostics).includes("AGF004"));
    const hit = result.diagnostics.find((d) => d.code === "AGF004");
    assert.match(hit?.path ?? "", /\/scenes\/main\/assets\/0$/);
    assert.match(hit?.fix ?? "", /Declare "ghost" under assets/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an inlined data: asset reports AGF006", async () => {
  const manifest = structuredClone(BASE);
  manifest.assets.bg = { type: "image", src: "data:image/svg+xml;base64,AAAA" };
  const root = await makeProject(manifest);
  try {
    const result = await checkProject(root);
    assert.ok(codes(result.diagnostics).includes("AGF006"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an asset path escaping the root reports AGF014", async () => {
  const manifest = structuredClone(BASE);
  manifest.assets.bg = { type: "image", src: "../outside.svg" };
  const root = await makeProject(manifest);
  try {
    const result = await checkProject(root);
    assert.ok(codes(result.diagnostics).includes("AGF014"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing module reports AGF007 at the module pointer", async () => {
  const root = await makeProject(BASE, { "assets/bg.svg": BASE_FILES["assets/bg.svg"]! });
  try {
    const result = await checkProject(root);
    const hit = result.diagnostics.find((d) => d.code === "AGF007");
    assert.ok(hit);
    assert.match(hit.path, /\/scenes\/main\/module$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a module over the ceiling reports AGF008", async () => {
  const manifest = structuredClone(BASE);
  manifest.limits = { maxModuleBytes: 1024 };
  const root = await makeProject(manifest, { ...BASE_FILES, "src/main.ts": "x".repeat(2048) });
  try {
    const result = await checkProject(root);
    assert.ok(codes(result.diagnostics).includes("AGF008"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an undeclared file under assets/ reports AGF013 as a warning", async () => {
  const root = await makeProject(BASE, { ...BASE_FILES, "assets/leftover.png": "not-an-image" });
  try {
    const result = await checkProject(root);
    const hit = result.diagnostics.find((d) => d.code === "AGF013");
    assert.ok(hit);
    assert.equal(hit.file, "assets/leftover.png");
    assert.equal(hit.severity, "warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid ID reports AGF003 with a suggested rename", async () => {
  const manifest = structuredClone(BASE);
  manifest.widgets["HUD Widget"] = { intents: ["confirm"], module: "src/hud.ts" };
  const root = await makeProject(manifest);
  try {
    const result = await checkProject(root);
    const hit = result.diagnostics.find((d) => d.code === "AGF003");
    assert.ok(hit);
    assert.match(hit.fix, /hud_widget/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown field reports AGF002 and names the field", async () => {
  const manifest = structuredClone(BASE) as Manifest & { extra?: unknown };
  manifest.extra = true;
  const root = await makeProject(manifest);
  try {
    const result = await checkProject(root);
    const hit = result.diagnostics.find((d) => d.code === "AGF002");
    assert.ok(hit);
    assert.match(hit.message, /extra/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broken JSON reports AGF001 instead of crashing", async () => {
  const root = await makeProject(BASE, { ...BASE_FILES, "manifest.json": '{ "name": ' });
  try {
    const result = await checkProject(root);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result.diagnostics), ["AGF001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add refuses to overwrite an existing entry", async () => {
  const root = await makeProject();
  try {
    const first = await addEntity({ kind: "asset", id: "bg", assetType: "image", src: "assets/bg.svg", root });
    assert.equal(first.ok, false);
    assert.match(first.message, /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add writes sorted keys and the new entry is immediately checkable", async () => {
  const root = await makeProject();
  try {
    await addEntity({ kind: "asset", id: "aaa_first", assetType: "image", src: "assets/bg.svg", root });
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(join(root, "manifest.json"), "utf8");
    const keys = Object.keys(JSON.parse(text).assets);
    assert.deepEqual(keys, [...keys].sort());

    const result = await checkProject(root);
    // The new asset has no referrer yet, so AGF009 is expected. No errors.
    assert.equal(result.ok, true);
    assert.ok(codes(result.diagnostics).includes("AGF009"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect returns referrers for every entity kind", async () => {
  const root = await makeProject();
  try {
    const asset = await inspectEntity("asset", "bg", root);
    assert.equal(asset.found, true);
    assert.deepEqual(asset.usedBy, ["scene/main"]);

    const widget = await inspectEntity("widget", "hud", root);
    assert.deepEqual(widget.usedBy, ["scene/main"]);

    const intent = await inspectEntity("intent", "confirm", root);
    assert.deepEqual(intent.usedBy, ["widget/hud"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect suggests the nearest ID for a typo", async () => {
  const root = await makeProject();
  try {
    const result = await inspectEntity("asset", "bgg", root);
    assert.equal(result.found, false);
    assert.match(result.note ?? "", /bg/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
