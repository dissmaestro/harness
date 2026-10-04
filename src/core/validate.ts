import type { JSONSchema } from "../types.ts";

/** Local models often send "5" for numbers, "true" for booleans, or JSON strings for objects. */
export function coerceArgs(schema: JSONSchema, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(out)) {
    const type = schema.properties?.[key]?.type;
    if (typeof value !== "string" || !type) continue;
    if ((type === "number" || type === "integer") && value.trim() !== "" && !isNaN(Number(value))) {
      out[key] = Number(value);
    } else if (type === "boolean" && /^(true|false)$/i.test(value.trim())) {
      out[key] = value.trim().toLowerCase() === "true";
    } else if (type === "object" || type === "array") {
      try {
        out[key] = JSON.parse(value);
      } catch {}
    }
  }
  return out;
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

/** Shallow validation: required keys, primitive types, enums. Returns an error message or null. */
export function validateArgs(schema: JSONSchema, args: Record<string, unknown>): string | null {
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) errors.push(`missing required parameter "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    if (prop.type && !typeOk(prop.type, value)) errors.push(`parameter "${key}" must be ${prop.type}`);
    if (prop.enum && !prop.enum.includes(value)) errors.push(`parameter "${key}" must be one of ${JSON.stringify(prop.enum)}`);
  }
  return errors.length ? errors.join("; ") : null;
}
