declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_DATA_MODEL: string | undefined;
  var $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: string | undefined;
  var $COMPILATION_CACHE_CLIENT: string | undefined;
}

const ENVIRONMENT_DEFINE = typeof $ENVIRONMENT === "string"
  ? $ENVIRONMENT
  : undefined;
const API_URL_DEFINE = typeof $API_URL === "string" ? $API_URL : undefined;
const COMMIT_SHA_DEFINE = typeof $COMMIT_SHA === "string"
  ? $COMMIT_SHA
  : undefined;
const EXPERIMENTAL_MODERN_DATA_MODEL_DEFINE =
  typeof $EXPERIMENTAL_MODERN_DATA_MODEL === "string"
    ? $EXPERIMENTAL_MODERN_DATA_MODEL
    : undefined;
const EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE =
  typeof $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE === "string"
    ? $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE
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

/**
 * Results in `true` (on), `false` (off), or `undefined` (default).
 */
function flagValue(flag: string | undefined): boolean | undefined {
  return (typeof flag === "string") ? (flag === "true") : undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernDataModel: flagValue(EXPERIMENTAL_MODERN_DATA_MODEL_DEFINE),
  persistentSchedulerState: flagValue(
    EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE,
  ),
};

export const COMPILATION_CACHE_CLIENT =
  COMPILATION_CACHE_CLIENT_DEFINE === "true";
