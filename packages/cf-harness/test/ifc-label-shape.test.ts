/**
 * What counts as a label this build can read.
 *
 * The answer has to hold for every input, including the ones a serializer
 * refuses, because the caller uses it to decide whether a container's taint
 * can be established at all — and a read that raises there leaves a run
 * recorded as it was, which is to say clean.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { inertLabelSnapshot } from "../src/ifc-label-shape.ts";

describe("inertLabelSnapshot()", () => {
  it("returns the clauses as plain data", () => {
    expect(inertLabelSnapshot({ confidentiality: ["finance"] })).toEqual({
      confidentiality: ["finance"],
    });
  });

  it("copies the clauses out of reach of whatever produced them", () => {
    // The snapshot is what a later comparison reads, so mutating the original
    // afterwards must not change what was established.
    const clause = [{ name: "finance" }];
    const snapshot = inertLabelSnapshot({ confidentiality: clause })!;
    clause.push({ name: "health" });
    (clause[0] as { name: string }).name = "mutated";

    expect(snapshot.confidentiality).toEqual([{ name: "finance" }]);
  });

  it("carries the atom shapes a real label holds", () => {
    // Strings, records, numbers, booleans and nulls all appear in atoms; an
    // object appearing twice in sequence is not a cycle.
    const atom = { name: "finance", version: 1, anyOf: null, strict: true };
    expect(
      inertLabelSnapshot({ confidentiality: [atom, atom], integrity: [] }),
    ).toEqual({
      confidentiality: [atom, atom],
      integrity: [],
    });
  });

  it("returns nothing for a value that is not a label", () => {
    for (const value of [undefined, null, "finance", 7, ["finance"]]) {
      expect(inertLabelSnapshot(value)).toBeUndefined();
    }
  });

  it("returns nothing for a container that is not inert", () => {
    class Label {
      confidentiality = ["finance"];
    }
    expect(inertLabelSnapshot(new Label())).toBeUndefined();
    expect(
      inertLabelSnapshot(
        new Proxy({ confidentiality: ["finance"] }, {
          ownKeys() {
            throw new Error("trap");
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns nothing for a clause that is not a list", () => {
    expect(inertLabelSnapshot({ confidentiality: "finance" })).toBeUndefined();
    expect(inertLabelSnapshot({ integrity: 7 })).toBeUndefined();
  });

  it("returns nothing for a clause holding something that is not data", () => {
    for (
      const clause of [
        [() => "finance"],
        [Symbol("finance")],
        [Number.NaN],
        [Number.POSITIVE_INFINITY],
        [{ nested: () => "finance" }],
      ]
    ) {
      expect(inertLabelSnapshot({ confidentiality: clause })).toBeUndefined();
    }
  });

  it("returns nothing for a clause that is an array subclass", () => {
    // `Array.isArray` is true of it, so the clause looks like a list — but
    // its prototype can carry anything, including a `toJSON` that runs later.
    class Clause extends Array {}
    const clause = Clause.from(["finance"]);

    expect(inertLabelSnapshot({ confidentiality: clause })).toBeUndefined();
  });

  it("returns nothing for a clause holding a non-inert container", () => {
    class Atom {}
    expect(
      inertLabelSnapshot({ confidentiality: [new Atom()] }),
    ).toBeUndefined();
  });

  it("returns nothing for another property carrying content", () => {
    // A key this build has no reading for is a label it cannot represent;
    // one carrying nothing is simply absent.
    expect(
      inertLabelSnapshot({ confidentiality: [], observes: "value" }),
    ).toBeUndefined();
    expect(inertLabelSnapshot({ confidentiality: [], observes: null }))
      .toEqual({ confidentiality: [] });
  });

  it("returns nothing for an accessor on the label's own property", () => {
    const label = {};
    Object.defineProperty(label, "confidentiality", {
      enumerable: true,
      get: () => ["finance"],
    });

    expect(inertLabelSnapshot(label)).toBeUndefined();
  });

  it("ignores a property that is not enumerable, and a symbol key", () => {
    const label: Record<string, unknown> = { confidentiality: ["finance"] };
    Object.defineProperty(label, "hidden", {
      enumerable: false,
      value: "ignored",
    });

    expect(inertLabelSnapshot(label)).toEqual({ confidentiality: ["finance"] });

    const keyed = { confidentiality: ["finance"] };
    Object.defineProperty(keyed, Symbol("marker"), {
      enumerable: true,
      value: "x",
    });
    expect(inertLabelSnapshot(keyed)).toBeUndefined();
  });

  it("is unmoved by a source that answers differently on a second read", () => {
    // The shape a single verdict about mutable input cannot catch: it passes
    // whatever check runs first, then reports something else when the value
    // is read again. The answer is not to detect the lie — a proxy can trap
    // any read — but to read each thing ONCE, through descriptors, and copy
    // as we go. The length is taken from its descriptor, so a `get` trap on
    // it never runs and a second answer has nothing left to change.
    let lengthReads = 0;
    const lying = new Proxy(["finance"], {
      get(target, key, receiver) {
        if (key === "length") {
          lengthReads += 1;
          return lengthReads > 1 ? 0 : 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(inertLabelSnapshot({ confidentiality: lying })).toEqual({
      confidentiality: ["finance"],
    });
    expect(lengthReads).toBe(0);
  });

  it("returns nothing when reading the source raises", () => {
    // The traps it cannot route around: a container that raises when its own
    // keys or descriptors are read establishes nothing, and says so rather
    // than propagating.
    for (
      const trapped of [
        new Proxy(["finance"], {
          ownKeys() {
            throw new Error("ownKeys exploded");
          },
        }),
        new Proxy(["finance"], {
          getOwnPropertyDescriptor() {
            throw new Error("descriptor exploded");
          },
        }),
      ]
    ) {
      expect(inertLabelSnapshot({ confidentiality: trapped })).toBeUndefined();
    }
  });

  it("carries an atom's own `__proto__` key as data", () => {
    // Pins the shape of the copy for the one key whose write path is not
    // ordinary: an own data property holding what the source held, on a copy
    // whose prototype is where it started. A copy that routed this key
    // through the inherited accessor instead would say less than the source.
    const atom: Record<string, unknown> = { name: "finance" };
    Object.defineProperty(atom, "__proto__", {
      value: "spoofed",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const snapshot = inertLabelSnapshot({ confidentiality: [atom] });
    const copied = (snapshot?.confidentiality as Record<string, unknown>[])[0];

    expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toBe(
      "spoofed",
    );
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
  });

  it("refuses a clause hidden as a non-enumerable property", () => {
    // A walk over own enumerable properties never sees it, so answering with
    // the label MINUS that clause would say the container carried less than
    // it does. That is the fail-open this exists to prevent: a shape this
    // cannot read, not a label with one fewer requirement.
    const label = {};
    Object.defineProperty(label, "confidentiality", {
      enumerable: false,
      value: ["finance"],
    });

    expect(inertLabelSnapshot(label)).toBeUndefined();
  });

  it("refuses a named property hung off a clause list", () => {
    // A list of atoms has indices. A named property on one is data the copy
    // has nowhere to put, and dropping it says less than the source.
    const clause: unknown[] = ["finance"];
    (clause as unknown as Record<string, unknown>).extra = "health";

    expect(inertLabelSnapshot({ confidentiality: clause })).toBeUndefined();
  });

  it("returns nothing for a cycle, however deeply it sits", () => {
    const clause: unknown[] = [];
    clause.push(clause);
    expect(inertLabelSnapshot({ confidentiality: clause })).toBeUndefined();

    const inner: Record<string, unknown> = { name: "finance" };
    inner.self = inner;
    expect(inertLabelSnapshot({ confidentiality: [inner] })).toBeUndefined();
  });

  it("returns nothing for data nested deeper than a label ever is", () => {
    let nest: unknown[] = ["finance"];
    for (let index = 0; index < 20_000; index++) {
      nest = [nest];
    }

    expect(inertLabelSnapshot({ confidentiality: nest })).toBeUndefined();
  });
});
