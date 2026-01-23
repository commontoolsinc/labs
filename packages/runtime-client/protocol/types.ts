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
}

export enum NotificationType {
  CellUpdate = "cell:update",
  ConsoleMessage = "callback:console",
  NavigateRequest = "callback:navigate",
  ErrorReport = "callback:error",
  Telemetry = "callback:telemetry",
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
export interface TimingHistogramBucket {
  // Shared bounds (from count-quantiles)
  lowerBound: number; // Lower bound of bucket (ms)
  upperBound: number; // Upper bound of bucket (ms)

  // Count-quantile data (buckets by sample percentile)
  countQuantile: {
    count: number; // Number of samples (~10% of total)
    totalTime: number; // Total time for these samples
  };

  // Time-quantile data (buckets by cumulative time percentile)
  timeQuantile: {
    count: number; // Number of samples in this time bucket
    totalTime: number; // Total time (~10% of total time)
  };
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
  histogram: TimingHistogramBucket[]; // 10 buckets, median at boundary 5/6
}

export type LoggerTimingData = Record<
  string,
  Record<string, TimingStats>
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
  | PageSyncedRequest;

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
}

export interface CellUpdateNotification {
  type: NotificationType.CellUpdate;
  cell: CellRef;
  value: JSONValue;
}

export interface ConsoleNotification {
  type: NotificationType.ConsoleMessage;
  metadata?: { charmId?: string; recipeId?: string; space?: string };
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
  charmId?: string;
  space?: string;
  recipeId?: string;
  spellId?: string;
  stackTrace?: string;
}

export interface TelemetryNotification {
  type: NotificationType.Telemetry;
  marker: RuntimeTelemetryMarkerResult;
}

export type RemoteResponse =
  | EmptyResponse
  | NullResponse
  | BooleanResponse
  | JSONValueResponse
  | CellResponse
  | GraphSnapshotResponse
  | LoggerCountsResponse
  | PageResponse;

export type IPCRemoteNotification =
  | CellUpdateNotification
  | ConsoleNotification
  | NavigateRequestNotification
  | ErrorNotification;

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
};

export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;
