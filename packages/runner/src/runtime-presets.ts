/**
 * First-party `RuntimeOptions` presets — the one place Runtime construction
 * config is assembled for our own environments (CT-1814).
 *
 * CT-1811 was a harness-vs-runtime divergence on the LOAD path, sealed by
 * `PatternManager.compileAndRegisterModules`. This module seals the second
 * axis: CONSTRUCTION-CONFIG drift. Before it, 13+ sites hand-rolled a subset
 * of `RuntimeOptions`, so a new option (or a changed constructor default)
 * could land unevenly and make the harness silently behave differently from
 * production. Observed instances: three parallel copies of the
 * env→`ExperimentalOptions` mapping whose parsers disagreed on non-canonical
 * values; the multi-user test worker not honoring `EXPERIMENTAL_*` while the
 * single-user runner did; client CLIs running patterns against the builder's
 * hardcoded-localhost `patternEnvironment` fallback.
 *
 * How the seal works — three gates, all in this file:
 *
 * 1. {@link RUNTIME_OPTION_KEYS} is a type-gated exhaustive registry of
 *    `keyof RuntimeOptions`. Adding an option to `RuntimeOptions` without
 *    registering it here is a COMPILE ERROR, which forces the author to
 *    decide, fleet-wide, how every environment treats the new option.
 * 2. {@link EXPERIMENTAL_ENV_VARS} is the canonical (and only) env mapping
 *    for `ExperimentalOptions`, type-gated the same way. A flag that is
 *    deliberately not env-reachable is declared `null` here instead of being
 *    silently absent from one wiring.
 * 3. Every preset composes the same {@link coreOptions}, so the invariant
 *    posture (today: the CFC dials) is written once. The conformance test
 *    (`runner/test/runtime-presets.test.ts`) pins each preset's full output
 *    as a golden, so any change to fleet posture is a visible diff there.
 *
 * Presets return a complete `RuntimeOptions`; call sites keep the
 * `new Runtime(...)` expression so construction stays greppable. Deliberate
 * per-environment deltas (mock fetch, error collectors, byte caches) are
 * explicit, documented parameters — a preset that hid them would be worse
 * than hand-rolled config. This is a convention, not a gate: a site CAN still
 * hand-roll `RuntimeOptions`, but first-party code should not.
 *
 * Classification of every option (the conformance test asserts this table):
 *
 * | Option                     | Treatment                                        |
 * | -------------------------- | ------------------------------------------------ |
 * | apiUrl                     | per-site (required param)                        |
 * | storageManager             | per-site (required param; open vs emulate, and   |
 * |                            | its identity/session, are the caller's domain)   |
 * | experimental               | per-site (required param — pass                  |
 * |                            | `experimentalOptionsFromEnv(...)`, host data, or |
 * |                            | an explicit `{}`; requiredness is the seal)      |
 * | cfcEnforcementMode         | core-pinned `"enforce-explicit"`; overridable in |
 * |                            | patternTest/unitTest (per-test laxer mode) and   |
 * |                            | browserWorker (host-controlled rollout)          |
 * | cfcFlowLabels              | core-default (off); browserWorker delta          |
 * | cfcWriteFloor              | core-default (off) — flip in coreOptions when a  |
 * |                            | first-party rollout begins                       |
 * | cfcTriggerReadGating       | core-default (off) — same                        |
 * | cfcPolicyEvaluation        | core-default (off) — same                        |
 * | cfcLabelMetadataProtection | core-default (off) — same (inv-12 Stage 1        |
 * |                            | rollout: observe first, then enforce)            |
 * | cfcDeclaredMonotonicity    | core-default (off) — same (WP5 §8.12.1 rollout:  |
 * |                            | observe first, then enforce)                     |
 * | cfcPolicyRecords           | core-default (none declared) — same              |
 * | cfcPrefixProvenanceStats   | core-default (off) — measurement opt-in, per     |
 * |                            | deployment (value-level provenance Stage 0)      |
 * | cfcTrustConfig             | core-default (none declared) — same              |
 * | cfcSinkMaxConfidentiality  | core-default (none declared) — same              |
 * | patternEnvironment         | pinned from apiUrl in productionServer /         |
 * |                            | remoteClient / browserWorker (patterns fetch     |
 * |                            | against the real deployment, not the builder's   |
 * |                            | localhost fallback); constructor default in the  |
 * |                            | local presets (patternTest/localDev/unitTest)    |
 * | fetch                      | real everywhere; patternTest delta (mock)        |
 * | externalSinkDisposition   | allow everywhere; productionServer delta for     |
 * |                            | executor shadow suppression                      |
 * | errorHandlers              | delta (collectors/telemetry), per preset         |
 * | consoleHandler             | delta (productionServer, browserWorker)          |
 * | navigateCallback           | delta (patternTest, remoteClient, browserWorker) |
 * | pieceCreatedCallback       | delta (browserWorker only)                       |
 * | telemetry                  | delta (productionServer, browserWorker)          |
 * | moduleByteCache            | delta (patternTest, remoteClient, unitTest)      |
 * | trustSnapshotProvider      | delta (remoteClient, browserWorker)              |
 * | spaceHostMap               | delta (browserWorker only — federation routing   |
 * |                            | is decided by the shell host)                    |
 * | commitBackpressure         | core-default; unitTest delta (scheduler tests    |
 * |                            | shrink the backoff window)                       |
 * | debug                      | core-default everywhere                          |
 * | hideInternalStackFrames    | core-default everywhere                          |
 */

