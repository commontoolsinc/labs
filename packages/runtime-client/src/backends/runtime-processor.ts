import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  toCompactDebugString,
  toStructuredDebugValue,
} from "@commonfabric/data-model/value-debug";
import {
  type SiteTable,
  siteTableCause,
  siteTableSchema,
} from "@commonfabric/home-schemas";
import {
  normalizeRenderConfidentialityCeiling,
  normalizeRenderDeclassificationPolicy,
  type RenderConfidentialityCeiling,
  type RenderDeclassificationPolicy,
  WorkerReconciler,
} from "@commonfabric/html/worker";
import { DID, Identity, type Session } from "@commonfabric/identity";
import type { Program } from "@commonfabric/js-compiler";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { setLLMUrl } from "@commonfabric/llm";
import { type ACL, isACLUser, isCapability } from "@commonfabric/memory/acl";
import {
  type OperationFieldAddress,
  toValuePath,
} from "@commonfabric/memory/v2";
import {
  PieceController,
  PiecesController,
  type PreparedPieceSourceChange,
  readPieceSourceMetadata,
  readPieceSourceRevision,
  readPieceSourceState,
} from "@commonfabric/piece/ops";
import {
  ACLManager,
  type BrowserWorkerPresetParams,
  type Cancel,
  type Cell,
  convertCellsToLinks,
  entityIdFrom,
  getCellOrThrow,
  getPatternIdentityRef,
  hasOperationStorageCapability,
  type IOperationStorageCapability,
  isCell,
  isCellResult,
  markRendererInputTx,
  markUiInputBlindWriteTx,
  normalizeSpaceHost,
  PatternCoverageCollector,
  Runtime,
  runtimePresets,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  setBlindStructuralTarget,
  setPatternEnvironment,
  type SigilLink,
  SpaceHostValidationError,
  unmarkUiInputBlindWriteTx,
} from "@commonfabric/runner";
import type { RuntimeOptions } from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  createRenderConfidentialityResolver,
  createRuntimeSpaceMembershipProvider,
  redactCaveatSourcesForDisplay,
  redactSigilCfcLabelViewsForDisplay,
  type RenderConfidentialityResolver,
  type SpaceMembershipProvider,
  stripSigilCfcLabelViews,
} from "@commonfabric/runner/cfc";
import { hashStringForEntityAddress } from "@commonfabric/runner/entity-kind";
import { NameSchema, rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { linkRefPayload } from "@commonfabric/runner/shared";
import { RemoteResponse } from "@commonfabric/runtime-client";
import {
  getLogger,
  getLoggerCountsBreakdown,
  getLoggerFlagsBreakdown,
  getTimingStatsBreakdown,
  Logger,
  resetAllCountBaselines,
  resetAllTimingBaselines,
} from "@commonfabric/utils/logger";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  getMetaLink,
  KeepAsCell,
  type NormalizedFullLink,
  parseLink,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  type ActionRunTraceResponse,
  BooleanResponse,
  type CellGetCfcLabelRequest,
  type CellGetRequest,
  type CellGetResponse,
  type CellPushRequest,
  type CellResolveAsCellRequest,
  CellResponse,
  type CellSendRequest,
  type CellSetRequest,
  type CellSubscribeRequest,
  type CellUnsubscribeRequest,
  type CfcLabelViewResponse,
  ClientNotificationType,
  type DetectNonIdempotentRequest,
  type DetectNonIdempotentResponse,
  type EnsureHomePatternRunningRequest,
  type GetActionRunTraceRequest,
  type GetCellRequest,
  GetGraphSnapshotRequest,
  type GetHomeSpaceCellRequest,
  type GetLoggerCountsRequest,
  type GetPatternCoverageRequest,
  type GetPatternSourcesRequest,
  type GetSettleStatsHistoryRequest,
  type GetSettleStatsRequest,
  type GetTriggerTraceRequest,
  type GetWriteStackTraceRequest,
  GraphSnapshotResponse,
  type InitializationData,
  type IPCClientNotification,
  IPCClientRequest,
  type LoggerCountsResponse,
  type LoggerMetadata,
  type LogLevel,
  NotificationType,
  type OperationApplyRequest,
  type OperationApplyResponse,
  type OperationCapabilitiesRequest,
  type OperationCapabilitiesResponse,
  type OperationFieldResponse,
  type OperationQueryRequest,
  type OperationReleaseRequest,
  type OperationSessionCloseRequest,
  type OperationSubscribeRequest,
  type OperationUnsubscribeRequest,
  type PageCreateRequest,
  type PageGetAllRequest,
  type PageGetRequest,
  type PageGetSlugRequest,
  PageGetSpaceDefault as PatternGetSpaceRoot,
  type PageRemoveRequest,
  PageResponse,
  type PageStartRequest,
  type PageStopRequest,
  type PageSyncedRequest,
  type PatternCoverageResponse,
  type PatternSourcesResponse,
  type PieceCloneRequest,
  type PieceGetSourceRequest,
  type PieceGetSourceRevisionRequest,
  type PieceSourceResponse,
  type PieceSourceRevisionResponse,
  type PieceUpdateSourceRequest,
  type PieceUpdateSourceResponse,
  type RecreateSpaceRootPatternRequest,
  type RegisterSpaceHostRequest,
  RequestType,
  type ResolveSpaceNameRequest,
  type SetActionRunTraceEnabledRequest,
  type SetBreakpointsRequest,
  type SetLoggerEnabledRequest,
  type SetLoggerLevelRequest,
  type SetSettleStatsEnabledRequest,
  type SetTelemetryEnabledRequest,
  type SettleStatsHistoryResponse,
  type SettleStatsResponse,
  type SetTriggerTraceEnabledRequest,
  type SetWriteStackTraceMatchersRequest,
  type SlugResponse,
  type SpaceAclResponse,
  type SpaceGetAclRequest,
  type SpaceRemoveAclEntryRequest,
  type SpaceResponse,
  type SpaceSetAclEntryRequest,
  type TriggerTraceResponse,
  type UploadBlobRequest,
  type UploadBlobResponse,
  type VDomBatchAppliedNotification,
  type VDomEventNotification,
  type VDomMountRequest,
  type VDomMountResponse,
  type VDomUnmountRequest,
  type WriteStackTraceResponse,
} from "@/protocol/mod.ts";

import type { VDomOp } from "@/protocol/types.ts";
import { cellRefToKey, describeFailure } from "@/shared/utils.ts";
import { postToClient } from "./post-to-client.ts";
import {
  postContextualRuntimeError,
  postRuntimeError,
} from "./runtime-error.ts";
import {
  assertFabricLoggerFlags,
  createCellRef,
  createPageRef,
  getCell,
  mapCellRefsToSigilLinks,
} from "./utils.ts";

/**
 * Maximum nesting depth of a console argument's debug rendering. The bound is
 * on the size of a message pattern code can emit in a loop; the transport
 * imposes none of its own. Two of the levels are the rendering's, spent on the
 * shapes this bridge exists to carry -- a tag around an instance's encoded
 * contents, a ref beside a query result's data -- so the depth of the logged
 * value that survives is smaller than the number here.
 */
const MAX_CONSOLE_DEBUG_DEPTH = 7;
const blobUploadCodec = newDefaultJsonCodecEngine();

/** Each registered logger's enabled state and level. */
function loggerMetadata(): LoggerMetadata {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  const result: LoggerMetadata = {};
  if (global.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
      result[name] = {
        enabled: !logger.disabled,
        level: (logger.level ?? "info") as LogLevel,
      };
    }
  }
  return result;
}

function spaceAclResponse(
  runtime: Runtime,
  space: DID,
  acl: ACL | null,
): SpaceAclResponse {
  const principal = runtime.userIdentityDID;
  const capability = principal === space
    ? "OWNER"
    : acl?.[principal] ?? acl?.["*"];
  return {
    access: {
      space,
      principal,
      acl: { ...(acl ?? {}) } as SpaceAclResponse["access"]["acl"],
      canEdit: capability === "OWNER",
    },
  };
}

// Split-timing for the CFC label IPC path. Counts/timing are readable via
// getLoggerCounts(); enabled silently so the hot path pays only the timestamp.
const cfcLabelLogger = getLogger("runtime-client.cfc-label", {
  enabled: true,
  level: "error",
});

function resolveBlobUrl(url: string, apiUrl: URL, space: DID): string {
  const spaceBaseUrl = new URL(`/${space}/`, apiUrl);
  return new URL(url, spaceBaseUrl).href;
}

/**
 * Worker/host server-execution posture agreement (review 2026-08-11
 * m7). The host declares its flag posture in
 * `InitializationData.experimental.serverExecution` (typed since this
 * fix — it previously rode as an untyped excess property, and
 * `data.experimental ?? {}` silently reverted an undeclared worker to
 * OFF while a flag-ON host diverted handler commits: F10 alive in one
 * realm and dead in the other). The worker asserts the CONSTRUCTED
 * runtime's resolved posture matches the declaration and refuses
 * initialization loudly on divergence — in either direction (a worker
 * whose realm-ambient default flipped ON under a host that declared
 * nothing is the same divergence mirrored). OFF-arm-neutral: a host
 * that declares nothing and a worker that resolves OFF agree, which is
 * every pre-existing deployment. Exported for testing.
 */
export function assertServerExecutionPostureAgreement(
  declared: InitializationData["experimental"],
  runtime: { experimental: { serverExecution?: boolean | undefined } },
): void {
  const hostOn = declared?.serverExecution === true;
  const workerOn = runtime.experimental.serverExecution === true;
  if (hostOn !== workerOn) {
    throw new Error(
      "worker/host server-execution posture mismatch: the host declared " +
        `${hostOn ? "ON" : "OFF (or absent)"} but the worker runtime ` +
        `resolved ${workerOn ? "ON" : "OFF"} — a divergent posture runs ` +
        "the F10 client contract in one realm and not the other " +
        "(review 2026-08-11 m7; docs/specs/server-side-execution/)",
    );
  }
}

