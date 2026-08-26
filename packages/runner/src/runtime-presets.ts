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
 * How the seal works — four gates, all in this file:
 *
 * 1. {@link RUNTIME_OPTION_KEYS} is a type-gated exhaustive registry of
 *    `keyof RuntimeOptions`. Adding an option to `RuntimeOptions` without
 *    registering it here is a COMPILE ERROR, which forces the author to
 *    decide, fleet-wide, how every environment treats the new option.
 * 2. {@link EXPERIMENTAL_ENV_VARS} is the canonical (and only) env mapping
 *    for `ExperimentalOptions`, type-gated the same way. A flag that is
 *    deliberately not env-reachable is declared `null` here instead of being
 *    silently absent from one wiring.
 * 3. {@link EXPERIMENTAL_FLAG_AUTHORITY} says, per flag, whether a client
 *    that is not built alongside its server follows the deployment or runs
 *    its own value — type-gated the same way, because a `cf` binary silently
 *    disagreeing with the server it talks to is the same drift one release
 *    further out. {@link experimentalOptionsForDeployedClient} is what such
 *    a client calls instead of {@link experimentalOptionsFromEnv}.
 * 4. Every preset composes the same {@link coreOptions}, so the invariant
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
 * |                            | an explicit `{}`; requiredness is the seal).     |
 * |                            | productionServer/remoteClient resolve an unset   |
 * |                            | `serverExecution` to the first-party default     |
 * |                            | constant; the single-process presets keep the    |
 * |                            | constructor default (OFF). A deployed CLIENT     |
 * |                            | passes what                                      |
 * |                            | `experimentalOptionsForDeployedClient` resolved  |
 * |                            | from the server it talks to (Gate 3)             |
 * | cfcEnforcementMode         | core-pinned `"enforce-explicit"`; overridable in |
 * |                            | patternTest/unitTest (per-test laxer mode) and   |
 * |                            | remoteClient/browserWorker (host-controlled      |
 * |                            | rollout)                                         |
 * | cfcFlowLabels              | core-default (off); remoteClient / browserWorker |
 * |                            | delta (host-controlled rollout)                  |
 * | cfcWriteFloor              | core-default (off) — flip in coreOptions when a  |
 * |                            | first-party rollout begins                       |
 * | cfcTriggerReadGating       | core-default (off) — same                        |
 * | cfcDecomposedEnvelopes     | core-default (off) — flip after every deployed   |
 * |                            | reader resolves stored roots' references         |
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
 * | errorHandlers              | delta (collectors/telemetry), per preset         |
 * | consoleHandler             | delta (productionServer, browserWorker)          |
 * | navigateCallback           | delta (patternTest, remoteClient, browserWorker) |
 * | pieceCreatedCallback       | delta (browserWorker only)                       |
 * | telemetry                  | delta (productionServer, browserWorker)          |
 * | moduleByteCache            | delta (patternTest, remoteClient, unitTest)      |
 * | patternCoverage            | delta (patternTest, remoteClient, browserWorker) |
 * |                            | — test/CI statement-coverage collection, unset   |
 * |                            | elsewhere                                        |
 * | onPatternInstantiated      | delta (patternTest only) — the vintage capture   |
 * |                            | passes it to learn which patterns a run          |
 * |                            | materialized and where. Observation only, and    |
 * |                            | deliberately NOT available to the deployed       |
 * |                            | presets: nothing in production should depend on  |
 * |                            | being told about instantiation                   |
 * | trustSnapshotProvider      | delta (remoteClient, browserWorker)              |
 * | spaceHostMap               | delta (browserWorker only — federation routing   |
 * |                            | is decided by the shell host)                    |
 * | commitBackpressure         | core-default; unitTest delta (scheduler tests    |
 * |                            | shrink the backoff window)                       |
 * | debug                      | core-default everywhere                          |
 * | hideInternalStackFrames    | core-default everywhere                          |
 * | servingPosture             | core-default (false) — NEVER set by a preset:    |
 * |                            | only the SpaceServer's runtime factory (the      |
 * |                            | toolshed ExecutorHost wiring and the executor    |
 * |                            | test harnesses) marks the serving posture, and   |
 * |                            | it hand-rolls its options deliberately           |
 *
 * One named departure a caller can opt into: `cfcPosture: "max-enforcement"`
 * (a `CoreParams` field) swaps the core-default CFC dial rows above for the
 * {@link MAX_ENFORCEMENT_CFC_OPTIONS} bundle, for that one runtime. The
 * per-preset host dials (`cfcEnforcementMode`, `cfcFlowLabels`) still apply
 * over the bundle, so a session-level raise wins either way.
 */

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  SinkMaxConfidentiality,
  TrustSnapshot,
} from "./cfc/mod.ts";
import { STANDARD_PROMPT_CAVEAT_POLICY } from "./cfc/mod.ts";
import type { CommitBackpressurePolicy } from "./scheduler/backpressure.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import type { IStorageManager } from "./storage/interface.ts";
import type { RuntimeTelemetry } from "./telemetry.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ExperimentalOptions,
  ModuleByteCache,
  NavigateCallback,
  PatternInstantiationObserver,
  PieceCreatedCallback,
  RuntimeFetch,
  RuntimeOptions,
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
  "cfcDecomposedEnvelopes",
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
  "patternCoverage",
  "onPatternInstantiated",
  "fetch",
  "servingPosture",
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
  // Content-addressed schemas (Phases 1 and 2) are default-on; env-reachable
  // so a process can opt out with an explicit "false" while the flag exists.
  contentAddressedSchemas: "EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS",
  // Scheduler-v2 lineage (#4090) is default-on. Keep a programmatic rollback
  // override while the flag exists; no environment exposure is needed.
  commitPreconditions: null,
  // Verb-contract WS-C: default-on since the invocation-protocol integration
  // proof (#5244); env-reachable so a process can opt out with an explicit
  // "false" while the flag exists.
  plainResultReceipts: "EXPERIMENTAL_PLAIN_RESULT_RECEIPTS",
  systemPatternAutoUpdate: "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE",
  computedCellIds: "EXPERIMENTAL_COMPUTED_CELL_IDS",
  lazyMaterialization: "EXPERIMENTAL_LAZY_MATERIALIZATION",
  // Reader precedence at link crossings is default-on; env-reachable so a
  // process can opt out with an explicit "false" while the flag exists.
  readerSchemaPrecedence: "EXPERIMENTAL_READER_SCHEMA_PRECEDENCE",
  // Server-execution v2 (docs/specs/server-side-execution/): the
  // deployed-topology presets below resolve an unset flag to
  // `SERVER_EXECUTION_DEFAULT_ENABLED`, so such a process always runs a
  // declared arm. Env-reachable so every server-side process can be flipped
  // either way, and an explicit value always wins over the constant.
  serverExecution: "EXPERIMENTAL_SERVER_EXECUTION",
} as const satisfies Record<keyof ExperimentalOptions, string | null>;

