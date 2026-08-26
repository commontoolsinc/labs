import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  CODEMIRROR_CHANGESET_CODEC,
  createDefaultOperationCodecRegistry,
  type OperationCodec,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";

const update = (
  clientId: string,
  length: number,
  from: number,
  insert: string,
) => ({
  updates: [{
    clientId,
    changes: ChangeSet.of({ from, insert }, length).toJSON(),
  }],
});

describe("v2-operation-codec", () => {
  it("integrates same-base CodeMirror updates in either canonical order", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const alice = update("alice", 3, 1, "X");
    const bob = update("bob", 3, 1, "Y");

    const aliceFirst = codec.integrate({
      materialized: "abc",
      submitted: alice,
      intervening: [],
    });
    const thenBob = codec.integrate({
      materialized: aliceFirst.materialized,
      submitted: bob,
      intervening: aliceFirst.operations,
    });
    expect(thenBob.materialized).toBe("aXYbc");

    const bobFirst = codec.integrate({
      materialized: "abc",
      submitted: bob,
      intervening: [],
    });
    const thenAlice = codec.integrate({
      materialized: bobFirst.materialized,
      submitted: alice,
      intervening: bobFirst.operations,
    });
    expect(thenAlice.materialized).toBe("aYXbc");
  });

  it("rebases an ordered local batch over the complete canonical suffix", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const remoteOne = codec.integrate({
      materialized: "ab",
      submitted: update("bob", 2, 1, "X"),
      intervening: [],
    });
    const remoteTwo = codec.integrate({
      materialized: remoteOne.materialized,
      submitted: update("carol", 3, 2, "Y"),
      intervening: [],
    });
    const localBatch = {
      updates: [{
        clientId: "alice",
        changes: ChangeSet.of({ from: 1, insert: "A" }, 2).toJSON(),
      }, {
        clientId: "alice",
        changes: ChangeSet.of({ from: 2, insert: "B" }, 3).toJSON(),
      }],
    };

    const integrated = codec.integrate({
      materialized: remoteTwo.materialized,
      submitted: localBatch,
      intervening: [...remoteOne.operations, ...remoteTwo.operations],
    });

    expect(integrated.materialized).toBe("aXYABb");
    expect(integrated.operations).toHaveLength(2);
  });

  it("rejects malformed CodeMirror payloads before returning output", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const malformed = [
      { materialized: 1, submitted: update("alice", 1, 0, "x") },
      { materialized: "a", submitted: null },
      { materialized: "a", submitted: { updates: "not-an-array" } },
      {
        materialized: "a",
        submitted: { updates: [{ clientId: "", changes: [1] }] },
      },
      {
        materialized: "a",
        submitted: {
          updates: [{ clientId: "alice", changes: [999] }],
        },
      },
      {
        materialized: "a",
        submitted: {
          updates: [{ clientId: "alice", changes: [1], effects: [] }],
        },
      },
    ] as const;

    for (const input of malformed) {
      expect(() =>
        codec.integrate({
          materialized: input.materialized,
          submitted: input.submitted,
          intervening: [],
        })
      ).toThrow();
    }
  });

  it("is deterministic and does not retain mutable submitted objects", () => {
    const codec = createDefaultOperationCodecRegistry().require(
      CODEMIRROR_CHANGESET_CODEC,
    );
    const submitted = update("alice", 3, 1, "X");
    const first = codec.integrate({
      materialized: "abc",
      submitted,
      intervening: [],
    });
    const second = codec.integrate({
      materialized: "abc",
      submitted,
      intervening: [],
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    submitted.updates[0].clientId = "mutated";
    expect(first.operations).toEqual([update("alice", 3, 1, "X")]);
  });

  it("enforces versioned unique ids for editor-neutral codecs", () => {
    const counter: OperationCodec = {
      id: "test-counter@1",
      integrate({ materialized, submitted }) {
        if (
          typeof materialized !== "number" || submitted === null ||
          typeof submitted !== "object" || Array.isArray(submitted) ||
          typeof (submitted as { by?: unknown }).by !== "number"
        ) {
          throw new Error("counter values must be numeric");
        }
        const by = (submitted as { by: number }).by;
        return { materialized: materialized + by, operations: [{ by }] };
      },
    };
    const registry = new OperationCodecRegistry([counter]);
    expect(
      registry.require("test-counter@1").integrate({
        materialized: 2,
        submitted: { by: 3 },
        intervening: [],
      }),
    ).toEqual({ materialized: 5, operations: [{ by: 3 }] });
    expect(() => registry.register(counter)).toThrow(
      "operation codec already registered",
    );
    expect(() => registry.register({ ...counter, id: "test-counter" })).toThrow(
      "requires a version suffix",
    );
  });
});
