import type { MetaField } from "@commonfabric/api";
import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import type {
  FabricPlainObject,
  FabricValue,
} from "@commonfabric/data-model/fabric-value";
import type { DID, KeyPairRaw } from "@commonfabric/identity";
import { type Program } from "@commonfabric/js-compiler/interface";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import type { CfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import type {
  ActionRunTraceEntry,
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
  PatternCoverageData,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commonfabric/runner/shared";
import { RuntimeTelemetryMarkerResult } from "@commonfabric/runtime-client";
export type { JSONSchema, JSONValue, Program };

export type { CfcLabelView };

export type MessageId = number;

export type CellRef = NormalizedFullLink & {
  cfcLabelView?: CfcLabelView;
};

export type PageRef = {
  cell: CellRef;
};

export enum RequestType {
  // Lifecycle
  Initialize = "initialize",
  Dispose = "dispose",

  // Cell operations (main -> worker)
  CellGet = "cell:get",
  CellSet = "cell:set",
  CellPush = "cell:push",
  CellSend = "cell:send",
  CellSubscribe = "cell:subscribe",
  CellUnsubscribe = "cell:unsubscribe",
  CellResolveAsCell = "cell:resolveAsCell",
  CellGetCfcLabel = "cell:getCfcLabel",

  // Runtime operations
  GetCell = "runtime:getCell",
  GetHomeSpaceCell = "runtime:getHomeSpaceCell",
  EnsureHomePatternRunning = "runtime:ensureHomePatternRunning",
  Idle = "runtime:idle",
  RuntimeSynced = "runtime:synced",
  ResolveSpaceName = "runtime:resolveSpaceName",
  RegisterSpaceHost = "runtime:registerSpaceHost",
  FlushCompileCacheWrites = "runtime:flushCompileCacheWrites",
  GetGraphSnapshot = "runtime:getGraphSnapshot",
  GetLoggerCounts = "runtime:getLoggerCounts",
  GetPatternCoverage = "runtime:getPatternCoverage",
  SetLoggerLevel = "runtime:setLoggerLevel",
  SetLoggerEnabled = "runtime:setLoggerEnabled",
  SetTelemetryEnabled = "runtime:setTelemetryEnabled",
  SetForwardWorkerConsole = "runtime:setForwardWorkerConsole",
  ResetLoggerBaselines = "runtime:resetLoggerBaselines",
  GetSettleStats = "runtime:getSettleStats",
  GetSettleStatsHistory = "runtime:getSettleStatsHistory",
  SetSettleStatsEnabled = "runtime:setSettleStatsEnabled",
  GetActionRunTrace = "runtime:getActionRunTrace",
  SetActionRunTraceEnabled = "runtime:setActionRunTraceEnabled",
  GetTriggerTrace = "runtime:getTriggerTrace",
  SetTriggerTraceEnabled = "runtime:setTriggerTraceEnabled",
  GetWriteStackTrace = "runtime:getWriteStackTrace",
  SetWriteStackTraceMatchers = "runtime:setWriteStackTraceMatchers",
  DetectNonIdempotent = "runtime:detectNonIdempotent",
  GetPatternSources = "runtime:getPatternSources",
  SetBreakpoints = "runtime:setBreakpoints",
  UploadBlob = "runtime:uploadBlob",

  // Page operations (main -> worker)
  GetSpaceRootPattern = "pattern:getSpaceRoot",
  RecreateSpaceRootPattern = "pattern:recreateSpaceRoot",
  PageCreate = "page:create",
  PageGet = "page:get",
  PageGetSlug = "page:getSlug",
  PageRemove = "page:remove",
  PageStart = "page:start",
  PageStop = "page:stop",
  PageGetAll = "page:getAll",
  PageSynced = "page:synced",
  PieceGetSource = "piece:getSource",
  PieceGetSourceRevision = "piece:getSourceRevision",
  PieceClone = "piece:clone",
  PieceUpdateSource = "piece:updateSource",
  SpaceGetAcl = "space:getAcl",
  SpaceSetAclEntry = "space:setAclEntry",
  SpaceRemoveAclEntry = "space:removeAclEntry",

  // VDOM operations (main -> worker)
  VDomMount = "vdom:mount",
  VDomUnmount = "vdom:unmount",
}

// One-way main -> worker notifications. Unlike requests, these carry no
// msgId and the worker sends no response. Used for fire-and-forget signals
// where the main thread does not depend on a reply.
export enum ClientNotificationType {
  VDomEvent = "vdom:event",
  VDomBatchApplied = "vdom:batch-applied",
}

export enum NotificationType {
  CellUpdate = "cell:update",
  ConsoleMessage = "callback:console",
  NavigateRequest = "callback:navigate",
  ErrorReport = "callback:error",
  Telemetry = "callback:telemetry",
  VDomBatch = "vdom:batch",
  PendingWritesChanged = "callback:pending-writes",
}

export type IPCClientMessage = {
  msgId: MessageId;
  data: IPCClientRequest;
};

export enum RuntimeErrorCode {
  CompilerStackLoadFailed = "compiler-stack-load-failed",
}

export type IPCRemoteResponse = {
  msgId: MessageId;
  data?: RemoteResponse;
} | {
  msgId: MessageId;
  error: string;
  code?: RuntimeErrorCode;
};

export type IPCRemoteMessage = IPCRemoteNotification | IPCRemoteResponse;

/**
 * Base of every request a handler receives.
 *
 * **Ownership.** Any value reaching a handler implementation is owned outright
 * by the receiver: it is guaranteed not to be shared elsewhere already, and not
 * to become shared later, except by the receiver's own action. A handler may
 * therefore retain, mutate, or cede what it is given without defending itself.
 *
 * That is a requirement on whatever delivers a request, not a property of any
 * particular transport -- see `RuntimeTransport.send()`.
 */
export type BaseRequest = {
  type: RequestType;
};

export type InitializationData = {
  // URL of backend server. Also the default host for spaces absent from
  // `spaceHostMap`.
  apiUrl: string;
  // Optional map from space DIDs to HTTP or HTTPS origins. A listed space has
  // its storage resolved against that host instead of `apiUrl`. Absent map or
  // absent entry ⇒ `apiUrl`, byte-identical to the single-host behavior.
  // Plain record: structured-clone-safe — no functions cross the worker
  // IPC boundary. Fixed for the connection's lifetime.
  spaceHostMap?: Record<string, string>;
  // Signer.
  //
  // TODO(danfuzz): this and `spaceIdentity` below are the other crossing the
  // `InsecureCryptoKeyPair` marker in `@commonfabric/identity`'s
  // `interface.ts` is about, and want the same `FabricBytes` for the same
  // reason.
  identity: KeyPairRaw;
  // Identity of space.
  spaceDid: DID;
  // Temporary space name
  spaceName?: string;
  // Temporary identity of space.
  spaceIdentity?: KeyPairRaw;
  // Default timeout in milliseconds.
  timeoutMs?: number;
  // Experimental space-model feature flags.
  experimental?: {
    modernCellRep?: boolean;
    // Roll a space's system root pattern (home included) forward in place
    // when its toolshed serves a newer identity. Default off.
    systemPatternAutoUpdate?: boolean;
    // Server-execution v2 (docs/specs/server-side-execution/). The host
    // DECLARES its posture here so the worker runs the same arm — the
    // flag previously rode only as an untyped excess property, and any
    // typed re-packaging silently reverted a worker to OFF while the
    // host diverted (F10 alive and dead across realms; review
    // 2026-08-11 m7). The worker refuses initialization when its
    // resolved posture disagrees with this declaration.
    serverExecution?: boolean;
    // Link writers emit cid: schema-document references, with each closure
    // materialized in the carrying transaction (content-addressed schemas
    // Phase 1). Default on; an explicit false is the rollback override.
    contentAddressedSchemas?: boolean;
  };
  // Commit-boundary CFC mode for the worker runtime.
  cfcEnforcementMode?:
    | "disabled"
    | "observe"
    | "enforce-explicit"
    | "enforce-strict";
  // Flow-label propagation dial for the worker runtime (S16 default
  // transition; docs/history/plans/cfc-future-work-implementation.md Epic H1):
  // "off" = no derivation; "observe" = compute the per-tx conservative
  // join and emit diagnostics, persist nothing; "persist" = write derived
  // label components. Propagation never rejects by itself. Absent =
  // the runner's default ("off").
  cfcFlowLabels?: "off" | "observe" | "persist";
  // Whether author-supplied render-boundary declassification is honored.
  // Defaults to "allow" (current behavior). "deny" ignores author-supplied
  // `declassifyConfidentiality` so a pattern can't release a secret upward
  // through a render boundary (audit S15).
  renderDeclassificationPolicy?: "allow" | "deny";
  // Host-supplied default render ceiling (spec §8.10.6, S16 phase D):
  // confidentiality a display surface admits by default — exact `atoms`
  // (the place for acting-user identity atoms) plus Caveat `caveatKinds`
  // (display-dischargeable classes). Undefined = no ceiling (current
  // behavior).
  renderConfidentialityCeiling?: {
    atoms?: readonly CfcConfClause[];
    caveatKinds?: readonly string[];
  };
  // Static trust snapshot applied to worker-owned transactions.
  trustSnapshot?: {
    id: string;
    actingPrincipal?: string;
    revision?: string;
  };
  // When true, the worker mirrors its own console output (log/warn/error)
  // to the main thread, which re-emits it on the page console prefixed
  // with `[worker]`, so runtime-internal logs reach devtools and
  // integration-test console capture. Off by default: each forwarded call
  // costs one postMessage, so it is enabled only for diagnostic runs.
  forwardWorkerConsole?: boolean;
  // When true, the worker runtime instruments every pattern compile for
  // statement coverage and accumulates hits, which the integration harness
  // pulls at teardown via GetPatternCoverage. Test/CI only (the coverage shell
  // build sets it); off by default. See docs/development/COVERAGE.md.
  patternCoverage?: boolean;
  // When true, the worker's remote storage overlaps watch-refresh round trips
  // up to a bounded window instead of the default strict single-flight
  // (`experimentalConcurrentWatchRefresh`, docs/development/EXPERIMENTAL_OPTIONS.md).
  // Fixed at StorageManager.open time, so like the render ceiling it takes
  // effect on the next runtime (reload), not live. Off by default; the shell
  // dogfood toggle `commonfabric.concurrentWatchRefresh()` sets it.
  concurrentWatchRefresh?: boolean;
};

export type InitializeRequest = BaseRequest & {
  type: RequestType.Initialize;
  data: InitializationData;
};

export type DisposeRequest = BaseRequest & {
  type: RequestType.Dispose;
};

export type CellGetRequest = BaseRequest & {
  type: RequestType.CellGet;
  cell: CellRef;
  meta?: MetaField;
  // Opt in to having the cell's display CFC label returned alongside the value,
  // so a caller that needs both pays one round-trip instead of a separate
  // CellGetCfcLabel request.
  includeCfcLabel?: boolean;
  // Opt in to having the read cell's own schema-bearing ref returned. Useful
  // when `meta` names a link field (pattern/argument/result): the resolved
  // cell's ref lets the caller subscribe to it or read it again directly,
  // and its schema carries the declarations (e.g. stream fields) that the
  // value alone does not.
  includeRef?: boolean;
};

/**
 * A cell's value as this connection carries it: the data a cell holds, with a
 * `CellRef` wherever a cell sits.
 *
 * Distinct from `JSONValue` in the two ways the traffic actually differs: a
 * present `undefined` is a value a cell can hold, and the containers are
 * readonly.
 *
 * TODO(danfuzz): this still cannot carry the whole `FabricValue` domain. A
 * `FabricSpecialObject` has no representation here, and neither does a
 * `bigint` or a `symbol`, both of which are `FabricValue` arms. The transport
 * is `postMessage` rather than JSON, so that is a gap rather than a limit --
 * though structured clone alone does not close it, a class instance arriving
 * with its prototype and private fields gone. `codec-realm` is the mechanism,
 * being the format written for this crossing: a `bigint` travels as itself, a
 * `symbol` under a tag, and a `FabricBytes` as an `ArrayBuffer` a send can
 * transfer. Until then
 * `CellHandle.serialize()` refuses all three, so what the gap costs is a throw
 * rather than silent loss.
 */
export type WireCellValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | readonly WireCellValue[]
  | { readonly [key: string]: WireCellValue }
  | CellRef;

export type CellSetRequest = BaseRequest & {
  type: RequestType.CellSet;
  cell: CellRef;
  value: WireCellValue;
};

// A read-modify-write append (`CellHandle.push`). Same wire shape as CellSet —
// it carries the whole already-appended array — but routed as its own request so
// the runtime keeps the read-target as a commit precondition (compare-and-set),
// rather than the blind last-write-wins of CellSet.
export type CellPushRequest = BaseRequest & {
  type: RequestType.CellPush;
  cell: CellRef;
  value: WireCellValue;
};

export type CellSendRequest = BaseRequest & {
  type: RequestType.CellSend;
  cell: CellRef;
  event: WireCellValue;
};

export type CellSubscribeRequest = BaseRequest & {
  type: RequestType.CellSubscribe;
  cell: CellRef;
  // Opt in to reactive CFC-label delivery: each CellUpdate then carries the
  // cell's current display label, and the worker reads that label as a tracked
  // dependency of the sink, so a label-only write (value unchanged) re-fires
  // the subscription. Off by default — only label-displaying callers pay it.
  includeCfcLabel?: boolean;
};

export type CellUnsubscribeRequest = BaseRequest & {
  type: RequestType.CellUnsubscribe;
  cell: CellRef;
};

export type CellResolveAsCellRequest = BaseRequest & {
  type: RequestType.CellResolveAsCell;
  cell: CellRef;
};

export type CellGetCfcLabelRequest = BaseRequest & {
  type: RequestType.CellGetCfcLabel;
  cell: CellRef;
};

// unused?
export type GetCellRequest = BaseRequest & {
  type: RequestType.GetCell;
  space: DID;
  cause: FabricValue;
  schema?: JSONSchema;
};

export type GetHomeSpaceCellRequest = BaseRequest & {
  type: RequestType.GetHomeSpaceCell;
};

export type EnsureHomePatternRunningRequest = BaseRequest & {
  type: RequestType.EnsureHomePatternRunning;
};

export type IdleRequest = BaseRequest & {
  type: RequestType.Idle;
};

/**
 * Await storage/piece-manager convergence for EVERY space this worker
 * has opened. Genuinely spaceless — like Idle — unlike PageSynced,
 * which awaits one named space's piece context.
 */
export type RuntimeSyncedRequest = BaseRequest & {
  type: RequestType.RuntimeSynced;
};

/** Resolve a legacy named space inside the worker so its derived identity can
 * be retained as fresh-space ACL bootstrap authority. */
export type ResolveSpaceNameRequest = BaseRequest & {
  type: RequestType.ResolveSpaceName;
  name: string;
};

/**
 * Record a runtime-learned HTTP or HTTPS host hint for a space (site-table v0).
 * The durable record is the home-space site table; this IPC lets an
 * embedder make a just-learned hint (e.g. from a share link) effective
 * on the live runtime without waiting for a sync round-trip. The
 * worker returns whether it accepted or confirmed the hint. A seed, an
 * accepted late hint fixes the route for the session. A read-only unseeded
 * provider opened through the default host remains provisional.
 *
 * ORDERING CONTRACT: an embedder sends a newly learned hint before it relies
 * on the space and proceeds only when the worker returns true. The first hint
 * replaces and reloads a read-only provisional default-host provider. An
 * accepted site-table route can reject a conflicting IPC hint. The IPC does
 * not override a seed or route already accepted for the session.
 */
export type RegisterSpaceHostRequest = BaseRequest & {
  type: RequestType.RegisterSpaceHost;
  space: DID;
  host: string;
};

/**
 * Await all in-flight compile-cache write-backs (persistence durability), as
 * distinct from `Idle` (reactive/scheduler quiescence). Used by tests that
 * assert a precompiled pattern loads without an in-client recompile: the cache
 * write must be durable before a subsequent load reads it.
 */
export type FlushCompileCacheWritesRequest = BaseRequest & {
  type: RequestType.FlushCompileCacheWrites;
};

export type GetGraphSnapshotRequest = BaseRequest & {
  type: RequestType.GetGraphSnapshot;
};

export type GetLoggerCountsRequest = BaseRequest & {
  type: RequestType.GetLoggerCounts;
};

export type GetPatternCoverageRequest = BaseRequest & {
  type: RequestType.GetPatternCoverage;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type SetLoggerLevelRequest = BaseRequest & {
  type: RequestType.SetLoggerLevel;
  /** Logger name. If not provided, sets level for all loggers. */
  loggerName?: string;
  level: LogLevel;
};

export type SetLoggerEnabledRequest = BaseRequest & {
  type: RequestType.SetLoggerEnabled;
  /** Logger name. If not provided, sets enabled for all loggers. */
  loggerName?: string;
  enabled: boolean;
};

export type SetTelemetryEnabledRequest = BaseRequest & {
  type: RequestType.SetTelemetryEnabled;
  enabled: boolean;
};

export type SetForwardWorkerConsoleRequest = BaseRequest & {
  type: RequestType.SetForwardWorkerConsole;
  enabled: boolean;
};

export type ResetLoggerBaselinesRequest = BaseRequest & {
  type: RequestType.ResetLoggerBaselines;
};

export type GetSettleStatsRequest = BaseRequest & {
  type: RequestType.GetSettleStats;
};

export type SetSettleStatsEnabledRequest = BaseRequest & {
  type: RequestType.SetSettleStatsEnabled;
  enabled: boolean;
};

export type GetSettleStatsHistoryRequest = BaseRequest & {
  type: RequestType.GetSettleStatsHistory;
};

export type GetActionRunTraceRequest = BaseRequest & {
  type: RequestType.GetActionRunTrace;
};

export type SetActionRunTraceEnabledRequest = BaseRequest & {
  type: RequestType.SetActionRunTraceEnabled;
  enabled: boolean;
};

export type GetTriggerTraceRequest = BaseRequest & {
  type: RequestType.GetTriggerTrace;
};

export type SetTriggerTraceEnabledRequest = BaseRequest & {
  type: RequestType.SetTriggerTraceEnabled;
  enabled: boolean;
};

export type GetWriteStackTraceRequest = BaseRequest & {
  type: RequestType.GetWriteStackTrace;
};

export type SetWriteStackTraceMatchersRequest = BaseRequest & {
  type: RequestType.SetWriteStackTraceMatchers;
  matchers: WriteStackTraceMatcher[];
};

export type DetectNonIdempotentRequest = BaseRequest & {
  type: RequestType.DetectNonIdempotent;
  durationMs?: number;
};

export type SettleStatsResponse = {
  stats: SettleStats | null;
};

export type SettleStatsHistoryResponse = {
  history: SettleStatsHistoryEntry[];
};

export type ActionRunTraceResponse = {
  trace: ActionRunTraceEntry[];
};

export type TriggerTraceResponse = {
  trace: TriggerTraceEntry[];
};

export type WriteStackTraceResponse = {
  trace: WriteStackTraceEntry[];
};

export type DetectNonIdempotentResponse = {
  result: SchedulerDiagnosisResult;
};

export type GetPatternSourcesRequest = BaseRequest & {
  type: RequestType.GetPatternSources;
};

export type PatternSourceFile = {
  name: string;
  contents: string;
};

export type PatternSourceInfo = {
  /** Content identity of the pattern's entry module (`cf:module/<hash>`). */
  identity: string;
  files: PatternSourceFile[];
  /** Names among `files` that carry data rather than code. */
  dataFiles?: string[];
};

export type PatternSourcesResponse = {
  patterns: PatternSourceInfo[];
};

export type SetBreakpointsRequest = BaseRequest & {
  type: RequestType.SetBreakpoints;
  actionIds: string[];
};

export type UploadBlobRequest = BaseRequest & {
  type: RequestType.UploadBlob;
  /** The space the blob belongs to — uploads target ITS host. */
  space: DID;
  contentType: string;
  /**
   * The blob's bytes: a `FabricBytes` in the realm-crossing form, which
   * carries it as a bare `ArrayBuffer` that structured cloning delivers whole
   * and a send can transfer. It decodes back into a `FabricBytes`, so the
   * bytes are an immutable value at both ends rather than a view a sender
   * still holds.
   */
  body: RealmEncodedValue;
  suffix?: string;
};

export type UploadBlobResponse = {
  id: string;
  url: string;
};

// Logger count types for IPC (matches @commonfabric/utils/logger types)
export type LogCounts = {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
};

export type LoggerBreakdown = {
  [messageKey: string]: LogCounts;
} & {
  total: number;
};

export type LoggerCountsData = Record<string, LoggerBreakdown> & {
  total: number;
};

export type LoggerInfo = {
  enabled: boolean;
  level: LogLevel;
};

export type LoggerMetadata = Record<string, LoggerInfo>;

// Timing stats types for IPC (matches @commonfabric/utils/logger types)
export type CDFPoint = {
  x: number; // Latency in ms
  y: number; // Cumulative probability (0-1)
};

export type TimingStats = {
  count: number; // Total measurements
  min: number; // Minimum time (ms)
  max: number; // Maximum time (ms)
  totalTime: number; // Sum for average calculation
  average: number; // totalTime / count
  p50: number; // Median (50th percentile)
  p95: number; // 95th percentile
  lastTime: number; // Most recent measurement
  lastTimestamp: number; // When last recorded
  cdf: CDFPoint[]; // CDF of all samples since start
  cdfSinceBaseline: CDFPoint[] | null; // CDF of samples since baseline reset
};

export type LoggerTimingData = Record<
  string,
  Record<string, TimingStats>
>;

/**
 * Active logger flags, by logger name, flag name and id. A flag set without
 * metadata is `null`.
 */
export type LoggerFlagsData = Record<
  string,
  Record<string, Record<string, FabricPlainObject | null>>
>;

export type PageCreateRequest = BaseRequest & {
  type: RequestType.PageCreate;
  /** The space the piece is created in — part of its address. */
  space: DID;
  source: {
    url: string;
  } | {
    program: Program;
  };
  // TODO(danfuzz): a piece's argument is a `FabricValue`, and `JSONValue`
  // narrows it to the JSON-compatible subset with nothing carrying the rest.
  // The same gap `WireCellValue` is marked with, at the other request that
  // sends a value into the worker, and closed by the same mechanism
  // (`codec-realm`).
  argument?: JSONValue;
  cause?: string;
  run?: boolean;
};

/**
 * Page operations resolve against one space's piece context, and every
 * request names its space explicitly — there is no implicit/default
 * space at this layer. The worker lazily builds a piece context per
 * space, sharing the one runtime/storage connection.
 */
export type PageGetSpaceDefault = BaseRequest & {
  type: RequestType.GetSpaceRootPattern;
  space: DID;
};

export type RecreateSpaceRootPatternRequest = BaseRequest & {
  type: RequestType.RecreateSpaceRootPattern;
  space: DID;
};

export type PageGetRequest = BaseRequest & {
  type: RequestType.PageGet;
  pageId: string;
  runIt?: boolean;
  space: DID;
};

export type PageGetSlugRequest = BaseRequest & {
  type: RequestType.PageGetSlug;
  pageId: string;
  space: DID;
};

export type PageRemoveRequest = BaseRequest & {
  type: RequestType.PageRemove;
  pageId: string;
  space: DID;
};

export type PageStartRequest = BaseRequest & {
  type: RequestType.PageStart;
  pageId: string;
  space: DID;
};

export type PageStopRequest = BaseRequest & {
  type: RequestType.PageStop;
  pageId: string;
  space: DID;
};

export type PageGetAllRequest = BaseRequest & {
  type: RequestType.PageGetAll;
  space: DID;
};

export type PageSyncedRequest = BaseRequest & {
  type: RequestType.PageSynced;
  space: DID;
};

/**
 * Read one piece's source state: the pattern it runs, the origin it tracks, the
 * history metadata it carries, and its authored source files. See
 * `docs/specs/piece-source-lifecycle.md`.
 */
export type PieceGetSourceRequest = BaseRequest & {
  type: RequestType.PieceGetSource;
  space: DID;
  pieceId: string;
};

/** Read the authored files retained for one recorded source revision. */
export type PieceGetSourceRevisionRequest = BaseRequest & {
  type: RequestType.PieceGetSourceRevision;
  space: DID;
  pieceId: string;
  revisionId: string;
};

/** Create a copy of a piece in another space. */
export type PieceCloneRequest = BaseRequest & {
  type: RequestType.PieceClone;
  sourceSpace: DID;
  pieceId: string;
  destinationSpace: DID;
  /** Seed the clone with snapshots of the source piece's durable data. */
  copyData?: boolean;
};

/** How a piece's origin URL resolves. */
export type PieceOriginKind = "web" | "fabric-piece" | "fabric-pattern";

export type PieceOriginView = {
  url: string;
  kind: PieceOriginKind;
  /** The URL as recorded on the piece, when normalization changed it. */
  recorded?: string;
};

export type PiecePatternRefView = {
  identity: string;
  symbol: string;
};

export type PieceSourceRevisionOperation =
  | "baseline"
  | "create"
  | "edit"
  | "origin-update"
  | "detach"
  | "revert"
  | "follow"
  | "repoint";

export type PieceSourceRevisionView = {
  revisionId: string;
  timestamp: number;
  pattern: PiecePatternRefView;
  origin?: PieceOriginView;
  operation: PieceSourceRevisionOperation;
  selectedRevisionId?: string;
};

export type PieceSourceView = {
  space: DID;
  pieceId: string;
  name?: string;
  pattern?: PiecePatternRefView;
  setupPattern?: PiecePatternRefView;
  displacedPattern?: PiecePatternRefView & { displacedAt?: number };
  origin?: PieceOriginView;
  repository?: string;
  entry?: string;
  files: PatternSourceFile[];
  /** Names among `files` that carry data rather than code. */
  dataFiles?: string[];
  history: PieceSourceRevisionView[];
  currentRevisionId?: string;
};

export type PieceSourceResponse = {
  source: PieceSourceView;
};

export type PieceSourceRevisionSourceView = {
  pattern: PiecePatternRefView;
  files: PatternSourceFile[];
  /** Names among `files` that carry data rather than code. */
  dataFiles?: string[];
};

export type PieceSourceRevisionResponse = {
  source: PieceSourceRevisionSourceView;
};

export type PieceSourceAction =
  | { kind: "detach" }
  | { kind: "restore"; revisionId: string }
  | { kind: "follow"; revisionId: string };

export type PieceUpdateSourceRequest = BaseRequest & {
  type: RequestType.PieceUpdateSource;
  space: DID;
  pieceId: string;
  action: PieceSourceAction;
  /** Opaque token returned with an incompatibility warning. */
  confirmationToken?: string;
};

export type PieceUpdateSourceResponse = PieceSourceResponse & {
  compatibilityWarning?: string;
  confirmationToken?: string;
  executionWarning?: string;
};

/** One access level in a space ACL. */
export type SpaceAclCapability = "READ" | "WRITE" | "OWNER";

/** The space ACL and the current principal's ability to administer it. */
export type SpaceAclView = {
  space: DID;
  principal: DID;
  acl: Record<string, SpaceAclCapability>;
  canEdit: boolean;
};

/** Response carrying a space's access-control view. */
export type SpaceAclResponse = {
  access: SpaceAclView;
};

/** Reads the ACL for one space. */
export type SpaceGetAclRequest = BaseRequest & {
  type: RequestType.SpaceGetAcl;
  space: DID;
};

/** Adds or replaces one explicit ACL entry in a space. */
export type SpaceSetAclEntryRequest = BaseRequest & {
  type: RequestType.SpaceSetAclEntry;
  space: DID;
  user: string;
  capability: SpaceAclCapability;
};

/** Removes one explicit ACL entry from a space. */
export type SpaceRemoveAclEntryRequest = BaseRequest & {
  type: RequestType.SpaceRemoveAclEntry;
  space: DID;
  user: string;
};

/** Common shape for one-way main -> worker notifications. */
export type BaseClientNotification = {
  type: ClientNotificationType;
};

/**
 * VDOM event message sent from main thread to worker when a DOM event fires.
 */
export type VDomEventNotification = BaseClientNotification & {
  type: ClientNotificationType.VDomEvent;
  /** The mount ID that this event belongs to */
  mountId: number;
  /** The handler ID that should process this event */
  handlerId: number;
  /** The serialized event data */
  event: SerializedDomEvent;
  /** The node ID where the event occurred */
  nodeId: number;
};

/**
 * Serialized DOM event data for IPC.
 */
export type SerializedDomEvent = {
  type: string;
  provenance?: {
    origin?: string;
    trusted?: boolean;
    ui?: {
      pattern?: string;
      eventIntegrity?: string[];
      uiContractDataset?: Record<string, string>;
    };
  };
  key?: string;
  code?: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  inputType?: string;
  data?: string | null;
  button?: number;
  buttons?: number;
  target?: SerializedEventTarget;
  detail?: JSONValue;
};

/**
 * Serialized event target data for IPC.
 */
export type SerializedEventTarget = {
  name?: string;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  selectedIndex?: number;
  selectedOptions?: { value: string }[];
  dataset?: Record<string, string>;
};

/**
 * Request to start VDOM rendering for a cell.
 * The worker will subscribe to the cell and send VDomBatch notifications.
 */
export type VDomMountRequest = BaseRequest & {
  type: RequestType.VDomMount;
  /** Unique ID for this mount instance (used to match unmount) */
  mountId: number;
  /** The cell to render as VDOM */
  cell: CellRef;
};

/**
 * Request to stop VDOM rendering for a mount.
 */
export type VDomUnmountRequest = BaseRequest & {
  type: RequestType.VDomUnmount;
  /** The mount ID to stop */
  mountId: number;
};

/**
 * Notification sent after the main thread applies a VDOM batch.
 */
export type VDomBatchAppliedNotification = BaseClientNotification & {
  type: ClientNotificationType.VDomBatchApplied;
  /** The mount ID that received the batch */
  mountId: number;
  /** The applied batch ID */
  batchId: number;
};

/** Union of all one-way main -> worker notifications. */
export type IPCClientNotification =
  | VDomEventNotification
  | VDomBatchAppliedNotification;

/**
 * Response to VDomMount with the root node ID.
 */
export type VDomMountResponse = {
  /** The root node ID for this mount */
  rootId: number;
};

/**
 * TODO(danfuzz): This type should be made compatible with `FabricValue`, for
 * transport implemented using `codec-realm`. As of this writing, secure crypto
 * keypairs cannot be properly represented: `InitializeRequest`'s `identity` is
 * a `KeyPairRaw`, whose `CryptoKeyPair` arm is a pair of opaque host objects
 * that no fabric class covers. Note also that an `interface` never satisfies
 * `FabricPlainObject` -- TypeScript grants an implicit index signature to an
 * anonymous object type and not to an interface -- so every arm here has to
 * become a type alias. The two ends of the crossing carry the matching
 * markers: `WebWorkerRuntimeTransport.send()` in
 * `../client/transports/web-worker/transport-web-worker.ts`, and the `message`
 * listener in `../backends/web-worker/index.ts`.
 */
export type IPCClientRequest =
  | InitializeRequest
  | DisposeRequest
  | CellGetRequest
  | CellSetRequest
  | CellPushRequest
  | CellSendRequest
  | CellSubscribeRequest
  | CellUnsubscribeRequest
  | CellResolveAsCellRequest
  | CellGetCfcLabelRequest
  | GetCellRequest
  | GetHomeSpaceCellRequest
  | EnsureHomePatternRunningRequest
  | GetGraphSnapshotRequest
  | GetLoggerCountsRequest
  | GetPatternCoverageRequest
  | SetLoggerLevelRequest
  | SetLoggerEnabledRequest
  | SetTelemetryEnabledRequest
  | SetForwardWorkerConsoleRequest
  | ResetLoggerBaselinesRequest
  | GetSettleStatsRequest
  | GetSettleStatsHistoryRequest
  | SetSettleStatsEnabledRequest
  | GetActionRunTraceRequest
  | SetActionRunTraceEnabledRequest
  | GetTriggerTraceRequest
  | SetTriggerTraceEnabledRequest
  | GetWriteStackTraceRequest
  | SetWriteStackTraceMatchersRequest
  | IdleRequest
  | FlushCompileCacheWritesRequest
  | PageCreateRequest
  | PageGetSpaceDefault
  | RecreateSpaceRootPatternRequest
  | PageGetRequest
  | PageGetSlugRequest
  | PageRemoveRequest
  | PageStartRequest
  | PageStopRequest
  | PageGetAllRequest
  | PageSyncedRequest
  | PieceGetSourceRequest
  | PieceGetSourceRevisionRequest
  | PieceCloneRequest
  | PieceUpdateSourceRequest
  | SpaceGetAclRequest
  | SpaceSetAclEntryRequest
  | SpaceRemoveAclEntryRequest
  | RuntimeSyncedRequest
  | ResolveSpaceNameRequest
  | RegisterSpaceHostRequest
  | VDomMountRequest
  | VDomUnmountRequest
  | DetectNonIdempotentRequest
  | GetPatternSourcesRequest
  | SetBreakpointsRequest
  | UploadBlobRequest;

export type NullResponse = null;

export type EmptyResponse = undefined;

export type BooleanResponse = {
  value: boolean;
};

/**
 * A cell's value on its way _out_ of the worker, which `WireCellValue` is on
 * its way in.
 *
 * TODO(danfuzz): the two directions want the same type and do not have it.
 * `JSONValue` cannot carry the whole `FabricValue` domain either, and this
 * direction loses where the inbound one throws: the producer hands over a
 * value with its `FabricPrimitive`s intact and structured clone strips each to
 * `{}` (see `handleCellGet` in `backends/runtime-processor.ts`).
 * `codec-realm` is the mechanism, and closing this gap and `WireCellValue`'s
 * is one change.
 */
export type JSONValueResponse = {
  value: JSONValue | undefined;
};

export type CellGetResponse = JSONValueResponse & {
  // Present only when the request set `includeCfcLabel`. `undefined` is a valid
  // value (the cell carries no label); the field is omitted when not requested.
  cfcLabel?: CfcLabelView | undefined;
  // Present only when the request set `includeRef` and the read resolved to a
  // cell (a raw-metadata read has no cell to reference).
  cell?: CellRef;
};

export type CellResponse = {
  cell: CellRef;
};

export type CfcLabelViewResponse = {
  cfcLabel: CfcLabelView | undefined;
};

export type PageResponse = {
  page: PageRef;
};

export type SlugResponse = {
  slug: string | undefined;
};

export type SpaceResponse = {
  space: DID;
};

export type GraphSnapshotResponse = {
  snapshot: SchedulerGraphSnapshot;
};

export type LoggerCountsResponse = {
  counts: LoggerCountsData;
  metadata: LoggerMetadata;
  timing: LoggerTimingData;
  flags: LoggerFlagsData;
};

export type PatternCoverageResponse = {
  /**
   * The worker collector's spans and hit counts, or `null` when this worker was
   * built without a collector. Null and empty are kept apart on purpose: a
   * worker that never had coverage on and one that had it on but ran nothing
   * instrumented are different failures, and reporting both as an empty report
   * makes the first invisible.
   */
  data: PatternCoverageData | null;
};

export type CellUpdateNotification = {
  type: NotificationType.CellUpdate;
  cell: CellRef;
  // TODO(danfuzz): the same gap `JSONValueResponse` is marked with. This is
  // the push form of the same read, produced by the same conversion.
  value: JSONValue;
  // Present only for subscriptions that opted in via `includeCfcLabel`. Carries
  // the cell's current display label so the client re-renders on label changes
  // without a separate getCfcLabel round-trip.
  cfcLabel?: CfcLabelView | undefined;
};

export type ConsoleNotification = {
  type: NotificationType.ConsoleMessage;
  metadata?: { pieceId?: string; patternId?: string; space?: string };
  method: string;
  // TODO(danfuzz): these arrive pre-flattened to text by
  // `sanitizeForPostMessage()` (`backends/runtime-processor.ts`), and the
  // receiver hands them to `console.log()` -- a devtools inspector, which can
  // show more of a value than a string of it can. A `codec-realm` arm here is
  // what lets the fabric among them cross whole; see the marker at the producer
  // for what else has to move first.
  args: JSONValue[];
};

export type NavigateRequestNotification = {
  type: NotificationType.NavigateRequest;
  targetCellRef: CellRef;
};

export type ErrorNotification = {
  type: NotificationType.ErrorReport;
  message: string;
  code?: RuntimeErrorCode;
  pieceId?: string;
  space?: string;
  patternId?: string;
  spellId?: string;
  stackTrace?: string;
};

export type TelemetryNotification = {
  type: NotificationType.Telemetry;
  marker: RuntimeTelemetryMarkerResult;
};

/**
 * Worker-to-page mirror of the storage manager's durability barrier: `pending`
 * is true while any issued commit is still unconfirmed by the server, false
 * once the pending set drains. The shell consults the latest value from its
 * beforeunload handler so a reload with unconfirmed writes prompts the user.
 */
export type PendingWritesNotification = {
  type: NotificationType.PendingWritesChanged;
  pending: boolean;
};

/**
 * The vocabulary of DOM mutations carried by a VDOM batch. The worker
 * reconciler that produces them and the main-thread applicator that consumes
 * them both live in `@commonfabric/html`, which defines the union; the protocol
 * re-exports it so a message shape and the ops inside it cannot describe
 * different things.
 */
import type { VDomOp } from "@commonfabric/html/vdom-ops";
export type { VDomOp };

/**
 * VDOM batch notification sent from worker to main thread.
 */
export type VDomBatchNotification = {
  type: NotificationType.VDomBatch;
  /** Identifier for this batch (for debugging/logging) */
  batchId: number;
  /** The operations to apply, in order */
  ops: VDomOp[];
  /** Optional: the root node ID for this render tree */
  rootId?: number;
  /** The mount ID this batch belongs to */
  mountId?: number;
};

export type RemoteResponse =
  | EmptyResponse
  | NullResponse
  | BooleanResponse
  | JSONValueResponse
  | CellGetResponse
  | CellResponse
  | CfcLabelViewResponse
  | GraphSnapshotResponse
  | LoggerCountsResponse
  | PatternCoverageResponse
  | SettleStatsResponse
  | SettleStatsHistoryResponse
  | ActionRunTraceResponse
  | TriggerTraceResponse
  | WriteStackTraceResponse
  | PageResponse
  | PieceSourceResponse
  | PieceSourceRevisionResponse
  | PieceUpdateSourceResponse
  | SpaceAclResponse
  | SlugResponse
  | SpaceResponse
  | VDomMountResponse
  | DetectNonIdempotentResponse
  | PatternSourcesResponse
  | UploadBlobResponse;

export type IPCRemoteNotification =
  | CellUpdateNotification
  | ConsoleNotification
  | NavigateRequestNotification
  | ErrorNotification
  | VDomBatchNotification
  | PendingWritesNotification;

export type Commands = {
  // Runtime requests
  [RequestType.Initialize]: {
    request: InitializeRequest;
    response: EmptyResponse;
  };
  [RequestType.Dispose]: {
    request: DisposeRequest;
    response: EmptyResponse;
  };
  [RequestType.GetCell]: {
    request: GetCellRequest;
    response: CellResponse;
  };
  [RequestType.GetHomeSpaceCell]: {
    request: GetHomeSpaceCellRequest;
    response: CellResponse;
  };
  [RequestType.EnsureHomePatternRunning]: {
    request: EnsureHomePatternRunningRequest;
    response: CellResponse;
  };
  [RequestType.Idle]: {
    request: IdleRequest;
    response: EmptyResponse;
  };
  [RequestType.FlushCompileCacheWrites]: {
    request: FlushCompileCacheWritesRequest;
    response: EmptyResponse;
  };
  [RequestType.GetGraphSnapshot]: {
    request: GetGraphSnapshotRequest;
    response: GraphSnapshotResponse;
  };
  [RequestType.GetLoggerCounts]: {
    request: GetLoggerCountsRequest;
    response: LoggerCountsResponse;
  };
  [RequestType.GetPatternCoverage]: {
    request: GetPatternCoverageRequest;
    response: PatternCoverageResponse;
  };
  [RequestType.SetLoggerLevel]: {
    request: SetLoggerLevelRequest;
    response: EmptyResponse;
  };
  [RequestType.SetLoggerEnabled]: {
    request: SetLoggerEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.SetTelemetryEnabled]: {
    request: SetTelemetryEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.SetForwardWorkerConsole]: {
    request: SetForwardWorkerConsoleRequest;
    response: EmptyResponse;
  };
  [RequestType.ResetLoggerBaselines]: {
    request: ResetLoggerBaselinesRequest;
    response: EmptyResponse;
  };
  [RequestType.GetSettleStats]: {
    request: GetSettleStatsRequest;
    response: SettleStatsResponse;
  };
  [RequestType.GetSettleStatsHistory]: {
    request: GetSettleStatsHistoryRequest;
    response: SettleStatsHistoryResponse;
  };
  [RequestType.SetSettleStatsEnabled]: {
    request: SetSettleStatsEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetActionRunTrace]: {
    request: GetActionRunTraceRequest;
    response: ActionRunTraceResponse;
  };
  [RequestType.SetActionRunTraceEnabled]: {
    request: SetActionRunTraceEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetTriggerTrace]: {
    request: GetTriggerTraceRequest;
    response: TriggerTraceResponse;
  };
  [RequestType.SetTriggerTraceEnabled]: {
    request: SetTriggerTraceEnabledRequest;
    response: EmptyResponse;
  };
  [RequestType.GetWriteStackTrace]: {
    request: GetWriteStackTraceRequest;
    response: WriteStackTraceResponse;
  };
  [RequestType.SetWriteStackTraceMatchers]: {
    request: SetWriteStackTraceMatchersRequest;
    response: EmptyResponse;
  };
  // Cell requests
  [RequestType.CellGet]: {
    request: CellGetRequest;
    response: CellGetResponse;
  };
  [RequestType.CellSet]: {
    request: CellSetRequest;
    response: EmptyResponse;
  };
  [RequestType.CellPush]: {
    request: CellPushRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSend]: {
    request: CellSendRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSubscribe]: {
    request: CellSubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.CellUnsubscribe]: {
    request: CellUnsubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.CellResolveAsCell]: {
    request: CellResolveAsCellRequest;
    response: CellResponse;
  };
  [RequestType.CellGetCfcLabel]: {
    request: CellGetCfcLabelRequest;
    response: CfcLabelViewResponse;
  };
  // Page requests
  [RequestType.PageCreate]: {
    request: PageCreateRequest;
    response: PageResponse;
  };
  [RequestType.PageSynced]: {
    request: PageSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.RuntimeSynced]: {
    request: RuntimeSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.ResolveSpaceName]: {
    request: ResolveSpaceNameRequest;
    response: SpaceResponse;
  };
  [RequestType.RegisterSpaceHost]: {
    request: RegisterSpaceHostRequest;
    response: BooleanResponse;
  };
  [RequestType.PageGet]: {
    request: PageGetRequest;
    response: PageResponse | NullResponse;
  };
  [RequestType.PageGetSlug]: {
    request: PageGetSlugRequest;
    response: SlugResponse;
  };
  [RequestType.PageRemove]: {
    request: PageRemoveRequest;
    response: BooleanResponse;
  };
  [RequestType.PageStart]: {
    request: PageStartRequest;
    response: BooleanResponse;
  };
  [RequestType.PageStop]: {
    request: PageStopRequest;
    response: BooleanResponse;
  };
  [RequestType.PageGetAll]: {
    request: PageGetAllRequest;
    response: CellResponse;
  };
  [RequestType.PieceGetSource]: {
    request: PieceGetSourceRequest;
    response: PieceSourceResponse;
  };
  [RequestType.PieceGetSourceRevision]: {
    request: PieceGetSourceRevisionRequest;
    response: PieceSourceRevisionResponse;
  };
  [RequestType.PieceClone]: {
    request: PieceCloneRequest;
    response: PageResponse;
  };
  [RequestType.PieceUpdateSource]: {
    request: PieceUpdateSourceRequest;
    response: PieceUpdateSourceResponse;
  };
  [RequestType.SpaceGetAcl]: {
    request: SpaceGetAclRequest;
    response: SpaceAclResponse;
  };
  [RequestType.SpaceSetAclEntry]: {
    request: SpaceSetAclEntryRequest;
    response: SpaceAclResponse;
  };
  [RequestType.SpaceRemoveAclEntry]: {
    request: SpaceRemoveAclEntryRequest;
    response: SpaceAclResponse;
  };
  [RequestType.GetSpaceRootPattern]: {
    request: PageGetSpaceDefault;
    response: PageResponse;
  };
  [RequestType.RecreateSpaceRootPattern]: {
    request: RecreateSpaceRootPatternRequest;
    response: PageResponse;
  };
  // Diagnosis requests
  [RequestType.DetectNonIdempotent]: {
    request: DetectNonIdempotentRequest;
    response: DetectNonIdempotentResponse;
  };
  [RequestType.GetPatternSources]: {
    request: GetPatternSourcesRequest;
    response: PatternSourcesResponse;
  };
  [RequestType.SetBreakpoints]: {
    request: SetBreakpointsRequest;
    response: EmptyResponse;
  };
  [RequestType.UploadBlob]: {
    request: UploadBlobRequest;
    response: UploadBlobResponse;
  };
  // VDOM requests
  [RequestType.VDomMount]: {
    request: VDomMountRequest;
    response: VDomMountResponse;
  };
  [RequestType.VDomUnmount]: {
    request: VDomUnmountRequest;
    response: EmptyResponse;
  };
};

export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;
