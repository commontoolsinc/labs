/**
 * @commontools/pattern-testing
 *
 * A test harness for writing unit and integration-style tests for CommonTools patterns.
 * Enables fast, isolated testing of pattern logic (computeds, handlers, reactivity)
 * without deploying full charms.
 *
 * @example
 * ```typescript
 * import { createTestHarness } from "@commontools/pattern-testing";
 *
 * const harness = await createTestHarness();
 * const { pattern, cells } = await harness.loadPattern("./counter.tsx", { value: 0 });
 *
 * pattern.result.increment.send({});
 * await harness.idle();
 *
 * expect(cells.value.get()).toBe(1);
 * await harness.dispose();
 * ```
 */

export { createTestHarness } from "./harness.ts";
export type { TestHarness, TestCell, LoadPatternResult } from "./harness.ts";
