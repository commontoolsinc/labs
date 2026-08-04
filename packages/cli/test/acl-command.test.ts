import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, stripAnsi, withEnv } from "./utils.ts";

function errorText(stderr: string[]): string {
  return stderr.map(stripAnsi).join("\n");
}

describe("cf acl", () => {
  it("reads the space options its environment declarations map", async () => {
    // `--api-url` and `--identity` reach the option parser through the
    // command's `CF_API_URL` and `CF_IDENTITY` declarations, so the only
    // option left unset is the one with no environment fallback.
    await withEnv("CF_API_URL", "https://toolshed.test", async () => {
      await withEnv("CF_IDENTITY", "/nonexistent/identity.key", async () => {
        const { code, stderr } = await cf("acl ls");
        expect(code).toBe(1);
        expect(errorText(stderr)).toContain(
          'Missing required option: "--space".',
        );
      });
    });
  });

  it("reports a missing identity on stderr and exits non-zero", async () => {
    await withEnv("CF_API_URL", undefined, async () => {
      await withEnv("CF_IDENTITY", undefined, async () => {
        const { code, stderr } = await cf("acl ls");
        expect(code).toBe(1);
        expect(errorText(stderr)).toContain(
          'Missing required option: "--identity", or "CF_IDENTITY".',
        );
      });
    });
  });
});
