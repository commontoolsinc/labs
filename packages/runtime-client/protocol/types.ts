import type {
  ActionRunTraceEntry,
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
  SettleStats,
  SettleStatsHistoryEntry,
  TriggerTraceEntry,
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "@commonfabric/runner/shared";
import type { CfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import type { DID, KeyPairRaw } from "@commonfabric/identity";
import { type Program } from "@commonfabric/js-compiler/interface";
import { RuntimeTelemetryMarkerResult } from "@commonfabric/runtime-client";
import type { MetaField } from "@commonfabric/api";
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
  RegisterSpaceHost = "runtime:registerSpaceHost",
  FlushCompileCacheWrites = "runtime:flushCompileCacheWrites",
  GetGraphSnapshot = "runtime:getGraphSnapshot",
  GetLoggerCounts = "runtime:getLoggerCounts",
  SetLoggerLevel = "runtime:setLoggerLevel",
  SetLoggerEnabled = "runtime:setLoggerEnabled",
  SetTelemetryEnabled = "runtime:setTelemetryEnabled",
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

  // VDOM operations (main -> worker)
  VDomEvent = "vdom:event",
  VDomMount = "vdom:mount",
  VDomUnmount = "vdom:unmount",
  VDomBatchApplied = "vdom:batch-applied",
}

export enum NotificationType {
  CellUpdate = "cell:update",
  ConsoleMessage = "callback:console",
  NavigateRequest = "callback:navigate",
  ErrorReport = "callback:error",
  Telemetry = "callback:telemetry",
  VDomBatch = "vdom:batch",
}

export interface IPCClientMessage {
  msgId: MessageId;
  data: IPCClientRequest;
}

export type IPCRemoteResponse = {
  msgId: MessageId;
  data?: RemoteResponse;
} | {
  msgId: MessageId;
  error: string;
};

export type IPCRemoteMessage = IPCRemoteNotification | IPCRemoteResponse;

export interface BaseRequest {
  type: RequestType;
}

export interface InitializationData {
  // URL of backend server. Also the default host for spaces absent from
  // `spaceHostMap`.
  apiUrl: string;
  // Optional space DID → host base URL map. A space listed here has its
  // storage resolved against that host instead of `apiUrl`. Absent map or
  // absent entry ⇒ `apiUrl`, byte-identical to the single-host behavior.
  // Plain record: structured-clone-safe — no functions cross the worker
  // IPC boundary. Fixed for the connection's lifetime.
  spaceHostMap?: Record<string, string>;
  // Signer.
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
    persistentSchedulerState?: boolean;
  };
  // Commit-boundary CFC mode for the worker runtime.
  cfcEnforcementMode?:
    | "disabled"
    | "observe"
    | "enforce-explicit"
    | "enforce-strict";
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
    atoms?: unknown[];
    caveatKinds?: string[];
  };
  // Static trust snapshot applied to worker-owned transactions.
  trustSnapshot?: {
    id: string;
    actingPrincipal?: string;
    revision?: string;
  };
}

export interface InitializeRequest extends BaseRequest {
  type: RequestType.Initialize;
  data: InitializationData;
}

export interface DisposeRequest extends BaseRequest {
  type: RequestType.Dispose;
}

export interface CellGetRequest extends BaseRequest {
  type: RequestType.CellGet;
  cell: CellRef;
  meta?: MetaField;
}

export interface CellSetRequest extends BaseRequest {
  type: RequestType.CellSet;
  cell: CellRef;
  value: JSONValue;
}

export interface CellSendRequest extends BaseRequest {
  type: RequestType.CellSend;
  cell: CellRef;
  event: JSONValue;
}

export interface CellSubscribeRequest extends BaseRequest {
  type: RequestType.CellSubscribe;
  cell: CellRef;
}

export interface CellUnsubscribeRequest extends BaseRequest {
  type: RequestType.CellUnsubscribe;
  cell: CellRef;
}

