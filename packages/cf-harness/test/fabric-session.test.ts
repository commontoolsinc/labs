import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cacheHarnessFabricSessionFactory,
  type HarnessFabricSession,
  harnessFabricSessionControllerOptions,
} from "../src/fabric-session.ts";

describe("fabric-session", () => {
  describe("harnessFabricSessionControllerOptions()", () => {
    const base = {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    };

    it("resolves the space and API URL and carries no dial the config omits", () => {
      const options = harnessFabricSessionControllerOptions(base);
      expect(options.apiUrl.href).toBe("https://toolshed.example/");
      expect(options.space).toBe("my-space");
      expect("cfcEnforcementMode" in options).toBe(false);
      expect("cfcFlowLabels" in options).toBe(false);
      expect("cfcPosture" in options).toBe(false);
      expect("cfcReadMaxConfidentiality" in options).toBe(false);
      expect("cfcReadOnExceed" in options).toBe(false);
    });

    it("carries the read ceiling the config sets, with its onExceed", () => {
      const options = harnessFabricSessionControllerOptions({
        ...base,
        cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
        cfcReadOnExceed: "skip",
      });
      expect(options.cfcReadMaxConfidentiality).toEqual([
        "did:key:zOwner",
        "did:key:zFacet",
      ]);
      expect(options.cfcReadOnExceed).toBe("skip");
    });

    it("carries every dial the config sets, posture included", () => {
      const options = harnessFabricSessionControllerOptions({
        ...base,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcPosture: "max-enforcement",
      });
      expect(options.cfcEnforcementMode).toBe("enforce-strict");
      expect(options.cfcFlowLabels).toBe("persist");
      expect(options.cfcPosture).toBe("max-enforcement");
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

    it("invokes a synchronously-throwing factory again after its rejection settles, and a later attempt can succeed", async () => {
      // Only a HEALTHY session is cached: a rejected construction clears the
      // cache so a later tool call retries the factory instead of replaying a
      // terminal failure for the rest of the run. This deliberately supersedes
      // the earlier behavior of caching the rejection forever.

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