import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  TrustSnapshot,
} from "./cfc/mod.ts";
import type { CommitBackpressurePolicy } from "./scheduler/backpressure.ts";
import type {
  ExternalSinkDispositionPolicy,
  IStorageManager,
} from "./storage/interface.ts";
import type { RuntimeTelemetry } from "./telemetry.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ExperimentalOptions,
  ModuleByteCache,
  NavigateCallback,
  PieceCreatedCallback,
  RuntimeOptions,
  VersionSkewHandler,
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// Gate 1: the exhaustive option registry.
// ---------------------------------------------------------------------------

/**
 * Every key of `RuntimeOptions`, by hand. The `satisfies` clause rejects
 * entries that are not real options; {@link _allOptionsClassified} below
 * rejects real options that are missing here. Together they force every
 * future `RuntimeOptions` addition through this file (and its review) before
 * it can ship — the point is not the list, it is the forced decision about
 * how each first-party environment treats the new option.
 */
export const RUNTIME_OPTION_KEYS = [
  "apiUrl",
  "spaceHostMap",
  "clientVersion",
  "onVersionSkew",
  "storageManager",
  "consoleHandler",
  "errorHandlers",
  "patternEnvironment",
  "navigateCallback",
  "pieceCreatedCallback",
  "debug",
  "telemetry",
  "experimental",
  "cfcEnforcementMode",
  "cfcFlowLabels",
  "cfcWriteFloor",
  "cfcTriggerReadGating",
  "cfcPolicyEvaluation",
  "cfcLabelMetadataProtection",
  "cfcDeclaredMonotonicity",
  "cfcPolicyRecords",
  "cfcPrefixProvenanceStats",
  "cfcTrustConfig",
  "cfcSinkMaxConfidentiality",
  "trustSnapshotProvider",
  "hideInternalStackFrames",
  "commitBackpressure",
  "moduleByteCache",
  "fetch",
  "externalSinkDisposition",
] as const satisfies readonly (keyof RuntimeOptions)[];

export type RuntimeOptionKey = (typeof RUNTIME_OPTION_KEYS)[number];

type MissingOptionKeys = Exclude<keyof RuntimeOptions, RuntimeOptionKey>;
// If the next line errors, a new `RuntimeOptions` key exists that the presets
// have not classified: add it to RUNTIME_OPTION_KEYS, decide its row in the
// table above, and extend the conformance-test goldens. The type error names
// the missing key(s).
const _unclassifiedOptions: never[] = [] as MissingOptionKeys[];

// ---------------------------------------------------------------------------
// Gate 2: the canonical experimental-flag env mapping.
// ---------------------------------------------------------------------------

/** Reads one environment variable; pass `Deno.env.get` in Deno contexts. */
export type EnvReader = (name: string) => string | undefined;

