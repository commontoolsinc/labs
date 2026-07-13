declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_CELL_REP: string | undefined;
  var $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: string | undefined;
  var $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: string | undefined;
  var $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE: string | undefined;
  var $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME: string | undefined;
  var $EXPERIMENTAL_INTERPRETER: string | undefined;
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
const EXPERIMENTAL_EAGER_SOURCE_ANNOTATION_DEFINE =
  typeof $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION === "string"
    ? $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION
    : undefined;
const EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_DEFINE =
  typeof $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE === "string"
    ? $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE
    : undefined;
const EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME_DEFINE =
  typeof $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME === "string"
    ? $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME
    : undefined;
const EXPERIMENTAL_INTERPRETER_DEFINE =
  typeof $EXPERIMENTAL_INTERPRETER === "string"
    ? $EXPERIMENTAL_INTERPRETER
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
  modernCellRep: flagValue(EXPERIMENTAL_MODERN_CELL_REP_DEFINE),
  persistentSchedulerState: flagValue(
    EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE,
  ),
  // Debug `.src` source annotation: ON in development builds (so per-primitive
  // source locations keep working for debugging), OFF in production (it is the
  // boot floor's largest single cost). The define overrides either way.
  eagerSourceAnnotation:
    flagValue(EXPERIMENTAL_EAGER_SOURCE_ANNOTATION_DEFINE) ??
      (ENVIRONMENT === "development"),
  // Auto-update the NON-HOME space-root system pattern (default-app) in place.
  // Default ON; a build define (`EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE=false`)
  // can force it off. The home root stays off — it carries real user data and
  // needs the second flag, pending the stable-addressing audit.
  systemPatternAutoUpdate:
    flagValue(EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_DEFINE) ?? true,
  systemPatternAutoUpdateHome: flagValue(
    EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME_DEFINE,
  ),
  // Reactive interpreter (#4514): default off; the felt define normalizes
  // CF_EXPERIMENTAL_INTERPRETER=1 to "true" so one env var flips the whole
  // stack (Deno realms read the env directly; browser realms only see this
  // define).
  experimentalInterpreter: flagValue(EXPERIMENTAL_INTERPRETER_DEFINE),
};
