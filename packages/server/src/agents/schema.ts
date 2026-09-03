// Minimal JSON Schema (subset) validator for agent definition input/output
// schemas. Deliberately tiny: the kernel only needs structural validation of
// plain-data verdicts and inputs, without pulling a full JSON Schema runtime.
//
// Supported keywords: type (incl. unions), properties, required,
// additionalProperties, items, enum, minimum/maximum, minLength/maxLength,
// minItems/maxItems.

import type { JsonSchemaValue } from "./types.js";

export interface SchemaIssue {
  /** Dotted path to the offending value, "" for the root. */
  path: string;
  message: string;
}

const TYPE_NAMES: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number";
  if (expected === "integer") return actual === "number" && Number.isInteger(value);
  return actual === expected;
}

function joinPath(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

/**
 * Validate `value` against `schema`. Returns all violations (empty = valid).
 * Unknown keywords are ignored; unsupported `type` values are a schema error.
 */
export function validateSchema(
  value: unknown,
  schema: JsonSchemaValue,
  path = "",
  issues: SchemaIssue[] = [],
): SchemaIssue[] {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const t of types) {
    if (typeof t !== "string" || !(t in TYPE_NAMES)) {
      issues.push({ path, message: `schema uses unsupported type ${JSON.stringify(t)}` });
      return issues;
    }
  }
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    issues.push({
      path,
      message: `expected ${types.join(" | ")}, got ${typeOf(value)}`,
    });
    return issues;
  }

  if (schema.enum !== undefined) {
    const options = schema.enum as unknown[];
    if (!options.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      issues.push({ path, message: `value ${JSON.stringify(value)} not in enum` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `value ${value} < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `value ${value} > maximum ${schema.maximum}` });
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        validateSchema(item, schema.items as JsonSchemaValue, joinPath(path, index), issues);
      }
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaValue>;
    const required = (schema.required ?? []) as string[];
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path, message: `missing required property "${key}"` });
      }
    }
    const additional = schema.additionalProperties;
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        validateSchema(child, properties[key], joinPath(path, key), issues);
      } else if (additional === false) {
        issues.push({ path: joinPath(path, key), message: "additional property not allowed" });
      } else if (typeof additional === "object" && additional !== null) {
        validateSchema(child, additional as JsonSchemaValue, joinPath(path, key), issues);
      }
    }
  }

  return issues;
}

/** Validate and throw a descriptive error on the first violation. */
export function assertSchema(value: unknown, schema: JsonSchemaValue, what: string): void {
  const issues = validateSchema(value, schema);
  if (issues.length > 0) {
    const first = issues[0];
    const at = first.path === "" ? what : `${what} at ${first.path}`;
    throw new Error(`${at}: ${first.message} (${issues.length} violation(s))`);
  }
}

/** True when `value` satisfies `schema`. */
export function schemaMatches(value: unknown, schema: JsonSchemaValue): boolean {
  return validateSchema(value, schema).length === 0;
}