/** The canonical parse: exactly `"true"` / `"false"`, anything else ignored. */
function parseFlagValue(raw: string, source: string): boolean | undefined {
  if (raw === "true" || raw === "false") return raw === "true";
  console.warn(
    `[runtime-presets] Ignoring ${source}="${raw}" — ` +
      `expected "true" or "false" (unset = default).`,
  );
  return undefined;
}

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
    const parsed = parseFlagValue(raw, envVar);
    if (parsed !== undefined) opts[key] = parsed;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Gate 3: which flags a deployed client takes from the server it talks to.
// ---------------------------------------------------------------------------

/**
 * Where a client resolves one flag when it is not built alongside the server
 * it talks to.
 *
 * - `"server"` — the deployment decides. The client adopts the value the
 *   server publishes (see {@link experimentalOptionsForDeployedClient}). Use
 *   this for a flag whose value is visible on the wire, in what gets stored,
 *   or in which side runs what: peers that disagree either refuse each other
 *   or, worse, quietly write data shaped for two different postures.
 * - `"client"` — the flag governs in-process behavior with no wire, storage,
 *   or division-of-labor consequence, so a client is free to run its own
 *   value. Justify the reasoning in a comment beside the entry: over-adopting
 *   costs nothing but a client that diverges where it should not is a silent
 *   corruption.
 */
