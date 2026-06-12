// Integration coverage for no-retry behavior lands in work orders 03/04,
// where the engine can actually emit precondition failures.
import { describe, expect, it } from "./scheduler-test-utils.ts";
import { isPermanentRejection } from "../src/storage/rejection.ts";

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
});
