/**
 * Guard for an action step's `event` payload: the runner sends what the step
 * authored, whatever its shape. The step is read through a schema that marks
 * the classification-only fields as values not to descend into; the payload is
 * not one of those, and reading it that way delivered `undefined` in place of
 * every object.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/action-event");

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("an action step's event payload", () => {
      it("reaches the handler as authored, for a primitive and an object", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "event-payload.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(2);
      });
    });
  },
);
