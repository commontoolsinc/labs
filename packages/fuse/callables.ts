import type { JSONSchema } from "@commonfabric/api";
import { ContextualFlowControl } from "../runner/src/cfc.ts";

const encoder = new TextEncoder();

export type CallableKind = "handler" | "tool";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSchemaRecord(schema: JSONSchema | undefined): schema is Record<
  string,
  unknown
> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

function isPatternSchemaValue(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const pattern = value as Record<string, unknown>;
  return "argumentSchema" in pattern || "resultSchema" in pattern ||
    "nodes" in pattern;
}

function isPatternSchemaSchema(schema: JSONSchema | undefined): boolean {
  if (!isSchemaRecord(schema)) return false;
  if (ContextualFlowControl.getAsCellValues(schema).at(0) === "cell") {
    return true;
  }

  const properties = schema.properties;
  if (
    typeof properties !== "object" || properties === null ||
    Array.isArray(properties)
  ) {
    return false;
  }

  return "argumentSchema" in properties || "resultSchema" in properties ||
    "nodes" in properties;
}

export function isStreamValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "$stream" in obj && obj.$stream === true;
}

export function isHandlerCell(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const cell = v as { isStream?: () => boolean };
  if (typeof cell.isStream === "function") {
    try {
      return cell.isStream();
    } catch {
      return false;
    }
  }
  return false;
}

export function isPatternToolValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "pattern" in obj && "extraParams" in obj &&
    isPatternSchemaValue(obj.pattern);
}

export function isPatternToolSchema(schema: JSONSchema | undefined): boolean {
  if (!isSchemaRecord(schema)) return false;
  const properties = schema.properties;
  if (
    typeof properties !== "object" || properties === null ||
    Array.isArray(properties)
  ) {
    return false;
  }

  return "pattern" in properties && "extraParams" in properties &&
    isPatternSchemaSchema(properties.pattern as JSONSchema | undefined);
}

export function classifyCallableEntry(
  value: unknown,
  schema?: JSONSchema,
): CallableKind | null {
  if (isPatternToolSchema(schema)) {
    return "tool";
  }

  if (isStreamValue(value) || isHandlerCell(value)) {
    return "handler";
  }

  if (schema === undefined && isPatternToolValue(value)) {
    return "tool";
  }

  return null;
}

export function buildCallableScript(
  execCli: string,
  schema?: JSONSchema,
  typeStr?: string,
): Uint8Array {
  const shim = execCli || "/usr/bin/false";
  // Comments are readable via `cat` and `head`; cf exec handles --help and
  // flag-based invocation (--value <x> for scalars, --flag <v> for objects).
  const schemaComment = schema !== undefined
    ? `# schema: ${JSON.stringify(schema)}\n`
    : "";
  const typeComment = typeStr !== undefined
    ? `# input: ${typeStr.replaceAll("\n", "\n# ")}\n`
    : "";
  return encoder.encode(
    `#!${shim} exec\n${schemaComment}${typeComment}exec ${
      shellQuote(shim)
    } exec "$0" "$@"\n`,
  );
}

export function transformCallableValues(
  value: unknown,
  classify: (key: string, value: unknown) => CallableKind | null = (
    _key,
    candidate,
  ) => classifyCallableEntry(candidate),
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const obj = value as Record<string, unknown>;
  let hasCallables = false;
  for (const [key, candidate] of Object.entries(obj)) {
    if (classify(key, candidate)) {
      hasCallables = true;
      break;
    }
  }
  if (!hasCallables) return value;

  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(obj)) {
    const callableKind = classify(key, candidate);
    if (callableKind) {
      result[key] = callableKind === "handler"
        ? { "/handler": key }
        : { "/tool": key };
    } else {
      result[key] = candidate;
    }
  }

  return result;
}
