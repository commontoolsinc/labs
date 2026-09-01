/**
 * `AncestorStack` answers the same question two ways -- by scanning its stack,
 * and from an index it builds once the chain is deep enough -- so what these
 * pin is that the two answers agree. A test that stays below the threshold
 * exercises only the scan, and one that never crosses back down exercises only
 * the index, so the cases that matter are the ones that cross it and come back.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { AncestorStack } from "../src/ancestor-stack.ts";

/** A chain of distinct values, long enough for a test to index into. */
function values(count: number): object[] {
  const out: object[] = [];

  for (let at = 0; at < count; at++) out.push({ at });

  return out;
}

describe("AncestorStack", () => {
  it("reports -1 for a value it has never held", () => {
    const stack = new AncestorStack();

    expect(stack.depthOf({})).toBe(-1);
  });

  it("reports each value's depth, shallow enough to answer by scanning", () => {
    const stack = new AncestorStack();
    const chain = values(4);

    for (const value of chain) stack.push(value);

    chain.forEach((value, at) => expect(stack.depthOf(value)).toBe(at));
  });

  it("reports -1 for a value that has been popped", () => {
    const stack = new AncestorStack();
    const [first, second] = values(2) as [object, object];

    stack.push(first);
    stack.push(second);
    stack.pop();

    expect(stack.depthOf(first)).toBe(0);
    expect(stack.depthOf(second)).toBe(-1);
  });

  it("tolerates a pop on an empty stack", () => {
    const stack = new AncestorStack();

    stack.pop();

    expect(stack.depthOf({})).toBe(-1);
  });

  it("reports the same depths past the threshold as below it", () => {
    // The whole point of the class: crossing `INDEX_AT` changes which
    // structure answers and must not change the answer.
    const stack = new AncestorStack();
    const chain = values(AncestorStack.INDEX_AT + 10);

    for (const value of chain) stack.push(value);

    chain.forEach((value, at) => expect(stack.depthOf(value)).toBe(at));
    expect(stack.depthOf({})).toBe(-1);
  });

  it("reports -1 for values popped back below the threshold", () => {
    // The index outlives the depth that built it, so an entry it no longer
    // holds has to be gone from it rather than merely unreachable by scanning.
    const stack = new AncestorStack();
    const chain = values(AncestorStack.INDEX_AT + 10);

    for (const value of chain) stack.push(value);
    for (let at = 0; at < 20; at++) stack.pop();

    chain.forEach((value, at) => {
      expect(stack.depthOf(value)).toBe(at < (chain.length - 20) ? at : -1);
    });
  });

  it("reports the right depth for a value re-pushed at a new depth", () => {
    // A walk reaches the same value at two positions all the time, one after
    // the other. What it must never get is the depth the earlier visit had.
    const stack = new AncestorStack();
    const chain = values(AncestorStack.INDEX_AT + 5);
    const revisited = {};

    for (const value of chain) stack.push(value);
    stack.push(revisited);
    expect(stack.depthOf(revisited)).toBe(chain.length);

    stack.pop();
    stack.pop();
    stack.push(revisited);
    expect(stack.depthOf(revisited)).toBe(chain.length - 1);
  });
});
