/**
 * Manifest loading and shape validation.
 *
 * A shape error stops semantic checking. If the structure is wrong, running
 * the remaining rules only produces noise, and noise makes the agent fix the
 * wrong thing first.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { manifestSchema } from "./schema.js";
import { CODES, diag } from "./diagnostics.js";
import type { Diagnostic, Manifest } from "./types.js";

export const MANIFEST_FILE = "manifest.json";

export interface LoadResult {
  /** Present only when shape validation passed. */
  manifest?: Manifest;
  diagnostics: Diagnostic[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(manifestSchema);

/** Translate one Ajv error into a message plus an actionable fix. */
function translate(err: ErrorObject): { message: string; fix: string } {
  const at = err.instancePath === "" ? "the root object" : err.instancePath;
  switch (err.keyword) {
    case "required": {
      const field = String((err.params as { missingProperty?: unknown }).missingProperty ?? "");
      return {
        message: `${at} is missing required field "${field}"`,
        fix: `Add "${field}" to ${at}.`,
      };
    }
    case "additionalProperties": {
      const field = String((err.params as { additionalProperty?: unknown }).additionalProperty ?? "");
      return {
        message: `${at} contains undefined field "${field}"`,
        fix: `Remove "${field}" from ${at}; if it is a typo, use a field name defined by the manifest schema.`,
      };
    }
    case "enum": {
      const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return {
        message: `${at} is not an allowed value (allowed: ${allowed.join(" | ")})`,
        fix: `Set ${at} to one of ${allowed.map((v) => JSON.stringify(v)).join(" or ")}.`,
      };
    }
    case "type": {
      const expected = String((err.params as { type?: unknown }).type ?? "");
      return {
        message: `${at} must be of type ${expected}`,
        fix: `Replace ${at} with a ${expected} value.`,
      };
    }
    case "pattern": {
      const pattern = String((err.params as { pattern?: unknown }).pattern ?? "");
      return {
        message: `${at} does not match pattern ${pattern}`,
        fix: `Rewrite ${at} to match ${pattern}.`,
      };
    }
    case "minLength":
      return {
        message: `${at} must not be empty`,
        fix: `Give ${at} a non-empty string value.`,
      };
    case "minimum": {
      const limit = String((err.params as { limit?: unknown }).limit ?? "");
      return {
        message: `${at} must be at least ${limit}`,
        fix: `Raise ${at} to ${limit} or higher.`,
      };
    }
    default:
      return {
        message: `${at} ${err.message ?? "does not satisfy the manifest schema"}`,
        fix: `Run "agf prompt local" for the manifest contract, then correct ${at}.`,
      };
  }
}

export async function loadManifest(root: string): Promise<LoadResult> {
  const file = join(root, MANIFEST_FILE);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      diagnostics: [
        diag(
          CODES.MANIFEST_PARSE,
          "error",
          MANIFEST_FILE,
          "",
          `cannot read manifest: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
          `Create ${MANIFEST_FILE} at the project root. Run "agf prompt local" for the full contract, or copy examples/minimal/manifest.json.`,
        ),
      ],
    };
  }

  // JSON.parse does not strip a BOM, and files edited on Windows often carry one.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch (error) {
    return {
      diagnostics: [
        diag(
          CODES.MANIFEST_PARSE,
          "error",
          MANIFEST_FILE,
          "",
          `${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`,
          "Fix the JSON syntax error (common causes: trailing comma, comments, single quotes), then rerun agf check.",
        ),
      ],
    };
  }

  if (!validate(raw)) {
    const diagnostics = (validate.errors ?? []).map((err: ErrorObject) => {
      const { message, fix } = translate(err);
      return diag(CODES.MANIFEST_SHAPE, "error", MANIFEST_FILE, err.instancePath || "", message, fix);
    });
    return { diagnostics };
  }

  return { manifest: raw as Manifest, diagnostics: [] };
}
