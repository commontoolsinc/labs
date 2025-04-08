import { isKeyPairRaw, KeyPairRaw } from "@commontools/identity";

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

export function isInitializationData(value: any): value is InitializationData {
  return !!(value && typeof value === "object" &&
    typeof value.did === "string" &&
    typeof value.toolshedUrl === "string" &&
    isKeyPairRaw(value.rawIdentity));
}

export type RunData = {
  charmId: string;
};

export function isRunData(value: any): value is RunData {
  return !!(value && typeof value === "object" &&
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

export function isWorkerIPCRequest(value: any): value is WorkerIPCRequest {
  if (!value || typeof value !== "object" || typeof value.msgId !== "number") {
    return false;
  }
  if (value.type === WorkerIPCMessageType.Initialize) {
    return isInitializationData(value.data);
  }
  if (value.type === WorkerIPCMessageType.Run) {
    return isRunData(value.data);
  }
  if (value.type === WorkerIPCMessageType.Cleanup) {
    return !("data" in value);
  }
  return false;
}

export type WorkerIPCResponse = {
  msgId: number;
  error?: string;
};

export function isWorkerIPCResponse(value: any): value is WorkerIPCResponse {
  return !!(value && typeof value === "object" &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true));
}
