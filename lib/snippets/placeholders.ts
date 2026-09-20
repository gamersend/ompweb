/**
 * Snippet placeholder grammar (BUILD-PLAN Phase 4).
 *
 *   $NAME      → placeholder
 *   ${NAME}    → placeholder (same NAME charset, brace-delimited)
 *   $$         → escapes a literal `$`
 *
 * NAME matches [A-Za-z_][A-Za-z0-9_]*. Anything else after `$` is a literal
 * `$` (e.g. `$1`, `${oops` without a closing brace, `$ space`). Pure module —
 * no I/O, shared by the store (preview), the API route (validation) and the
 * composer row (fill).
 */

const PLACEHOLDER_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Ordered unique placeholder names in first-appearance order. `$$` escapes
 *  contribute nothing. */
export function parsePlaceholders(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    if (match[0] === "$$") continue;
    const name = match[1] ?? match[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function hasPlaceholders(body: string): boolean {
  return parsePlaceholders(body).length > 0;
}

/**
 * Fill placeholders with `values`. A name present in `values` is replaced
 * (empty string allowed); a name missing from `values` stays as its literal
 * source text so an unfilled snippet never silently loses its marker. `$$`
 * unescapes to a literal `$` either way.
 */
export function fill(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(PLACEHOLDER_RE, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = braced ?? bare;
    if (name !== undefined && Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name];
    }
    return match;
  });
}
