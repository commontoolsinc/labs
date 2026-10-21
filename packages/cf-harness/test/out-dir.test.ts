import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { insideGit } from "../scripts/want-eval/out-dir.ts";

describe("insideGit()", () => {
  it("returns true inside a work tree", () => {
    expect(insideGit({ success: true, stdout: "true\nfalse\n", stderr: "" }))
      .toBe(true);
  });

  it("returns true inside a `.git` directory or a bare repository", () => {
    expect(insideGit({ success: true, stdout: "false\ntrue\n", stderr: "" }))
      .toBe(true);
  });

  it("returns false outside any repository", () => {
    expect(insideGit({
      success: false,
      stdout: "",
      stderr:
        "fatal: not a git repository (or any of the parent directories): .git\n",
    })).toBe(false);
  });

  it("returns false when git says neither", () => {
    expect(insideGit({ success: true, stdout: "false\nfalse\n", stderr: "" }))
      .toBe(false);
  });

  it("throws for any other failure, and for an answer it cannot read", () => {
    expect(() =>
      insideGit({ success: false, stdout: "", stderr: "fatal: bad config\n" })
    ).toThrow("bad config");
    expect(() => insideGit({ success: true, stdout: "true\n", stderr: "" }))
      .toThrow("answered");
  });
});
