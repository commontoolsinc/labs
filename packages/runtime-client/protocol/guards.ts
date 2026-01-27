import { isDID } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";
import {
  CellRef,
  CellUpdateNotification,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  IPCClientMessage,
  IPCClientRequest,
  IPCRemoteMessage,
  IPCRemoteNotification,
  IPCRemoteResponse,
  NavigateRequestNotification,
  NotificationType,
  RequestType,
  TelemetryNotification,
} from "./types.ts";

export function isCellRef(value: unknown): value is CellRef {
  if (!isRecord(value)) return false;
  return Array.isArray(value.path) && typeof value.id === "string" &&
    !!value.id &&
    typeof value.type === "string" && isDID(value.space);
}

export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return (
    isRecord(value) &&
    typeof value.apiUrl === "string" && !!value.identity &&
    typeof value.spaceDid === "string"
  );
}

export function isIPCClientRequest(value: unknown): value is IPCClientRequest {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    Object.values(RequestType).includes(
      value.type as RequestType,
    )
  );
}

export function isIPCClientMessage(value: unknown): value is IPCClientMessage {
  return (
    isRecord(value) &&
    typeof value.msgId === "number" &&
    isIPCClientRequest(value.data)
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
    isRecord(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true)
  );
}

export function isIPCRemoteNotification(
  value: unknown,
): value is IPCRemoteNotification {
  return isTelemetryNotification(value) || isCellUpdateNotification(value) ||
    isConsoleNotification(value) ||
    isNavigateRequestNotification(value) || isErrorNotification(value);
}

export function isCellUpdateNotification(
  value: unknown,
): value is CellUpdateNotification {
  return (
    isRecord(value) &&
    value.type === NotificationType.CellUpdate &&
    typeof value.cell === "object" &&
    "value" in value
  );
}

export function isConsoleNotification(
  value: unknown,
): value is ConsoleNotification {
  return (
    isRecord(value) &&
    value.type === NotificationType.ConsoleMessage &&
    typeof value.method === "string" &&
    Array.isArray(value.args)
  );
}

export function isNavigateRequestNotification(
  value: unknown,
): value is NavigateRequestNotification {
  return (
    isRecord(value) &&
    value.type === NotificationType.NavigateRequest &&
    isRecord(value.targetCellRef)
  );
}

export function isErrorNotification(
  value: unknown,
): value is ErrorNotification {
  return (
    isRecord(value) &&
    value.type === NotificationType.ErrorReport &&
    typeof value.message === "string"
  );
}

export function isTelemetryNotification(
  value: unknown,
): value is TelemetryNotification {
  return (
    isRecord(value) &&
    value.type === NotificationType.Telemetry &&
    typeof value.marker === "object"
  );
}
