import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { resolveGithubToken } from "../src/auth.ts";

describe("auth", () => {
  describe("resolveGithubToken()", () => {
    it("returns `GH_TOKEN` without invoking `gh`", async () => {
      let invoked = false;
      const token = await resolveGithubToken(
        (key) => key === "GH_TOKEN" ? " secret " : undefined,
        () => {
          invoked = true;
          return Promise.resolve({ code: 0, stdout: "other", stderr: "" });
        },
      );

      expect(token).toBe("secret");
      expect(invoked).toBe(false);
    });

    it("returns the token printed by `gh auth token`", async () => {
      const token = await resolveGithubToken(
        () => undefined,
        () => Promise.resolve({ code: 0, stdout: "secret\n", stderr: "" }),
      );

      expect(token).toBe("secret");
    });

    it("reports a failed `gh auth token` without including stdout", async () => {
      try {
        await resolveGithubToken(
          () => undefined,
          () =>
            Promise.resolve({
              code: 1,
              stdout: "sensitive",
              stderr: "not logged in\nmore detail",
            }),
        );
        throw new Error("expected token resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "gh auth token failed: not logged in",
        );
        expect((error as Error).message.includes("sensitive")).toBe(false);
      }
    });
  });
});
