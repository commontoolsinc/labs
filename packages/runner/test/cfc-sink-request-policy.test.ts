import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { verifySinkRequestRelease } from "../src/cfc/sink-request.ts";

describe("CFC sink request policy", () => {
  it("accepts matching sink-request policy inputs and rejects mismatches", () => {
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/api",
      options: {
        method: "POST",
        headers: {
          "x-test": "initial",
        },
      },
    });

    const tx = {
      getCfcState: () => ({
        writePolicyInputs: [{
          kind: "sink-request",
          effectId: "fetchData:abc123",
          sink: "fetchData",
          request,
        }],
      }),
    } as unknown as {
      getCfcState(): {
        writePolicyInputs: readonly [{
          kind: "sink-request";
          effectId: string;
          sink: string;
          request: typeof request;
        }];
      };
    };

    expect(
      verifySinkRequestRelease(tx, "fetchData", "fetchData:abc123", request),
    ).toBeUndefined();

    expect(
      verifySinkRequestRelease(tx, "fetchData", "fetchData:abc123", {
        ...request,
        options: {
          ...request.options,
          headers: {
            "x-test": "mutated",
          },
        },
      }),
    ).toContain("mismatch");
  });
});
