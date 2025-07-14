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

// To deploy alongside the jumble instance, we have a host
// serving this application via prefixed URL `/shell`.
// On page load, if URL is `${HOST}/shell`, use that prefix
// whenever rendering links or parsing URL etc.
// This can be removed once we have a single deployment type.
export const USE_SHELL_PREFIX: boolean = (() => {
  const location = new URL(globalThis.location.href);
  const firstSegment = location.pathname.split("/").filter(Boolean)[0];
  return firstSegment === "shell";
})();
