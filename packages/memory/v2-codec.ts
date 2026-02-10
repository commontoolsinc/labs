/**
 * Memory v2 Codec
 *
 * Encoding/decoding between internal v2 types (with parent References)
 * and wire format types (without parent, strings for hashes). Handles
 * the conversion for the protocol layer.
 *
 * @see spec 04-protocol.md
 * @module v2-codec
 */

import type { ClientCommit, Operation } from "./v2-types.ts";
import type { TransactCommand, UserOperation } from "./v2-protocol.ts";

// ---------------------------------------------------------------------------
// Operation encoding (internal → wire)
// ---------------------------------------------------------------------------

/**
 * Convert an internal Operation (with parent Reference) to
 * wire-format UserOperation (without parent).
 * The server resolves parents from head state.
 */
export function operationToWire(op: Operation): UserOperation {
  switch (op.op) {
    case "set":
      return { op: "set", id: op.id, value: op.value };
    case "patch":
      return { op: "patch", id: op.id, patches: op.patches };
    case "delete":
      return { op: "delete", id: op.id };
    case "claim":
      return { op: "claim", id: op.id };
  }
}

/**
 * Convert a batch of internal operations to wire format.
 */
export function operationsToWire(ops: Operation[]): UserOperation[] {
  return ops.map(operationToWire);
}

// ---------------------------------------------------------------------------
// Read encoding (References → strings for wire)
// ---------------------------------------------------------------------------

/**
 * Encode a ClientCommit's read dependencies for the wire format.
 * Converts Reference objects to their string representation.
 */
export function encodeReads(
  reads: ClientCommit["reads"],
): TransactCommand["args"]["reads"] {
  return {
    confirmed: reads.confirmed.map((r) => ({
      id: r.id,
      hash: r.hash.toString(),
      version: r.version,
    })),
    pending: reads.pending.map((r) => ({
      id: r.id,
      hash: r.hash.toString(),
      fromCommit: r.fromCommit.toString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Full commit encoding
// ---------------------------------------------------------------------------

/**
 * Encode a full ClientCommit into wire-format transact command args.
 */
export function encodeTransactArgs(
  commit: ClientCommit,
): TransactCommand["args"] {
  return {
    reads: encodeReads(commit.reads),
    operations: operationsToWire(commit.operations),
    ...(commit.codeCID ? { codeCID: commit.codeCID.toString() } : {}),
    ...(commit.branch ? { branch: commit.branch } : {}),
  };
}
