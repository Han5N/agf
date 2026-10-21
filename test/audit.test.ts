/**
 * Audit regression tests.
 *
 * Each test proves one detector actually fires. An audit that reports nothing is
 * indistinguishable from an audit that is broken, so every signal needs a case
 * that makes it appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { auditProject, parseTrend } from "../src/audit.js";

const MANIFEST = {
  schemaVersion: 1,
  name: "audit-case",
  entry: "scene/main",
  assets: { bg: { type: "image", src: "assets/bg.svg" } },
  intents: { confirm: { type: "button", bindings: [] } },
  widgets: { hud: { intents: ["confirm"], module: "src/hud.ts" } },
  scenes: { main: { module: "src/main.ts", assets: ["bg"], widgets: ["hud"] } },
};

const BASE_FILES: Record<string, string> = {
  "assets/bg.svg": "<svg/>",
  "src/main.ts": 'import { createHud } from "./hud.js";\nexport function createMainScene() { return createHud(); }\n',
  "src/hud.ts": "export function createHud() { return true; }\n",
};

async function makeProject(
  manifest: unknown = MANIFEST,
  files: Record<string, string> = BASE_FILES,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agf-audit-"));
  const all: Record<string, string> = { "manifest.json": JSON.stringify(manifest, null, 2), ...files };
  for (const [rel, content] of Object.entries(all)) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

function codes(report: Awaited<ReturnType<typeof auditProject>>): string[] {
  return report.findings.map((f) => f.code);
}

test("a clean project produces no findings and a good fan-out grade", async () => {
  const root = await makeProject();
  try {
    const report = await auditProject(root);
    assert.deepEqual(report.findings, []);
    assert.equal(report.ok, true);
    const fanOut = report.metrics.find((m) => m.key === "averageFanOut");
    assert.equal(fanOut?.grade, "good");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("byte-identical assets report AUD001", async () => {
  // Loosen the literal type so a second asset can be added in the test.
  const manifest = structuredClone(MANIFEST) as { assets: Record<string, { type: string; src: string }> };
  manifest.assets.copy = { type: "image", src: "assets/copy.svg" };
  const root = await makeProject(manifest, { ...BASE_FILES, "assets/copy.svg": "<svg/>" });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD001");
    assert.ok(hit);
    assert.equal(hit.level, "bad");
    assert.equal(report.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an asset ID used in code but undeclared reports AUD002", async () => {
  const root = await makeProject(MANIFEST, {
    ...BASE_FILES,
    "src/hud.ts": 'export function createHud(ctx) { return ctx.assets.image("ghost_icon"); }\n',
  });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD002");
    assert.ok(hit);
    assert.match(hit.message, /ghost_icon/);
    assert.deepEqual(hit.detail, ["src/hud.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a string matching an existing asset file stem reports AUD002", async () => {
  const root = await makeProject(MANIFEST, {
    ...BASE_FILES,
    "assets/leftover.svg": "<svg id='x'/>",
    "src/hud.ts": 'const name = "leftover";\nexport function createHud() { return name; }\n',
  });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD002");
    assert.ok(hit);
    assert.match(hit.message, /leftover/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dependency cycle reports AUD005", async () => {
  const root = await makeProject(MANIFEST, {
    ...BASE_FILES,
    "src/a.ts": 'import { b } from "./b.js";\nexport const a = () => b();\n',
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = () => a();\n',
  });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD005");
    assert.ok(hit);
    assert.match(hit.message, /a\.ts.*b\.ts.*a\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unimported module reports AUD007", async () => {
  const root = await makeProject(MANIFEST, {
    ...BASE_FILES,
    "src/abandoned.ts": "export const nothing = 1;\n",
  });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD007");
    assert.ok(hit);
    assert.match(hit.message, /abandoned\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same six code lines in two files reports AUD006", async () => {
  const block = [
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
    "const d = 4;",
    "const e = 5;",
    "const f = 6;",
  ].join("\n");
  const root = await makeProject(MANIFEST, {
    ...BASE_FILES,
    "src/one.ts": `import { createHud } from "./hud.js";\n${block}\nexport const one = a;\n`,
    "src/two.ts": `import { createHud } from "./hud.js";\n${block}\nexport const two = f;\n`,
  });
  try {
    const report = await auditProject(root);
    const hit = report.findings.find((f) => f.code === "AUD006");
    assert.ok(hit);
    assert.equal(hit.level, "warn");
    assert.ok((hit.detail ?? []).some((d) => d.includes("one.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fan-out above the TIOBE good threshold drops the grade", async () => {
  // One module importing seven others: average fan-out 7, above the TIOBE
  // B threshold of 6.44, so the grade is bad.
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const imports = names.map((name) => `import { ${name} } from "./${name}.js";`).join("\n");
  const root = await makeProject(MANIFEST, {
    "assets/bg.svg": "<svg/>",
    "src/hub.ts": `${imports}\nexport const hub = a;\n`,
  });
  try {
    const report = await auditProject(root);
    const fanOut = report.metrics.find((m) => m.key === "averageFanOut");
    assert.ok(fanOut);
    assert.ok(fanOut.value > 6.44);
    assert.equal(fanOut.grade, "bad");
    assert.equal(report.structure.maxFanOut?.count, names.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fan-out between the two TIOBE thresholds grades ok", async () => {
  const names = ["a", "b", "c", "d", "e"];
  const imports = names.map((name) => `import { ${name} } from "./${name}.js";`).join("\n");
  const root = await makeProject(MANIFEST, {
    "assets/bg.svg": "<svg/>",
    "src/hub.ts": `${imports}\nexport const hub = a;\n`,
  });
  try {
    const report = await auditProject(root);
    const fanOut = report.metrics.find((m) => m.key === "averageFanOut");
    assert.equal(fanOut?.grade, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable manifest reports AUD000 instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agf-audit-"));
  try {
    const report = await auditProject(root);
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report), ["AUD000"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseTrend reads measured counts from the round log", () => {
  const log = [
    "### 2026-10-21T10:00:00.000Z — first",
    "- changed: a.ts",
    "- check: 2 error / 1 warning (AGF004)",
    "",
    "### 2026-10-21T11:00:00.000Z — second",
    "- check: 0 error / 0 warning",
  ].join("\n");

  const points = parseTrend(log);
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], { at: "2026-10-21T10:00:00.000Z", task: "first", errors: 2, warnings: 1 });
  assert.equal(points[1]?.errors, 0);
});

test("parseTrend ignores entries without a check line", () => {
  const log = "### 2026-10-21T10:00:00.000Z — hand edited\n- changed: nothing\n";
  assert.deepEqual(parseTrend(log), []);
});
