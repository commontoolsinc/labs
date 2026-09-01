/**
 * Unit tests for the process's claim on the deployment it connects to: what
 * `claimProcessDeployment` accepts, what it refuses, and how it compares two
 * spellings of one API URL. The claim is a module-level string and nothing
 * else, so each case resets it and calls the function directly.
 *
 * The last case drives the real `loadPieces`, which claims ahead of the
 * identity it reads and the flags it fetches from the deployment. A refused
 * connection therefore rejects with the limit's own message, and no runtime,
 * socket, or server stands behind that case either.
 */

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