export type ExperimentalFlagAuthority = "server" | "client";

/**
 * The authority for every flag in {@link ExperimentalOptions}, type-gated the
 * same way as {@link EXPERIMENTAL_ENV_VARS}: a new flag does not compile
 * until it is classified here, so "does a `cf` binary follow the deployment
 * on this?" is a decision on record rather than whatever the default happened
 * to be.
 *
 * Every flag is server-authoritative today. That is the safe direction rather
 * than a coincidence — each one is visible in what gets written (the link and
 * entity-id encodings, receipt contents, schema references), in what the
 * server admits (commit preconditions, per-class admission), in which side
 * runs the compute at all, or in which documents a subscription ships.
 * `"client"` is here for the flag that gates a purely local experiment;
 * nothing qualifies yet.
 */
export const EXPERIMENTAL_FLAG_AUTHORITY = {
  // Link serialization: the two encodings are a hard mismatch, which the
  // memory handshake already refuses to connect across.
  modernCellRep: "server",
  // An emission gate whose rollout is fleet-wide and one-way: a deployment
  // turns it on only once every client of it reads references, and an
  // explicit `false` is how it rolls back. A client still emitting after that
  // writes the form the deployment decided to stop producing.
  contentAddressedSchemas: "server",
  // The server enforces the preconditions this flag makes a commit carry.
  commitPreconditions: "server",
  // Decides what a verb's receipt holds. Under server execution the SERVER
  // runs the handler, so a client on the other value reads back a receipt
  // shaped by a rule it does not share.
  plainResultReceipts: "server",
  // Whether this deployment rolls patterns forward in place. Both runtimes
  // race the update under the flag, OCC-guarded; a client on the other value
  // either never participates or drags a deployment that opted out.
  systemPatternAutoUpdate: "server",
  // Entity-id minting: a peer predating the `computed:` scheme throws on such
  // ids arriving via sync, so the scheme has to be fleet-wide.
  computedCellIds: "server",
  // Changes which paths a lift's argument read, and the consumed-read set is
  // what a commit declares and the server admits against.
  lazyMaterialization: "server",
  // The whole point of the flag is which side computes what is stored.
  serverExecution: "server",
  // The server's traversal decides what a subscription loads, tracks, and
  // ships; a client resolving hops under the other combine rule expects
  // documents the server did not send (or ignores ones it did). The arms
  // read the same stored data, so adoption is safe either way — but both
  // sides must run the same one.
  readerSchemaPrecedence: "server",
} as const satisfies Record<
  keyof ExperimentalOptions,
  ExperimentalFlagAuthority
>;

/**
 * Where a server publishes the experimental posture its own Runtime resolved.
 * Same document as the deployment's DID and commit, so a client that already
 * asks who it is talking to learns the posture in the same breath.
 */
export const SERVER_EXPERIMENTAL_PATH = "/api/meta";

/**
 * Set to `"false"` to keep a client on its own posture and ignore whatever
 * the server publishes. The escape hatch for a deployment publishing
 * something a client cannot run — per-flag `EXPERIMENTAL_*` overrides handle
 * the case where you know WHICH flag, this one the case where you do not.
 */
export const ADOPT_SERVER_FLAGS_ENV = "CF_ADOPT_SERVER_FLAGS";

