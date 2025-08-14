// Minimal protocol types for storage WS v2 (do not import from memory/)

export type DID = `did:${string}:${string}`;

export type Invocation<Ability extends string, Of extends DID, Args> = {
  iss: DID;
  aud?: DID;
  cmd: Ability;
  sub: Of;
  args: Args;
  iat?: number;
  exp?: number;
  nonce?: Uint8Array;
  prf: unknown[]; // delegation chain (UCAN or equivalent)
};

export type Authorization<Cmd> = {
  signature: Uint8Array; // signature over canonical invocation content
  access: Record<string, unknown>; // proof map or UCAN chain blob
};

export type UCAN<Cmd> = { invocation: Cmd; authorization: Authorization<Cmd> };

// Session hello: client identifies itself and reports last fully processed epoch
export type StorageHello = Invocation<"/storage/hello", DID, {
  clientId: string;
  sinceEpoch: number; // -1 if none
}>;

export type TaskReturn<Cmd, Result> = {
  the: "task/return";
  of: `job:${string}`;
  is: Result;
};

// Epoch-grouped deliver: bundles all doc updates for a single epoch
export type DeliverDocSnapshot = {
  docId: string;
  branch?: string;
  version: { epoch: number; branch?: string };
  kind: "snapshot";
  body: string; // base64 encoded Automerge bytes
};

export type DeliverDocDelta = {
  docId: string;
  branch?: string;
  version: { epoch: number; branch?: string };
  kind: "delta";
  body: string[]; // base64 encoded change bytes
};

export type Deliver = {
  type: "deliver";
  streamId: DID; // space DID
  epoch: number; // global tx epoch
  docs: Array<DeliverDocSnapshot | DeliverDocDelta>;
};

export type Ack = { type: "ack"; streamId: DID; epoch: number };

export type Complete = {
  type: "complete";
  at: { epoch?: number; seq?: number; heads?: string[] };
  streamId: DID;
  filterId: string;
};

// Command-specific invocations
import type { JsonSchema } from "../query/ir.ts";
import type { BranchRef, Heads, ReadAssert, SubmittedChange } from "../types.ts";

export type QueryArgs = {
  docId: string;
  schema?: JsonSchema;
  path?: string[];
};

export type GetArgs = { query?: QueryArgs; consumerId: string };

export type StorageGet = Invocation<"/storage/get", DID, GetArgs>;
export type StorageSubscribe = Invocation<"/storage/subscribe", DID, GetArgs>;

// Tx command
import type { TxReceipt } from "../interface.ts";

// WS-layer TxRequest accepts change bytes as base64 string, number[] or Uint8Array
export type ByteLike = string | number[] | Uint8Array;
export type WSTxChange = { bytes: ByteLike };
export type WSTxWriteRequest = {
  ref: BranchRef;
  baseHeads: Heads;
  changes: ReadonlyArray<WSTxChange>;
  allowServerMerge?: boolean;
};
export type WSTxRequest = {
  clientTxId?: string;
  reads: ReadonlyArray<ReadAssert>;
  writes: ReadonlyArray<WSTxWriteRequest>;
};

export type StorageTx = Invocation<"/storage/tx", DID, WSTxRequest>;
export type StorageTxResult = TxReceipt;
