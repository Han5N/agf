/**
 * ID grammar.
 *
 * Lowercase dot-separated segments keep one identifier usable as a manifest
 * key, a file stem and a CSS selector. That is why uppercase, spaces and
 * hyphens are rejected rather than normalized: normalization hides the
 * mismatch until it reaches the DOM.
 */

const SEGMENT = "[a-z][a-z0-9_]*";
const ID_RE = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*$`);

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

/** Entry is always scene/<id>. Returns the scene ID, or null when malformed. */
export function parseEntry(entry: string): string | null {
  const prefix = "scene/";
  if (!entry.startsWith(prefix)) return null;
  const id = entry.slice(prefix.length);
  return isValidId(id) ? id : null;
}

/** JSON Pointer for an entity, e.g. /assets/bg_menu. */
export function pointerFor(section: string, id: string): string {
  return `/${section}/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
