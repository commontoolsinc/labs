import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { gitShowFailureMeansAbsent } from "./check-test-aliases.ts";

describe("check-test-aliases", () => {
  describe("gitShowFailureMeansAbsent()", () => {
    it("returns true for the two absent-path messages", () => {
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: path 'tasks/test-identity-aliases.jsonl' " +
          "does not exist in 'abc123'",
      )).toBe(true);
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: path 'tasks/test-identity-aliases.jsonl' " +
          "exists on disk, but not in 'abc123'",
      )).toBe(true);
    });

    it("returns false for any other git failure", () => {
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: unable to read tree",
      )).toBe(false);
      expect(gitShowFailureMeansAbsent(
        "git show failed: fatal: bad object abc123",
      )).toBe(false);
    });
  });
});
