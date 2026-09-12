/**
 * The messages that cross between a `WorkerController` and its worker: the
 * requests the controller sends, the responses the worker posts back, and the
 * predicates each side checks an incoming message against.
 */

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** The kinds of request a controller sends its worker. */
export enum WorkerIPCMessageType {
  /** Set the worker up for its space; the first request, sent once. */
  Initialize = "initialize",

  /** Run one piece's background updater. */
  Run = "run",

  /** Tear the worker's runtime down ahead of termination. */
  Cleanup = "cleanup",
}

/** Payload of an `Initialize` request. */
export type InitializationData = {
  /** DID of the space the worker serves. */
  did: string;

  /** URL of the toolshed the worker's runtime talks to. */
  toolshedUrl: string;

  /**
   * The service's signer, as a `codec-realm` encoding of the `FabricKeyPair`
   * it signs with. Encoded rather than plain because that is the one format
   * which carries either state of a key pair -- key handles included --
   * across a realm boundary whole.
   *
   * The name is load-bearing: `safeFormat()` in `./worker.ts` redacts this key
   * out of everything it logs, and it redacts by name.
   */
  encodedIdentity: RealmEncodedValue;

  /** Experimental runtime options, forwarded from the service's own runtime. */
  experimental?: {
    modernCellRep?: boolean;
  };
};

/** Returns whether `value` has the shape of an `InitializationData`. */
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

/** Payload of a `Run` request. */
export type RunData = {
  /** Entity id of the piece to run. */
  pieceId: string;
};

/** Returns whether `value` has the shape of a `RunData`. */
export function isRunData(value: unknown): value is RunData {
  return !!(isObjectNotArray(value) &&
    typeof value.pieceId === "string");
}

/**
 * A request from a controller to its worker, tagged by kind and numbered so
 * that the response can be matched to it.
 */
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

/** Returns whether `value` is a `WorkerIPCRequest`, its payload included. */
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

/**
 * The worker's answer to a request, carrying the request's `msgId` and, when
 * the request failed, the error's message. The one unsolicited message, which
 * the worker posts once it is listening, has `type` set to `ready`.
 */
export type WorkerIPCResponse = {
  /** The `msgId` of the request this answers; `-1` on the `ready` message. */
  msgId: number;

  /** Message of the error that failed the request; absent on success. */
  error?: string;

  /** Kind of an unsolicited message; `ready` is the one kind. */
  type?: string;
};

/** Returns whether `value` has the shape of a `WorkerIPCResponse`. */
export function isWorkerIPCResponse(
  value: unknown,
): value is WorkerIPCResponse {
  return !!(isObjectNotArray(value) &&
    typeof value.msgId === "number" &&
    ("error" in value ? typeof value.error === "string" : true) &&
    ("type" in value ? typeof value.type === "string" : true));
}
