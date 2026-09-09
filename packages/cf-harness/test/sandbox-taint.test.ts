/**
 * The accumulator itself: what it does with each state it can be moved into,
 * and what it refuses to be moved into.
 *
 * Two directions matter. Confidentiality only accumulates, so a later clean
 * invocation cannot lower what an earlier one established. And a run that
 * lost track of an invocation stays lost, because nothing later can establish
 * what that invocation did.
 */

import type { IFCLabel } from "@commonfabric/runner/cfc";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  forgetSandboxTaintForTesting,
  joinSandboxTaint,
  poisonSandboxTaint,
  sandboxTaint,
  seedSandboxTaint,
} from "../src/sandbox-taint.ts";

const withRun = (body: (runId: string) => void): void => {
  const runId = `taint-${crypto.randomUUID()}`;
  try {
    body(runId);
  } finally {
    forgetSandboxTaintForTesting(runId);
  }
};

describe("a run's accumulated sandbox taint", () => {
  it("starts knowing that nothing has been accumulated", () => {
    withRun((runId) => {
      expect(sandboxTaint(runId)).toEqual({ kind: "known" });
    });
  });

  it("accumulates confidentiality across invocations", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, { confidentiality: ["finance"] });
      joinSandboxTaint(runId, { confidentiality: ["health"] });

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance", "health"] },
      });
    });
  });

  it("keeps what it has when a later invocation reports nothing", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, { confidentiality: ["finance"] });
      joinSandboxTaint(runId, {});

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("drops integrity, which the checked write path cannot add", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, {
        confidentiality: ["finance"],
        integrity: ["trusted"],
      });

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("hands out a state no later hand can change", () => {
    // The accumulator is trusted evidence about untrusted work. A caller that
    // could push a clause onto the label it was handed would leave the run
    // recorded as carrying something no invocation reported, and the map this
    // is kept in would be the last place anyone looked for the change.
    withRun((runId) => {
      const taint = joinSandboxTaint(runId, { confidentiality: ["finance"] });
      if (taint.kind !== "known" || taint.label === undefined) {
        throw new Error("expected the join to record a label");
      }
      const clause = taint.label.confidentiality as string[];

      expect(() => clause.push("health")).toThrow(TypeError);
      expect(() => {
        (taint as { kind: string }).kind = "unknown";
      }).toThrow(TypeError);
      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("stays lost once an invocation left no evidence", () => {
    withRun((runId) => {
      poisonSandboxTaint(runId, "first reason");
      poisonSandboxTaint(runId, "second reason");
      joinSandboxTaint(runId, { confidentiality: ["finance"] });

      // The first reason names the invocation that lost the evidence; a later
      // one describes a run that was already lost.
      expect(sandboxTaint(runId)).toEqual({
        kind: "unknown",
        reason: "first reason",
      });
    });
  });

  it("accumulates the label it validated, not a later read of the same one", () => {
    // A reported taint is data too, and the reporting runtime is not this
    // process. Descriptors that state a requirement while a direct property
    // read states none is the shape that turns a checked label into a clean
    // record; the join carries what the check saw.
    withRun((runId) => {
      const label = new Proxy({ confidentiality: ["finance"] }, {
        get: (target, key) =>
          key === "confidentiality" ? [] : Reflect.get(target, key),
      });

      expect(joinSandboxTaint(runId, label)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("accumulates without raising when the label refuses a direct read", () => {
    // The join runs at the invocation boundary, where an exception would
    // travel out of the sandbox call while the run stayed recorded as it was
    // — which is to say clean.
    withRun((runId) => {
      const label = new Proxy({ confidentiality: ["finance"] }, {
        get: (target, key) => {
          if (key === "confidentiality") {
            throw new Error("the reported label refuses to be read again");
          }
          return Reflect.get(target, key);
        },
      });

      expect(joinSandboxTaint(runId, label)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("refuses a clause list whose members the copy would lose", () => {
    // Each of these iterates as EMPTY once copied naively, so the shape that
    // reaches the merge is a clause with no members — a run that carried a
    // requirement recorded as carrying none. A refusal is the only answer
    // that is not weaker than the source.
    const lists: readonly [string, unknown[]][] = [
      [
        "a member hidden behind a non-enumerable index",
        (() => {
          const clause: unknown[] = [];
          Object.defineProperty(clause, "0", {
            enumerable: false,
            value: "finance",
          });
          return clause;
        })(),
      ],
      [
        "a key past the last index there is",
        (() => {
          const clause: unknown[] = [];
          Object.defineProperty(clause, String(2 ** 32 - 1), {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "finance",
          });
          return clause;
        })(),
      ],
      [
        "a gap where a member should be",
        (() => {
          const clause: unknown[] = [];
          clause[1] = "finance";
          return clause;
        })(),
      ],
    ];

    for (const [shape, confidentiality] of lists) {
      // Both boundaries: the live join, and the seed a resume comes back on.
      // A shape the type system says a label cannot have, which is what the
      // check exists for: what reaches these is data off a file or a wire.
      const label = { confidentiality } as unknown as IFCLabel;
      withRun((runId) => {
        expect({ shape, kind: joinSandboxTaint(runId, label).kind })
          .toEqual({ shape, kind: "unknown" });
      });
      withRun((runId) => {
        expect({
          shape,
          kind: seedSandboxTaint(runId, { kind: "known", label }).kind,
        }).toEqual({ shape, kind: "unknown" });
      });
    }
  });

  it("poisons rather than accumulating a label it cannot read", () => {
    withRun((runId) => {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);

      const taint = joinSandboxTaint(
        runId,
        { confidentiality: cyclic } as unknown as { confidentiality: string[] },
      );

      expect(taint.kind).toBe("unknown");
    });
  });

  it("seeds a resumed run from what its record says", () => {
    withRun((runId) => {
      expect(
        seedSandboxTaint(runId, {
          kind: "known",
          label: { confidentiality: ["finance"] },
        }),
      ).toEqual({ kind: "known", label: { confidentiality: ["finance"] } });
    });

    withRun((runId) => {
      expect(seedSandboxTaint(runId, { kind: "unknown", reason: "lost" }))
        .toEqual({ kind: "unknown", reason: "lost" });
    });

    withRun((runId) => {
      // A record that states a clean run says so; nothing is accumulated.
      expect(seedSandboxTaint(runId, { kind: "known" })).toEqual({
        kind: "known",
      });
    });
  });

  it("treats a record that says nothing as a run it cannot account for", () => {
    // Absence is not evidence of a clean run: this process saw none of the
    // earlier invocations, and the record it resumed from does not say.
    withRun((runId) => {
      expect(seedSandboxTaint(runId, undefined).kind).toBe("unknown");
    });
  });

  it("seeds from the label it validated, not a later read of the record", () => {
    // The record is data, and data can be a proxy: descriptors that report a
    // requirement while a direct property read reports none. Seeding from a
    // second read would put the run back as clean while the shape check that
    // passed had seen otherwise.
    withRun((runId) => {
      const label = new Proxy({ confidentiality: ["finance"] }, {
        get: (_target, key) =>
          key === "confidentiality" ? [] : Reflect.get(_target, key),
      });

      expect(seedSandboxTaint(runId, { kind: "known", label })).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("seeds from the snapshot even when the record refuses a direct read", () => {
    // Validation reads through descriptors, so every read after it is a
    // re-read — and a record that stops answering them is the case that
    // decides whether anything downstream still makes one. Seeding runs
    // inside engine construction, so an exception here does not surface as a
    // lost run: it takes the whole run down, and a caller that catches it is
    // left with a map entry that still reads as clean.
    withRun((runId) => {
      const label = new Proxy({ confidentiality: ["finance"] }, {
        get: (target, key) => {
          if (key === "confidentiality") {
            throw new Error("the record refuses to be read again");
          }
          return Reflect.get(target, key);
        },
      });

      const seeded = seedSandboxTaint(runId, { kind: "known", label });

      expect(seeded).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
      expect(sandboxTaint(runId)).toEqual(seeded);
    });
  });

  it("reads the record's own fields once, and poisons when reading one raises", () => {
    // The record reaches this as an object, not only as parsed JSON, so an
    // accessor on it is reachable. A field read twice is a second chance for
    // the source to say something no check saw, and a field that raises is a
    // run taken down inside engine construction rather than recorded as one
    // whose earlier work cannot be accounted for.
    withRun((runId) => {
      let reads = 0;
      const record = {
        kind: "known",
        get label() {
          reads += 1;
          return reads === 1 ? { confidentiality: ["finance"] } : {};
        },
      };

      expect(seedSandboxTaint(runId, record as never)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
      expect(reads).toBe(1);
    });

    withRun((runId) => {
      const record = {
        get kind(): string {
          throw new Error("the record exploded on its discriminant");
        },
      };

      expect(seedSandboxTaint(runId, record as never).kind).toBe("unknown");
    });
  });

  it("treats a record it cannot read as a run it cannot account for", () => {
    for (
      const stored of [
        { kind: "clean" },
        { kind: "unknown" },
        { kind: "known", label: { confidentiality: "finance" } },
        "known",
        42,
        null,
      ]
    ) {
      withRun((runId) => {
        expect(
          seedSandboxTaint(runId, stored as never).kind,
        ).toBe("unknown");
      });
    }
  });
});
