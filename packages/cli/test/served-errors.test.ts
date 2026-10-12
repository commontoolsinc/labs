import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { EventIntentOutcome, Runtime } from "@commonfabric/runner";
import {
  collectServedErrors,
  servedRuntimeErrors,
} from "../lib/served-errors.ts";

/**
 * A stand-in runtime whose event outcomes the test delivers, through the
 * returned `deliver()`.
 */
function outcomeSource(): {
  runtime: Runtime;
  deliver: (outcome: EventIntentOutcome) => void;
} {
  const subscribers: ((outcome: EventIntentOutcome) => void)[] = [];
  const runtime: Partial<Runtime> = {
    subscribeEventIntentOutcomes: (subscriber) => {
      subscribers.push(subscriber);
      return () => {};
    },
  };
  return {
    runtime: runtime as Runtime,
    deliver: (outcome) => {
      for (const subscriber of subscribers) subscriber(outcome);
    },
  };
}

/** An outcome of `kind` for an event in a space of no consequence. */
function outcome(
  kind: EventIntentOutcome["kind"],
  reason: string,
): EventIntentOutcome {
  return { space: "did:key:z6MkTest", eventId: "event-1", kind, reason };
}

describe("served-errors", () => {
  describe("collectServedErrors()", () => {
    it("returns a list holding the reason of each `errored` outcome", () => {
      // The outcome is synthetic: a served run that throws where the test's
      // own speculative run did not is not one a pattern can bring about on
      // demand.
      const { runtime, deliver } = outcomeSource();
      const errors = collectServedErrors(runtime);
      deliver(outcome("errored", "the served run threw"));
      expect(errors).toStrictEqual(["the served run threw"]);
    });

    it("returns a list holding nothing for outcomes of other kinds", () => {
      const { runtime, deliver } = outcomeSource();
      const errors = collectServedErrors(runtime);
      deliver(outcome("dropped", "dropped"));
      deliver(outcome("refused", "refused"));
      deliver(outcome("needs-attention", "needs attention"));
      expect(errors).toStrictEqual([]);
    });
  });

  describe("servedRuntimeErrors()", () => {
    it("returns each served error marked as served when no local error matches it", () => {
      expect(servedRuntimeErrors(["the served run threw"], [])).toStrictEqual([
        "[served] the served run threw",
      ]);
    });

    it("returns nothing for a served error whose text is a local error's message", () => {
      expect(
        servedRuntimeErrors(["the handler threw"], ["the handler threw"]),
      ).toStrictEqual([]);
    });

    it("returns a served error that a local error has already answered for", () => {
      // Two served throws and one speculative one: one is reported as the
      // local error, and the other only as served.
      expect(
        servedRuntimeErrors(
          ["the handler threw", "the handler threw"],
          ["the handler threw"],
        ),
      ).toStrictEqual(["[served] the handler threw"]);
    });
  });
});
