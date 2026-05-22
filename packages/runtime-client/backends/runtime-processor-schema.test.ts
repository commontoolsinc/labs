import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hasExplicitSubscriptionSchema } from "./runtime-processor.ts";

describe("hasExplicitSubscriptionSchema", () => {
  it("treats boolean true as an explicit subscription schema", () => {
    expect(hasExplicitSubscriptionSchema(true)).toBe(true);
  });

  it("rejects missing, false, and empty object schemas", () => {
    expect(hasExplicitSubscriptionSchema(undefined)).toBe(false);
    expect(hasExplicitSubscriptionSchema(false)).toBe(false);
    expect(hasExplicitSubscriptionSchema({})).toBe(false);
  });

  it("accepts non-empty object schemas", () => {
    expect(hasExplicitSubscriptionSchema({ type: "object" })).toBe(true);
  });
});
