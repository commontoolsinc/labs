import type {
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
} from "@commontools/runner/shared";
import type { DID, KeyPairRaw } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";
import { Program } from "@commontools/js-compiler";

export type MessageId = number;

export type SubscriptionId = string;

/**
 * Serializable cell reference that can cross the worker boundary.
 * Uses NormalizedFullLink format which contains: id, path, space, type, and optional schema.
 */
export type CellRef = NormalizedFullLink;

/**
 * IPC message types for RuntimeClient communication
 */
export enum RuntimeClientMessageType {
  // Lifecycle
  Initialize = "initialize",
  Ready = "ready",
  Dispose = "dispose",

  // Cell operations (main -> worker)
  CellGet = "cell:get",
  CellSet = "cell:set",
  CellSend = "cell:send",
  CellSync = "cell:sync",
  CellSubscribe = "cell:subscribe",
  CellUnsubscribe = "cell:unsubscribe",

  // Cell updates (worker -> main)
  CellUpdate = "cell:update",

  // Runtime operations
  GetCell = "runtime:getCell",
  Idle = "runtime:idle",

  // Charm operations (main -> worker)
  CharmCreateFromUrl = "charm:create:url",
  CharmCreateFromProgram = "charm:create:program",
  GetSpaceRootPattern = "pattern:getSpaceRoot",
  CharmSyncPattern = "charm:syncPattern",
  CharmGet = "charm:get",
  CharmRemove = "charm:remove",
  CharmStart = "charm:start",
  CharmStop = "charm:stop",
  CharmGetAll = "charm:getAll",
  CharmSynced = "charm:synced",

  // Callbacks (worker -> main, async notifications)
  ConsoleMessage = "callback:console",
  NavigateRequest = "callback:navigate",
  ErrorReport = "callback:error",
}

/**
 * Initialization data sent to the worker.
 * Only serializable data can cross the boundary.
 */
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

/**
 * Type guard for InitializationData
 */
export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return (
    isRecord(value) &&
    typeof value.apiUrl === "string" && !!value.identity &&
    typeof value.spaceDid === "string"
  );
}

// ============================================================================
// Request Messages (main -> worker)
// ============================================================================

export interface BaseRequest {
  msgId: MessageId;
  type: RuntimeClientMessageType;
}

export interface InitializeRequest extends BaseRequest {
  type: RuntimeClientMessageType.Initialize;
  data: InitializationData;
}

export interface DisposeRequest extends BaseRequest {
  type: RuntimeClientMessageType.Dispose;
}

export interface CellGetRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellGet;
  cellRef: CellRef;
}

export interface CellSetRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellSet;
  cellRef: CellRef;
  value: JSONValue;
}

export interface CellSendRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellSend;
  cellRef: CellRef;
  event: JSONValue;
}

export interface CellSyncRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellSync;
  cellRef: CellRef;
}

export interface CellSubscribeRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellSubscribe;
  cellRef: CellRef;
  subscriptionId: string;
  /** Whether the client already has a cached value. If false, worker sends initial value. */
  hasValue: boolean;
}

export interface CellUnsubscribeRequest extends BaseRequest {
  type: RuntimeClientMessageType.CellUnsubscribe;
  subscriptionId: string;
}

// unused?
export interface GetCellRequest extends BaseRequest {
  type: RuntimeClientMessageType.GetCell;
  space: DID;
  cause: JSONValue;
  schema?: JSONSchema;
}

export interface IdleRequest extends BaseRequest {
  type: RuntimeClientMessageType.Idle;
}

// ============================================================================
// Charm Requests (main -> worker)
// ============================================================================

/**
 * Create a new charm from a URL.
 */
export interface CharmCreateFromUrlRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmCreateFromUrl;
  /** URL to load a charm from */
  entryUrl: string;
  /** Optional initial argument values */
  argument?: JSONValue;
  /** Cause of charm creation */
  cause?: string;
  /** Whether to run the charm immediately (default: true) */
  run?: boolean;
}

/**
 * Create a new charm from a URL.
 */
export interface CharmCreateFromProgramRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmCreateFromProgram;
  /** Program to run */
  program: Program;
  /** Optional initial argument values */
  argument?: JSONValue;
  /** Cause of charm creation */
  cause?: string;
  /** Whether to run the charm immediately (default: true) */
  run?: boolean;
}

export interface CharmGetSpaceDefault extends BaseRequest {
  type: RuntimeClientMessageType.GetSpaceRootPattern;
}

export interface CharmSyncPatternRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmSyncPattern;
  charmId: string;
}

/**
 * Get a charm by ID.
 */
export interface CharmGetRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmGet;
  charmId: string;
  /** Whether to run the charm if not already running */
  runIt?: boolean;
}

/**
 * Remove a charm from the space.
 */
export interface CharmRemoveRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmRemove;
  charmId: string;
}

/**
 * Start a charm's execution.
 */
export interface CharmStartRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmStart;
  charmId: string;
}

/**
 * Stop a charm's execution.
 */
export interface CharmStopRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmStop;
  charmId: string;
}

/**
 * Get all charms in the space.
 */
export interface CharmGetAllRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmGetAll;
}

/**
 * Wait for CharmManager to be synced with storage.
 */
