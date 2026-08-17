/**
 * Guard for an action step's `event` payload in a multi-user run, the
 * orchestrator's half of `test-runner-action-event.test.ts`. The step reader
 * classifies a step by which field is present and reads the payload through
 * that same schema; the payload is not classified but sent, and reading it as
 * a value the traversal must not descend into delivered every object as
 * `undefined`.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/multi-user-action-event",
);

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("an action step's event payload", () => {
      it("reaches the handler as authored, nested object included", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "event-payload.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });
    });
  },
);
