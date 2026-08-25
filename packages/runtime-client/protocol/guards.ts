import { isDID } from "@commonfabric/identity";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  CellRef,
  CellUpdateNotification,
  ClientNotificationType,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  IPCClientMessage,
  IPCClientNotification,
  IPCClientRequest,
  IPCRemoteMessage,
  IPCRemoteNotification,
  IPCRemoteResponse,
  NavigateRequestNotification,
  NotificationType,
  PendingWritesNotification,
  RequestType,
  TelemetryNotification,
  TransportNotificationType,
  VDomBatchNotification,
  WORKER_CONSOLE_LEVELS,
  WorkerConsoleLevel,
  WorkerConsoleNotification,
  WorkerReadyNotification,
} from "./types.ts";

export function isCellRef(value: unknown): value is CellRef {
  if (!isObjectNotArray(value)) return false;
  return Array.isArray(value.path) && typeof value.id === "string" &&
    !!value.id &&
    isDID(value.space);
}

export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return (
    isObjectNotArray(value) &&
    typeof value.apiUrl === "string" && !!value.identity &&
    typeof value.spaceDid === "string"
  );
}

export function isIPCClientRequest(value: unknown): value is IPCClientRequest {
  return (
    isObjectNotArray(value) &&
    typeof value.type === "string" &&
    Object.values(RequestType).includes(
      value.type as RequestType,
    )
  );
}

export function isIPCClientMessage(value: unknown): value is IPCClientMessage {
  return (
    isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    isIPCClientRequest(value.data)
  );
}

export function isIPCClientNotification(
  value: unknown,
): value is IPCClientNotification {
  return (
    isObjectNotArray(value) &&
    typeof value.type === "string" &&
    Object.values(ClientNotificationType).includes(
      value.type as ClientNotificationType,
    )
  );
}

export function isIPCRemoteMessage(
  value: unknown,
): value is IPCRemoteMessage {
  return isIPCRemoteResponse(value) || isIPCRemoteNotification(value);
}

export function isIPCRemoteResponse(
  value: unknown,
): value is IPCRemoteResponse {
  return (
    isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true)
  );
}

export function isIPCRemoteNotification(
  value: unknown,
): value is IPCRemoteNotification {
  return isTelemetryNotification(value) || isCellUpdateNotification(value) ||
    isConsoleNotification(value) ||
    isNavigateRequestNotification(value) || isErrorNotification(value) ||
    isVDomBatchNotification(value) || isPendingWritesNotification(value);
}

export function isCellUpdateNotification(
  value: unknown,
): value is CellUpdateNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.CellUpdate &&
    typeof value.cell === "object" &&
    "value" in value
  );
}

export function isConsoleNotification(
  value: unknown,
): value is ConsoleNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.ConsoleMessage &&
    typeof value.method === "string" &&
    Array.isArray(value.args)
  );
}

export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.NavigateRequest &&
    isObjectNotArray(value.targetCellRef)
  );
}

export function isErrorNotification(
  value: unknown,
): value is ErrorNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.ErrorReport &&
    typeof value.message === "string"
  );
}

export function isTelemetryNotification(
  value: unknown,
): value is TelemetryNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.Telemetry &&
    typeof value.marker === "object"
  );
}

export function isPendingWritesNotification(
  value: unknown,
): value is PendingWritesNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.PendingWritesChanged &&
    typeof value.pending === "boolean"
  );
}

export function isVDomBatchNotification(
  value: unknown,
): value is VDomBatchNotification {
  return (
    isObjectNotArray(value) &&
    value.type === NotificationType.VDomBatch &&
    typeof value.batchId === "number" &&
    Array.isArray(value.ops)
  );
}

/**
 * Is `value` a {@link WorkerReadyNotification}? This is the post the transport
 * settles `ready()` on, and the only message it treats that way.
 */
export function isWorkerReadyNotification(
  value: unknown,
): value is WorkerReadyNotification {
  return (
    isObjectNotArray(value) &&
    value.type === TransportNotificationType.WorkerReady
  );
}

/**
 * Is `value` a {@link WorkerConsoleNotification}? A `level` outside
 * {@link WORKER_CONSOLE_LEVELS} is not one, which bounds what this recognizes
 * to what the worker's console bridge produces: the bridge posts from that
 * same roster, so nothing it sends is excluded here.
 */
export function isWorkerConsoleNotification(
  value: unknown,
): value is WorkerConsoleNotification {
  return (
    isObjectNotArray(value) &&
    value.type === TransportNotificationType.WorkerConsole &&
    WORKER_CONSOLE_LEVELS.includes(value.level as WorkerConsoleLevel) &&
    typeof value.text === "string"
  );
}