/**
 * Read a server's published posture into `ExperimentalOptions`.
 *
 * Deliberately incurious about anything it does not recognize. A key this
 * build has no flag for is a NEWER server and entirely normal; a non-boolean
 * value is a malformed declaration and is dropped with a warning rather than
 * coerced. Neither is grounds for refusing to run — a client that cannot read
 * the posture keeps its built-in defaults, which is what it did before the
 * server published anything at all.
 */
export function parseServerExperimentalOptions(
  declared: unknown,
): ExperimentalOptions {
  if (declared === null || typeof declared !== "object") return {};
  const opts: ExperimentalOptions = {};
  for (const key of Object.keys(EXPERIMENTAL_FLAG_AUTHORITY)) {
    const value = (declared as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      console.warn(
        `[runtime-presets] Ignoring server-published ${key}=` +
          `${JSON.stringify(value)} — expected a boolean.`,
      );
      continue;
    }
    opts[key as keyof ExperimentalOptions] = value;
  }
  return opts;
}

/**
 * Resolve one client's posture from what the server published and what its
 * own environment says, in that order of increasing authority:
 *
 * 1. an explicit `EXPERIMENTAL_*` wins outright — it is the documented
 *    rollback lever and CI's way to pin a lane, and a server able to overrule
 *    it would leave neither mechanism working;
 * 2. otherwise a `"server"` flag takes the published value;
 * 3. otherwise the flag stays unset and the built-in default governs, which
 *    is exactly what an old server, an unreachable one, or a `"client"` flag
 *    leaves behind.
 */
export function adoptServerExperimentalOptions(
  server: ExperimentalOptions,
  env: ExperimentalOptions,
  /**
   * The classification to resolve against. Defaults to the registry, and is
   * a parameter so the `"client"` arm stays exercised while no first-party
   * flag carries it.
   */
  authorities: Record<
    keyof ExperimentalOptions,
    ExperimentalFlagAuthority
  > = EXPERIMENTAL_FLAG_AUTHORITY,
): ExperimentalOptions {
  const opts: ExperimentalOptions = { ...env };
  for (
    const [key, authority] of Object.entries(authorities) as [
      keyof ExperimentalOptions,
      ExperimentalFlagAuthority,
    ][]
  ) {
    if (authority !== "server") continue;
    if (opts[key] !== undefined) continue;
    const published = server[key];
    if (published !== undefined) opts[key] = published;
  }
  return opts;
}

export interface DeployedClientExperimentalParams {
  /** The deployment this client runs against. */
  apiUrl: URL;

  /** Reads this process's environment; pass `Deno.env.get` in Deno contexts. */
  env: EnvReader;

  /**
   * Cancels the request. A caller whose startup is cancellable must pass its
   * signal: without one, a deployment that accepts the connection and then
   * says nothing holds the caller here for as long as it stays silent, and
   * no shutdown can reach it.
   */
  signal?: AbortSignal;

