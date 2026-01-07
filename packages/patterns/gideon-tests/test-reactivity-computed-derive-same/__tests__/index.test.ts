/**
 * Test: computed() and derive() equivalence
 *
 * This test validates the claim that computed() and derive() are functionally
 * identical by verifying they produce the same values and update in lockstep.
 *
 * Pattern: ../index.tsx
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createTestHarness,
  type TestHarness,
} from "@commontools/pattern-testing";
import { dirname, fromFileUrl, join } from "@std/path";

// Resolve pattern path relative to this test file
const PATTERN_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "index.tsx",
);

interface PatternInput {
  firstName: string;
  lastName: string;
  age: number;
}

interface PatternOutput {
  computedFullName: string;
  deriveFullName: string;
  deriveWithDeps: string;
}

describe("computed/derive equivalence", { sanitizeResources: false }, () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("computed and derive produce identical initial values", async () => {
    const { pattern } = await harness.loadPattern<PatternInput, PatternOutput>(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    await harness.idle();

    const expected = "John Doe (age 30)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("all three update when firstName changes", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    // Change firstName
    await cells.firstName.set("Alice");
    await harness.idle();

    const expected = "Alice Doe (age 30)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("all three update when lastName changes", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    // Change lastName
    await cells.lastName.set("Smith");
    await harness.idle();

    const expected = "John Smith (age 30)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("all three update when age changes", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    // Change age
    await cells.age.set(25);
    await harness.idle();

    const expected = "John Doe (age 25)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("all three update when multiple inputs change", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    // Change all inputs
    await cells.firstName.set("Bob");
    await cells.lastName.set("Johnson");
    await cells.age.set(42);
    await harness.idle();

    const expected = "Bob Johnson (age 42)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("handles empty string values", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "John",
        lastName: "Doe",
        age: 30,
      },
    );

    // Set firstName to empty
    await cells.firstName.set("");
    await harness.idle();

    const expected = " Doe (age 30)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });

  it("handles zero age", async () => {
    const { pattern, cells } = await harness.loadPattern<
      PatternInput,
      PatternOutput
    >(
      PATTERN_PATH,
      {
        firstName: "Baby",
        lastName: "Newborn",
        age: 0,
      },
    );

    await harness.idle();

    const expected = "Baby Newborn (age 0)";
    expect(pattern.result.computedFullName).toBe(expected);
    expect(pattern.result.deriveFullName).toBe(expected);
    expect(pattern.result.deriveWithDeps).toBe(expected);
  });
});