export interface CellResolveAsCellRequest extends BaseRequest {
  type: RequestType.CellResolveAsCell;
  cell: CellRef;
}

export interface CellGetCfcLabelRequest extends BaseRequest {
  type: RequestType.CellGetCfcLabel;
  cell: CellRef;
}

// unused?
export interface GetCellRequest extends BaseRequest {
  type: RequestType.GetCell;
  space: DID;
  cause: JSONValue;
  schema?: JSONSchema;
}

export interface GetHomeSpaceCellRequest extends BaseRequest {
  type: RequestType.GetHomeSpaceCell;
}

export interface EnsureHomePatternRunningRequest extends BaseRequest {
  type: RequestType.EnsureHomePatternRunning;
}

export interface IdleRequest extends BaseRequest {
  type: RequestType.Idle;
}

/**
 * Await storage/piece-manager convergence for EVERY space this worker
 * has opened. Genuinely spaceless — like Idle — unlike PageSynced,
 * which awaits one named space's piece context.
 */
export interface RuntimeSyncedRequest extends BaseRequest {
  type: RequestType.RuntimeSynced;
}

/**
 * Record a runtime-learned host hint for a space (site-table v0).
 * The durable record is the home-space site table; this IPC lets an
 * embedder make a just-learned hint (e.g. from a share link) effective
 * on the live runtime without waiting for a sync round-trip. The
 * worker's refusal semantics apply: seed wins, opened spaces are never
 * re-pointed.
 *
 * ORDERING CONTRACT: an embedder that will mount a space it just
 * learned the host for must send this BEFORE the first mount of that
 * space — once a space opens against the default host, the
 * opened-space rule pins it for the session. The table is the durable
 * record; this IPC is the ordering guarantee.
 */
export interface RegisterSpaceHostRequest extends BaseRequest {
  type: RequestType.RegisterSpaceHost;
  space: DID;
  host: string;
}

/**
 * Await all in-flight compile-cache write-backs (persistence durability), as
 * distinct from `Idle` (reactive/scheduler quiescence). Used by tests that
 * assert a precompiled pattern loads without an in-client recompile: the cache
 * write must be durable before a subsequent load reads it.
 */
export interface FlushCompileCacheWritesRequest extends BaseRequest {
  type: RequestType.FlushCompileCacheWrites;
}

export interface GetGraphSnapshotRequest extends BaseRequest {
  type: RequestType.GetGraphSnapshot;
}

