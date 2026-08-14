import { isDID } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";
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
  VDomBatchNotification,
} from "./types.ts";

export function isCellRef(value: unknown): value is CellRef {
  if (!isObjectOrArray(value)) return false;
  return Array.isArray(value.path) && typeof value.id === "string" &&
    !!value.id &&
    isDID(value.space);
}

export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return (
    isObjectOrArray(value) &&
    typeof value.apiUrl === "string" && !!value.identity &&
    typeof value.spaceDid === "string"
  );
}

export function isIPCClientRequest(value: unknown): value is IPCClientRequest {
  return (
    isObjectOrArray(value) &&
    typeof value.type === "string" &&
    Object.values(RequestType).includes(
      value.type as RequestType,
    )
  );
}

export function isIPCClientMessage(value: unknown): value is IPCClientMessage {
  return (
    isObjectOrArray(value) &&
    typeof value.msgId === "number" &&
    isIPCClientRequest(value.data)
  );
}

export function isIPCClientNotification(
  value: unknown,
): value is IPCClientNotification {
  return (
    isObjectOrArray(value) &&
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
    isObjectOrArray(value) &&
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
    isObjectOrArray(value) &&
    value.type === NotificationType.CellUpdate &&
    typeof value.cell === "object" &&
    "value" in value
  );
}

export function isConsoleNotification(
  value: unknown,
): value is ConsoleNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.ConsoleMessage &&
    typeof value.method === "string" &&
    Array.isArray(value.args)
  );
}

export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.NavigateRequest &&
    isObjectOrArray(value.targetCellRef)
  );
}

export function isErrorNotification(
  value: unknown,
): value is ErrorNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.ErrorReport &&
    typeof value.message === "string"
  );
}

export function isTelemetryNotification(
  value: unknown,
): value is TelemetryNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.Telemetry &&
    typeof value.marker === "object"
  );
}

export function isPendingWritesNotification(
  value: unknown,
): value is PendingWritesNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.PendingWritesChanged &&
    typeof value.pending === "boolean"
  );
}

export function isVDomBatchNotification(
  value: unknown,
): value is VDomBatchNotification {
  return (
    isObjectOrArray(value) &&
    value.type === NotificationType.VDomBatch &&
    typeof value.batchId === "number" &&
    Array.isArray(value.ops)
  );
}
