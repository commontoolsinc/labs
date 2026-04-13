import type { MemoryVersion } from "@commonfabric/memory/interface";

declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $MEMORY_VERSION: string | undefined;
  var $EXPERIMENTAL_MODERN_DATA_MODEL: string | undefined;
  var $EXPERIMENTAL_UNIFIED_JSON_ENCODING: string | undefined;
  var $EXPERIMENTAL_MODERN_SCHEMA_HASH: string | undefined;
  var $EXPERIMENTAL_MODERN_HASH: string | undefined;
  var $COMPILATION_CACHE_CLIENT: string | undefined;
}

const ENVIRONMENT_DEFINE = typeof $ENVIRONMENT === "string"
  ? $ENVIRONMENT
  : undefined;
const API_URL_DEFINE = typeof $API_URL === "string" ? $API_URL : undefined;
const COMMIT_SHA_DEFINE = typeof $COMMIT_SHA === "string"
  ? $COMMIT_SHA
  : undefined;
const MEMORY_VERSION_DEFINE = typeof $MEMORY_VERSION === "string"
  ? $MEMORY_VERSION
  : undefined;
const EXPERIMENTAL_MODERN_DATA_MODEL_DEFINE =
  typeof $EXPERIMENTAL_MODERN_DATA_MODEL === "string"
    ? $EXPERIMENTAL_MODERN_DATA_MODEL
    : undefined;
const EXPERIMENTAL_UNIFIED_JSON_ENCODING_DEFINE =
  typeof $EXPERIMENTAL_UNIFIED_JSON_ENCODING === "string"
    ? $EXPERIMENTAL_UNIFIED_JSON_ENCODING
    : undefined;
const EXPERIMENTAL_MODERN_SCHEMA_HASH_DEFINE =
  typeof $EXPERIMENTAL_MODERN_SCHEMA_HASH === "string"
    ? $EXPERIMENTAL_MODERN_SCHEMA_HASH
    : undefined;
const EXPERIMENTAL_MODERN_HASH_DEFINE =
  typeof $EXPERIMENTAL_MODERN_HASH === "string"
    ? $EXPERIMENTAL_MODERN_HASH
    : undefined;
const COMPILATION_CACHE_CLIENT_DEFINE =
  typeof $COMPILATION_CACHE_CLIENT === "string"
    ? $COMPILATION_CACHE_CLIENT
    : undefined;

export const ENVIRONMENT: "development" | "production" =
  ENVIRONMENT_DEFINE === "production" ? ENVIRONMENT_DEFINE : "development";

export const API_URL: URL = new URL(
  API_URL_DEFINE ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

export const COMMIT_SHA: string | undefined = COMMIT_SHA_DEFINE;
export const MEMORY_VERSION: MemoryVersion | undefined =
  MEMORY_VERSION_DEFINE === "v1" || MEMORY_VERSION_DEFINE === "v2"
    ? MEMORY_VERSION_DEFINE
    : undefined;

/**
 * Results in `true` (on), `false` (off), or `undefined` (default).
 */
function flagValue(flag: string | undefined): boolean | undefined {
  return (typeof flag === "string") ? (flag === "true") : undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernDataModel: flagValue(EXPERIMENTAL_MODERN_DATA_MODEL_DEFINE),
  unifiedJsonEncoding: flagValue(EXPERIMENTAL_UNIFIED_JSON_ENCODING_DEFINE),
  modernHash: flagValue(EXPERIMENTAL_MODERN_HASH_DEFINE),
  modernSchemaHash: flagValue(EXPERIMENTAL_MODERN_SCHEMA_HASH_DEFINE),
};

export const COMPILATION_CACHE_CLIENT =
  COMPILATION_CACHE_CLIENT_DEFINE === "true";
