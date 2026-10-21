/**
 * agf data model.
 *
 * This file is the authoritative description of manifest semantics. The JSON
 * Schema in `schema.ts` owns shape; this file owns meaning. Change both
 * together, or agents will read two contracts that contradict each other.
 *
 * Design rule: the vocabulary holds four concepts — scene, widget, intent and
 * asset. Before adding a fifth, prove it cannot be expressed with these.
 */

/** Diagnostic severity. error blocks completion; warning only asks for an explanation. */
export type Severity = "error" | "warning";

/**
 * One structured diagnostic.
 *
 * This shape is consumed by agents, not read as prose: file plus path locates
 * the change, code can be allowlisted, and fix must be directly executable.
 * A diagnostic without a fix reports a problem and withholds the remedy.
 */
export interface Diagnostic {
  /** Stable rule code such as AGF005. Never renumber after release. */
  code: string;
  severity: Severity;
  /** Path relative to the project root, always "/"-separated. */
  file: string;
  /** JSON Pointer inside the manifest; a file path for non-manifest sources. */
  path: string;
  /** One sentence naming the exact violation, including the offending ID. */
  message: string;
  /** Executable next action. Imperative, naming the file and the new value. */
  fix: string;
}

/** Asset kinds. Kept small: each addition needs a loader and a rule. */
export type AssetType = "image" | "audio" | "video" | "font" | "json";

export interface AssetDef {
  type: AssetType;
  /** Project-relative path. No data: URIs, no traversal outside the root. */
  src: string;
}

/**
 * Input intent. The device-independent layer: keyboard, touch and gamepad all
 * collapse into intents. Widgets consume intents and never read raw events.
 */
export type IntentType = "axis2" | "button" | "pointer" | "text";

export interface IntentDef {
  type: IntentType;
  /** Bindings are interpreted by the runtime; Core checks shape only. */
  bindings?: unknown[];
}

export interface WidgetDef {
  /** Consumed intent IDs. An empty list means a decorative control. */
  intents: string[];
  /** Widget implementation module, relative to the project root. */
  module: string;
}

export interface SceneDef {
  /** Scene implementation module, relative to the project root. */
  module: string;
  /** Asset IDs this scene uses. Drives orphan detection and load lists. */
  assets?: string[];
  /** Widget IDs this scene mounts. */
  widgets?: string[];
}

/** Project ceiling. Exists to stop logic drifting back into one large file. */
export interface Limits {
  /** Maximum module size in bytes. Defaults to 256 KiB. */
  maxModuleBytes?: number;
}

export interface Manifest {
  schemaVersion: number;
  name: string;
  /** Entry point, always in `scene/<scene ID>` form. */
  entry: string;
  assets: Record<string, AssetDef>;
  intents: Record<string, IntentDef>;
  widgets: Record<string, WidgetDef>;
  scenes: Record<string, SceneDef>;
  limits?: Limits;
}

/** Check totals. Numbers exist for regression comparison, not decoration. */
export interface CheckSummary {
  errors: number;
  warnings: number;
  scenes: number;
  assets: number;
  widgets: number;
  intents: number;
  /** Distinct module files across scenes and widgets. */
  modules: number;
  /** Largest module, for spotting renewed bloat. */
  largestModule: { path: string; bytes: number } | null;
}

export interface CheckResult {
  ok: boolean;
  /** project: manifest-driven. prototype: a single HTML file, checked loosely. */
  mode: "project" | "prototype";
  manifestFile: string;
  diagnostics: Diagnostic[];
  summary: CheckSummary;
}

/** Entity kinds, shared by inspect, add and prompt. */
export type EntityKind = "scene" | "widget" | "intent" | "asset";
