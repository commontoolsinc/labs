/**
 * Stitch — sync protocol using monotonic sequence numbers.
 *
 * Defines the message types from docs/specs/sync-protocol.md and provides a
 * stub server session. The stub accepts connections but errors on the first
 * incoming message, making the incomplete state visible at runtime.
 */

import type { FabricDatum } from "@commontools/data-model/fabric-value";
import type { Immutable } from "@commontools/utils/types";
import type { SchemaPathSelector, URI } from "./interface.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Describes which documents a client wants to subscribe to, and with what
 * schema granularity. The key "*" matches all documents in the space.
 */
export type SubscriptionSelector = Map<URI | "*", SchemaPathSelector>;

/**
 * The set of documents a client read when authoring a commit. The server uses
 * this to determine whether any of those reads have been invalidated by
 * concurrent commits.
 */
export type ReadSet = URI[];

/** A single operation within a commit. */
export type CommitOp = {
  op: "set";
  id: URI;
  path: readonly string[];
  value: Immutable<FabricDatum>;
};

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientCommit = {
  type: "commit";
  /** Client's monotonic message id for this session. */
  clientSeq: number;
  /** Latest global serverSeq the client has processed. */
  serverSeq: number;
  readSet: ReadSet;
  ops: CommitOp[];
  signature: string;
};

export type ClientSubscribe = {
  type: "subscribe";
  selector: SubscriptionSelector;
};

export type ClientUnsubscribe = {
  type: "unsubscribe";
  selector: SubscriptionSelector;
};

export type ClientMessage = ClientCommit | ClientSubscribe | ClientUnsubscribe;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

/** Sent to the originating client when a commit is accepted into canonical history. */
export type ServerAccepted = {
  type: "accepted";
  clientSeq: number;
  serverSeq: number;
};

/** Sent to the originating client when a commit is rejected. */
export type ServerRejected = {
  type: "rejected";
  clientSeq: number;
};

/**
 * Sent in response to a subscribe request; carries current snapshots for one
 * or more docs. The serverSeq here becomes this client's floor for snapshot
 * retention.
 */
export type ServerSubscribed = {
  type: "subscribed";
  serverSeq: number;
  docs: Record<string, unknown>;
};

/**
 * Subscription update sent to all clients subscribed to at least one document
 * touched by a commit, excluding the originating client.
 */
export type ServerUpdate = {
  type: "update";
  serverSeq: number;
  ops: CommitOp[];
};

export type ServerMessage =
  | ServerAccepted
  | ServerRejected
  | ServerSubscribed
  | ServerUpdate;

// ---------------------------------------------------------------------------
// Stub server session
// ---------------------------------------------------------------------------

/**
 * Returns a TransformStream that will serve as the stitch server session.
 * Both sides carry newline-delimited JSON strings.
 *
 * This is a stub: it errors on the first incoming message. Replace the
 * transform body with the real implementation as it is built out.
 */
export const createSession = (): TransformStream<string, string> => {
  return new TransformStream<string, string>({
    transform(_chunk, controller) {
      controller.error(
        new Error("stitch server session: not yet implemented"),
      );
    },
  });
};
