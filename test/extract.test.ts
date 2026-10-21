/**
 * Extraction planning tests.
 *
 * The sample is a deliberate single-file game: inline data URI, inline SVG,
 * canvas drawing, raw listeners and module-level state. Every detector has a
 * case here, because a plan that silently misses a boundary is worse than no
 * plan at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractProject, formatExtract } from "../src/extract.js";
import { checkProject } from "../src/check.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "examples", "prototype");

test("extract finds inline assets and raw listeners", async () => {
  const report = await extractProject("index.html", FIXTURE);

  assert.equal(report.hasViewport, true);
  assert.ok(report.lines > 100);

  const dataUris = report.assets.filter((asset) => asset.kind === "data-uri");
  assert.equal(dataUris.length, 1);
  assert.equal(dataUris[0]?.suggestedPath.startsWith("assets/"), true);

  const events = report.listeners.map((listener) => listener.event);
  assert.ok(events.includes("keydown"));
  assert.ok(events.includes("pointerdown"));
});

test("extract classifies functions by what they touch", async () => {
  const report = await extractProject("index.html", FIXTURE);
  const category = (name: string) => report.functions.find((fn) => fn.name === name)?.category;

  assert.equal(category("bindInput"), "input");
  assert.equal(category("draw"), "render");
  assert.equal(category("step"), "loop");
  assert.equal(category("collides"), "rules");
  assert.equal(category("rotateCells"), "rules");
});

test("extract only reports top-level state, not function locals", async () => {
  const report = await extractProject("index.html", FIXTURE);
  const names = report.state.map((item) => item.name);

  assert.ok(names.includes("grid"));
  assert.ok(names.includes("piece"));
  assert.ok(!names.includes("nx"), "nx is a loop local");
  assert.ok(!names.includes("cleared"), "cleared is a function local");
});

test("extract suggests module paths and keeps the order sequential", async () => {
  const report = await extractProject("index.html", FIXTURE);
  const paths = report.modules.map((module) => module.path);

  assert.ok(paths.includes("src/core/input.js"));
  assert.ok(paths.includes("src/systems/renderer.js"));

  const text = formatExtract(report);
  assert.match(text, /^3\. Move canvas drawing/m);
  assert.doesNotMatch(text, /^1\. Move canvas drawing/m);
});

test("check falls back to prototype mode when there is no manifest", async () => {
  const result = await checkProject(FIXTURE);
  assert.equal(result.mode, "prototype");
  assert.equal(result.ok, true, "prototype mode never blocks");
  assert.ok(result.diagnostics.some((d) => d.code === "PRT002"));
});

test("check uses project mode when a manifest exists", async () => {
  const result = await checkProject(join(ROOT, "examples", "minimal"));
  assert.equal(result.mode, "project");
  assert.equal(result.ok, true);
});
