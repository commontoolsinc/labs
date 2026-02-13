declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_RICH_STORABLE_VALUES: string | undefined;
  var $EXPERIMENTAL_STORABLE_PROTOCOL: string | undefined;
  var $EXPERIMENTAL_UNIFIED_JSON_ENCODING: string | undefined;
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
  richStorableValues: $EXPERIMENTAL_RICH_STORABLE_VALUES === "true",
  storableProtocol: $EXPERIMENTAL_STORABLE_PROTOCOL === "true",
  unifiedJsonEncoding: $EXPERIMENTAL_UNIFIED_JSON_ENCODING === "true",
};