/**
 * Map host-decided `InitializationData` onto `runtimePresets.browserWorker`
 * params (CT-1814): the shared first-party posture (CFC pins,
 * patternEnvironment from apiUrl) lives in the preset; this function only
 * carries what the host actually decided. Exported for testing.
 */
export function browserWorkerParamsFromInitializationData(
  data: InitializationData,
  storageManager: RuntimeOptions["storageManager"],
  telemetry: RuntimeTelemetry,
): BrowserWorkerPresetParams {
  return {
    apiUrl: new URL(data.apiUrl),
    storageManager,
    // The host decides the flags (shell build-time defines); absent ⇒ runtime
    // defaults.
    experimental: data.experimental ?? {},
    telemetry,
    ...(data.spaceHostMap !== undefined
      ? { spaceHostMap: data.spaceHostMap }
      : {}),
    ...(data.cfcEnforcementMode !== undefined
      ? { cfcEnforcementMode: data.cfcEnforcementMode }
      : {}),
    ...(data.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: data.cfcFlowLabels }
      : {}),
    ...(data.trustSnapshot
      ? { trustSnapshotProvider: () => data.trustSnapshot }
      : {}),
    // The worker owns its collector so the GetPatternCoverage handler can read
    // it back through `runtime.patternCoverage`; the harness pulls it at teardown.
    ...(data.patternCoverage
      ? { patternCoverage: new PatternCoverageCollector() }
      : {}),
  };
}

/**
 * Builds the H3b display-boundary resolver for a worker's renders. When a
 * ceiling is in force, each render egress resolves principal-form atoms
 * (Space-via-HasRole) RUNNER-side; the reconciler only fits the result.
 *
 * Reader membership is sourced ONLY from verified facts, never from a cell's
 * mere local residency:
 *  - the acting user's own identity space (space DID == principal DID) — a
 *    principal definitionally reads its own space;
 *  - the current session workspace (`sessionSpace` = the space the session was
 *    authorized to open) — with `createSession({ spaceName })` the home space
 *    is a derived `spaceIdentity` DID distinct from the principal DID, and it
 *    is the space `session.open` gated on, so an own-workspace `Space(...)`
 *    label resolves rather than over-blocking.
 *
 * Broader cross-space membership comes from the §4.9.3 membership lookup: a
 * runtime-backed `SpaceMembershipProvider` reads each other space's declared
 * ACL doc and mints a reader fact only when it grants the acting user READ+
 * (never from residency). Its cross-space guarantee is exactly as strong as
 * the deployment `MEMORY_ACL_MODE`. Service DIDs are NOT threaded to the
 * worker today (design §9), so `serviceDids` is `[]` and service principals —
 * which rarely render — fail closed. Returns undefined when no ceiling is
 * configured (no render gating — today's behavior).
 */
export function renderConfidentialityResolverFor(
  runtime: Runtime,
  identity: Identity,
  ceiling: RenderConfidentialityCeiling | undefined,
  sessionSpace?: string,
  membershipProvider?: SpaceMembershipProvider,
): RenderConfidentialityResolver | undefined {
  if (ceiling === undefined) {
    return undefined;
  }
  const actingPrincipal = runtime.trustSnapshotProvider()?.actingPrincipal ??
    identity.did();
  const memberSpaces = sessionSpace === undefined ||
      sessionSpace === actingPrincipal
    ? [actingPrincipal]
    : [actingPrincipal, sessionSpace];
  return createRenderConfidentialityResolver({
    actingPrincipal,
    trustConfig: runtime.cfcTrustConfig,
    memberSpaces,
    // Share the reconciler's provider instance when supplied (so Stage-2 ACL
    // subscriptions and the resolver's reads observe the same cells); else
    // build a private one — both read the same underlying runtime documents.
    membershipProvider: membershipProvider ??
      createRuntimeSpaceMembershipProvider(runtime, actingPrincipal),
  });
}

/**
 * The §4.9.3 membership provider for a worker's renders — the reactive half of
 * the render lookup. Built once per worker (same lifetime as the resolver) and
 * threaded to BOTH `renderConfidentialityResolverFor` (as the resolver's
 * lookup) and the reconciler (for Stage-2 ACL-change subscriptions), so the two
 * share one instance. Undefined when no ceiling is configured — no render
 * gating, so no membership lookup. Service DIDs are not threaded to the worker
 * (design §9), so service principals fail closed.
 */
export function renderMembershipProviderFor(
  runtime: Runtime,
  identity: Identity,
  ceiling: RenderConfidentialityCeiling | undefined,
): SpaceMembershipProvider | undefined {
  if (ceiling === undefined) {
    return undefined;
  }
  const actingPrincipal = runtime.trustSnapshotProvider()?.actingPrincipal ??
    identity.did();
  return createRuntimeSpaceMembershipProvider(runtime, actingPrincipal);
}

/**
 * Formats a cell link for display in console output.
 * Returns a string like "[Cell: of:fid1:abc.../path/to/prop]"
 */
function formatCellLink(cell: Cell<unknown>): string {
  try {
    const link: SigilLink = cell.getAsLink();
    const inner = linkRefPayload(link);
    const pathStr = inner.path?.length ? `/${inner.path.join("/")}` : "";
    return `[Cell: ${inner.id ?? "?"}${pathStr}]`;
  } catch {
    return "[Cell]";
  }
}

/**
 * Produces the replacer that `toConsoleDebugValue()` converts through. It
 * renders the values the conversion cannot render on its own: a cell by the
 * link it holds, and a query-result proxy by that link together with the data
 * behind it.
 *
 * The result is stateful -- it holds what it built for each proxy -- so it
 * serves a single conversion.
 */
function newConsoleDebugReplacer(): (value: any) => any {
  const proxyValues = new Map<object, unknown>();

  return (value: any) => {
    if (isCell(value)) {
      return formatCellLink(value);
    }

    // `isCellResult()` reads a symbol-keyed property, which a hostile proxy's
    // `get` trap throws from. A throw here counts as declining to replace, and
    // the value goes on to be rendered as whatever it appears to be.
    if (!isCellResult(value)) {
      return value;
    }

    const already = proxyValues.get(value);
    if (already !== undefined) {
      // The same proxy converts to the same object every time, so that the
      // conversion's own identity-keyed cycle detection sees a repeat as one.
      return already;
    }

    const result: Record<string, unknown> = {
      __ref: formatCellLink(getCellOrThrow(value)),
    };

    // The properties are exposed rather than copied, so that the conversion
    // reads each one under its own guard: a proxy that throws on one key
    // still reports the rest, and `__ref` along with them.
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        enumerable: true,
        get: () => value[key],
      });
    }

    // Held only once complete, so that a proxy which throws before its keys
    // can be listed is rendered the same way everywhere it appears rather
    // than leaving a half-built object behind for its later positions. The
    // conversion descends after this returns, so a cycle still finds it.
    proxyValues.set(value, result);

    return result;
  };
}

/**
 * Converts one of a pattern's `console.*` arguments into the value that crosses
 * to the main thread.
 *
 * Exported for testing.
 */
export function toConsoleDebugValue(value: unknown): FabricValue {
  return toStructuredDebugValue(
    value,
    MAX_CONSOLE_DEBUG_DEPTH,
    newConsoleDebugReplacer(),
  );
}

export const hasExplicitSubscriptionSchema = (schema: unknown): boolean =>
  schema === true ||
  (schema !== undefined && schema !== false &&
    typeof schema === "object" && schema !== null &&
    Object.keys(schema).length > 0);

type RuntimeOperationTarget = {
  capability: IOperationStorageCapability;
  address: OperationFieldAddress;
};

type RuntimeOperationSession = {
  cellKey: string;
  target: RuntimeOperationTarget;
  subscriptions: Set<string>;
};

export class RuntimeProcessor {
  private runtime: Runtime;
  private cc: PiecesController;
  private spaces = new Map<DID, PiecesController>();
  private identity: Identity;
  private _isDisposed = false;
  private disposingPromise: Promise<void> | undefined;
  private subscriptions = new Map<string, Cancel>();
  private operationSubscriptions = new Map<
    string,
    { cancel?: Cancel; cancelled: boolean; sessionKey?: string }
  >();
  private operationSessions = new Map<string, RuntimeOperationSession>();
  private pieceSourceConfirmations = new Map<
    string,
    { token: string; prepared: PreparedPieceSourceChange }
  >();
  private telemetry: RuntimeTelemetry;
  #telemetryEnabled = false;

  // VDOM mounts: mountId -> { reconciler, cancel }
  private vdomMounts = new Map<
    number,
    { reconciler: WorkerReconciler; cancel: Cancel }
  >();
  private vdomBatchIdCounter = 0;
  // Render-boundary declassification policy applied to every mount's
  // reconciler. Set from InitializationData; "allow" preserves prior behavior.
  private renderDeclassificationPolicy: RenderDeclassificationPolicy = "allow";
  // Host-supplied default render ceiling applied to every mount's
  // reconciler. Undefined preserves prior behavior (no ceiling).
  private renderConfidentialityCeiling?: RenderConfidentialityCeiling;
  // Runner-side display-boundary resolver (Epic H3b) built once from the
  // runtime's trust config + acting principal when a ceiling is in force.
  // Rewrites a cell's label through the exchange rules so `Space(...)`-via-
  // `HasRole` principal forms resolve before the reconciler's ceiling fit.
  private renderConfidentialityResolver?: RenderConfidentialityResolver;
  // §4.9.3 Stage 2: the membership provider shared with the resolver above and
  // handed to every mount's reconciler, so a `Space(X)`-labeled cell blocked
  // before X's ACL synced re-renders once the ACL grants READ. Undefined when
  // no ceiling is in force.
  private renderMembershipProvider?: SpaceMembershipProvider;

