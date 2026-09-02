// System prompt template rendering (env-bound injection).
//
// Templates use `{{path.to.value}}` placeholders resolved against
// `{ env, input }`. Rendering is strict: an unknown placeholder aborts the run
// instead of silently leaking an unresolved (possibly wrong-env) prompt.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export interface TemplateVars {
  env: unknown;
  input: unknown;
}

function resolvePath(vars: TemplateVars, path: string): unknown {
  let current: unknown = vars;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      throw new Error(`unknown template variable "${path}"`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Render a definition's system prompt template. `{{env.*}}` resolves against
 * the current run's env binding, `{{input}}` against the validated input.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = resolvePath(vars, path);
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}