  /** Injectable for tests; the real `fetch` otherwise. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The posture a client that is NOT built alongside its server should run:
 * the deployment's own, with this process's explicit `EXPERIMENTAL_*`
 * overriding it flag by flag.
 *
 * Call it in place of {@link experimentalOptionsFromEnv} wherever a runtime
 * talks to a deployed API — `cf`, the pieces controller, the agents host, the
 * admin CLIs. The presets that run against LOCAL emulated storage have no
 * server to ask and keep reading the environment alone.
 *
 * Every way of not getting an answer — an old server with no posture on its
 * meta document, an unreachable one, a body that will not parse — resolves to
 * the environment alone. Absence of a declaration is not a declaration, and
 * the caller is about to fail loudly on its real work if the server is
 * genuinely down; failing here first would only obscure that.
 *
 * An aborted `signal` is the one case that does NOT resolve: the caller
 * asked to stop, so this throws the abort reason rather than handing back a
 * posture nobody is going to use. That holds whether the abort arrives before
 * the call, while the request is in flight, or while its body is being read —
 * every one of those paths ends at the same throw.
 */
export async function experimentalOptionsForDeployedClient(
  params: DeployedClientExperimentalParams,
): Promise<ExperimentalOptions> {
  // Before anything else, including the opt-out below: a caller that has
  // already stopped gets the abort, not a posture.
  params.signal?.throwIfAborted();
  const env = experimentalOptionsFromEnv(params.env);
  const raw = params.env(ADOPT_SERVER_FLAGS_ENV);
  if (
    raw !== undefined && parseFlagValue(raw, ADOPT_SERVER_FLAGS_ENV) === false
  ) {
    return env;
  }
  const fetchImpl = params.fetch ?? globalThis.fetch;
  let declared: unknown;
  try {
    // The signal rides the request, which is what makes the BODY read below
    // cancellable too: aborting a signal passed to `fetch` terminates the
    // ongoing fetch and errors the response's stream, so a stalled
    // `response.json()` rejects rather than hanging, and lands in the catch.
    const response = await fetchImpl(
      new URL(SERVER_EXPERIMENTAL_PATH, params.apiUrl),
      params.signal !== undefined ? { signal: params.signal } : {},
    );
    if (!response.ok) {
      // Discard the body rather than leaving the connection holding an
      // unread stream. An error page is not a posture even when it parses
      // as one.
      await response.body?.cancel();
      return env;
    }
    declared = ((await response.json()) as { experimental?: unknown })
      ?.experimental;
  } catch {
    // A cancelled startup is the caller's decision, not a server that failed
    // to answer: propagate it instead of resolving a posture into a runtime
    // construction the caller is abandoning.
    params.signal?.throwIfAborted();
    return env;
  }
  return adoptServerExperimentalOptions(
    parseServerExperimentalOptions(declared),
    env,
  );
}

// ---------------------------------------------------------------------------
// The max-enforcement CFC posture (CT-2075's named bundle).
// ---------------------------------------------------------------------------

/**
 * Names of the CFC posture bundles a preset caller can opt into. One posture
 * exists today; the type is here so the next one is an addition, not a
 * redesign.
 */
export type CfcPosture = "max-enforcement";

/**
 * Confidentiality ceilings of the max-enforcement posture: every network-fetch
 * egress sink is public-only (an empty ceiling admits no confidential atom),
 * so labeled data cannot leave through the network-fetch sinks.
 *
 * The llm sinks (`llm`, `llmDialog`, `generateText`, `generateObject`) carry
 * no ceiling, and a sink with no ceiling gets NO gate: under this posture,
 * llm-sink release is ungoverned — any confidentiality, a secret as much as a
 * risk caveat, reaches the llm sinks without a policy evaluation running for
 * them. Ungated rather than public-only because ceiling membership is exact
 * clause subsumption (`atomsOutsideCeiling`) — a ceiling entry cannot admit
 * "any material-risk caveat regardless of `source`" — while risk-caveated
 * ingested content is exactly what an llm sink exists to process, so a
 * public-only ceiling would refuse the flows the sink is for. Governing llm
 * release needs a boundary-scoped admission mechanism (a public-only ceiling
 * paired with an exchange rule that admits the material-risk family at
 * llm-class boundaries), which this posture does not yet carry.
 */
export const MAX_ENFORCEMENT_SINK_CEILINGS: SinkMaxConfidentiality = Object
  .freeze({
    fetchBinary: Object.freeze([]),
    fetchText: Object.freeze([]),
    fetchJson: Object.freeze([]),
    fetchJsonUnchecked: Object.freeze([]),
    fetchProgram: Object.freeze([]),
    streamData: Object.freeze([]),
  });

/**
 * The max-enforcement CFC posture: every staged-rollout enforcement dial at
 * its enforcing value, as one named opt-in bundle (CT-2075 ran them together
 * and found they co-exist as one system; this is that experiment's dial set,
 * landed at the seam it designated). A preset caller opts in through
 * {@link CoreParams.cfcPosture}; the fleet posture in {@link coreOptions}
 * is unchanged.
 *
 * Deliberately NOT in the bundle:
 * - `cfcEnforcementMode` — the core pin (`enforce-explicit`) stands; a host
 *   raises one session to `enforce-strict` through its own preset dial
 *   (remoteClient/browserWorker), and the bundle's `persist` flow labels are
 *   what make that raise conform (strict requires persist).
 * - `cfcDecomposedEnvelopes` — gated on every deployed reader resolving
 *   stored roots' references, a readiness question, not an enforcement one.
 * - `cfcTrustConfig` — deployment-specific declarations; nothing generic to
 *   bundle.
 * - `cfcPrefixProvenanceStats` — measurement, not enforcement.
 */
export const MAX_ENFORCEMENT_CFC_OPTIONS = Object.freeze(
  {
    cfcFlowLabels: "persist",
    cfcWriteFloor: "enforce",
    cfcTriggerReadGating: true,
    cfcPolicyEvaluation: "enforce",
    cfcPolicyRecords: Object.freeze([...STANDARD_PROMPT_CAVEAT_POLICY]),
    cfcDeclaredMonotonicity: "enforce",
    cfcLabelMetadataProtection: "enforce",
    cfcSinkMaxConfidentiality: MAX_ENFORCEMENT_SINK_CEILINGS,
  } as const,
) satisfies Partial<RuntimeOptions>;

// ---------------------------------------------------------------------------
// Gate 4: the shared core all presets compose.
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

