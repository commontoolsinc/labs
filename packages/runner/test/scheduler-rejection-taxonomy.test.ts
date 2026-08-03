// Integration coverage for no-retry behavior lands in work orders 03/04,
// where the engine can actually emit precondition failures.
import { describe, expect, it } from "./scheduler-test-utils.ts";
import {
  isExecutionLeaseFenceRejection,
  isPermanentRejection,
  isTerminalRejection,
} from "../src/storage/rejection.ts";

describe("scheduler rejection taxonomy", () => {
  it("classifies precondition failures as permanent", () => {
    expect(isPermanentRejection({
      name: "PreconditionFailedError",
    })).toBe(true);
  });

  it("does not classify conflicts as permanent", () => {
    expect(isPermanentRejection({
      name: "ConflictError",
    })).toBe(false);
  });

  it("does not classify missing errors as permanent", () => {
    expect(isPermanentRejection(undefined)).toBe(false);
  });

  it("classifies a row-label commit refusal as terminal", () => {
    // A deterministic commit-rule refusal (memory/v2/sqlite/commit-eval.ts):
    // re-running recomputes the identical refused write, so it must never retry.
    expect(isTerminalRejection({
      name: "RowLabelCommitError",
    })).toBe(true);
    expect(isTerminalRejection({
      name: "ExecutionActionFirewallError",
    })).toBe(true);
  });

  it("does not classify retryable/transient rejections as terminal", () => {
    // A stale-read conflict CAN converge on retry; a generic transient error
    // keeps its bounded retry budget — neither is terminal.
    expect(isTerminalRejection({ name: "ConflictError" })).toBe(false);
    expect(isTerminalRejection({ name: "TransactionError" })).toBe(false);
    expect(isTerminalRejection({ name: "PreconditionFailedError" })).toBe(
      false,
    );
    expect(isTerminalRejection(undefined)).toBe(false);
  });

  it("keeps permanent and terminal as distinct categories", () => {
    // Both stop the handler, but they are different provenance (idempotency
    // precondition vs. deterministic data refusal) and must not be conflated.
    expect(isPermanentRejection({ name: "RowLabelCommitError" })).toBe(false);
    expect(isTerminalRejection({ name: "PreconditionFailedError" })).toBe(
      false,
    );
  });

  it("classifies stale execution authority separately from data refusal", () => {
    const rejection = { name: "ExecutionLeaseFenceError" };
    expect(isExecutionLeaseFenceRejection(rejection)).toBe(true);
    expect(isPermanentRejection(rejection)).toBe(false);
    expect(isTerminalRejection(rejection)).toBe(false);
  });
});
