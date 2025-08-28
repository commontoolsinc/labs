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

export type TaskReturn<Cmd, Result> = {
  the: "task/return";
  of: `job:${string}`;
  is: Result;
};

export type Deliver = {
  type: "deliver";
  streamId: DID; // space DID
  filterId: string; // server-assigned (subscription id)
  deliveryNo: number; // monotonic per (streamId, filterId)
  payload: unknown;
};

export type Ack = { type: "ack"; streamId: DID; deliveryNo: number };

export type Complete = {
  type: "complete";
  at: { epoch?: number; seq?: number; heads?: string[] };
  streamId: DID;
  filterId: string;
};

// Command-specific invocations
export type GetArgs = { query?: Record<string, unknown>; consumerId: string };

export type StorageGet = Invocation<"/storage/get", DID, GetArgs>;
export type StorageSubscribe = Invocation<"/storage/subscribe", DID, GetArgs>;

// For tx we will add a dedicated type in a subsequent step