  /**
   * Opt this runtime into a named CFC posture bundle
   * ({@link MAX_ENFORCEMENT_CFC_OPTIONS}). Applied in {@link coreOptions},
   * under the per-preset host dials, so a host that raises
   * `cfcEnforcementMode` or `cfcFlowLabels` for one session still wins.
   * Unset means the fleet posture: the core pin plus constructor defaults.
   */
  cfcPosture?: CfcPosture;
}

/**
 * The invariant first-party posture, written once. Rollout dials (the CFC
 * modes) get flipped HERE, in one reviewed place, for every preset user at
 * once — the constructor defaults then only govern non-preset constructions.
 */

/**
 * The first-party server-execution default for the DEPLOYED-TOPOLOGY
 * presets (server-execution v2, docs/plans/server-execution-v2.md Phase
 * 7's flip): `productionServer` and `remoteClient` run against a serving
 * toolshed, so an UNSET flag resolves to
 * `SERVER_EXECUTION_DEFAULT_ENABLED` — explicit in the returned options,
 * which claims the process's ambient flag through the Runtime's enabler.
 * An explicit value (env "false" — the OFF arm / rollback lever) always
 * wins. The single-process presets (`patternTest`, `localDev`,
 * `unitTest`) deliberately do NOT apply it: an emulated-storage runtime
 * has no serving host, so it runs the derive-and-commit model (the
 * ambient baseline, OFF) by construction — see
 * `docs/development/EXPERIMENTAL_OPTIONS.md`.
 */
function withServerExecutionDefault(
  experimental: ExperimentalOptions,
): ExperimentalOptions {
  return {
    ...experimental,
    serverExecution: experimental.serverExecution ??
      SERVER_EXECUTION_DEFAULT_ENABLED,
  };
}

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
    // cfcDecomposedEnvelopes /
    // cfcPolicyEvaluation / cfcLabelMetadataProtection /
    // cfcDeclaredMonotonicity / cfcPolicyRecords /
    // cfcTrustConfig / cfcSinkMaxConfidentiality ride the constructor
    // defaults (off / none) — deliberately absent here until a first-party
    // rollout begins. A caller that opts into `cfcPosture` gets the named
    // bundle's values instead, for this one runtime.
    ...(params.cfcPosture === "max-enforcement"
      ? MAX_ENFORCEMENT_CFC_OPTIONS
      : {}),
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
}

