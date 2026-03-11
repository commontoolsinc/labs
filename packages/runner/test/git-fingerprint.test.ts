import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { computeGitFingerprint } from "../src/compilation-cache/git-fingerprint.ts";

describe("computeGitFingerprint", () => {
  it("returns a string in a git repository", async () => {
    const fingerprint = await computeGitFingerprint();

    // We're running inside a git repo, so this should succeed
    expect(fingerprint).toBeDefined();
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint!.length).toBe(64); // SHA-256 hex
  });

  it("returns the same value on consecutive calls (clean tree)", async () => {
    const first = await computeGitFingerprint();
    const second = await computeGitFingerprint();

    expect(first).toBe(second);
  });
});
