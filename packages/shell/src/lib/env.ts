declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_DATA_MODEL: string | undefined;
  var $EXPERIMENTAL_UNIFIED_JSON_ENCODING: string | undefined;
  var $EXPERIMENTAL_MODERN_HASH: string | undefined;
  var $EXPERIMENTAL_MODERN_SCHEMA_HASH: string | undefined;
  var $COMPILATION_CACHE_CLIENT: string | undefined;
}

export const ENVIRONMENT: "development" | "production" =
  $ENVIRONMENT === "production" ? $ENVIRONMENT : "development";

export const API_URL: URL = new URL(
  $API_URL ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

export const COMMIT_SHA: string | undefined = $COMMIT_SHA;

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernDataModel: $EXPERIMENTAL_MODERN_DATA_MODEL === "true",
  unifiedJsonEncoding: $EXPERIMENTAL_UNIFIED_JSON_ENCODING === "true",
  modernHash: $EXPERIMENTAL_MODERN_HASH === "true",
  modernSchemaHash: $EXPERIMENTAL_MODERN_SCHEMA_HASH === "true",
};

export const COMPILATION_CACHE_CLIENT = $COMPILATION_CACHE_CLIENT === "true";
