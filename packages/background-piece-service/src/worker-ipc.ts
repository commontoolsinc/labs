import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { isObjectNotArray } from "@commonfabric/utils/types";

export enum WorkerIPCMessageType {
  Initialize = "initialize",
  Run = "run",
  Cleanup = "cleanup",
}

export type InitializationData = {
  did: string;
  toolshedUrl: string;
  // The service's signer, as a `codec-realm` encoding of the `FabricKeyPair`
  // it signs with. Encoded rather than plain because that is the one format
  // which carries either state of a key pair -- key handles included --
  // across a realm boundary whole.
  //
  // The name is load-bearing: `safeFormat()` in `./worker.ts` redacts this key
  // out of everything it logs, and it redacts by name.
  encodedIdentity: RealmEncodedValue;
  experimental?: {
    modernCellRep?: boolean;
  };
};

export function isInitializationData(
  value: unknown,
): value is InitializationData {
  return !!(isObjectNotArray(value) &&
    typeof value.did === "string" &&
    typeof value.toolshedUrl === "string" &&
    // The envelope's shape and no more: what it decodes to is settled by the
    // decode itself, in `initialize()`, the marker in slot zero being
    // recognizable only there.
    Array.isArray(value.encodedIdentity) &&
    (value.encodedIdentity.length === 2));
}

export type RunData = {
  pieceId: string;
};

export function isRunData(value: unknown): value is RunData {
  return !!(isObjectNotArray(value) &&
    typeof value.pieceId === "string");
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
  if (!isObjectNotArray(value) || typeof value.msgId !== "number") {
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
  return !!(isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true) &&
    ("type" in value ? typeof value.type === "string" : true));
}
