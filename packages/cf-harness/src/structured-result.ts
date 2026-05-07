import type { JSONSchema } from "@commonfabric/api";
import {
  type SchemaOpaqueLinkSanitizationResult,
  validateAndSanitizeStructuredResultValue,
  validateStructuredResultValue as validateCfcStructuredResultValue,
} from "@commonfabric/runner/cfc";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  if (
    typeof parsed !== "boolean" &&
    (!isRecord(parsed) || Array.isArray(parsed))
  ) {
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
  },
): SanitizedStructuredResult =>
  validateAndSanitizeStructuredResultValue(options);