/**
 * The one env mapping for {@link ExperimentalOptions}. `null` declares a flag
 * as deliberately programmatic-only, so "not env-wired" is a decision on
 * record rather than an omission in one of several parallel wirings.
 * (Previously toolshed, background-piece-service, and the CLI each kept their
 * own copy, and the two parser families disagreed on non-canonical values:
 * `flagValue()` read anything but "false" as true, the CLI read anything but
 * "true" as false — so `EXPERIMENTAL_MODERN_CELL_REP=1` enabled the flag on
 * toolshed and disabled it under `cf test`.)
 *
 * Every experimental flag is catalogued in
 * `docs/development/EXPERIMENTAL_OPTIONS.md`; update that registry when adding
 * or removing an entry here.
 */
export const EXPERIMENTAL_ENV_VARS = {
  modernCellRep: "EXPERIMENTAL_MODERN_CELL_REP",
  persistentSchedulerState: "EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE",
  serverPrimaryExecution: "EXPERIMENTAL_SERVER_PRIMARY_EXECUTION",
  eagerSourceAnnotation: "EXPERIMENTAL_EAGER_SOURCE_ANNOTATION",
  // Scheduler-v2 lineage (#4090) is default-on. Keep a programmatic rollback
  // override while the flag exists; no environment exposure is needed.
  commitPreconditions: null,
  systemPatternAutoUpdate: "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE",
  systemPatternAutoUpdateHome: "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE_HOME",
} as const satisfies Record<keyof ExperimentalOptions, string | null>;

/**
 * Read `ExperimentalOptions` from the environment via the canonical mapping.
 * Accepted values are exactly `"true"` and `"false"`; unset means "use the
 * default". Anything else is ignored WITH A WARNING rather than coerced —
 * the old wirings silently coerced garbage, in opposite directions.
 */
