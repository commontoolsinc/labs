declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_CELL_REP: string | undefined;
  var $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: string | undefined;
  var $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION: string | undefined;
  var $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: string | undefined;
  var $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS:
    | string
    | undefined;
  var $EXPERIMENTAL_COMPUTED_CELL_IDS: string | undefined;
  var $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: string | undefined;
  var $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE: string | undefined;
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
const EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DEFINE =
  typeof $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION === "string"
    ? $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION
    : undefined;
const EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH_DEFINE =
  typeof $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH === "string"
    ? $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH
    : undefined;
const EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_DEFINE =
  typeof $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS ===
      "string"
    ? $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS
    : undefined;
const EXPERIMENTAL_COMPUTED_CELL_IDS_DEFINE =
  typeof $EXPERIMENTAL_COMPUTED_CELL_IDS === "string"
    ? $EXPERIMENTAL_COMPUTED_CELL_IDS
    : undefined;
const EXPERIMENTAL_EAGER_SOURCE_ANNOTATION_DEFINE =
  typeof $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION === "string"
    ? $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION
    : undefined;
const EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_DEFINE =
  typeof $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE === "string"
    ? $EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE
    : undefined;

export const ENVIRONMENT: "development" | "production" =
  ENVIRONMENT_DEFINE === "production" ? ENVIRONMENT_DEFINE : "development";

export const API_URL: URL = new URL(
  API_URL_DEFINE ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

export const COMMIT_SHA: string | undefined = COMMIT_SHA_DEFINE;

/** Results in `true` (on), `false` (off), or `undefined` (default). */
function flagValue(
  name: string,
  flag: string | undefined,
): boolean | undefined {
  if (flag === "true") return true;
  if (flag === "false") return false;
  if (flag !== undefined) {
    console.warn(
      `[shell env] Ignoring ${name}=${JSON.stringify(flag)} — ` +
        `expected "true" or "false" (unset = default).`,
    );
  }
  return undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernCellRep: flagValue(
    "EXPERIMENTAL_MODERN_CELL_REP",
    EXPERIMENTAL_MODERN_CELL_REP_DEFINE,
  ),
  persistentSchedulerState: flagValue(
    "EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE",
    EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE_DEFINE,
  ),
  serverPrimaryExecution: flagValue(
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION",
    EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DEFINE,
  ),
  // The browser's own-side half of the F5 doc-set-watch dial: the worker
  // Runtime installs it as its ambient config, and the replica ANDs it with
  // the server-advertised subcapability. Layered above serverPrimaryExecution
  // (enabling the base flag alone never turns it on); without this key a
  // browser build can never negotiate the subcap, whatever the server says.
  serverPrimaryExecutionDocSetWatch: flagValue(
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH",
    EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH_DEFINE,
  ),
  // The browser's own-side half of the C1.7 context-lattice-claims-v1
  // subcapability: the worker Runtime installs it as its ambient memory
  // config, so this realm's `hello` OFFERS context-scoped claim delivery and
  // the server records the session as negotiating. Layered above
  // serverPrimaryExecution. Without this key a browser build can never
  // negotiate the subcap whatever the server advertises — and because the
  // amendment-11 cohort gate needs EVERY session of a principal to have
  // negotiated, that alone made user lanes un-openable in exactly the
  // deployments worth measuring (client-passivity §5g item 5).
  serverPrimaryExecutionContextLatticeClaims: flagValue(
    "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS",
    EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS_DEFINE,
  ),
  computedCellIds: flagValue(
    "EXPERIMENTAL_COMPUTED_CELL_IDS",
    EXPERIMENTAL_COMPUTED_CELL_IDS_DEFINE,
  ),
  // Debug `.src` source annotation: ON in development builds (so per-primitive
  // source locations keep working for debugging), OFF in production (it is the
  // boot floor's largest single cost). The define overrides either way.
  eagerSourceAnnotation: flagValue(
    "EXPERIMENTAL_EAGER_SOURCE_ANNOTATION",
    EXPERIMENTAL_EAGER_SOURCE_ANNOTATION_DEFINE,
  ) ??
    (ENVIRONMENT === "development"),
  // Auto-update space-root system patterns (default-app AND home) in place.
  // Default ON; a build define (`EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE=false`)
  // can force it off. Home state survival across an in-place roll is pinned by
  // home-golden-replay.test.ts, so the home root no longer needs a second flag.
  systemPatternAutoUpdate: flagValue(
    "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE",
    EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_DEFINE,
  ) ?? true,
};
