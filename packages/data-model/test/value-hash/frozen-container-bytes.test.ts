/**
 * The hasher's reuse of a deep-frozen container's encoded bytes: a container
 * it has fed once is fed again from the bytes it kept, with the hash the same
 * as a walk would make, and a container whose bytes depend on where it sits is
 * walked every time.
 *
 * The first-principles hash each case compares against is the hash of a
 * mutable copy of the same value. A mutable container is never kept, and a
 * fresh one is never found, so hashing the copy walks everything.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze, type FabricValue, hashStringOf } from "@";
import { getContainersHashedForTestingOnly } from "@/for-testing-only.ts";

/**
 * Returns a plain object wide enough that its encoding is worth keeping:
 * `count` entries, each holding a small object.
 */
function wideObject(count: number): Record<string, FabricValue> {
  const result: Record<string, FabricValue> = {};
  for (let i = 0; i < count; i++) {
    result[`definition-${i}`] = { type: "object", title: `Definition ${i}` };
  }
  return result;
}

/** Returns an array long enough that its encoding is worth keeping. */
function longArray(count: number): FabricValue[] {
  return Array.from(
    { length: count },
    (_, i) => ({ id: i, name: `item-${i}` }),
  );
}

/** Returns how many containers hashing `value` walks. */
function containersWalkedBy(value: FabricValue): number {
  const before = getContainersHashedForTestingOnly();
  hashStringOf(value);
  return getContainersHashedForTestingOnly() - before;
}

describe("frozen-container-bytes", () => {
  it("feeds a deep-frozen object reached again from its kept bytes, with the hash a walk makes", () => {
    const map = deepFreeze(wideObject(40));
    const firstRoot = { body: "first", $defs: map };
    const secondRoot = { body: "second", $defs: map };
    const expected = hashStringOf({ body: "second", $defs: wideObject(40) });

    // The map and its forty entries, plus the root.
    expect(containersWalkedBy(firstRoot)).toBe(42);
    // The root alone: the map is fed from its bytes.
    expect(containersWalkedBy(secondRoot)).toBe(1);
    expect(hashStringOf(secondRoot)).toBe(expected);
  });

  it("feeds a deep-frozen array reached again from its kept bytes", () => {
    const list = deepFreeze(longArray(40));
    const expected = hashStringOf({ tag: "b", list: longArray(40) });

    expect(containersWalkedBy({ tag: "a", list })).toBe(42);
    expect(containersWalkedBy({ tag: "b", list })).toBe(1);
    expect(hashStringOf({ tag: "b", list })).toBe(expected);
  });

  it("keeps the bytes of a deep-frozen container fed inside another kept container", () => {
    const inner = deepFreeze(wideObject(40));
    const outer = deepFreeze({ inner, more: wideObject(40) });
    const expected = hashStringOf({
      wrap: { inner: wideObject(40), more: wideObject(40) },
    });

    hashStringOf({ first: inner });
    // The outer container, its `more` map and that map's entries; `inner` is
    // fed from its bytes, and what it feeds becomes part of the outer's.
    expect(containersWalkedBy({ wrap: outer })).toBe(43);
    expect(containersWalkedBy({ wrap: outer })).toBe(1);
    expect(hashStringOf({ wrap: outer })).toBe(expected);
  });

  it("walks a deep-frozen container too small to be worth keeping every time", () => {
    const small = deepFreeze({ k: 1 });
    const expected = hashStringOf({ b: { k: 1 } });

    expect(containersWalkedBy({ a: small })).toBe(2);
    expect(containersWalkedBy({ b: small })).toBe(2);
    expect(hashStringOf({ b: small })).toBe(expected);
  });

  it("walks a deep-frozen container whose walk fed a cycle reference every time", () => {
    // Two containers in one cycle, each reached first from the other's
    // position. What the hasher feeds for `a` under `b` is `b`'s whole
    // encoding and a reference back to `a`; under its own root it is a
    // reference to `b`, so no kept bytes could serve both.
    const makePair = (): [
      Record<string, FabricValue>,
      Record<string, FabricValue>,
    ] => {
      const a: Record<string, FabricValue> = wideObject(20);
      const b: Record<string, FabricValue> = wideObject(20);
      a.to = b;
      b.to = a;
      return [a, b];
    };
    const [a, b] = makePair();
    deepFreeze(a);
    const [expectedA, expectedB] = makePair();

    expect(containersWalkedBy({ x: b })).toBe(43);
    expect(hashStringOf({ x: b })).toBe(hashStringOf({ x: expectedB }));
    expect(containersWalkedBy({ x: a })).toBe(43);
    expect(hashStringOf({ x: a })).toBe(hashStringOf({ x: expectedA }));
  });

  it("walks a mutable container every time", () => {
    const map = wideObject(40);

    expect(containersWalkedBy({ body: "first", $defs: map })).toBe(42);
    expect(containersWalkedBy({ body: "second", $defs: map })).toBe(42);
  });
});
