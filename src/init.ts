/**
 * Project bootstrap.
 *
 * `agf init` must work in an empty directory. The earlier version required a
 * manifest to exist first, which pushed the agent into hand-writing one before
 * it could use any tool — the exact thing the toolchain is meant to prevent.
 *
 * What it creates is a project that already passes `check`: a manifest whose
 * entry points at a file that exists. An empty scene is honest (AGF012 warns
 * about it) and gives the agent a green baseline to build from.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { resolveRoot } from "./check.js";
import { initLocal } from "./local.js";
import { MANIFEST_FILE } from "./manifest.js";

export interface InitResult {
  ok: boolean;
  message: string;
  created: string[];
  skipped: string[];
}

const SCENE_MODULE = `/**
 * Main scene: assembly only.
 *
 * Replace this with real assembly — load assets, mount widgets, hold state.
 */
export function createMainScene(ctx) {
  return {
    mount() {},
    unmount() {},
  };
}
`;

export async function initProject(rootInput?: string): Promise<InitResult> {
  const root = resolveRoot(rootInput);
  const created: string[] = [];
  const skipped: string[] = [];

  const manifestPath = join(root, MANIFEST_FILE);
  const existing = await readFile(manifestPath, "utf8").catch(() => null);

  if (existing === null) {
    const name = slug(basename(root)) || "game";
    const manifest = {
      schemaVersion: 1,
      name,
      entry: "scene/main",
      assets: {},
      intents: {},
      widgets: {},
      scenes: { main: { module: "src/scenes/main.js" } },
    };
    await mkdir(root, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    created.push(MANIFEST_FILE);

    const scenePath = join(root, "src", "scenes", "main.js");
    const sceneExists = await readFile(scenePath, "utf8").catch(() => null);
    if (sceneExists === null) {
      await mkdir(join(root, "src", "scenes"), { recursive: true });
      await writeFile(scenePath, SCENE_MODULE, "utf8");
      created.push("src/scenes/main.js");
    }
  } else {
    skipped.push(MANIFEST_FILE);
  }

  const local = await initLocal(root);
  if (local.ok) {
    created.push("AGF.md", ".agf/log.md");
  } else {
    skipped.push("AGF.md");
  }

  return {
    ok: true,
    message:
      created.length > 0
        ? `Initialized ${created.join(", ")}. Next: declare entities with agf_add, then agf_check.`
        : "Nothing to create; the project is already initialized.",
    created,
    skipped,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
