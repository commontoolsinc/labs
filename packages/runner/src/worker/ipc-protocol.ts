import type { JSONSchema, JSONValue } from "@commontools/api";
import type { DID, KeyPairRaw } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";
import type { SigilLink, URI } from "../sigil-types.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { Program } from "@commontools/js-compiler";

/**
 * Message ID for request/response correlation
 */
export type MessageId = number;

/**
 * Serializable cell reference that can cross the worker boundary.
 * Uses SigilLink format for identification.
 */
export interface CellRef {
  /** Sigil link identifying the cell: { "/": { "link@1": { id, path, space, schema } } } */
  link: SigilLink;
  /** Optional schema for the cell */
  schema?: JSONSchema;
}

/**
 * IPC message types for RuntimeWorker communication
 */
export enum RuntimeWorkerMessageType {
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
  GetCellFromLink = "runtime:getCellFromLink",
  GetCellFromEntityId = "runtime:getCellFromEntityId",
  Idle = "runtime:idle",

  // Charm operations (main -> worker)
  CharmCreateFromUrl = "charm:create:url",
  CharmCreateFromProgram = "charm:create:program",
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

  // Errors
  Error = "error",
}

/**
 * Initialization data sent to the worker.
 * Only serializable data can cross the boundary.
 */
export interface InitializationData {
  /** API URL as string */
  apiUrl: string;
  /** Identity */
  identity: KeyPairRaw;
  /** Optional, temporary identity of space */
  spaceIdentity?: KeyPairRaw;
  /** space DID to connect to */
  spaceDid: DID;
  /** Optional space name */
  spaceName?: string;
  /** Request timeout in milliseconds (default: 60000) */
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
  type: RuntimeWorkerMessageType;
}

export interface InitializeRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.Initialize;
  data: InitializationData;
}

export interface DisposeRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.Dispose;
}

export interface CellGetRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellGet;
  cellRef: CellRef;
}

export interface CellSetRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellSet;
  cellRef: CellRef;
  value: JSONValue;
}

export interface CellSendRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellSend;
  cellRef: CellRef;
  event: JSONValue;
}

export interface CellSyncRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellSync;
  cellRef: CellRef;
}

export interface CellSubscribeRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellSubscribe;
  cellRef: CellRef;
  subscriptionId: string;
}

export interface CellUnsubscribeRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CellUnsubscribe;
  subscriptionId: string;
}

export interface GetCellRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.GetCell;
  space: MemorySpace;
  cause: JSONValue;
  schema?: JSONSchema;
}

export interface GetCellFromLinkRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.GetCellFromLink;
  link: SigilLink;
  schema?: JSONSchema;
}

export interface GetCellFromEntityIdRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.GetCellFromEntityId;
  space: MemorySpace;
  entityId: URI;
  path?: string[];
  schema?: JSONSchema;
}

export interface IdleRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.Idle;
}

// ============================================================================
// Charm Requests (main -> worker)
// ============================================================================

/**
 * Create a new charm from a URL.
 */
export interface CharmCreateFromUrlRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmCreateFromUrl;
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
  type: RuntimeWorkerMessageType.CharmCreateFromProgram;
  /** Program to run */
  program: Program;
  /** Optional initial argument values */
  argument?: JSONValue;
  /** Cause of charm creation */
  cause?: string;
  /** Whether to run the charm immediately (default: true) */
  run?: boolean;
}

export interface CharmSyncPatternRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmSyncPattern;
  charmId: string;
}

/**
 * Get a charm by ID.
 */
export interface CharmGetRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmGet;
  charmId: string;
  /** Whether to run the charm if not already running */
  runIt?: boolean;
}

/**
 * Remove a charm from the space.
 */
export interface CharmRemoveRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmRemove;
  charmId: string;
}

/**
 * Start a charm's execution.
 */
export interface CharmStartRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmStart;
  charmId: string;
}

/**
 * Stop a charm's execution.
 */
export interface CharmStopRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmStop;
  charmId: string;
}

/**
 * Get all charms in the space.
 */
export interface CharmGetAllRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmGetAll;
}

/**
 * Wait for CharmManager to be synced with storage.
 */
