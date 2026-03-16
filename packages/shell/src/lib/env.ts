import type { MemoryVersion } from "@commontools/memory/interface";

declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $MEMORY_VERSION: string | undefined;
  var $EXPERIMENTAL_MODERN_DATA_MODEL: string | undefined;
  var $EXPERIMENTAL_RICH_STORABLE_VALUES: string | undefined;
  var $EXPERIMENTAL_STORABLE_PROTOCOL: string | undefined;
  var $EXPERIMENTAL_UNIFIED_JSON_ENCODING: string | undefined;
  var $EXPERIMENTAL_MODERN_SCHEMA_HASH: string | undefined;
  var $EXPERIMENTAL_MODERN_HASH: string | undefined;
  var $EXPERIMENTAL_CANONICAL_HASHING: string | undefined;
  var $COMPILATION_CACHE_CLIENT: string | undefined;
}

export const ENVIRONMENT: "development" | "production" =
  $ENVIRONMENT === "production" ? $ENVIRONMENT : "development";

export const API_URL: URL = new URL(
  $API_URL ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

export const COMMIT_SHA: string | undefined = $COMMIT_SHA;
export const MEMORY_VERSION: MemoryVersion | undefined =
  $MEMORY_VERSION === "v1" || $MEMORY_VERSION === "v2"
    ? $MEMORY_VERSION
    : undefined;

/**
 * Results in `true` (on), `false` (off), or `undefined` (default).
 */
function flagValue(flag: string | undefined): boolean | undefined {
  return (typeof flag === "string") ? (flag === "true") : undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernDataModel: flagValue($EXPERIMENTAL_MODERN_DATA_MODEL),
  richStorableValues: flagValue($EXPERIMENTAL_RICH_STORABLE_VALUES),
  storableProtocol: flagValue($EXPERIMENTAL_STORABLE_PROTOCOL),
  unifiedJsonEncoding: flagValue($EXPERIMENTAL_UNIFIED_JSON_ENCODING),
  modernHash: flagValue($EXPERIMENTAL_MODERN_HASH),
  modernSchemaHash: flagValue($EXPERIMENTAL_MODERN_SCHEMA_HASH),
  canonicalHashing: flagValue($EXPERIMENTAL_CANONICAL_HASHING),
};

export const COMPILATION_CACHE_CLIENT = $COMPILATION_CACHE_CLIENT === "true";