export interface GetLoggerCountsRequest extends BaseRequest {
  type: RequestType.GetLoggerCounts;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SetLoggerLevelRequest extends BaseRequest {
  type: RequestType.SetLoggerLevel;
  /** Logger name. If not provided, sets level for all loggers. */
  loggerName?: string;
  level: LogLevel;
}

export interface SetLoggerEnabledRequest extends BaseRequest {
  type: RequestType.SetLoggerEnabled;
  /** Logger name. If not provided, sets enabled for all loggers. */
  loggerName?: string;
  enabled: boolean;
}

export interface SetTelemetryEnabledRequest extends BaseRequest {
  type: RequestType.SetTelemetryEnabled;
  enabled: boolean;
}

export interface ResetLoggerBaselinesRequest extends BaseRequest {
  type: RequestType.ResetLoggerBaselines;
}

export interface GetSettleStatsRequest extends BaseRequest {
  type: RequestType.GetSettleStats;
}

export interface SetSettleStatsEnabledRequest extends BaseRequest {
  type: RequestType.SetSettleStatsEnabled;
  enabled: boolean;
}

export interface GetSettleStatsHistoryRequest extends BaseRequest {
  type: RequestType.GetSettleStatsHistory;
}

export interface GetActionRunTraceRequest extends BaseRequest {
  type: RequestType.GetActionRunTrace;
}

export interface SetActionRunTraceEnabledRequest extends BaseRequest {
  type: RequestType.SetActionRunTraceEnabled;
  enabled: boolean;
}

export interface GetTriggerTraceRequest extends BaseRequest {
  type: RequestType.GetTriggerTrace;
}

export interface SetTriggerTraceEnabledRequest extends BaseRequest {
  type: RequestType.SetTriggerTraceEnabled;
  enabled: boolean;
}

export interface GetWriteStackTraceRequest extends BaseRequest {
  type: RequestType.GetWriteStackTrace;
}

export interface SetWriteStackTraceMatchersRequest extends BaseRequest {
  type: RequestType.SetWriteStackTraceMatchers;
  matchers: WriteStackTraceMatcher[];
}

export interface DetectNonIdempotentRequest extends BaseRequest {
  type: RequestType.DetectNonIdempotent;
  durationMs?: number;
}

export interface SettleStatsResponse {
  stats: SettleStats | null;
}

export interface SettleStatsHistoryResponse {
  history: SettleStatsHistoryEntry[];
}

export interface ActionRunTraceResponse {
  trace: ActionRunTraceEntry[];
}

export interface TriggerTraceResponse {
  trace: TriggerTraceEntry[];
}

export interface WriteStackTraceResponse {
  trace: WriteStackTraceEntry[];
}

export interface DetectNonIdempotentResponse {
  result: SchedulerDiagnosisResult;
}

export interface GetPatternSourcesRequest extends BaseRequest {
  type: RequestType.GetPatternSources;
}

export interface PatternSourceFile {
  name: string;
  contents: string;
}

export interface PatternSourceInfo {
  patternId: string;
  patternName?: string;
  files: PatternSourceFile[];
}

export interface PatternSourcesResponse {
  patterns: PatternSourceInfo[];
}

export interface SetBreakpointsRequest extends BaseRequest {
  type: RequestType.SetBreakpoints;
  actionIds: string[];
}

export interface UploadBlobRequest extends BaseRequest {
  type: RequestType.UploadBlob;
  /** The space the blob belongs to — uploads target ITS host. */
  space: DID;
  contentType: string;
  body: number[];
  suffix?: string;
}

export interface UploadBlobResponse {
  id: string;
  url: string;
}

// Logger count types for IPC (matches @commonfabric/utils/logger types)
export interface LogCounts {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
}

export type LoggerBreakdown = {
  [messageKey: string]: LogCounts;
} & {
  total: number;
};

export type LoggerCountsData = Record<string, LoggerBreakdown> & {
  total: number;
};

export interface LoggerInfo {
  enabled: boolean;
  level: LogLevel;
}

export type LoggerMetadata = Record<string, LoggerInfo>;

// Timing stats types for IPC (matches @commonfabric/utils/logger types)
export interface CDFPoint {
  x: number; // Latency in ms
  y: number; // Cumulative probability (0-1)
}

export interface TimingStats {
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
}

export type LoggerTimingData = Record<
  string,
  Record<string, TimingStats>
>;

export type LoggerFlagsData = Record<
  string,
  Record<string, Record<string, Record<string, unknown> | null>>
>;

export interface PageCreateRequest extends BaseRequest {
  type: RequestType.PageCreate;
  /** The space the piece is created in — part of its address. */
  space: DID;
  source: {
    url: string;
  } | {
    program: Program;
  };
  argument?: JSONValue;
  cause?: string;
  run?: boolean;
}

/**
 * Page operations resolve against one space's piece context, and every
 * request names its space explicitly — there is no implicit/default
 * space at this layer. The worker lazily builds a piece context per
 * space, sharing the one runtime/storage connection.
 */
export interface PageGetSpaceDefault extends BaseRequest {
  type: RequestType.GetSpaceRootPattern;
  space: DID;
}

export interface RecreateSpaceRootPatternRequest extends BaseRequest {
  type: RequestType.RecreateSpaceRootPattern;
  space: DID;
}

export interface PageGetRequest extends BaseRequest {
  type: RequestType.PageGet;
  pageId: string;
  runIt?: boolean;
  space: DID;
}

export interface PageGetSlugRequest extends BaseRequest {
  type: RequestType.PageGetSlug;
  pageId: string;
  space: DID;
}

export interface PageRemoveRequest extends BaseRequest {
  type: RequestType.PageRemove;
  pageId: string;
  space: DID;
}

export interface PageStartRequest extends BaseRequest {
  type: RequestType.PageStart;
  pageId: string;
  space: DID;
}

export interface PageStopRequest extends BaseRequest {
  type: RequestType.PageStop;
  pageId: string;
  space: DID;
}

export interface PageGetAllRequest extends BaseRequest {
  type: RequestType.PageGetAll;
  space: DID;
}

export interface PageSyncedRequest extends BaseRequest {
  type: RequestType.PageSynced;
  space: DID;
}

/**
 * VDOM event message sent from main thread to worker when a DOM event fires.
 */
export interface VDomEventRequest extends BaseRequest {
  type: RequestType.VDomEvent;
  /** The mount ID that this event belongs to */
  mountId: number;
  /** The handler ID that should process this event */
  handlerId: number;
  /** The serialized event data */
  event: SerializedDomEvent;
  /** The node ID where the event occurred */
  nodeId: number;
}

/**
 * Serialized DOM event data for IPC.
 */
export interface SerializedDomEvent {
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
}

/**
 * Serialized event target data for IPC.
 */
export interface SerializedEventTarget {
  name?: string;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  selectedIndex?: number;
  selectedOptions?: { value: string }[];
  dataset?: Record<string, string>;
}

/**
 * Request to start VDOM rendering for a cell.
 * The worker will subscribe to the cell and send VDomBatch notifications.
 */
export interface VDomMountRequest extends BaseRequest {
  type: RequestType.VDomMount;
  /** Unique ID for this mount instance (used to match unmount) */
  mountId: number;
  /** The cell to render as VDOM */
  cell: CellRef;
}

/**
 * Request to stop VDOM rendering for a mount.
 */
export interface VDomUnmountRequest extends BaseRequest {
  type: RequestType.VDomUnmount;
  /** The mount ID to stop */
  mountId: number;
}

/**
 * Request sent after the main thread applies a VDOM batch.
 */
export interface VDomBatchAppliedRequest extends BaseRequest {
  type: RequestType.VDomBatchApplied;
  /** The mount ID that received the batch */
  mountId: number;
  /** The applied batch ID */
  batchId: number;
}

/**
 * Response to VDomMount with the root node ID.
 */
export interface VDomMountResponse {
  /** The root node ID for this mount */
  rootId: number;
}

export type IPCClientRequest =
  | InitializeRequest
  | DisposeRequest
  | CellGetRequest
  | CellSetRequest
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
  | SetLoggerLevelRequest
  | SetLoggerEnabledRequest
  | SetTelemetryEnabledRequest
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
  | RuntimeSyncedRequest
  | RegisterSpaceHostRequest
  | VDomEventRequest
  | VDomMountRequest
  | VDomUnmountRequest
  | VDomBatchAppliedRequest
  | DetectNonIdempotentRequest
  | GetPatternSourcesRequest
  | SetBreakpointsRequest
  | UploadBlobRequest;

export type NullResponse = null;

export type EmptyResponse = undefined;

export interface BooleanResponse {
  value: boolean;
}

export interface JSONValueResponse {
  value: JSONValue | undefined;
}

export interface CellResponse {
  cell: CellRef;
}

export interface CfcLabelViewResponse {
  cfcLabel: CfcLabelView | undefined;
}

export interface PageResponse {
  page: PageRef;
}

export interface SlugResponse {
  slug: string | undefined;
}

export interface GraphSnapshotResponse {
  snapshot: SchedulerGraphSnapshot;
}

export interface LoggerCountsResponse {
  counts: LoggerCountsData;
  metadata: LoggerMetadata;
  timing: LoggerTimingData;
  flags: LoggerFlagsData;
}

export interface CellUpdateNotification {
  type: NotificationType.CellUpdate;
  cell: CellRef;
  value: JSONValue;
}

export interface ConsoleNotification {
  type: NotificationType.ConsoleMessage;
  metadata?: { pieceId?: string; patternId?: string; space?: string };
  method: string;
  args: JSONValue[];
}

export interface NavigateRequestNotification {
  type: NotificationType.NavigateRequest;
  targetCellRef: CellRef;
}

export interface ErrorNotification {
  type: NotificationType.ErrorReport;
  message: string;
  pieceId?: string;
  space?: string;
  patternId?: string;
  spellId?: string;
  stackTrace?: string;
}

export interface TelemetryNotification {
  type: NotificationType.Telemetry;
  marker: RuntimeTelemetryMarkerResult;
}

/**
 * VDOM operation for IPC.
 */
export type VDomOp =
  | { op: "create-element"; nodeId: number; tagName: string }
  | { op: "create-text"; nodeId: number; text: string }
  | { op: "update-text"; nodeId: number; text: string }
  | { op: "set-prop"; nodeId: number; key: string; value: JSONValue }
  | { op: "remove-prop"; nodeId: number; key: string }
  | { op: "set-event"; nodeId: number; eventType: string; handlerId: number }
  | { op: "remove-event"; nodeId: number; eventType: string }
  | { op: "set-binding"; nodeId: number; propName: string; cellRef: CellRef }
  | {
    op: "insert-child";
    parentId: number;
    childId: number;
    beforeId: number | null;
  }
  | {
    op: "move-child";
    parentId: number;
    childId: number;
    beforeId: number | null;
  }
  | { op: "remove-node"; nodeId: number }
  | { op: "set-attrs"; nodeId: number; attrs: Record<string, JSONValue> };

/**
 * VDOM batch notification sent from worker to main thread.
 */
export interface VDomBatchNotification {
  type: NotificationType.VDomBatch;
  /** Identifier for this batch (for debugging/logging) */
  batchId: number;
  /** The operations to apply, in order */
  ops: VDomOp[];
  /** Optional: the root node ID for this render tree */
  rootId?: number;
  /** The mount ID this batch belongs to */
  mountId?: number;
}

export type RemoteResponse =
  | EmptyResponse
  | NullResponse
  | BooleanResponse
  | JSONValueResponse
  | CellResponse
  | CfcLabelViewResponse
  | GraphSnapshotResponse
  | LoggerCountsResponse
  | SettleStatsResponse
  | SettleStatsHistoryResponse
  | ActionRunTraceResponse
  | TriggerTraceResponse
  | WriteStackTraceResponse
  | PageResponse
  | SlugResponse
  | VDomMountResponse
  | DetectNonIdempotentResponse
  | PatternSourcesResponse
  | UploadBlobResponse;

export type IPCRemoteNotification =
  | CellUpdateNotification
  | ConsoleNotification
  | NavigateRequestNotification
  | ErrorNotification
  | VDomBatchNotification;

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
    response: JSONValueResponse;
  };
  [RequestType.CellSet]: {
    request: CellSetRequest;
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
  [RequestType.VDomEvent]: {
    request: VDomEventRequest;
    response: EmptyResponse;
  };
  [RequestType.VDomMount]: {
    request: VDomMountRequest;
    response: VDomMountResponse;
  };
  [RequestType.VDomUnmount]: {
    request: VDomUnmountRequest;
    response: EmptyResponse;
  };
  [RequestType.VDomBatchApplied]: {
    request: VDomBatchAppliedRequest;
    response: EmptyResponse;
  };
};

export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;
