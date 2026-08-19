import type { JSONSchema } from "@commonfabric/api";
import {
  type SchemaOpaqueLinkSanitizationResult,
  type StructuredResultReservedKeys,
  validateAndSanitizeStructuredResultValue,
  validateStructuredResultValue as validateCfcStructuredResultValue,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

export const DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES = 32 * 1024;

export interface ParsedStructuredResultSchema {
  schema: JSONSchema;
  bytes: number;
}

export type SanitizedStructuredResult = SchemaOpaqueLinkSanitizationResult;

export interface ParseStructuredResultSchemaOptions {
  label?: string;
  maxBytes?: number;
}

export interface ParseStructuredResultJsonOptions {
  emptyMessage?: string;
  invalidMessage?: string;
}

const textBytes = (input: string): Uint8Array =>
  new TextEncoder().encode(input);

const sha256Digest = async (input: Uint8Array): Promise<string> => {
  const digestInput = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

export const digestJsonValue = async (input: unknown): Promise<string> =>
  await sha256Digest(textBytes(JSON.stringify(input)));

/**
 * Tells whether `value` is a sealed opaque-link object: the single-key
 * `@link` object the sanitizer substitutes for a position it seals, whose
 * target carries the `opaque:` scheme.
 *
 * A seal is a REDACTION rather than an address. It marks a position a
 * structured result withheld, and it names nothing that can be read — the
 * handle boundary deliberately leaves it alone, and no reader resolves it. Any
 * code that receives a sanitized value back from a model, and would treat it
 * as data, asks this first.
 */
export const isSealedOpaqueLinkObject = (value: unknown): boolean => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const target = value["@link"];
  return Object.keys(value).length === 1 &&
    typeof target === "string" &&
    target.startsWith("opaque:");
};

/**
 * Replaces each position a sanitization reports having sealed with the
 * fabric address `buildRef` states for that path. Provenance comes from the
 * sanitizer's own `sealedPaths`, never from inspecting the value: a sealed
 * link an author declared in the schema — even one spelled with the same
 * handle id — is preserved by the sanitizer, absent from `sealedPaths`, and
 * passes through here untouched.
 *
 * This is what makes a sealed position composable instead of terminal: a
 * run_pattern result is fabric-backed by construction, so a position the
 * schema could not release as text still has an address, and an address can
 * be described and wired onward where an `opaque:` output link cannot.
 */
export const addressSealedPositions = (
  value: unknown,
  sealedPaths: readonly (readonly (string | number)[])[],
  buildRef: (path: readonly (string | number)[]) => string,
): unknown => {
  let result = value;
  for (const path of sealedPaths) {
    result = replaceAtPath(result, path, buildRef(path));
  }
  return result;
};

/**
 * `value` with the position at `path` replaced by `replacement`, rebuilding
 * only the spine. A path that no longer exists in the value — which a
 * correct `sealedPaths` never names — leaves the value unchanged rather
 * than inventing structure.
 */
const replaceAtPath = (
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): unknown => {
  if (path.length === 0) {
    return replacement;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const index = typeof head === "number" ? head : Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      return value;
    }
    const items = [...value];
    items[index] = replaceAtPath(items[index], rest, replacement);
    return items;
  }
  if (isObjectNotArray(value)) {
    const key = String(head);
    if (!Object.hasOwn(value, key)) {
      return value;
    }
    return { ...value, [key]: replaceAtPath(value[key], rest, replacement) };
  }
  return value;
};

export const parseStructuredResultSchema = (
  input: unknown,
  options: ParseStructuredResultSchemaOptions = {},
): ParsedStructuredResultSchema | undefined => {
  if (input === undefined) {
    return undefined;
  }
  const label = options.label ?? "structured result schema";
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error(`${label} string must be valid JSON`);
    }
  }
  if (typeof parsed !== "boolean" && !isObjectNotArray(parsed)) {
    throw new Error(
      `${label} must be a JSON Schema object, boolean, or JSON string`,
    );
  }
  const encoded = JSON.stringify(parsed);
  const bytes = textBytes(encoded).byteLength;
  const maxBytes = options.maxBytes ??
    DEFAULT_STRUCTURED_RESULT_SCHEMA_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} bytes`);
  }
  return {
    schema: parsed as JSONSchema,
    bytes,
  };
};

export const parseStructuredResultJson = (
  text: string,
  options: ParseStructuredResultJsonOptions = {},
): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(options.emptyMessage ?? "structured result was empty");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      options.invalidMessage ?? "structured result was not valid JSON",
    );
  }
};

export const validateStructuredResultValue = (
  options: {
    schema: JSONSchema;
    value: unknown;
  },
): void => validateCfcStructuredResultValue(options);

export const validateAndSanitizeStructuredResult = (
  options: {
    schema: JSONSchema;
    value: unknown;
    opaqueHandleId: string;
  } & StructuredResultReservedKeys,
): SanitizedStructuredResult =>
  validateAndSanitizeStructuredResultValue(options);
