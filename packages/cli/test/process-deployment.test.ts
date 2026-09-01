import { expect } from "@std/expect";
import { beforeEach, describe, it } from "@std/testing/bdd";

import { loadPieces } from "../lib/piece.ts";
import {
  claimProcessDeployment,
  resetProcessDeployment,
} from "../lib/process-deployment.ts";

describe("process-deployment", () => {
  beforeEach(() => {
    resetProcessDeployment();
  });

  describe("claimProcessDeployment()", () => {
    it("accepts a second claim on the deployment already claimed", () => {
      claimProcessDeployment("https://toolshed.test");
      expect(() => claimProcessDeployment("https://toolshed.test/"))
        .not.toThrow();
    });

    it("throws naming both deployments given a different one", () => {
      claimProcessDeployment("https://first.test");
      expect(() => claimProcessDeployment("https://second.test")).toThrow(
        /`https:\/\/first\.test\/`.*`https:\/\/second\.test\/`/,
      );
    });

    it("compares an api url that does not parse as written", () => {
      claimProcessDeployment("toolshed-without-a-scheme");
      expect(() => claimProcessDeployment("toolshed-without-a-scheme"))
        .not.toThrow();
      expect(() => claimProcessDeployment("another-without-a-scheme"))
        .toThrow();
    });
  });

  describe("loadPieces()", () => {
    // The claim is the connection's first act, ahead of the identity it reads
    // and the deployment it fetches flags from, so the rejection below is the
    // limit's own message rather than a failure of either.

    it("rejects a connection to a second deployment", async () => {
      claimProcessDeployment("https://first.test");
      await expect(loadPieces({
        apiUrl: "https://second.test",
        identity: "/nonexistent/second-deployment.key",
        space: "second-deployment",
      })).rejects.toThrow("one deployment per process");
    });
  });
});
