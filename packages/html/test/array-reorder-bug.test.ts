/**
 * Minimal reproduction test for the array reorder rendering bug.
 *
 * Bug: When array items are reordered using .map(), the rendered UI shows
 * stale data. The data is correct (refresh fixes it), but DOM shows wrong values.
 *
 * Root cause: In render.ts bindChildren(), the DOM reordering algorithm
 * (lines 229-246) captures `domNodes = Array.from(element.childNodes)` once,
 * then iterates and calls insertBefore(). But insertBefore() mutates the live
 * DOM, making the captured domNodes array reference stale positions.
 *
 * Fix: Re-query the DOM child position before each insertBefore call.
 */

import { beforeEach, describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";
import { MockDoc } from "../src/mock-doc.ts";

let mock: MockDoc;

beforeEach(() => {
  mock = new MockDoc(
    `<!DOCTYPE html><html><body><ul id="list"></ul></body></html>`,
  );
});

describe("DOM reordering bug - minimal reproduction", () => {
  /**
   * This test directly simulates the buggy algorithm from render.ts.
   * It SHOULD pass (order should swap) but currently FAILS due to the bug.
   */
  it("array swap should reorder DOM correctly (reproduces bug)", () => {
    const { document } = mock;
    const parent = document.getElementById("list")!;

    // Setup: Create initial DOM [Alice, Bob]
    const aliceEl = document.createElement("li");
    aliceEl.textContent = "Alice";
    const bobEl = document.createElement("li");
    bobEl.textContent = "Bob";

    parent.appendChild(aliceEl);
    parent.appendChild(bobEl);

    // Verify initial state
    let children = parent.getElementsByTagName("li");
    assert.equal(
      children[0].textContent,
      "Alice",
      "Setup: Alice should be first",
    );
    assert.equal(children[1].textContent, "Bob", "Setup: Bob should be second");

    // Simulate reactive update: new order is [Bob, Alice]
    const newOrder = [bobEl, aliceEl];

    // === BUGGY ALGORITHM FROM render.ts lines 229-246 ===
    // BUG: Captures domNodes once, but insertBefore mutates the DOM
    const domNodes = Array.from(parent.childNodes);
    for (let i = 0; i < newOrder.length; i++) {
      const desiredNode = newOrder[i];
      if (domNodes[i] !== desiredNode) {
        (parent as any).insertBefore(desiredNode, domNodes[i] ?? null);
      }
    }
    // === END BUGGY ALGORITHM ===

    // Assert expected behavior (this will FAIL due to the bug)
    children = parent.getElementsByTagName("li");
    assert.equal(
      children[0].textContent,
      "Bob",
      "FAILS: After swap, Bob should be first but DOM shows Alice",
    );
    assert.equal(
      children[1].textContent,
      "Alice",
      "FAILS: After swap, Alice should be second but DOM shows Bob",
    );
  });

  /**
   * This test shows the corrected algorithm that properly reorders.
   */
  it("CORRECT algorithm: re-query DOM before each insertBefore", () => {
    const { document } = mock;
    const parent = document.getElementById("list")!;

    // Setup: Create initial DOM [Alice, Bob]
    const aliceEl = document.createElement("li");
    aliceEl.textContent = "Alice";
    const bobEl = document.createElement("li");
    bobEl.textContent = "Bob";

    parent.appendChild(aliceEl);
    parent.appendChild(bobEl);

    // Simulate reactive update: new order is [Bob, Alice]
    const newOrder = [bobEl, aliceEl];

    // === CORRECT ALGORITHM ===
    // FIX: Re-query DOM position before each move
    for (let i = 0; i < newOrder.length; i++) {
      const desiredNode = newOrder[i];
      const currentChildren = Array.from(parent.childNodes); // Re-query each iteration
      const currentNode = currentChildren[i];
      if (currentNode !== desiredNode) {
        (parent as any).insertBefore(desiredNode, currentNode ?? null);
      }
    }
    // === END CORRECT ALGORITHM ===

    // Assert expected behavior (this PASSES)
    const children = parent.getElementsByTagName("li");
    assert.equal(children[0].textContent, "Bob", "Bob should be first");
    assert.equal(children[1].textContent, "Alice", "Alice should be second");
  });
});

describe("DOM reordering bug - three item case", () => {
  /**
   * Test with 3 items to show the bug more clearly.
   * Reverse [A, B, C] to [C, B, A]
   */
  it("reverse order of 3 items (reproduces bug)", () => {
    const { document } = mock;
    const parent = document.getElementById("list")!;

    // Setup: [A, B, C]
    const aEl = document.createElement("li");
    aEl.textContent = "A";
    const bEl = document.createElement("li");
    bEl.textContent = "B";
    const cEl = document.createElement("li");
    cEl.textContent = "C";

    parent.appendChild(aEl);
    parent.appendChild(bEl);
    parent.appendChild(cEl);

    // Desired order: [C, B, A]
    const newOrder = [cEl, bEl, aEl];

    // Buggy algorithm
    const domNodes = Array.from(parent.childNodes);
    for (let i = 0; i < newOrder.length; i++) {
      const desiredNode = newOrder[i];
      if (domNodes[i] !== desiredNode) {
        (parent as any).insertBefore(desiredNode, domNodes[i] ?? null);
      }
    }

    const children = parent.getElementsByTagName("li");
    // Expected: C, B, A
    // Actual (buggy): varies based on how the stale references interact
    assert.equal(
      children[0].textContent,
      "C",
      "FAILS: C should be first after reverse",
    );
    assert.equal(
      children[1].textContent,
      "B",
      "B should be second (may pass by luck)",
    );
    assert.equal(
      children[2].textContent,
      "A",
      "FAILS: A should be third after reverse",
    );
  });
});
