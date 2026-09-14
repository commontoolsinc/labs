import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  describeFiredBackstops,
  firedBackstops,
  type SilentBackstop,
} from "./support/silent-backstop-guard.ts";

const backstop: SilentBackstop = {
  logger: "storage.v2",
  key: "conflict-read-repair-timeout",
  meaning: "the read-repair wait gave up",
};

describe("silent-backstop-guard", () => {
  describe("installSilentBackstopGuard()", () => {
    it("fails a test whose conflict retry could only ride the read-repair backstop", async () => {
      // The fixture is a test built to ride the backstop: its cold replica
      // commits a stale read, and the manual fan-out it never flushes withholds
      // the caught-up frame the retry is gated on, so the read-repair wait in
      // `src/storage/v2.ts` ends only through `CONFLICT_READ_REPAIR_TIMEOUT_MS`.
      // Run under the package preload as the task runs a test file, it fails
      // through the guard the preload installs, and through nothing else: its
      // own assertion — the commit came back as the conflict — holds.
      const fixture = new URL(
        "./support/conflict-read-repair-backstop.fixture.ts",
        import.meta.url,
      );
      const output = await runDenoCommandWithTemporaryLock({
        root: new URL("../../../", import.meta.url).pathname,
        cwd: new URL("../", import.meta.url).pathname,
        args: (tempLock) => [
          "test",
          "--no-check",
          "--lock",
          tempLock,
          "--frozen=true",
          "--preload=test/clock-preload.ts",
          "--allow-ffi",
          "--allow-env",
          "--allow-read",
          "--allow-write=/tmp,/var/folders",
          fixture.pathname,
        ],
        env: { ENV: "test" },
      });
      const transcript = `${new TextDecoder().decode(output.stdout)}\n${
        new TextDecoder().decode(output.stderr)
      }`;
      expect(
        output.success,
        `the fixture passed: the backstop carried it silently\n${transcript}`,
      ).toBe(false);
      expect(transcript).toContain("silent backstop fired during this test");
      expect(transcript).toContain(
        'storage.v2 "conflict-read-repair-timeout" fired 1 time',
      );
      expect(transcript).not.toContain("AssertionError");
    });
  });

  describe("firedBackstops()", () => {
    const key = `${backstop.logger}\0${backstop.key}`;

    it("returns nothing for a count that did not move", () => {
      expect(
        firedBackstops([backstop], new Map([[key, 3]]), new Map([[key, 3]])),
      ).toEqual([]);
    });

    it("returns the backstop with how many times it fired", () => {
      expect(
        firedBackstops([backstop], new Map([[key, 3]]), new Map([[key, 5]])),
      ).toEqual([{ backstop, fired: 2 }]);
    });

    it("returns nothing for a backstop no logger has counted yet", () => {
      expect(firedBackstops([backstop], new Map(), new Map())).toEqual([]);
    });
  });

  describe("describeFiredBackstops()", () => {
    it("returns the backstop, its count, and its meaning", () => {
      const message = describeFiredBackstops([{ backstop, fired: 2 }]);
      expect(message).toContain("silent backstop fired during this test");
      expect(message).toContain(
        'storage.v2 "conflict-read-repair-timeout" fired 2 times',
      );
      expect(message).toContain(backstop.meaning);
    });
  });
});