export interface RemoteClientPresetParams extends CoreParams {
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;

  /** Shared compiled-module-byte cache (integration suites). */
  moduleByteCache?: ModuleByteCache;

  /** Trust provenance for CFC-relevant writes (pieces controller). */
  trustSnapshotProvider?: () => TrustSnapshot | undefined;

  /** Statement-coverage collector for the pattern integration harness. */
  patternCoverage?: PatternCoverageCollector;

  /**
   * Host-controlled rollout dials, the browserWorker precedent: a client
   * host (cf-harness's fabric session) may raise enforcement and turn on
   * flow-label persistence for one session without moving the fleet posture
   * in `coreOptions`.
   */
  cfcEnforcementMode?: CfcEnforcementMode;
  cfcFlowLabels?: CfcFlowLabelsMode;
}

export interface PatternTestPresetParams extends CoreParams {
  /** Mock fetch honoring test-declared `fetchMocks` (CT-1768). */
  fetch?: RuntimeFetch;
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;
  moduleByteCache?: ModuleByteCache;

  /** Per-test laxer mode; defaults to the shared core pin. */
  cfcEnforcementMode?: CfcEnforcementMode;

  /** Statement-coverage collector for `cf test` and the pattern harnesses. */
  patternCoverage?: PatternCoverageCollector;

  /** Records what a run materializes; see the vintage capture. */
  onPatternInstantiated?: PatternInstantiationObserver;
}

export interface BrowserWorkerPresetParams extends CoreParams {
  /** Map from space DIDs to HTTP or HTTPS origins selected by the shell host. */
  spaceHostMap?: Record<string, string>;

  /** Host-controlled rollout dials, from `InitializationData`. */
  cfcEnforcementMode?: CfcEnforcementMode;
  cfcFlowLabels?: CfcFlowLabelsMode;
  trustSnapshotProvider?: () => TrustSnapshot | undefined;
  telemetry?: RuntimeTelemetry;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  navigateCallback?: NavigateCallback;
  pieceCreatedCallback?: PieceCreatedCallback;

  /** Statement-coverage collector, set only on the coverage-collecting shell build. */
  patternCoverage?: PatternCoverageCollector;
}

export interface UnitTestPresetParams extends Omit<CoreParams, "experimental"> {
  /** Optional here (unlike the first-party presets): unit tests default to no flags. */
  experimental?: ExperimentalOptions;
  fetch?: RuntimeFetch;
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
      ...coreOptions({
        ...params,
        experimental: withServerExecutionDefault(params.experimental),
      }),
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
    };
  },

  /**
   * Short-lived client runtime operating against a deployed API (cast-admin,
   * pieces controller, `cf acl` / `cf piece`). Same posture as
   * productionServer; the deltas are collectors and caches.
   */
  remoteClient(params: RemoteClientPresetParams): RuntimeOptions {
    return {
      ...coreOptions({
        ...params,
        experimental: withServerExecutionDefault(params.experimental),
      }),
      patternEnvironment: { apiUrl: params.apiUrl },
      ...(params.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: params.cfcEnforcementMode }
        : {}),
      ...(params.cfcFlowLabels !== undefined
        ? { cfcFlowLabels: params.cfcFlowLabels }
        : {}),
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
      ...(params.patternCoverage !== undefined
        ? { patternCoverage: params.patternCoverage }
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
      ...(params.patternCoverage !== undefined
        ? { patternCoverage: params.patternCoverage }
        : {}),
      ...(params.onPatternInstantiated !== undefined
        ? { onPatternInstantiated: params.onPatternInstantiated }
        : {}),
    };
  },

  /** Local CLI check runtime: emulated storage, real fetch. */
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
      ...(params.patternCoverage !== undefined
        ? { patternCoverage: params.patternCoverage }
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
