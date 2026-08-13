import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cacheHarnessFabricSessionFactory,
  type HarnessFabricSession,
} from "../src/fabric-session.ts";

describe("fabric-session", () => {
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

    it("invokes a factory that throws synchronously exactly once across two calls, rejecting both", async () => {
      let calls = 0;
      const cached = cacheHarnessFabricSessionFactory(() => {
        calls += 1;
        throw new Error("construction failed");
      });
      await expect(cached()).rejects.toThrow("construction failed");
      await expect(cached()).rejects.toThrow("construction failed");
      expect(calls).toBe(1);
    });
  });
});
