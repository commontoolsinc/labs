import { isKeyPairRaw, KeyPairRaw } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";

export enum WorkerIPCMessageType {
  Initialize = "initialize",
  Run = "run",
  Cleanup = "cleanup",
}

export type InitializationData = {
  did: string;
  toolshedUrl: string;
  rawIdentity: KeyPairRaw;
};

export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return !!(isRecord(value) &&
    typeof value.did === "string" &&
    typeof value.toolshedUrl === "string" &&
    isKeyPairRaw(value.rawIdentity));
}

export type RunData = {
  charmId: string;
};

export function isRunData(value: unknown): value is RunData {
  return !!(isRecord(value) &&
    typeof value.charmId === "string");
}

export type WorkerIPCRequest = {
  type: WorkerIPCMessageType.Initialize;
  msgId: number;
  data: InitializationData;
} | {
  type: WorkerIPCMessageType.Run;
  msgId: number;
  data: RunData;
} | {
  type: WorkerIPCMessageType.Cleanup;
  msgId: number;
};

export function isWorkerIPCRequest(value: unknown): value is WorkerIPCRequest {
  if (!isRecord(value) || typeof value.msgId !== "number") {
    return false;
  }
  if (value.type === WorkerIPCMessageType.Cleanup) {
    return true;
  }
  if (value.type === WorkerIPCMessageType.Initialize) {
    return isInitializationData(value.data);
  }
  if (value.type === WorkerIPCMessageType.Run) {
    return isRunData(value.data);
  }
  return false;
}

export type WorkerIPCResponse = {
  msgId: number;
  error?: string;
  type?: string;
};

export function isWorkerIPCResponse(
  value: unknown,
): value is WorkerIPCResponse {
  return !!(isRecord(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true) &&
    ("type" in value ? typeof value.type === "string" : true));
}
