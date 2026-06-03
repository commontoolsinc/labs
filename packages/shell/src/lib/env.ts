declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_CELL_REP: string | undefined;
  var $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: string | undefined;
  var $EXPERIMENTAL_ESM_MODULE_LOADER: string | undefined;
  var $COMPILATION_CACHE_CLIENT: string | undefined;
}

const ENVIRONMENT_DEFINE = typeof $ENVIRONMENT === "string"
  ? $ENVIRONMENT
  : undefined;
const API_URL_DEFINE = typeof $API_URL === "string" ? $API_URL : undefined;
const COMMIT_SHA_DEFINE = typeof $COMMIT_SHA === "string"
  ? $COMMIT_SHA
  : undefined;
const EXPERIMENTAL_MODERN_CELL_REP_DEFINE =
  typeof $EXPERIMENTAL_MODERN_CELL_REP === "string"
    ? $EXPERIMENTAL_MODERN_CELL_REP
    : undefined;
const EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE =
  typeof $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE === "string"
    ? $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE
    : undefined;
const EXPERIMENTAL_ESM_MODULE_LOADER_DEFINE =
  typeof $EXPERIMENTAL_ESM_MODULE_LOADER === "string"
    ? $EXPERIMENTAL_ESM_MODULE_LOADER
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

/**
 * Like {@link flagValue} but mirrors the runner's `CF_ESM_MODULE_LOADER`
 * parsing (`readEnvDefault` in esm-loader-config.ts), which accepts `"1"` as
 * well as `"true"`, so the same env var enables the ESM loader identically on
 * the server and in the browser worker.
 */
function esmLoaderFlagValue(flag: string | undefined): boolean | undefined {
  return (typeof flag === "string")
    ? (flag === "1" || flag === "true")
    : undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernCellRep: flagValue(EXPERIMENTAL_MODERN_CELL_REP_DEFINE),
  persistentSchedulerState: flagValue(
    EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE,
  ),
  esmModuleLoader: esmLoaderFlagValue(EXPERIMENTAL_ESM_MODULE_LOADER_DEFINE),
};

export const COMPILATION_CACHE_CLIENT =
  COMPILATION_CACHE_CLIENT_DEFINE === "true";
