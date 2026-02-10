import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  encodeReads,
  encodeTransactArgs,
  operationsToWire,
  operationToWire,
} from "../v2-codec.ts";
import { claimOp, deleteOp, patchOp, setOp } from "../v2-fact.ts";
import type { ClientCommit, EntityId, PatchOp } from "../v2-types.ts";
import type { Reference } from "merkle-reference";
import { refer } from "../reference.ts";

const ENTITY: EntityId = "urn:entity:test1";
const ENTITY2: EntityId = "urn:entity:test2";

describe("v2-codec operation encoding", () => {
  it("encodes a set operation to wire format (strips parent)", () => {
    const op = setOp(ENTITY, { x: 1 });
    const wire = operationToWire(op);
    expect(wire).toEqual({ op: "set", id: ENTITY, value: { x: 1 } });
    // Wire format should NOT have a parent field
    expect("parent" in wire).toBe(false);
  });

  it("encodes a patch operation to wire format", () => {
    const patches: PatchOp[] = [{ op: "add", path: "/foo", value: "bar" }];
    const op = patchOp(ENTITY, patches);
    const wire = operationToWire(op);
    expect(wire).toEqual({ op: "patch", id: ENTITY, patches });
    expect("parent" in wire).toBe(false);
  });

  it("encodes a delete operation to wire format", () => {
    const op = deleteOp(ENTITY);
    const wire = operationToWire(op);
    expect(wire).toEqual({ op: "delete", id: ENTITY });
    expect("parent" in wire).toBe(false);
  });

  it("encodes a claim operation to wire format", () => {
    const parent = refer({ some: "state" }) as unknown as Reference;
    const op = claimOp(ENTITY, parent);
    const wire = operationToWire(op);
    expect(wire).toEqual({ op: "claim", id: ENTITY });
    expect("parent" in wire).toBe(false);
  });

  it("encodes a batch of operations", () => {
    const ops = [
      setOp(ENTITY, 42),
      deleteOp(ENTITY2),
    ];
    const wire = operationsToWire(ops);
    expect(wire.length).toBe(2);
    expect(wire[0].op).toBe("set");
    expect(wire[1].op).toBe("delete");
  });
});

describe("v2-codec read encoding", () => {
  it("encodes confirmed reads with Reference-to-string conversion", () => {
    const hash = refer({ some: "fact" }) as unknown as Reference;
    const reads = {
      confirmed: [{ id: ENTITY, hash, version: 3 }],
      pending: [],
    };
    const encoded = encodeReads(reads);
    expect(encoded.confirmed.length).toBe(1);
    expect(encoded.confirmed[0].id).toBe(ENTITY);
    expect(typeof encoded.confirmed[0].hash).toBe("string");
    expect(encoded.confirmed[0].hash).toBe(hash.toString());
    expect(encoded.confirmed[0].version).toBe(3);
  });

  it("encodes pending reads with Reference-to-string conversion", () => {
    const hash = refer({ some: "pending" }) as unknown as Reference;
    const fromCommit = refer({ commit: 1 }) as unknown as Reference;
    const reads = {
      confirmed: [],
      pending: [{ id: ENTITY, hash, fromCommit }],
    };
    const encoded = encodeReads(reads);
    expect(encoded.pending.length).toBe(1);
    expect(typeof encoded.pending[0].hash).toBe("string");
    expect(typeof encoded.pending[0].fromCommit).toBe("string");
    expect(encoded.pending[0].hash).toBe(hash.toString());
    expect(encoded.pending[0].fromCommit).toBe(fromCommit.toString());
  });

  it("handles empty reads", () => {
    const encoded = encodeReads({ confirmed: [], pending: [] });
    expect(encoded.confirmed).toEqual([]);
    expect(encoded.pending).toEqual([]);
  });
});

describe("v2-codec full commit encoding", () => {
  it("encodes a full ClientCommit for the transact command", () => {
    const hash = refer({ some: "fact" }) as unknown as Reference;
    const commit: ClientCommit = {
      reads: {
        confirmed: [{ id: ENTITY, hash, version: 1 }],
        pending: [],
      },
      operations: [
        setOp(ENTITY, "new-value"),
        deleteOp(ENTITY2),
      ],
    };
    const encoded = encodeTransactArgs(commit);

    // Reads should be string-encoded
    expect(typeof encoded.reads.confirmed[0].hash).toBe("string");

    // Operations should be wire format (no parent)
    expect(encoded.operations.length).toBe(2);
    expect("parent" in encoded.operations[0]).toBe(false);

    // Optional fields should be absent
    expect("codeCID" in encoded).toBe(false);
    expect("branch" in encoded).toBe(false);
  });

  it("includes optional codeCID and branch when present", () => {
    const codeCID = refer({ code: "test" }) as unknown as Reference;
    const commit: ClientCommit = {
      reads: { confirmed: [], pending: [] },
      operations: [],
      codeCID,
      branch: "feature/test",
    };
    const encoded = encodeTransactArgs(commit);
    expect(encoded.codeCID).toBe(codeCID.toString());
    expect(encoded.branch).toBe("feature/test");
  });
});