export interface CharmSyncedRequest extends BaseRequest {
  type: RuntimeWorkerMessageType.CharmSynced;
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
  | GetCellFromLinkRequest
  | GetCellFromEntityIdRequest
  | IdleRequest
  | CharmCreateFromUrlRequest
  | CharmCreateFromProgramRequest
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

/**
 * Base response for all request/response pairs.
 * Always includes msgId and optionally error.
 */
export interface BaseResponse {
  msgId: MessageId;
  error?: string;
}

/**
 * Ready signal sent by worker on startup (before any requests).
 */
export interface ReadyResponse {
  type: RuntimeWorkerMessageType.Ready;
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

/**
 * Serializable charm info that can cross the worker boundary.
 */
export interface CharmInfo {
  /** Charm ID */
  id: string;
  /** Cell reference for the charm's main cell */
  cellRef: CellRef;
  /** Recipe ID if available */
  recipeId?: string;
}

/**
 * Response for charm create request.
 */
export interface CharmCreateResponse extends BaseResponse {
  charm: CharmInfo;
}

/**
 * Response for charm get request.
 */
export interface CharmGetResponse extends BaseResponse {
  charm: CharmInfo | null;
}

/**
 * Response for charm get all request.
 * Returns cell refs for all charms - subscribe to get values.
 */
export interface CharmGetAllResponse extends BaseResponse {
  /** Cell reference for the charms list cell */
  charmsListCellRef: CellRef;
}

/**
 * Async notification sent by worker when a subscribed cell changes.
 * This is NOT a response to a request - it has no msgId.
 */
export interface CellUpdateNotification {
  type: RuntimeWorkerMessageType.CellUpdate;
  subscriptionId: string;
  value: JSONValue;
}

/**
 * Console message notification from worker.
 * Sent when code in the worker calls console.log/warn/error/etc.
 */
export interface ConsoleMessageNotification {
  type: RuntimeWorkerMessageType.ConsoleMessage;
  metadata?: { charmId?: string; recipeId?: string; space?: string };
  method: string; // ConsoleMethod: "log" | "warn" | "error" | etc.
  args: JSONValue[];
}

/**
 * Navigate request notification from worker.
 * Sent when a recipe calls navigateTo().
 */
export interface NavigateRequestNotification {
  type: RuntimeWorkerMessageType.NavigateRequest;
  /** The cell to navigate to, as a SigilLink */
  targetCellRef: CellRef;
}

/**
 * Error report notification from worker.
 * Sent when an error occurs during recipe execution.
 */
export interface ErrorReportNotification {
  type: RuntimeWorkerMessageType.ErrorReport;
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
  | CharmCreateResponse
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

/**
 * Type guard for WorkerIPCRequest
 */
export function isWorkerIPCRequest(value: unknown): value is WorkerIPCRequest {
  return (
    isRecord(value) &&
    typeof value.msgId === "number" &&
    typeof value.type === "string" &&
    Object.values(RuntimeWorkerMessageType).includes(
      value.type as RuntimeWorkerMessageType,
    )
  );
}

/**
 * Type guard for WorkerIPCResponse (request responses with msgId)
 */
export function isWorkerIPCResponse(
  value: unknown,
): value is BaseResponse {
  return (
    isRecord(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true)
  );
}

/**
 * Type guard for ReadyResponse
 */
export function isReadyResponse(
  value: unknown,
): value is ReadyResponse {
  return (
    isRecord(value) &&
    value.type === RuntimeWorkerMessageType.Ready &&
    value.msgId === -1
  );
}

/**
 * Type guard for CellUpdateNotification
 */
export function isCellUpdateNotification(
  value: unknown,
): value is CellUpdateNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeWorkerMessageType.CellUpdate &&
    typeof value.subscriptionId === "string"
  );
}

/**
 * Type guard for ConsoleMessageNotification
 */
export function isConsoleMessageNotification(
  value: unknown,
): value is ConsoleMessageNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeWorkerMessageType.ConsoleMessage &&
    typeof value.method === "string"
  );
}

/**
 * Type guard for NavigateRequestNotification
 */
export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeWorkerMessageType.NavigateRequest &&
    isRecord(value.targetCellRef)
  );
}

/**
 * Type guard for ErrorReportNotification
 */
export function isErrorReportNotification(
  value: unknown,
): value is ErrorReportNotification {
  return (
    isRecord(value) &&
    value.type === RuntimeWorkerMessageType.ErrorReport &&
    typeof value.message === "string"
  );
}
