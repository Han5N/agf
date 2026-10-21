/**
 * Prompt blocks, in two file sizes.
 *
 * The third size — the Info Block — has no file and no command. It is the return
 * value of any tool call: one entity or one finding, consumed where it arrives.
 *
 * Global is a shipped static file. Local is the project's AGF.md when present,
 * otherwise the rendered template.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveRoot } from "./check.js";
import { loadManifest } from "./manifest.js";
import { composeLocal, renderLocal } from "./local.js";

export type PromptSize = "global" | "local";

/** Resolves to the package root from both dist/ and src/. */
const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export interface PromptBlock {
  size: PromptSize;
  /** builtin: shipped global rules. project: the project's AGF.md. template: rendered default. */
  source: "builtin" | "project" | "template";
  text: string;
}

export async function loadPrompt(size: PromptSize, rootInput?: string): Promise<PromptBlock> {
  if (size === "global") {
    return { size, source: "builtin", text: await readFile(join(PROMPTS_DIR, "global.md"), "utf8") };
  }

  const project = await composeLocal(rootInput);
  if (project !== null) {
    return { size, source: "project", text: project.text };
  }

  const loaded = await loadManifest(resolveRoot(rootInput));
  if (!loaded.manifest) {
    throw new Error("No AGF.md and no readable manifest. Fix the manifest, then run agf init.");
  }
  return { size, source: "template", text: await renderLocal(loaded.manifest) };
}