export interface CharmSyncedRequest extends BaseRequest {
  type: RuntimeClientMessageType.CharmSynced;
}

export type WorkerIPCRequest =
  | InitializeRequest
  | DisposeRequest
  | CellGetRequest
  | CellSetRequest
  | CellSendRequest
  | CellSyncRequest
  | CellSubscribeRequest
  | CellUnsubscribeRequest
  | GetCellRequest
  | IdleRequest
  | CharmCreateFromUrlRequest
  | CharmCreateFromProgramRequest
  | CharmGetSpaceDefault
  | CharmSyncPatternRequest
  | CharmGetRequest
  | CharmRemoveRequest
  | CharmStartRequest
  | CharmStopRequest
  | CharmGetAllRequest
  | CharmSyncedRequest;

// ============================================================================
// Response Messages (worker -> main)
// ============================================================================

export interface BaseResponse {
  msgId: MessageId;
  error?: string;
}

export interface ReadyResponse {
  type: RuntimeClientMessageType.Ready;
  msgId: -1;
}

export interface CellGetResponse extends BaseResponse {
  value: JSONValue | undefined;
}

export interface CellSyncResponse extends BaseResponse {
  value: JSONValue | undefined;
}

export interface GetCellResponse extends BaseResponse {
  cellRef: CellRef;
}

// ============================================================================
// Charm Responses (worker -> main)
// ============================================================================

export interface CharmInfo {
  /** Charm ID */
  id: string;
  /** Cell reference for the charm's main cell */
  cellRef: CellRef;
  /** Recipe ID if available */
  recipeId?: string;
}

export interface CharmResponse extends BaseResponse {
  charm: CharmInfo;
}
export interface CharmResultResponse extends CharmResponse {
  result: CellRef;
}
export interface CharmGetResponse extends BaseResponse {
  charm: CharmInfo | null;
}
export interface CharmGetAllResponse extends BaseResponse {
  /** Cell reference for the charms list cell */
  charmsListCellRef: CellRef;
}

/**
 * Async notification sent by worker when a subscribed cell changes.
 * This is NOT a response to a request - it has no msgId.
 */
export interface CellUpdateNotification {
  type: RuntimeClientMessageType.CellUpdate;
  subscriptionId: string;
  value: JSONValue;
}

/**
 * Console message notification from worker.
 * Sent when code in the worker calls console.log/warn/error/etc.
 */
export interface ConsoleMessageNotification {
  type: RuntimeClientMessageType.ConsoleMessage;
  metadata?: { charmId?: string; recipeId?: string; space?: string };
  method: string; // ConsoleMethod: "log" | "warn" | "error" | etc.
  args: JSONValue[];
}

/**
 * Navigate request notification from worker.
 * Sent when a recipe calls navigateTo().
 */
export interface NavigateRequestNotification {
  type: RuntimeClientMessageType.NavigateRequest;
  /** The cell to navigate to, as a SigilLink */
  targetCellRef: CellRef;
}

/**
 * Error report notification from worker.
 * Sent when an error occurs during recipe execution.
 */
export interface ErrorReportNotification {
  type: RuntimeClientMessageType.ErrorReport;
  message: string;
  charmId?: string;
  space?: string;
  recipeId?: string;
  spellId?: string;
}

/**
 * Union of all possible messages from worker to main thread.
 * Note: CellUpdateNotification is a push notification, not a response.
 */
export type WorkerIPCResponse =
  | ReadyResponse
  | BaseResponse
  | CellGetResponse
  | CellSyncResponse
  | GetCellResponse
  | CharmResponse
  | CharmResultResponse
  | CharmGetResponse
  | CharmGetAllResponse;

/**
 * Union of all async notifications from worker (not request responses).
 */
export type WorkerNotification =
  | CellUpdateNotification
  | ConsoleMessageNotification
  | NavigateRequestNotification
  | ErrorReportNotification;

/**
 * Union of all messages that can be received from worker.
 * Includes both responses and notifications.
 */
export type WorkerIPCMessage =
  | WorkerIPCResponse
  | WorkerNotification;

export function isWorkerIPCRequest(value: unknown): value is WorkerIPCRequest {
  return (
    isRecord(value) &&
    typeof value.msgId === "number" &&
    typeof value.type === "string" &&
    Object.values(RuntimeClientMessageType).includes(
      value.type as RuntimeClientMessageType,
    )
  );
}

export function isWorkerIPCResponse(
  value: unknown,
): value is BaseResponse {
  return (
    isRecord(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true)
  );
}

export function isReadyResponse(
  value: unknown,
): value is ReadyResponse {
  return (
    isRecord(value) &&
    value.type === RuntimeClientMessageType.Ready &&
    value.msgId === -1
  );
}

export function isCellUpdateNotification(
  value: unknown,
): value is CellUpdateNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeClientMessageType.CellUpdate &&
    typeof value.subscriptionId === "string"
  );
}

export function isConsoleMessageNotification(
  value: unknown,
): value is ConsoleMessageNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeClientMessageType.ConsoleMessage &&
    typeof value.method === "string"
  );
}

export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeClientMessageType.NavigateRequest &&
    isRecord(value.targetCellRef)
  );
}

export function isErrorReportNotification(
  value: unknown,
): value is ErrorReportNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeClientMessageType.ErrorReport &&
    typeof value.message === "string"
  );
}