export function experimentalOptionsFromEnv(
  env: EnvReader,
): ExperimentalOptions {
  const opts: ExperimentalOptions = {};
  for (
    const [key, envVar] of Object.entries(EXPERIMENTAL_ENV_VARS) as [
      keyof ExperimentalOptions,
      string | null,
    ][]
  ) {
    if (envVar === null) continue;
    const raw = env(envVar);
    if (raw === undefined) continue;
    if (raw === "true" || raw === "false") {
      opts[key] = raw === "true";
    } else {
      console.warn(
        `[runtime-presets] Ignoring ${envVar}="${raw}" — ` +
          `expected "true" or "false" (unset = default).`,
      );
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Gate 3: the shared core all presets compose.
// ---------------------------------------------------------------------------

interface CoreParams {
  /** Base URL of the memory/API service this runtime talks to. */
  apiUrl: URL;
  /** Storage backend — `StorageManager.open(...)` against a deployment, or `.emulate(...)` in-memory. */
  storageManager: IStorageManager;
  /**
   * Experimental flags. Required on purpose: pass
   * `experimentalOptionsFromEnv(Deno.env.get)` where the environment should
   * be honored, host-provided data where the host decides (browser worker),
   * or an explicit `{}` — each of which is a visible, reviewable choice,
   * where an omitted field was silent drift.
   */
  experimental: ExperimentalOptions;
}

/**
 * The invariant first-party posture, written once. Rollout dials (the CFC
 * modes) get flipped HERE, in one reviewed place, for every preset user at
 * once — the constructor defaults then only govern non-preset constructions.
 */
function coreOptions(params: CoreParams): RuntimeOptions {
  return {
    apiUrl: params.apiUrl,
    storageManager: params.storageManager,
    experimental: params.experimental,
    // Pinned, not defaulted: several sites pinned this individually so that a
    // changed constructor default could not silently relax them; the pin now
    // lives once. Same value as the constructor default today.
    cfcEnforcementMode: "enforce-explicit",
    // cfcFlowLabels / cfcWriteFloor / cfcTriggerReadGating /
    // cfcPolicyEvaluation / cfcLabelMetadataProtection /
    // cfcDeclaredMonotonicity / cfcPolicyRecords /
    // cfcTrustConfig / cfcSinkMaxConfidentiality ride the constructor
    // defaults (off / none) — deliberately absent here until a first-party
    // rollout begins.
  };
}

// ---------------------------------------------------------------------------
// The presets.
// ---------------------------------------------------------------------------

export interface ProductionServerPresetParams extends CoreParams {
  /**
   * Base URL patterns see (`patternEnvironment.apiUrl`) for relative fetches.
   * Defaults to `apiUrl`; toolshed passes its public API_URL here while
   * `apiUrl` carries MEMORY_URL.
   */
  patternApiUrl?: URL;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  telemetry?: RuntimeTelemetry;
  /** Executor workers inject a deny/broker boundary; ordinary servers omit. */
  fetch?: typeof globalThis.fetch;
  externalSinkDisposition?: ExternalSinkDispositionPolicy;
}

export interface RemoteClientPresetParams extends CoreParams {
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;
  /** Shared compiled-module-byte cache (integration suites). */
  moduleByteCache?: ModuleByteCache;
  /** Trust provenance for CFC-relevant writes (pieces controller). */
  trustSnapshotProvider?: () => TrustSnapshot | undefined;
}

export interface PatternTestPresetParams extends CoreParams {
  /** Mock fetch honoring test-declared `fetchMocks` (CT-1768). */
  fetch?: typeof globalThis.fetch;
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;
  moduleByteCache?: ModuleByteCache;
  /** Per-test laxer mode; defaults to the shared core pin. */
  cfcEnforcementMode?: CfcEnforcementMode;
}

export interface BrowserWorkerPresetParams extends CoreParams {
  /** Space DID → host base URL map (federation); decided by the shell host. */
  spaceHostMap?: Record<string, string>;
  /** This client build's git sha, for the system-pattern update version gate. */
  clientVersion?: string;
  /** Host-controlled rollout dials, from `InitializationData`. */
  cfcEnforcementMode?: CfcEnforcementMode;
  cfcFlowLabels?: CfcFlowLabelsMode;
  trustSnapshotProvider?: () => TrustSnapshot | undefined;
  telemetry?: RuntimeTelemetry;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;
  pieceCreatedCallback?: PieceCreatedCallback;
  /** System-pattern update version-skew signal → shell IPC. */
  onVersionSkew?: VersionSkewHandler;
}

export interface UnitTestPresetParams extends Omit<CoreParams, "experimental"> {
  /** Optional here (unlike the first-party presets): unit tests default to no flags. */
  experimental?: ExperimentalOptions;
  fetch?: typeof globalThis.fetch;
  errorHandlers?: ErrorHandler[];
  moduleByteCache?: ModuleByteCache;
  cfcEnforcementMode?: CfcEnforcementMode;
  /** Scheduler tests shrink the backoff/retry window. */
  commitBackpressure?: Partial<CommitBackpressurePolicy>;
}

export const runtimePresets = {
  /**
   * Long-running server process (toolshed, background-piece-service main and
   * worker). Remote storage, real fetch, patterns fetch against the
   * deployment's own API base.
   */
  productionServer(params: ProductionServerPresetParams): RuntimeOptions {
    return {
      ...coreOptions(params),
      patternEnvironment: { apiUrl: params.patternApiUrl ?? params.apiUrl },
      ...(params.consoleHandler !== undefined
        ? { consoleHandler: params.consoleHandler }
        : {}),
      ...(params.errorHandlers !== undefined
        ? { errorHandlers: params.errorHandlers }
        : {}),
      ...(params.telemetry !== undefined
        ? { telemetry: params.telemetry }
        : {}),
      ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
      ...(params.externalSinkDisposition !== undefined
        ? { externalSinkDisposition: params.externalSinkDisposition }
        : {}),
    };
  },

  /**
   * Short-lived client runtime operating against a deployed API (cast-admin,
   * pieces controller, `cf acl` / `cf piece`). Same posture as
   * productionServer; the deltas are collectors and caches.
   */
  remoteClient(params: RemoteClientPresetParams): RuntimeOptions {
    return {
      ...coreOptions(params),
      patternEnvironment: { apiUrl: params.apiUrl },
      ...(params.errorHandlers !== undefined
        ? { errorHandlers: params.errorHandlers }
        : {}),
      ...(params.navigateCallback !== undefined
        ? { navigateCallback: params.navigateCallback }
        : {}),
      ...(params.moduleByteCache !== undefined
        ? { moduleByteCache: params.moduleByteCache }
        : {}),
      ...(params.trustSnapshotProvider !== undefined
        ? { trustSnapshotProvider: params.trustSnapshotProvider }
        : {}),
    };
  },

  /**
   * Pattern-test harness runtime (single-user `cf test`, the multi-user test
   * worker, the generated-patterns integration harness). Local by design:
   * `patternEnvironment` stays on the constructor default so unmocked
   * relative fetches keep today's local-dev fall-through.
   */
  patternTest(params: PatternTestPresetParams): RuntimeOptions {
    const core = coreOptions(params);
    return {
      ...core,
      ...(params.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: params.cfcEnforcementMode }
        : {}),
      ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
      ...(params.errorHandlers !== undefined
        ? { errorHandlers: params.errorHandlers }
        : {}),
      ...(params.navigateCallback !== undefined
        ? { navigateCallback: params.navigateCallback }
        : {}),
      ...(params.moduleByteCache !== undefined
        ? { moduleByteCache: params.moduleByteCache }
        : {}),
    };
  },

  /** Local CLI development runtime (`cf check` / `cf dev`): emulated storage, real fetch. */
  localDev(params: CoreParams): RuntimeOptions {
    return coreOptions(params);
  },

  /**
   * In-browser worker runtime behind the shell (runtime-client's
   * RuntimeProcessor). Everything host-decided arrives as data from
   * `InitializationData` — experimental flags are the shell's build-time
   * defines, the CFC dials are host-controlled rollout.
   */
  browserWorker(params: BrowserWorkerPresetParams): RuntimeOptions {
    return {
      ...coreOptions(params),
      patternEnvironment: { apiUrl: params.apiUrl },
      ...(params.spaceHostMap !== undefined
        ? { spaceHostMap: params.spaceHostMap }
        : {}),
      ...(params.clientVersion !== undefined
        ? { clientVersion: params.clientVersion }
        : {}),
      ...(params.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: params.cfcEnforcementMode }
        : {}),
      ...(params.cfcFlowLabels !== undefined
        ? { cfcFlowLabels: params.cfcFlowLabels }
        : {}),
      ...(params.trustSnapshotProvider !== undefined
        ? { trustSnapshotProvider: params.trustSnapshotProvider }
        : {}),
      ...(params.telemetry !== undefined
        ? { telemetry: params.telemetry }
        : {}),
      ...(params.consoleHandler !== undefined
        ? { consoleHandler: params.consoleHandler }
        : {}),
      ...(params.errorHandlers !== undefined
        ? { errorHandlers: params.errorHandlers }
        : {}),
      ...(params.navigateCallback !== undefined
        ? { navigateCallback: params.navigateCallback }
        : {}),
      ...(params.pieceCreatedCallback !== undefined
        ? { pieceCreatedCallback: params.pieceCreatedCallback }
        : {}),
      ...(params.onVersionSkew !== undefined
        ? { onVersionSkew: params.onVersionSkew }
        : {}),
    };
  },

  /**
   * Bare unit-test runtime: the `{ apiUrl, storageManager: emulate }` shape
   * the runner test suite constructs by hand today. Adoption is incremental
   * and optional (CT-1814 scopes the migration to harness + production
   * sites); it exists so new tests have a preset to reach for.
   */
  unitTest(params: UnitTestPresetParams): RuntimeOptions {
    return {
      ...coreOptions({ ...params, experimental: params.experimental ?? {} }),
      ...(params.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: params.cfcEnforcementMode }
        : {}),
      ...(params.fetch !== undefined ? { fetch: params.fetch } : {}),
      ...(params.errorHandlers !== undefined
        ? { errorHandlers: params.errorHandlers }
        : {}),
      ...(params.moduleByteCache !== undefined
        ? { moduleByteCache: params.moduleByteCache }
        : {}),
      ...(params.commitBackpressure !== undefined
        ? { commitBackpressure: params.commitBackpressure }
        : {}),
    };
  },
} as const;
