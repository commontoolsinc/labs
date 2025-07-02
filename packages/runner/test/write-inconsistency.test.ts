import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as TransactionInvariant from "../src/storage/transaction/attestation.ts";

describe("Write Inconsistency Errors", () => {
  it("should provide descriptive error messages for write operations", () => {
    const source = {
      address: { id: "test:1", type: "application/json", path: [] },
      value: "not an object",
    } as const;

    const targetAddress = {
      id: "test:1",
      type: "application/json",
      path: ["property"],
    } as const;

    const result = TransactionInvariant.write(
      source,
      targetAddress,
      "some value",
    );

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("StorageTransactionInconsistent");
    expect(result.error?.message).toContain("Transaction consistency violated");
    expect(result.error?.message).toContain("cannot write");
    expect(result.error?.message).toContain("expected an object");
    expect(result.error?.message).toContain("encountered:");
  });

  it("should provide descriptive error messages for read operations", () => {
    const source = {
      address: { id: "test:2", type: "application/json", path: [] },
      value: 42,
    } as const;

    const targetAddress = {
      id: "test:2",
      type: "application/json",
      path: ["nested", "property"],
    } as const;

    const result = TransactionInvariant.read(source, targetAddress);

    expect(result.error).toBeDefined();
    expect(result.error?.name).toBe("StorageTransactionInconsistent");
    expect(result.error?.message).toContain("Transaction consistency violated");
    expect(result.error?.message).toContain("cannot read");
    expect(result.error?.message).toContain("expected an object");
    expect(result.error?.message).toContain("encountered: 42");
  });
});
