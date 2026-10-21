/**
 * JSON Schema for the manifest — shape only.
 *
 * Cross-file references, ID closure and "does the file exist" are semantic
 * constraints and live in rules.ts. The split is deliberate: a schema reports an
 * exact location, but it cannot express that a referenced path exists on disk.
 */

export const SCHEMA_VERSION = 1;

export const manifestSchema = {
  type: "object",
  required: ["schemaVersion", "name", "entry", "assets", "intents", "widgets", "scenes"],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [SCHEMA_VERSION] },
    name: { type: "string", minLength: 1 },
    entry: { type: "string", pattern: "^scene/" },
    assets: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["type", "src"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["image", "audio", "video", "font", "json"] },
          src: { type: "string", minLength: 1 },
        },
      },
    },
    intents: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["axis2", "button", "pointer", "text"] },
          bindings: { type: "array", items: {} },
        },
      },
    },
    widgets: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["intents", "module"],
        additionalProperties: false,
        properties: {
          intents: { type: "array", items: { type: "string" } },
          module: { type: "string", minLength: 1 },
        },
      },
    },
    scenes: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["module"],
        additionalProperties: false,
        properties: {
          module: { type: "string", minLength: 1 },
          assets: { type: "array", items: { type: "string" } },
          widgets: { type: "array", items: { type: "string" } },
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxModuleBytes: { type: "integer", minimum: 1024 },
      },
    },
  },
} as const;

/** Default module ceiling: 256 KiB. Beyond this a single file stops being maintainable. */
export const DEFAULT_MAX_MODULE_BYTES = 256 * 1024;
