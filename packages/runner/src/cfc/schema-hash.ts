import type { JSONSchema } from "../builder/types.ts";
import { toHex } from "./shared.ts";

const CFC_SCHEMA_HASH_VERSION = "cfc-schema-v1";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalizeSchemaValue(
  value: unknown,
  visited: Set<object> = new Set(),
): CanonicalValue {
  if (value === null) return null;

  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) {
      throw new Error("Cyclic reference detected in schema value");
    }
    visited.add(value);
    return value.map((item) => canonicalizeSchemaValue(item, visited));
  }

  if (typeof value === "object") {
    if (visited.has(value)) {
      throw new Error("Cyclic reference detected in schema value");
    }
    visited.add(value);
    const record = value as Record<string, unknown>;
    const canonical: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(record).sort()) {
      const nextValue = record[key];
      if (nextValue === undefined) {
        continue;
      }
      canonical[key] = canonicalizeSchemaValue(nextValue, visited);
    }
    return canonical;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return String(value);
}

export async function computeCfcSchemaHash(
  schema: JSONSchema,
): Promise<string> {
  const payload = JSON.stringify({
    version: CFC_SCHEMA_HASH_VERSION,
    schema: canonicalizeSchemaValue(schema),
  });

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );

  return toHex(new Uint8Array(digest));
}