  private constructor(
    runtime: Runtime,
    cc: PiecesController,
    initSpace: DID,
    identity: Identity,
    telemetry: RuntimeTelemetry,
  ) {
    this.runtime = runtime;
    this.cc = cc;
    this.spaces.set(initSpace, cc);
    this.identity = identity;
    this.telemetry = telemetry;
    this.telemetry.addEventListener("telemetry", this.#onTelemetry);
  }

  static async initialize(data: InitializationData): Promise<RuntimeProcessor> {
    const apiUrlObj = new URL(data.apiUrl);
    const identity = await Identity.fromKeyPair(
      data.identity,
    );
    const spaceIdentity = data.spaceIdentity
      ? await Identity.fromKeyPair(
        data.spaceIdentity,
      )
      : undefined;
    const space = data.spaceDid;
    const telemetry = new RuntimeTelemetry();

    setLLMUrl(data.apiUrl);
    setPatternEnvironment({ apiUrl: apiUrlObj });

    const session = {
      spaceIdentity,
      as: identity,
      space: data.spaceDid,
      spaceName: data.spaceName,
    };

    const storageManager = StorageManager.open({
      as: identity,
      spaceIdentity: spaceIdentity,
      memoryHost: apiUrlObj,
      spaceHostMap: data.spaceHostMap,
      // Host dogfood toggle (commonfabric.concurrentWatchRefresh): overlap
      // watch-refresh round trips up to a bounded window. Off unless the host
      // set it; the default is strict single-flight.
      settings: {
        experimentalConcurrentWatchRefresh:
          data.concurrentWatchRefresh === true,
      },
    });

    // Mirror the durability barrier to the page: `pending` is true while any
    // issued commit is still unconfirmed. The shell keeps the latest value and
    // consults it from its beforeunload handler, so a reload with unconfirmed
    // writes prompts the user instead of silently dropping them.
    storageManager.subscribePendingCommits((pending) => {
      postToClient({
        type: NotificationType.PendingWritesChanged,
        pending,
      });
    });

    let homePieces: PiecesController | undefined = undefined;
    let processor: RuntimeProcessor | undefined = undefined;
    // Everything below goes through the browserWorker preset (CT-1814):
    // host-decided data via the params mapper, plus this worker's declared
    // deltas (the postMessage bridges for console/navigate/piece/errors).
    const runtime = new Runtime(runtimePresets.browserWorker({
      ...browserWorkerParamsFromInitializationData(
        data,
        storageManager,
        telemetry,
      ),
      consoleHandler: ({ metadata, method, args }) => {
        postToClient({
          type: NotificationType.ConsoleMessage,
          metadata,
          method,
          args: args.map((arg) => toConsoleDebugValue(arg)),
        });
        return args;
      },

      navigateCallback: (target) => {
        const link = parseLink(target.getAsLink()) as NormalizedFullLink;
        postToClient({
          type: NotificationType.NavigateRequest,
          targetCellRef: link,
        });
      },

      pieceCreatedCallback: (piece) => {
        const writeContext = runtime.getWriteDebugContext();
        // Register the piece in ITS space's list: a piece created by a
        // running foreign-space pattern routes to that space's controller
        // (the context exists — it started the pattern). Fallback to
        // the home controller, the sole pre-multi-space behavior.
        const pieces = (piece.space && processor?.piecesFor(piece.space)) ??
          homePieces;
        if (!pieces) return;
        void runtime.withWriteDebugContext(
          writeContext,
          () => pieces.add([piece]),
        ).catch((e: unknown) => {
          console.error(
            "[RuntimeProcessor] Failed to add created piece:",
            {
              error: e instanceof Error ? e.message : e,
            },
          );
        });
      },

      errorHandlers: [postContextualRuntimeError],
    }));

    // Fail LOUD on a worker/host flag divergence (review 2026-08-11
    // m7) — see assertServerExecutionPostureAgreement.
    assertServerExecutionPostureAgreement(data.experimental, runtime);

    if (!await runtime.healthCheck()) {
      throw new Error(`Could not connect to "${data.apiUrl}"`);
    }

    // Allow the worker to acknowledge initialization immediately. Consumers
    // that need storage/piece convergence should call `synced()`.
    homePieces = new PiecesController(session, runtime);

    processor = new RuntimeProcessor(
      runtime,
      homePieces,
      space,
      identity,
      telemetry,
    );
    // InitializationData crosses postMessage with no runtime validation, so a
    // typo'd host config or version-skewed peer must fail CLOSED, not open:
    // any present-but-unknown value becomes "deny"; absent stays "allow".
    processor.renderDeclassificationPolicy =
      normalizeRenderDeclassificationPolicy(data.renderDeclassificationPolicy);
    processor.renderConfidentialityCeiling =
      normalizeRenderConfidentialityCeiling(data.renderConfidentialityCeiling);
    processor.renderMembershipProvider = renderMembershipProviderFor(
      runtime,
      identity,
      processor.renderConfidentialityCeiling,
    );
    processor.renderConfidentialityResolver = renderConfidentialityResolverFor(
      runtime,
      identity,
      processor.renderConfidentialityCeiling,
      space,
      processor.renderMembershipProvider,
    );
    // Site-table v0: the home space carries space-to-host hints; the
    // runtime reads them as its live host lookup (2026-06-09 federation
    // session — "move the lookup into the runtime itself"). A seeded route or
    // earlier hint can reject an entry. A default-host provider is provisional.
    // Failures here must not block worker boot.
    processor.watchSiteTable();
    return processor;
  }

  #siteTableCancel: Cancel | undefined;
  #siteTableWarned = new Set<string>();

  /**
   * Subscribes to the home-space site table and registers the last entry for
   * each space that contains only an HTTP or HTTPS origin. Fire-and-forget:
   * resolution hints are an enhancement, never a boot dependency.
   *
   * ORDERING CONTRACT for embedders: push a newly learned hint through the
   * RegisterSpaceHost IPC before relying on that space, and proceed only when
   * registration succeeds. The first hint can replace a provisional
   * default-host provider that has not issued a write. A route already accepted
   * from the table remains fixed and rejects a conflicting IPC hint. The table
   * is the durable record.
   */
  watchSiteTable(): void {
    try {
      const userDid = this.runtime.userIdentityDID;
      const table = this.runtime.getCell(
        userDid,
        siteTableCause(userDid),
        siteTableSchema,
      );
      Promise.resolve(table.sync()).then(() => {
        // dispose() may have run while sync was in flight — installing
        // the sink then would leak a live subscription past disposal.
        if (this._isDisposed) return;
        this.#siteTableCancel = table.sink(
          (entries: Readonly<SiteTable> | undefined) => {
            const latestEntries = new Map<
              string,
              { did: DID; host: string }
            >();
            for (const entry of entries ?? []) {
              if (
                typeof entry?.did !== "string" ||
                typeof entry.host !== "string" ||
                entry.host.length === 0 ||
                !entry.did.startsWith("did:")
              ) {
                continue;
              }
              let host: URL;
              try {
                host = normalizeSpaceHost(entry.host);
              } catch (error) {
                if (!(error instanceof SpaceHostValidationError)) throw error;
                console.warn(
                  `[RuntimeProcessor] Ignoring invalid site-table entry for ${entry.did}:`,
                  error.message,
                );
                continue;
              }
              latestEntries.set(entry.did, {
                did: entry.did as DID,
                host: host.toString(),
              });
            }
            for (const entry of latestEntries.values()) {
              try {
                const accepted = this.runtime.registerSpaceHost(
                  entry.did,
                  entry.host,
                );
                // Warn once per rejected fact. A seeded route or an earlier
                // accepted hint can fix a different host.
                if (!accepted) {
                  const key = `${entry.did}|${entry.host}`;
                  const effective = this.runtime.hostForSpace(
                    entry.did,
                  ).toString();
                  if (
                    effective !== new URL(entry.host).toString() &&
                    !this.#siteTableWarned.has(key)
                  ) {
                    this.#siteTableWarned.add(key);
                    console.warn(
                      `[RuntimeProcessor] Site-table hint for ${entry.did} not in effect ` +
                        `(explicit space route already fixed); using ${effective}`,
                    );
                  }
                }
              } catch (error) {
                console.warn(
                  `[RuntimeProcessor] Ignoring invalid site-table entry for ${entry.did}:`,
                  error instanceof Error ? error.message : error,
                );
              }
            }
          },
        );
      }).catch((error: unknown) => {
        console.warn(
          "[RuntimeProcessor] Site table unavailable (continuing without hints):",
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      console.warn(
        "[RuntimeProcessor] Site table watch failed to start:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * The PiecesController already serving a space, if any. Used by the
   * piece-created callback to register a piece in its own space's
   * list; deliberately does NOT create a context (a piece can only be
   * created by a pattern some existing context started).
   */
  piecesFor(space: DID): PiecesController | undefined {
    return this.spaces.get(space);
  }

  dispose(): Promise<void> {
    if (this.disposingPromise) return this.disposingPromise;
    this._isDisposed = true;
    this.disposingPromise = (async () => {
      this.telemetry.removeEventListener("telemetry", this.#onTelemetry);
      try {
        this.#siteTableCancel?.();
        this.#siteTableCancel = undefined;
        for (const cancel of this.subscriptions.values()) {
          cancel();
        }
        this.subscriptions.clear();
        for (const subscription of this.operationSubscriptions.values()) {
          subscription.cancelled = true;
          subscription.cancel?.();
        }
        this.operationSubscriptions.clear();
        this.operationSessions.clear();
        this.pieceSourceConfirmations.clear();

        // Clean up VDOM mounts
        for (const { reconciler, cancel } of this.vdomMounts.values()) {
          cancel();
          reconciler.unmount();
        }
        this.vdomMounts.clear();

        await this.runtime.storageManager.synced();
        await this.runtime.dispose();
      } catch (e) {
        console.error(`Failure during WorkerRuntime disposal: ${e}`);
      }
    })();
    return this.disposingPromise;
  }

  isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Resolve the piece context for a space. The space the worker was
   * initialized with gets the context built at initialize; any other
   * space lazily gets its own PiecesController, sharing
   * this worker's runtime/scheduler/storage (the storage layer is
   * already multi-space). The per-space session authenticates as the
   * user — no per-space signer, matching the storage connections.
   *
   * `space` is required: page operations carry their space explicitly,
   * with no implicit default at this layer. (The runtime guard catches
   * out-of-date callers that still omit it.)
   */
  private getSpaceCtx(space: DID): PiecesController {
    const target: DID | undefined = space;
    if (!target) {
      throw new Error("Page operations must name a space explicitly.");
    }
    let ctx = this.spaces.get(target);
    if (!ctx) {
      const created = new PiecesController(
        { as: this.identity, space: target },
        this.runtime,
      );
      ctx = created;
      this.spaces.set(target, ctx);
      // The constructor kicks the space-cell sync into `ready` without
      // awaiting it. Observe the failure and evict, so a transient
      // error (unreachable host, bad space) doesn't poison this space
      // for the worker's lifetime — the next request rebuilds the
      // context — and doesn't surface as an unhandled rejection.
      created.ready.catch((error: unknown) => {
        if (this.spaces.get(target) === created) {
          this.spaces.delete(target);
        }
        console.error(
          `[RuntimeProcessor] Space context for ${target} failed to sync:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
    return ctx;
  }

  handleCellGet(
    request: CellGetRequest,
  ): CellGetResponse {
    // Fail closed on the retired raw label-metadata seam (inv-12 Stage 0 /
    // SC-14 / SC-25): `meta: "cfc"` used to return the raw `["cfc"]` envelope
    // (unredacted Caveat.source and other principal identities) via
    // getMetaRaw. "cfc" is no longer a MetaField, but the wire is untyped
    // JSON — reject the request rather than serve raw metadata. Display
    // label views are served redacted via `includeCfcLabel` / CellGetCfcLabel.
    if ((request.meta as string | undefined) === "cfc") {
      throw new Error(
        'cell/get meta "cfc" is not served over IPC (inv-12); ' +
          "use getCfcLabel for the redacted display view",
      );
    }
    let cell = getCell(this.runtime, request.cell);
    if (request.meta !== undefined) {
      const rootCell = getCell(this.runtime, { ...request.cell, path: [] });
      if (
        request.meta === "pattern" || request.meta === "argument" ||
        request.meta === "result"
      ) {
        // For the meta link fields, use the meta linked cell instead
        const rootCell = getCell(this.runtime, { ...request.cell, path: [] });
        const link = getMetaLink(rootCell, request.meta);
        if (link === undefined) return { value: undefined };
        cell = this.runtime.getCellFromLink({
          ...link,
          path: [...link.path, ...request.cell.path],
        });
      } else {
        // For meta cells that aren't link cells, return the raw data
        return {
          value: rootCell.getMetaRaw(request.meta) as FabricValue,
        };
      }
    }
    const value = cell.get();
    // The sigil links inside the response carry cfcLabelView copies; redact
    // Caveat.source in those too (inv-12 Stage 0, same display redaction as
    // the top-level cfcLabel below). Display-only: the worker neither
    // persists nor re-imports inbound views, so the redacted copies cannot
    // round-trip into under-labeled state.
    //
    // `convertCellsToLinks()` preserves a `FabricPrimitive` by identity, and
    // the envelope's encoding carries one to the main thread with its class,
    // so what the response holds is what the cell held.
    const converted = redactSigilCfcLabelViewsForDisplay(
      convertCellsToLinks(value, {
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
        doNotConvertCellResults: true,
        includeCfcLabelView: true,
      }),
    ) as FabricValue;
    // The resolved cell's own schema-bearing ref, when asked for — for a meta
    // link read this addresses the linked cell itself, so the caller can
    // subscribe to it or consult its schema's declarations.
    const refField = request.includeRef ? { cell: createCellRef(cell) } : {};
    if (!request.includeCfcLabel) {
      return { value: converted, ...refField };
    }
    // Same display-label read as handleCellGetCfcLabel: pure store read, then
    // redact Caveat.source for display (audit 28b). One round-trip for both.
    const cfcLabel = cfcLabelViewForCell(cell);
    return {
      value: converted,
      ...refField,
      cfcLabel: cfcLabel === undefined
        ? undefined
        : redactCaveatSourcesForDisplay(cfcLabel),
    };
  }

  // A `CellHandle.set` is a blind leaf overwrite (last-write-wins); a
  // `CellHandle.push` is read-modify-write and keeps compare-and-set. The
  // blind-vs-CAS decision is made by METHOD — which request type the client sent
  // — not by inspecting the value's shape. Both carry the whole already-resolved
  // value on the wire.
  handleCellSet(request: CellSetRequest): void {
    this.applyCellWrite(request, /* blind */ true);
  }

  handleCellPush(request: CellPushRequest): void {
    this.applyCellWrite(request, /* blind */ false);
  }

  private operationSessionKey(cell: CellGetRequest["cell"]): string {
    return JSON.stringify([
      cell.space,
      cell.id,
      cell.scope ?? "space",
      cell.path,
    ]);
  }

  private operationTarget(
    cell: CellGetRequest["cell"],
    operationSessionId?: string,
  ) {
    if (
      operationSessionId !== undefined &&
      (operationSessionId.length === 0 || operationSessionId.length > 256)
    ) {
      throw new Error("operation session id is malformed");
    }
    const cellKey = this.operationSessionKey(cell);
    const sessionKey = operationSessionId;
    // A few unit harnesses construct the processor from its prototype. Keep
    // this lazy initialization in addition to the class field so those
    // read-only protocol harnesses exercise the same session behavior.
    this.operationSessions ??= new Map();
    const existing = sessionKey === undefined
      ? undefined
      : this.operationSessions.get(sessionKey);
    if (existing !== undefined) {
      if (existing.cellKey !== cellKey) {
        throw new Error("operation session cannot change its source cell");
      }
      return { ...existing.target, sessionKey, session: existing };
    }
    const link = getCell(this.runtime, cell).resolveAsCell()
      .getAsNormalizedFullLink();
    const provider = this.runtime.storageManager.open(link.space);
    const capability = hasOperationStorageCapability(provider)
      ? provider
      : provider.replica;
    if (!hasOperationStorageCapability(capability)) {
      throw new Error(
        "runtime storage does not support collaborative operations",
      );
    }
    const target = {
      capability,
      address: {
        id: link.id,
        scope: link.scope,
        path: toValuePath(link.path),
      },
    };
    if (sessionKey === undefined) {
      return { ...target, sessionKey: undefined, session: undefined };
    }
    const session = {
      cellKey,
      target,
      subscriptions: new Set<string>(),
    };
    this.operationSessions.set(sessionKey, session);
    return { ...target, sessionKey, session };
  }

  async handleOperationCapabilities(
    request: OperationCapabilitiesRequest,
  ): Promise<OperationCapabilitiesResponse> {
    const { capability } = this.operationTarget(
      request.cell,
      request.operationSessionId,
    );
    return { codecs: [...await capability.operationCodecs()] };
  }

  async handleOperationQuery(
    request: OperationQueryRequest,
  ): Promise<OperationFieldResponse> {
    const { capability, address } = this.operationTarget(
      request.cell,
      request.operationSessionId,
    );
    const field = await capability.queryOperationField({
      ...address,
      ...(request.after === undefined ? {} : { after: request.after }),
    });
    return { field: field };
  }

  async handleOperationApply(
    request: OperationApplyRequest,
  ): Promise<OperationApplyResponse> {
    const { capability, address } = this.operationTarget(
      request.cell,
      request.operationSessionId,
    );
    const resolution = await capability.applyOperation({
      op: "apply-op",
      ...address,
      codec: request.codec,
      submissionId: request.submissionId,
      base: request.base,
      ...(request.baselineHash === undefined
        ? {}
        : { baselineHash: request.baselineHash }),
      payload: request.payload,
    });
    return { resolution: resolution };
  }

  async handleOperationSubscribe(
    request: OperationSubscribeRequest,
  ): Promise<BooleanResponse> {
    if (this.operationSubscriptions.has(request.subscriptionId)) {
      return { value: false };
    }
    const { capability, address, sessionKey, session } = this.operationTarget(
      request.cell,
      request.operationSessionId,
    );
    const subscription: {
      cancel?: Cancel;
      cancelled: boolean;
      sessionKey?: string;
    } = {
      cancelled: false,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    };
    this.operationSubscriptions.set(request.subscriptionId, subscription);
    session?.subscriptions.add(request.subscriptionId);
    let cancel: Cancel;
    try {
      cancel = await capability.subscribeOperationField({
        ...address,
        ...(request.after === undefined ? {} : { after: request.after }),
      }, (field) => {
        if (
          this.operationSubscriptions.get(request.subscriptionId) !==
            subscription
        ) return;
        queueMicrotask(() =>
          postToClient({
            type: NotificationType.OperationUpdate,
            subscriptionId: request.subscriptionId,
            field: field,
          })
        );
      });
    } catch (error) {
      if (
        this.operationSubscriptions.get(request.subscriptionId) === subscription
      ) {
        this.operationSubscriptions.delete(request.subscriptionId);
        session?.subscriptions.delete(request.subscriptionId);
        if (
          sessionKey !== undefined && session?.subscriptions.size === 0 &&
          this.operationSessions.get(sessionKey) === session
        ) {
          this.operationSessions.delete(sessionKey);
        }
      }
      throw error;
    }
    if (
      this._isDisposed || subscription.cancelled ||
      this.operationSubscriptions.get(request.subscriptionId) !== subscription
    ) {
      cancel();
      return { value: false };
    }
    subscription.cancel = cancel;
    return { value: true };
  }

  async handleOperationRelease(
    request: OperationReleaseRequest,
  ): Promise<BooleanResponse> {
    const { capability, address } = this.operationTarget(
      request.cell,
      request.operationSessionId,
    );
    await capability.releaseOperationField({
      op: "release-op-field",
      ...address,
      codec: request.codec,
      cursor: request.cursor,
    });
    return { value: true };
  }

  handleOperationUnsubscribe(
    request: OperationUnsubscribeRequest,
  ): BooleanResponse {
    const subscription = this.operationSubscriptions.get(
      request.subscriptionId,
    );
    if (subscription === undefined) return { value: false };
    this.operationSubscriptions.delete(request.subscriptionId);
    subscription.cancelled = true;
    subscription.cancel?.();
    if (subscription.sessionKey !== undefined) {
      const session = this.operationSessions?.get(subscription.sessionKey);
      session?.subscriptions.delete(request.subscriptionId);
      if (session?.subscriptions.size === 0) {
        this.operationSessions.delete(subscription.sessionKey);
      }
    }
    return { value: true };
  }

  handleOperationSessionClose(
    request: OperationSessionCloseRequest,
  ): BooleanResponse {
    return {
      value: this.operationSessions?.delete(request.operationSessionId),
    };
  }

  // Shared write path for CellSet/CellPush. In blind mode the set's reads carry no
  // value-equality precondition, so a UI overwrite is last-write-wins and no
  // longer loses the own-write race that rolled the edit back. In their place we
  // thread ONE structural precondition — the cell's PARENT address — which
  // buildReads turns into a nonRecursive read: that catches a concurrent whole-doc
  // delete or an ancestor reshape (so a stale nested patch can't throw at
  // read-materialization) without conflicting on a concurrent write to the cell's
  // own value. We compute the parent here, at handleCellSet, because the logical
  // write path is known only here — buildReads sees the optimized element-level
  // diff. In non-blind (push) mode the read-target stays a commit precondition, so
  // a concurrent push aborts rather than being clobbered. The blind mark is
  // cleared before prepareTxForCommit so CFC boundary-commit read-then-writes
  // retain their preconditions.
  applyCellWrite(
    request: CellSetRequest | CellPushRequest,
    blind: boolean,
  ): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    const value = mapCellRefsToSigilLinks(request.value);
    if (blind) {
      markUiInputBlindWriteTx(tx);
      // Renderer-input provenance that survives to commit, so the scheduler can
      // shape the resulting subscriber wake (timing side-channel mitigation,
      // channels 4/5). A `blind` write is exactly a renderer `$value` input write.
      markRendererInputTx(tx);
      // The resolved storage address of the write target; its parent is the
      // structural existence/shape precondition for the blind write.
      const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
      setBlindStructuralTarget(tx, {
        id: link.id,
        space: link.space,
        scope: link.scope,
        path: link.path.slice(0, -1),
      });
    }
    cell.withTx(tx).set(value);
    if (blind) unmarkUiInputBlindWriteTx(tx);
    this.runtime.prepareTxForCommit(tx);
    // Local visibility is established by commit(); the promise tracks remote
    // confirmation/rollback and must not block cell IPC.
    tx.commit();
  }

  handleCellSend(request: CellSendRequest): void {
    const tx = this.runtime.edit();
    const cell = getCell(this.runtime, request.cell);
    cell.withTx(tx).send(mapCellRefsToSigilLinks(request.event));
    this.runtime.prepareTxForCommit(tx);
    // Local visibility is established by commit(); the promise tracks remote
    // confirmation/rollback and must not block cell IPC.
    tx.commit();
  }

  handleCellSubscribe(request: CellSubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);

    if (this.subscriptions.has(key)) {
      return { value: false };
    }

    const cell = getCell(this.runtime, request.cell);

    const cancel = cell.sink((value, cfcLabel) => {
      // Log empty-schema subscriptions that produce CellResult proxies.
      // These are the call sites that need real schemas added.
      const hasSchema = hasExplicitSubscriptionSchema(request.cell.schema);
      if (!hasSchema && isCellResult(value)) {
        console.error(
          `[handleCellSubscribe] EMPTY SCHEMA SUBSCRIPTION producing ` +
            `CellResult proxy. Add a schema to this subscription site!\n` +
            `  cell: ${request.cell.id}\n` +
            `  path: ${JSON.stringify(request.cell.path)}\n` +
            `  space: ${request.cell.space}\n` +
            `  schema: ${JSON.stringify(request.cell.schema)}`,
        );
      }
      // As in handleCellGet: redact Caveat.source in the cfcLabelView copies
      // riding sigil links inside the update value (inv-12 Stage 0).
      const converted = redactSigilCfcLabelViewsForDisplay(
        convertCellsToLinks(value, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
          doNotConvertCellResults: true,
          includeCfcLabelView: true,
        }),
      ) as FabricValue;
      // The sink read the raw label on its tracked tx (so cfc writes re-fire
      // it); redact Caveat.source here before it crosses to the main thread.
      const redactedLabel = request.includeCfcLabel
        ? (cfcLabel === undefined
          ? undefined
          : redactCaveatSourcesForDisplay(cfcLabel))
        : undefined;

      // `.sink` fires synchronously on invocation. Trigger the notification
      // in a microtask so that the subscription response returns
      // before a notification fires.
      queueMicrotask(() =>
        postToClient({
          type: NotificationType.CellUpdate,
          cell: request.cell,
          value: converted,
          ...(request.includeCfcLabel ? { cfcLabel: redactedLabel } : {}),
        })
      );
    }, { includeCfcLabel: request.includeCfcLabel === true });

    this.subscriptions.set(key, cancel);
    return { value: true };
  }

  handleCellUnsubscribe(request: CellUnsubscribeRequest): BooleanResponse {
    const key = cellRefToKey(request.cell);
    const cancel = this.subscriptions.get(key);
    if (cancel) {
      cancel();
      this.subscriptions.delete(key);
      return { value: true };
    }
    return { value: false };
  }

  handleCellResolveAsCell(request: CellResolveAsCellRequest): CellResponse {
    const cell = getCell(this.runtime, request.cell);
    const resolved = cell.resolveAsCell();
    return {
      cell: createCellRef(resolved),
    };
  }

  handleCellGetCfcLabel(
    request: CellGetCfcLabelRequest,
  ): CfcLabelViewResponse {
    // Label reads must use the runtime's stored cell identity. The request
    // schema is client-supplied view context, not trusted label provenance.
    const { schema: _schema, ...cellRef } = request.cell;
    const cell = getCell(this.runtime, cellRef);
    // Pure, non-blocking read of the CURRENT local store — no sync. getCfcLabel
    // is the display-label seam, and its only callers are reactive UI components
    // (cf-cfc-label, cf-cfc-authorship, cf-profile-badge) that subscribe to the
    // cell and re-read the label whenever it changes. They own liveness: a
    // not-yet-loaded doc is also not rendered, so an empty label is the correct
    // deferred answer and self-heals when the subscription delivers the doc
    // (which carries its `cfc` metadata). The earlier per-call source-chain sync
    // re-loaded already-present docs and, under multi-writer churn, blocked on
    // in-flight watch refreshes — ~99.97% of this IPC's cost, p95 >1s at 4
    // browsers. The enforcement path reads labels through other seams; here we
    // only redact `Caveat.source` for display (audit item 28b, inv-12).
    const totalStart = performance.now();
    const cfcLabel = cfcLabelViewForCell(cell);
    const response = {
      cfcLabel: cfcLabel === undefined
        ? undefined
        : redactCaveatSourcesForDisplay(cfcLabel),
    };
    cfcLabelLogger.time(totalStart, "total");
    return response;
  }

  handleGetCell(request: GetCellRequest): CellResponse {
    const cell = this.runtime.getCell(
      request.space,
      request.cause,
      request.schema,
    );

    return {
      cell: createCellRef(cell, request.schema),
    };
  }

  handleGetHomeSpaceCell(_request: GetHomeSpaceCellRequest): CellResponse {
    const homeSpaceCell = this.runtime.getHomeSpaceCell();
    return {
      cell: createCellRef(homeSpaceCell),
    };
  }

  /**
   * Ensure the home space's default pattern is running and return a CellRef to it.
   * This is needed for favorites operations which require the pattern to be active.
   * Creates the home pattern if it doesn't exist yet.
   */
  async handleEnsureHomePatternRunning(
    _request: EnsureHomePatternRunningRequest,
  ): Promise<CellResponse> {
    const homeSpaceCell = this.runtime.getHomeSpaceCell();
    await homeSpaceCell.sync();

    // Always the PiecesController path: ensureDefaultPattern() reconciles the
    // persisted identity and carries the cold-start setup repair that heals an
    // aged home root. Starting the pattern directly here would skip that
    // repair, and with `systemPatternAutoUpdate` unset nothing else heals the
    // root — so no fast path belongs in front of the controller.
    const homeSession: Session = {
      as: this.identity,
      space: this.runtime.userIdentityDID,
    };
    const homeCC = new PiecesController(homeSession, this.runtime);
    await homeCC.synced();

    const homePattern = await homeCC.ensureDefaultPattern();

    return {
      cell: createCellRef(homePattern.getCell()),
    };
  }

  async handleIdle(): Promise<void> {
    // The client reads "idle" as a safe point to navigate or reload, so it
    // must include durability of just-issued writes: idleWithPendingCommits()
    // waits for reactive quiescence and for every in-flight commit together
    // (see Scheduler.idleWithPendingCommits; the pending set is sourced from
    // the storage manager, covering event handlers, direct cell IPC writes,
    // and reactive write-backs alike). Internal callers that only need
    // reactive quiescence use runtime.idle() and are unaffected.
    await this.runtime.scheduler.idleWithPendingCommits();
  }

  // Persistence durability, distinct from handleIdle's reactive quiescence:
  // awaits in-flight compile-cache write-backs so a subsequent load reads the
  // freshly-written entry instead of recompiling.
  async handleFlushCompileCacheWrites(): Promise<void> {
    await this.runtime.patternManager.flushCompileCacheWrites();
  }

  async handlePieceCreate(
    request: PageCreateRequest,
  ): Promise<PageResponse> {
    const cc = this.getSpaceCtx(request.space);
    let program: Program | undefined;
    let origin: string | undefined;
    if ("url" in request.source && request.source.url) {
      const sourceUrl = new URL(request.source.url);
      if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
        throw new Error("Piece source URL must use HTTP or HTTPS.");
      }
      origin = sourceUrl.href;
      program = await cc.runtime.harness.resolve(
        new HttpProgramResolver(sourceUrl),
      );
    } else if ("program" in request.source) {
      program = request.source.program;
    } else {
      throw new Error("Invalid source.");
    }

    // Checked rather than cast. The wire carries a `FabricValue` and so does
    // the API, but a piece's input is a record: `cc.create()` takes an
    // `object`, and casting a `bigint` to one would hand the runtime something
    // it cannot use and say nothing about why.
    const argument = request.argument;
    if ((argument !== undefined) && !isObjectNotArray(argument)) {
      // The rejected value is named rather than its `typeof`, which calls both
      // an array and `null` an `object` and so says nothing about either. It
      // is bounded because the argument is a caller's data.
      throw new Error(
        `A piece's argument must be a record, not: ${
          toCompactDebugString(argument, 120)
        }`,
      );
    }

    const piece = await cc.create<NameSchema>(program, {
      input: argument,
      origin,
      start: request.run ?? true,
    }, request.cause);
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  async handleGetSpaceRootPattern(
    request: PatternGetSpaceRoot,
  ): Promise<PageResponse> {
    const cc = this.getSpaceCtx(request.space);
    const piece = await cc.ensureDefaultPattern();
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  async handleRecreateSpaceRootPattern(
    request: RecreateSpaceRootPatternRequest,
  ): Promise<PageResponse> {
    const cc = this.getSpaceCtx(request.space);
    const piece = await cc.recreateDefaultPattern();
    return {
      page: createPageRef(piece.getCell()),
    };
  }

  // TODO(runtime-worker-refactor): Can this fail? What if the cell
  // is not a page cell?
  async handlePageGet(
    request: PageGetRequest,
  ): Promise<PageResponse> {
    const cc = this.getSpaceCtx(request.space);
    const requestedCell = this.runtime.getCellFromEntityId(
      cc.getSpace(),
      entityIdFrom(request.pageId),
    );
    await requestedCell.sync();
    const redirect = parseLink(
      requestedCell.getRaw(),
      requestedCell.getAsNormalizedFullLink(),
    );
    if (redirect?.overwrite === "redirect") {
      const target = this.runtime.getCellFromLink({
        ...redirect,
        space: redirect.space ?? cc.getSpace(),
        scope: redirect.scope ?? "space",
      });
      await target.sync();
      const targetLink = target.getAsNormalizedFullLink();
      const hasPattern = getPatternIdentityRef(target) !== undefined ||
        target.getMetaRaw("pattern") !== undefined;
      if (!hasPattern || targetLink.path.length > 0) {
        const pageCell = hasPattern && targetLink.path.length > 0
          ? target.asSchemaFromLinks()
          : target;
        await pageCell.pull();
        return {
          page: createPageRef(pageCell),
        };
      }

      const cell = await cc.getPieceCell(
        target,
        request.runIt ?? false,
      );
      return {
        page: createPageRef(cell),
      };
    }

    const cell = await cc.getPieceCell(
      request.pageId,
      request.runIt ?? false,
    );

    return {
      page: createPageRef(cell),
    };
  }

  async handlePageGetSlug(
    request: PageGetSlugRequest,
  ): Promise<SlugResponse> {
    const pieces = this.getSpaceCtx(request.space);
    const cell = this.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pageId),
    );
    await cell.sync();
    const slug = cell.getMetaRaw("slug");
    return { slug: typeof slug === "string" ? slug : undefined };
  }

  async handlePageRemove(
    request: PageRemoveRequest,
  ): Promise<BooleanResponse> {
    const cc = this.getSpaceCtx(request.space);
    return { value: await cc.remove(request.pageId) };
  }

  async handlePageStart(
    request: PageStartRequest,
  ): Promise<BooleanResponse> {
    const cc = this.getSpaceCtx(request.space);
    await cc.startPiece(request.pageId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  async handlePageStop(
    request: PageStopRequest,
  ): Promise<BooleanResponse> {
    const cc = this.getSpaceCtx(request.space);
    await cc.stopPiece(request.pageId);
    // @TODO(runtime-worker-refactor): Return status based on if
    // pattern was actually found and stopped
    return { value: true };
  }

  async handlePageGetAll(request: PageGetAllRequest): Promise<CellResponse> {
    const pieces = this.getSpaceCtx(request.space);
    const piecesCell = await pieces.getPieceRegistry();
    return {
      cell: createCellRef(piecesCell),
    };
  }

  async handlePageSynced(request: PageSyncedRequest): Promise<void> {
    const pieces = this.getSpaceCtx(request.space);
    await pieces.synced();
  }

  async handlePieceGetSource(
    request: PieceGetSourceRequest,
  ): Promise<PieceSourceResponse> {
    const pieces = this.getSpaceCtx(request.space);
    // The reader syncs the piece itself, as its first step.
    const cell = this.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
    );
    const state = await readPieceSourceState(this.runtime, cell);
    return { source: { ...state, space: state.space as DID } };
  }

  async handlePieceGetSourceRevision(
    request: PieceGetSourceRevisionRequest,
  ): Promise<PieceSourceRevisionResponse> {
    const pieces = this.getSpaceCtx(request.space);
    const cell = this.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
    );
    return {
      source: await readPieceSourceRevision(
        this.runtime,
        cell,
        request.revisionId,
      ),
    };
  }

  /** Clone a source piece into another space. */
  async handlePieceClone(request: PieceCloneRequest): Promise<PageResponse> {
    const sourcePieces = this.getSpaceCtx(request.sourceSpace);
    const sourceCell = this.runtime.getCellFromEntityId(
      sourcePieces.getSpace(),
      entityIdFrom(request.pieceId),
    );
    const source = new PieceController(sourcePieces, sourceCell);
    const clone = await source.cloneTo(
      this.getSpaceCtx(request.destinationSpace),
      { copyData: request.copyData === true },
    );
    return { page: createPageRef(clone.getCell()) };
  }

  async handlePieceUpdateSource(
    request: PieceUpdateSourceRequest,
  ): Promise<PieceUpdateSourceResponse> {
    if (
      request.confirmationToken !== undefined &&
      (typeof request.confirmationToken !== "string" ||
        request.confirmationToken.length === 0)
    ) {
      throw new Error("confirmationToken must be a non-empty string");
    }
    const pieces = this.getSpaceCtx(request.space);
    // Keyed on the piece's bare hash rather than the request's spelling of it:
    // a caller may prepare a change under one accepted address form and
    // confirm it under the other, and both must reach the one pending entry.
    const confirmationKey = `${request.space}\u0000${
      hashStringForEntityAddress(request.pieceId)
    }`;
    let confirmedChange: PreparedPieceSourceChange | undefined;
    if (request.confirmationToken === undefined) {
      this.pieceSourceConfirmations.delete(confirmationKey);
    } else {
      const pending = this.pieceSourceConfirmations.get(confirmationKey);
      this.pieceSourceConfirmations.delete(confirmationKey);
      if (
        pending === undefined ||
        pending.token !== request.confirmationToken
      ) {
        throw new Error(
          "the piece source compatibility confirmation is no longer valid",
        );
      }
      confirmedChange = pending.prepared;
    }
    const cell = this.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(request.pieceId),
    );
    const controller = new PieceController(pieces, cell);
    const result = await controller.changeSource(request.action, {
      confirmedChange,
    });
    let confirmationToken: string | undefined;
    if (result.status === "incompatible") {
      confirmationToken = crypto.randomUUID();
      this.pieceSourceConfirmations.set(confirmationKey, {
        token: confirmationToken,
        prepared: result.prepared,
      });
    }
    const appliedState = result.status === "applied"
      ? readPieceSourceMetadata(this.runtime, cell)
      : undefined;
    let state;
    let sourceReadWarning: string | undefined;
    try {
      state = await readPieceSourceState(this.runtime, cell);
    } catch (error) {
      if (result.status !== "applied") throw error;
      state = appliedState!;
      sourceReadWarning = `source details could not be refreshed: ${
        describeFailure(error)
      }`;
    }
    const executionWarning = result.status === "applied"
      ? [result.executionWarning, sourceReadWarning]
        .filter((message): message is string => message !== undefined)
        .join("; ") || undefined
      : undefined;
    const executionResponse = executionWarning === undefined
      ? {}
      : { executionWarning };
    return {
      source: { ...state, space: state.space as DID },
      ...executionResponse,
      ...(result.status === "incompatible"
        ? {
          compatibilityWarning: result.message,
          confirmationToken,
        }
        : {}),
    };
  }

  async handleSpaceGetAcl(
    request: SpaceGetAclRequest,
  ): Promise<SpaceAclResponse> {
    this.getSpaceCtx(request.space);
    const acl = await new ACLManager(this.runtime, request.space).get();
    return spaceAclResponse(this.runtime, request.space, acl);
  }

  async handleSpaceSetAclEntry(
    request: SpaceSetAclEntryRequest,
  ): Promise<SpaceAclResponse> {
    if (!isACLUser(request.user)) {
      throw new Error("user must be `*` or a valid DID");
    }
    if (!isCapability(request.capability)) {
      throw new Error("capability must be `READ`, `WRITE`, or `OWNER`");
    }
    this.getSpaceCtx(request.space);
    const manager = new ACLManager(this.runtime, request.space);
    const acl = await manager.set(request.user, request.capability);
    return spaceAclResponse(
      this.runtime,
      request.space,
      acl,
    );
  }

  async handleSpaceRemoveAclEntry(
    request: SpaceRemoveAclEntryRequest,
  ): Promise<SpaceAclResponse> {
    if (!isACLUser(request.user)) {
      throw new Error("user must be `*` or a valid DID");
    }
    this.getSpaceCtx(request.space);
    const manager = new ACLManager(this.runtime, request.space);
    const acl = await manager.remove(request.user);
    return spaceAclResponse(
      this.runtime,
      request.space,
      acl,
    );
  }

  handleRegisterSpaceHost(
    request: RegisterSpaceHostRequest,
  ): BooleanResponse {
    return {
      value: this.runtime.registerSpaceHost(request.space, request.host),
    };
  }

  async handleResolveSpaceName(
    request: ResolveSpaceNameRequest,
  ): Promise<SpaceResponse> {
    return { space: await this.runtime.resolveSpaceName(request.name) };
  }

  /** Convergence across every opened space — no space named, none implied. */
  async handleRuntimeSynced(): Promise<void> {
    await Promise.all(
      [...this.spaces.values()].map((pieces) => pieces.synced()),
    );
  }

  getGraphSnapshot(_: GetGraphSnapshotRequest): GraphSnapshotResponse {
    return { snapshot: this.runtime.scheduler.getGraphSnapshot() };
  }

  getLoggerCounts(_: GetLoggerCountsRequest): LoggerCountsResponse {
    const counts = getLoggerCountsBreakdown();
    const metadata = loggerMetadata();
    const timing = getTimingStatsBreakdown();
    const flags = getLoggerFlagsBreakdown();
    assertFabricLoggerFlags(flags);
    return { counts, metadata, timing, flags };
  }

  setLoggerLevel(request: SetLoggerLevelRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.level = request.level;
    }
  }

  setLoggerEnabled(request: SetLoggerEnabledRequest): void {
    const loggers = this.#getLoggers(request.loggerName);
    for (const logger of loggers) {
      logger.disabled = !request.enabled;
    }
  }

  setTelemetryEnabled(request: SetTelemetryEnabledRequest): void {
    this.#telemetryEnabled = request.enabled;
    this.runtime.scheduler.setEventPreflightTelemetryEnabled(request.enabled);
  }

  resetLoggerBaselines(_: any): void {
    resetAllCountBaselines();
    resetAllTimingBaselines();
  }

  #getLoggers(loggerName?: string): Logger[] {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    if (!global.commonfabric?.logger) {
      return [];
    }
    if (loggerName) {
      const logger = global.commonfabric.logger[loggerName];
      return logger ? [logger] : [];
    }
    return Object.values(global.commonfabric.logger);
  }

  #onTelemetry = (event: Event) => {
    if (!this.#telemetryEnabled) return;
    const marker = (event as RuntimeTelemetryEvent).marker;
    postToClient({
      type: NotificationType.Telemetry,
      marker,
    });
  };

  getPatternSources(
    _request: GetPatternSourcesRequest,
  ): PatternSourcesResponse {
    const snapshot = this.runtime.scheduler.getGraphSnapshot();
    const seen = new Set<string>();
    const patterns: PatternSourcesResponse["patterns"] = [];

    for (const node of snapshot.nodes) {
      const ref = node.patternIdentity;
      if (!ref || seen.has(ref.identity)) continue;
      seen.add(ref.identity);
      // Best-effort source view for LIVE patterns: resolve the running
      // pattern by identity and read its authored files (source is per
      // module, so the symbol only selects a representative artifact). A
      // source-free by-identity reload carries no program — omit it (same
      // graceful degradation as the prior meta-cell read's try/catch).
      const program = this.runtime.patternManager.getPatternProgramBySync(
        ref.identity,
        ref.symbol,
      );
      if (program) {
        patterns.push({
          identity: ref.identity,
          files: program.files.map((f) => ({
            name: f.name,
            contents: f.contents,
          })),
          ...(program.dataFiles === undefined
            ? {}
            : { dataFiles: program.dataFiles }),
        });
      }
    }
    return { patterns };
  }

  setBreakpoints(request: SetBreakpointsRequest): void {
    this.runtime.scheduler.setBreakpoints(request.actionIds);
  }

  async handleUploadBlob(
    request: UploadBlobRequest,
  ): Promise<UploadBlobResponse> {
    // Guard for untyped callers: the request must name the blob's space
    // (required since the federation work) — fail with a named error
    // rather than a confusing server 404 on /undefined/blobs/….
    if (!request.space || !String(request.space).startsWith("did:")) {
      throw new Error("uploadBlob requires a space DID");
    }
    const suffix = (request.suffix ?? "bin").replace(/^\./, "") || "bin";
    // The blob belongs to the named space, so it uploads to — and its
    // returned URL resolves against — THAT space's host.
    const host = this.runtime.hostForSpace(request.space);
    const target = new URL(
      `/${request.space}/blobs/upload.${encodeURIComponent(suffix)}`,
      host,
    );
    // The envelope's decode already produced this; `request.body` is a
    // `FabricBytes` by the time it arrives, and a handler owns the values its
    // request carries per `BaseRequest`, so nothing else is reading it. The
    // check is on the arm rather than the decode: the declared type is what
    // the client is meant to send, not what a malformed message can hold.
    const bytes = request.body;
    if (!(bytes instanceof FabricBytes)) {
      throw new Error("uploadBlob requires bytes as its body");
    }
    // Blob upload payloads must preserve FabricBytes even when the wider
    // process is running with legacy memory JSON flags.
    const body = blobUploadCodec.encode({
      type: request.contentType,
      body: bytes,
    });
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Blob upload failed: ${response.status} ${await response.text()}`,
      );
    }
    const result = await response.json() as Partial<UploadBlobResponse>;
    if (typeof result.id !== "string" || typeof result.url !== "string") {
      throw new Error("Blob upload returned an invalid response");
    }
    return {
      id: result.id,
      url: resolveBlobUrl(result.url, host, request.space),
    };
  }

  async detectNonIdempotent(
    request: DetectNonIdempotentRequest,
  ): Promise<DetectNonIdempotentResponse> {
    const result = await this.runtime.scheduler.runDiagnosis(
      request.durationMs,
    );
    return { result };
  }

  getPatternCoverage(_: GetPatternCoverageRequest): PatternCoverageResponse {
    return { data: this.runtime.patternCoverage?.toData() ?? null };
  }

  getSettleStats(
    _request: GetSettleStatsRequest,
  ): SettleStatsResponse {
    return {
      stats: this.runtime.scheduler.getSettleStats(),
    };
  }

  getSettleStatsHistory(
    _request: GetSettleStatsHistoryRequest,
  ): SettleStatsHistoryResponse {
    return {
      history: this.runtime.scheduler.getSettleStatsHistory(),
    };
  }

  setSettleStatsEnabled(
    request: SetSettleStatsEnabledRequest,
  ): void {
    this.runtime.scheduler.setSettleStatsEnabled(request.enabled);
  }

  getActionRunTrace(
    _request: GetActionRunTraceRequest,
  ): ActionRunTraceResponse {
    return {
      trace: this.runtime.scheduler.getActionRunTrace(),
    };
  }

  setActionRunTraceEnabled(
    request: SetActionRunTraceEnabledRequest,
  ): void {
    this.runtime.scheduler.setActionRunTraceEnabled(request.enabled);
  }

  getTriggerTrace(
    _request: GetTriggerTraceRequest,
  ): TriggerTraceResponse {
    return {
      trace: this.runtime.scheduler.getTriggerTrace(),
    };
  }

  setTriggerTraceEnabled(
    request: SetTriggerTraceEnabledRequest,
  ): void {
    this.runtime.scheduler.setTriggerTraceEnabled(request.enabled);
  }

  getWriteStackTrace(
    _request: GetWriteStackTraceRequest,
  ): WriteStackTraceResponse {
    return {
      trace: this.runtime.getWriteStackTrace(),
    };
  }

  setWriteStackTraceMatchers(
    request: SetWriteStackTraceMatchersRequest,
  ): void {
    this.runtime.setWriteStackTraceMatchers(request.matchers);
  }

  async handleRequest(
    request: IPCClientRequest,
  ): Promise<RemoteResponse | void> {
    switch (request.type) {
      case RequestType.Dispose:
        return await this.dispose();
      case RequestType.CellGet:
        return this.handleCellGet(request);
      case RequestType.CellSet:
        return this.handleCellSet(request);
      case RequestType.CellPush:
        return this.handleCellPush(request);
      case RequestType.CellSend:
        return this.handleCellSend(request);
      case RequestType.CellSubscribe:
        return this.handleCellSubscribe(request);
      case RequestType.CellUnsubscribe:
        return this.handleCellUnsubscribe(request);
      case RequestType.CellResolveAsCell:
        return this.handleCellResolveAsCell(request);
      case RequestType.CellGetCfcLabel:
        return await this.handleCellGetCfcLabel(request);
      case RequestType.OperationQuery:
        return await this.handleOperationQuery(request);
      case RequestType.OperationCapabilities:
        return await this.handleOperationCapabilities(request);
      case RequestType.OperationApply:
        return await this.handleOperationApply(request);
      case RequestType.OperationRelease:
        return await this.handleOperationRelease(request);
      case RequestType.OperationSubscribe:
        return await this.handleOperationSubscribe(request);
      case RequestType.OperationUnsubscribe:
        return this.handleOperationUnsubscribe(request);
      case RequestType.OperationSessionClose:
        return this.handleOperationSessionClose(request);
      case RequestType.GetCell:
        return this.handleGetCell(request);
      case RequestType.GetHomeSpaceCell:
        return this.handleGetHomeSpaceCell(request);
      case RequestType.EnsureHomePatternRunning:
        return await this.handleEnsureHomePatternRunning(request);
      case RequestType.Idle:
        return await this.handleIdle();
      case RequestType.FlushCompileCacheWrites:
        return await this.handleFlushCompileCacheWrites();
      case RequestType.PageCreate:
        return await this.handlePieceCreate(
          request,
        );
      case RequestType.GetSpaceRootPattern:
        return await this.handleGetSpaceRootPattern(
          request,
        );
      case RequestType.RecreateSpaceRootPattern:
        return await this.handleRecreateSpaceRootPattern(
          request,
        );
      case RequestType.PageGet:
        return await this.handlePageGet(request);
      case RequestType.PageGetSlug:
        return await this.handlePageGetSlug(request);
      case RequestType.PageRemove:
        return await this.handlePageRemove(request);
      case RequestType.PageStart:
        return await this.handlePageStart(request);
      case RequestType.PageStop:
        return await this.handlePageStop(request);
      case RequestType.PageGetAll:
        return await this.handlePageGetAll(request);
      case RequestType.PieceGetSource:
        return await this.handlePieceGetSource(request);
      case RequestType.PieceGetSourceRevision:
        return await this.handlePieceGetSourceRevision(request);
      case RequestType.PieceClone:
        return await this.handlePieceClone(request);
      case RequestType.PieceUpdateSource:
        return await this.handlePieceUpdateSource(request);
      case RequestType.SpaceGetAcl:
        return await this.handleSpaceGetAcl(request);
      case RequestType.SpaceSetAclEntry:
        return await this.handleSpaceSetAclEntry(request);
      case RequestType.SpaceRemoveAclEntry:
        return await this.handleSpaceRemoveAclEntry(request);
      case RequestType.PageSynced:
        return await this.handlePageSynced(request);
      case RequestType.RuntimeSynced:
        return await this.handleRuntimeSynced();
      case RequestType.ResolveSpaceName:
        return await this.handleResolveSpaceName(request);
      case RequestType.RegisterSpaceHost:
        return this.handleRegisterSpaceHost(request);
      case RequestType.GetGraphSnapshot:
        return this.getGraphSnapshot(request);
      case RequestType.GetLoggerCounts:
        return this.getLoggerCounts(request);
      case RequestType.GetPatternCoverage:
        return this.getPatternCoverage(request);
      case RequestType.SetLoggerLevel:
        return this.setLoggerLevel(request);
      case RequestType.SetLoggerEnabled:
        return this.setLoggerEnabled(request);
      case RequestType.SetTelemetryEnabled:
        return this.setTelemetryEnabled(request);
      case RequestType.ResetLoggerBaselines:
        return this.resetLoggerBaselines(request);
      case RequestType.GetSettleStats:
        return this.getSettleStats(request);
      case RequestType.GetSettleStatsHistory:
        return this.getSettleStatsHistory(request);
      case RequestType.SetSettleStatsEnabled:
        return this.setSettleStatsEnabled(request);
      case RequestType.GetActionRunTrace:
        return this.getActionRunTrace(request);
      case RequestType.SetActionRunTraceEnabled:
        return this.setActionRunTraceEnabled(request);
      case RequestType.GetTriggerTrace:
        return this.getTriggerTrace(request);
      case RequestType.SetTriggerTraceEnabled:
        return this.setTriggerTraceEnabled(request);
      case RequestType.GetWriteStackTrace:
        return this.getWriteStackTrace(request);
      case RequestType.SetWriteStackTraceMatchers:
        return this.setWriteStackTraceMatchers(request);
      case RequestType.DetectNonIdempotent:
        return await this.detectNonIdempotent(request);
      case RequestType.GetPatternSources:
        return this.getPatternSources(request);
      case RequestType.SetBreakpoints:
        return this.setBreakpoints(request);
      case RequestType.UploadBlob:
        return await this.handleUploadBlob(request);
      case RequestType.VDomMount:
        return this.handleVDomMount(request);
      case RequestType.VDomUnmount:
        return this.handleVDomUnmount(request);
      default:
        throw new Error(`Unknown message type: ${(request as any).type}`);
    }
  }

  /**
   * Dispatch a one-way notification from the main thread. There is no response
   * channel back to the sender, so handlers return void; a throw propagates to
   * the worker message loop, which logs it worker-side.
   */
  handleNotification(notification: IPCClientNotification): void {
    switch (notification.type) {
      case ClientNotificationType.VDomEvent:
        return this.handleVDomEvent(notification);
      case ClientNotificationType.VDomBatchApplied:
        return this.handleVDomBatchApplied(notification);
      default:
        console.warn(
          `[RuntimeProcessor] Unknown notification type: ${
            (notification as any).type
          }`,
        );
    }
  }

  /**
   * Handle a DOM event dispatched from the main thread.
   * This routes the event to the appropriate reconciler based on mountId.
   */
  handleVDomEvent(request: VDomEventNotification): void {
    const mount = this.vdomMounts.get(request.mountId);
    if (!mount) {
      console.warn(
        `[RuntimeProcessor] No mount found for mountId: ${request.mountId}`,
      );
      return;
    }

    // CustomEvent.detail was JSON.stringify'd on the main thread (invoking
    // CellHandle.toJSON), so sigil links in it bypass getCell /
    // cellRefToSigilLink — strip any main-thread cfcLabelView copies before
    // a handler can write them (inv-12 Stage 0; codex/cubic review).
    const dispatched = mount.reconciler.dispatchEvent(
      request.handlerId,
      stripSigilCfcLabelViews(request.event) as typeof request.event,
    );
    if (!dispatched) {
      console.warn(
        `[RuntimeProcessor] No handler found for mountId: ${request.mountId}, handlerId: ${request.handlerId}`,
      );
    }
  }

  /**
   * Handle a request to start VDOM rendering for a cell.
   * Creates a WorkerReconciler, subscribes to the cell, and sends VDomBatch notifications.
   */
  handleVDomMount(request: VDomMountRequest): VDomMountResponse {
    const { mountId, cell: cellRef } = request;

    // Check if already mounted
    if (this.vdomMounts.has(mountId)) {
      this.handleVDomUnmount({ type: RequestType.VDomUnmount, mountId });
    }

    // Get the cell from the runtime and apply rendererVDOMSchema
    // The schema has a [UI] property definition that handles VDOM unwrapping
    const rawCell = getCell(this.runtime, cellRef);
    const cell = rawCell.asSchema(rendererVDOMSchema);

    // Create a reconciler that sends ops to the main thread
    const reconciler = new WorkerReconciler({
      renderDeclassificationPolicy: this.renderDeclassificationPolicy,
      renderConfidentialityCeiling: this.renderConfidentialityCeiling,
      resolveRenderConfidentiality: this.renderConfidentialityResolver,
      membershipProvider: this.renderMembershipProvider,
      onOps: (ops: VDomOp[]) => {
        const batchId = this.vdomBatchIdCounter++;
        postToClient({
          type: NotificationType.VDomBatch,
          batchId,
          ops,
          mountId,
          rootId: reconciler.getRootNodeId(),
        });
        return batchId;
      },
      onError: postRuntimeError,
    });

    // Mount the cell - the reconciler will subscribe and emit initial ops
    const cancel = reconciler.mount(cell);

    // Track this mount
    this.vdomMounts.set(mountId, { reconciler, cancel });

    return { rootId: reconciler.getRootNodeId() };
  }

  /**
   * Handle a request to stop VDOM rendering for a mount.
   */
  handleVDomUnmount(request: VDomUnmountRequest): void {
    const { mountId } = request;

    const mount = this.vdomMounts.get(mountId);
    if (!mount) {
      console.warn(`[RuntimeProcessor] Mount ${mountId} not found for unmount`);
      return;
    }

    // Cancel subscriptions and clean up
    mount.cancel();
    mount.reconciler.unmount();
    this.vdomMounts.delete(mountId);
  }

  handleVDomBatchApplied(request: VDomBatchAppliedNotification): void {
    const mount = this.vdomMounts.get(request.mountId);
    if (!mount) {
      return;
    }
    mount.reconciler.acknowledgeBatchApplied(request.batchId);
  }
}
