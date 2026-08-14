import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cacheHarnessFabricSessionFactory,
  harnessFabricCfcOptions,
  type HarnessFabricSession,
} from "../src/fabric-session.ts";

describe("fabric-session", () => {
  it("maps observe mode to a complete warn-only runtime posture", () => {
    expect(harnessFabricCfcOptions("observe")).toEqual({
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "observe",
      cfcWriteFloor: "observe",
      cfcTriggerReadGating: false,
      cfcPolicyEvaluation: "observe",
      cfcLabelMetadataProtection: "observe",
      cfcDeclaredMonotonicity: "observe",
    });
  });

  describe("cacheHarnessFabricSessionFactory()", () => {
    it("returns the same session promise for every call", async () => {
      let calls = 0;
      const session = {} as HarnessFabricSession;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        return Promise.resolve(session);
      });
      const first = cached();
      const second = cached();
      expect(second).toBe(first);
      expect(await first).toBe(session);
      expect(calls).toBe(1);
    });

    it("shares one in-flight construction between concurrent calls even when it rejects", async () => {
      let calls = 0;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        return Promise.reject(new Error("construction failed"));
      });
      const first = cached();
      const second = cached();
      expect(second).toBe(first);
      await expect(first).rejects.toThrow("construction failed");
      expect(calls).toBe(1);
    });

    // Only a HEALTHY session is cached: a rejected construction clears the
    // cache so a later tool call retries the factory instead of replaying a
    // terminal failure for the rest of the run. This deliberately supersedes
    // the earlier behavior of caching the rejection forever.
    it("invokes a synchronously-throwing factory again after its rejection settles, and a later attempt can succeed", async () => {
      let calls = 0;
      const session = {} as HarnessFabricSession;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("construction failed");
        }
        return Promise.resolve(session);
      });
      await expect(cached()).rejects.toThrow("construction failed");
      expect(await cached()).toBe(session);
      expect(calls).toBe(2);
    });
  });
});
