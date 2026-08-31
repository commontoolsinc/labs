/**
 * The conversion takes what a pattern produced, and a pattern produces both
 * frozen and unfrozen values. Frozenness is therefore an input the walk gets
 * handed rather than one it controls, and this file pins what it may and may
 * not change about the answer: nothing about which values are refused, nothing
 * about what a converted value holds, and nothing about the input itself. What
 * comes back is a fresh container, mutable, whichever way the input went in.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import { type CellLinkInput, convertCellsToLinks } from "../src/cell.ts";

/** The subject: a record with a nested array and a nested record. */
type Subject = {
  list: number[];
  inner: { n: number };
  name: string;
};

/** Builds a fresh subject, so no test reads one another has converted. */
function makeSubject(): Subject {
  return { list: [1, 2, 3], inner: { n: 1 }, name: "subject" };
}

/** An array with a hole in it, which a rebuild has to carry rather than fill. */
function sparseArray(): unknown[] {
  const out: unknown[] = [];

  out[0] = 1;
  out[3] = 4;

  return out;
}

/** Every object reachable in a value, by identity. */
function reachableObjects(
  value: unknown,
  found: Set<object> = new Set(),
): Set<object> {
  if ((value === null) || (typeof value !== "object")) return found;
  if (found.has(value)) return found;

  found.add(value);
  for (const member of Object.values(value)) reachableObjects(member, found);

  return found;
}

describe("convert-cells-to-links-frozenness", () => {
  it("returns the same value for a frozen input as for an unfrozen one", () => {
    const unfrozen = convertCellsToLinks(makeSubject());
    const frozen = convertCellsToLinks(deepFreeze(makeSubject()));

    expect(frozen).toEqual(unfrozen);
  });

  it("returns a container the caller may still write into, given a frozen input", () => {
    const result = convertCellsToLinks(deepFreeze(makeSubject())) as Subject;

    expect(Object.isFrozen(result)).toBe(false);
    expect(Object.isFrozen(result.list)).toBe(false);
    expect(Object.isFrozen(result.inner)).toBe(false);
  });

  it("returns a container the caller may still write into, given an unfrozen input", () => {
    const result = convertCellsToLinks(makeSubject()) as Subject;

    expect(Object.isFrozen(result)).toBe(false);
    expect(Object.isFrozen(result.list)).toBe(false);
    expect(Object.isFrozen(result.inner)).toBe(false);
  });

  it("returns containers that are none of the input's, given an unfrozen input", () => {
    // Writing into the result must not reach the value the caller handed over,
    // which holding any of the input's containers would let it do.
    const input = makeSubject();
    const result = convertCellsToLinks(input) as Subject;

    expect(result).not.toBe(input);
    expect(result.list).not.toBe(input.list);
    expect(result.inner).not.toBe(input.inner);
  });

  it("returns nothing mutable that the input also holds", () => {
    // The whole of the property the test above samples: across a value with
    // every container shape in it, no object reachable in the result is one
    // reachable in the input unless it is frozen. A `FabricPrimitive` is
    // shared, deliberately and by identity, and is frozen -- so what this
    // counts is the mutable intersection, which has to be empty.
    //
    // The conversion reads the input's own containers rather than copies of
    // them, at every level: the shallow conversion at the top of a node shares
    // that node's children by reference whatever frozenness it is asked for.
    // What keeps the input's containers out of the result is the rebuild
    // below, and this is what says the rebuild reaches all of them.
    const input = {
      list: [1, 2, 3],
      nested: { deep: { deeper: [{ a: 1 }, { b: 2 }] } },
      date: new Date(1000),
      bytes: new Uint8Array([1, 2, 3]),
      sparse: sparseArray(),
      emptyArray: [],
      emptyRecord: {},
      prebuilt: new FabricBytes(new Uint8Array([9, 9])),
    } as unknown as CellLinkInput;
    const prebuilt = (input as { prebuilt: FabricBytes }).prebuilt;

    const shared = [...reachableObjects(convertCellsToLinks(input))]
      .filter((object) => reachableObjects(input).has(object));

    expect(shared.filter((object) => !Object.isFrozen(object))).toEqual([]);
    // The one thing shared is the primitive the caller built, by identity.
    expect(shared).toEqual([prebuilt]);
    expect(shared[0]).toBe(prebuilt);
  });

  it("leaves an unfrozen input unfrozen and unchanged", () => {
    const input = makeSubject();

    convertCellsToLinks(input);

    expect(input).toEqual(makeSubject());
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.list)).toBe(false);
  });

  it("returns a `Date` and a `Uint8Array` as frozen fabric primitives", () => {
    // A `FabricPrimitive` is born deep-frozen, so the frozenness this walk asks
    // the shallow conversion for never reaches one. Pinned at this seam because
    // the arms that mint these two both read that flag.
    const result = convertCellsToLinks({
      date: new Date(1000),
      bytes: new Uint8Array([1, 2, 3]),
    }) as { date: unknown; bytes: unknown };

    expect(result.date).toBeInstanceOf(FabricEpochNsec);
    expect(result.bytes).toBeInstanceOf(FabricBytes);
    expect(Object.isFrozen(result.date)).toBe(true);
    expect(Object.isFrozen(result.bytes)).toBe(true);
  });

  it("throws for an unfrozen array carrying a named property", () => {
    const array: unknown[] = [1, 2, 3];
    (array as unknown as Record<string, unknown>).extra = "nope";

    expect(() => convertCellsToLinks({ array } as CellLinkInput)).toThrow();
  });

  it("throws for a frozen array carrying a named property", () => {
    const array: unknown[] = [1, 2, 3];
    (array as unknown as Record<string, unknown>).extra = "nope";

    expect(() => convertCellsToLinks(deepFreeze({ array }) as CellLinkInput))
      .toThrow();
  });

  it("throws for an unfrozen object with an accessor-backed property", () => {
    const object = {};
    Object.defineProperty(object, "live", { get: () => 1, enumerable: true });

    expect(() => convertCellsToLinks({ object })).toThrow();
  });

  it("throws for a frozen object with an accessor-backed property", () => {
    const object = {};
    Object.defineProperty(object, "live", { get: () => 1, enumerable: true });

    expect(() => convertCellsToLinks(deepFreeze({ object }))).toThrow();
  });
});
