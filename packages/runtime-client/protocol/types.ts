import type {
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
  SchedulerGraphSnapshot,
} from "@commontools/runner/shared";
import type { DID, KeyPairRaw } from "@commontools/identity";
import { type Program } from "@commontools/js-compiler/interface";
import { RuntimeTelemetryMarkerResult } from "@commontools/runtime-client";
export type { JSONSchema, JSONValue, Program };

export type MessageId = number;

export type CellRef = NormalizedFullLink;

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

  // Runtime operations
  GetCell = "runtime:getCell",
  GetHomeSpaceCell = "runtime:getHomeSpaceCell",
  EnsureHomePatternRunning = "runtime:ensureHomePatternRunning",
  Idle = "runtime:idle",
  GetGraphSnapshot = "runtime:getGraphSnapshot",
  SetPullMode = "runtime:setPullMode",
  GetLoggerCounts = "runtime:getLoggerCounts",
  SetLoggerLevel = "runtime:setLoggerLevel",
  SetLoggerEnabled = "runtime:setLoggerEnabled",
  SetTelemetryEnabled = "runtime:setTelemetryEnabled",
  ResetLoggerBaselines = "runtime:resetLoggerBaselines",

  // Page operations (main -> worker)
  GetSpaceRootPattern = "pattern:getSpaceRoot",
  RecreateSpaceRootPattern = "pattern:recreateSpaceRoot",
  PageCreate = "page:create",
  PageGet = "page:get",
  PageRemove = "page:remove",
  PageStart = "page:start",
  PageStop = "page:stop",
  PageGetAll = "page:getAll",
  PageSynced = "page:synced",

  // VDOM operations (main -> worker)
  VDomEvent = "vdom:event",
  VDomMount = "vdom:mount",
  VDomUnmount = "vdom:unmount",
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
  // URL of backend server.
  apiUrl: string;
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
    richStorableValues?: boolean;
    storableProtocol?: boolean;
    unifiedJsonEncoding?: boolean;
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

export interface GetGraphSnapshotRequest extends BaseRequest {
  type: RequestType.GetGraphSnapshot;
}

export interface SetPullModeRequest extends BaseRequest {
  type: RequestType.SetPullMode;
  pullMode: boolean;
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

// Logger count types for IPC (matches @commontools/utils/logger types)
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

// Timing stats types for IPC (matches @commontools/utils/logger types)
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
  source: {
    url: string;
  } | {
    program: Program;
  };
  argument?: JSONValue;
  cause?: string;
  run?: boolean;
}

export interface PageGetSpaceDefault extends BaseRequest {
  type: RequestType.GetSpaceRootPattern;
}

export interface RecreateSpaceRootPatternRequest extends BaseRequest {
  type: RequestType.RecreateSpaceRootPattern;
}

export interface PageGetRequest extends BaseRequest {
  type: RequestType.PageGet;
  pageId: string;
  runIt?: boolean;
}

export interface PageRemoveRequest extends BaseRequest {
  type: RequestType.PageRemove;
  pageId: string;
}

export interface PageStartRequest extends BaseRequest {
  type: RequestType.PageStart;
  pageId: string;
}

export interface PageStopRequest extends BaseRequest {
  type: RequestType.PageStop;
  pageId: string;
}

export interface PageGetAllRequest extends BaseRequest {
  type: RequestType.PageGetAll;
}

export interface PageSyncedRequest extends BaseRequest {
  type: RequestType.PageSynced;
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
  | GetCellRequest
  | GetHomeSpaceCellRequest
  | EnsureHomePatternRunningRequest
  | GetGraphSnapshotRequest
  | SetPullModeRequest
  | GetLoggerCountsRequest
  | SetLoggerLevelRequest
  | SetLoggerEnabledRequest
  | SetTelemetryEnabledRequest
  | ResetLoggerBaselinesRequest
  | IdleRequest
  | PageCreateRequest
  | PageGetSpaceDefault
  | RecreateSpaceRootPatternRequest
  | PageGetRequest
  | PageRemoveRequest
  | PageStartRequest
  | PageStopRequest
  | PageGetAllRequest
  | PageSyncedRequest
  | VDomEventRequest
  | VDomMountRequest
  | VDomUnmountRequest;

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

export interface PageResponse {
  page: PageRef;
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
  metadata?: { pieceId?: string; recipeId?: string; space?: string };
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
  recipeId?: string;
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
  | GraphSnapshotResponse
  | LoggerCountsResponse
  | PageResponse
  | VDomMountResponse;

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
  [RequestType.GetGraphSnapshot]: {
    request: GetGraphSnapshotRequest;
    response: GraphSnapshotResponse;
  };
  [RequestType.SetPullMode]: {
    request: SetPullModeRequest;
    response: EmptyResponse;
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
  // Page requests
  [RequestType.PageCreate]: {
    request: PageCreateRequest;
    response: PageResponse;
  };
  [RequestType.PageSynced]: {
    request: PageSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.PageGet]: {
    request: PageGetRequest;
    response: PageResponse | NullResponse;
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
};

export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;
