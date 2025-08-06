declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
}

export const ENVIRONMENT: "development" | "production" =
  $ENVIRONMENT === "production" ? $ENVIRONMENT : "development";

export const API_URL: URL = new URL(
  $API_URL ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

export const COMMIT_SHA: string | undefined = $COMMIT_SHA;
