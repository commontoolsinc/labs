import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { withEnv } from "./utils.ts";
import { runMultiUserTestPattern } from "../lib/multi-user-test-runner.ts";
import { runTestPattern } from "../lib/test-runner.ts";

const REFUSAL =
  "`cf test` refuses `EXPERIMENTAL_SERVER_EXECUTION=true`: it hosts no serving loop";

describe(
  "cf test with server execution on",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    // Each case names a test file that does not exist. The refusal comes
    // before the file is read, so a runner that did not refuse fails on the
    // missing file instead, with a message other than the refusal.

    it("rejects a single-user run with the refusal", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-test-on-single-" });
      try {
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          await expect(
            runTestPattern(join(dir, "never-read.test.tsx"), { root: dir }),
          ).rejects.toThrow(REFUSAL);
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns the refusal as the error of a multi-user run", async () => {
      const dir = await Deno.makeTempDir({ prefix: "cf-test-on-multi-" });
      try {
        let result:
          | Awaited<ReturnType<typeof runMultiUserTestPattern>>
          | undefined;
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          result = await runMultiUserTestPattern(
            join(dir, "never-read.test.tsx"),
            { participants: [{ name: "alice", user: "alice" }] },
            { root: dir },
          );
        });
        expect(result?.error).toContain(REFUSAL);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);
