/**
 * CLI smoke tests.
 *
 * Covers positional-argument parsing, which regresses easily. Rule logic is
 * tested in check.test.ts. These run a real child process because the thing
 * under test is the shape of the command line itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("npx", ["tsx", CLI, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("check exits 0 on the clean example project", async () => {
  const result = await run(["check", "examples/minimal"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /0 error \/ 0 warning/);
});

test("inspect does not treat the kind as a root", async () => {
  const result = await run(["inspect", "widget", "hud", "examples/minimal"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Referenced by: scene\/main/);
});

test("inspect accepts the --root form", async () => {
  const result = await run(["inspect", "asset", "bg_menu", "--root", "examples/minimal"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /bg_menu\.svg/);
});

test("check exits 1 on a broken project and prints a fix", async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "agf-cli-"));
  try {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "bad",
        entry: "scene/main",
        assets: {},
        intents: {},
        widgets: {},
        scenes: { main: { module: "src/main.ts", assets: ["ghost"] } },
      }),
      "utf8",
    );
    const result = await run(["check", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /fix :/);
    assert.match(result.stdout, /AGF004/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown entity kind exits 2", async () => {
  const result = await run(["inspect", "nope", "x"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown entity kind/);
});

test("--json output parses and reports the correct ok flag", async () => {
  const result = await run(["check", "examples/minimal", "--json"]);
  const parsed = JSON.parse(result.stdout) as { ok: boolean; summary: { scenes: number } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.scenes, 1);
});
