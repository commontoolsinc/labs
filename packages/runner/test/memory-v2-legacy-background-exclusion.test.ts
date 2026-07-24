import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type {
  LegacyBackgroundExclusion,
  LegacyBackgroundExclusionStatus,
} from "@commonfabric/memory/v2";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "runner-legacy-background-exclusion",
);
const space = signer.did();
const exclusion: LegacyBackgroundExclusion = {
  version: 1,
  space,
  branch: "",
  exclusionGeneration: 7,
  holderId: "background:test",
  servicePrincipal: signer.did(),
  expiresAt: 10_000,
};
const status: LegacyBackgroundExclusionStatus = {
  exclusion,
  ready: true,
};

Deno.test("memory v2 provider forwards legacy background exclusion control", async () => {
  let sessionCreates = 0;
  const calls: unknown[] = [];
  const storage = TestStorageManager.create({
    as: signer,
    memoryHost: new URL("memory://"),
  }, {
    create() {
      sessionCreates += 1;
      return Promise.resolve({
        client: {
          serverFlags: null,
          close: () => Promise.resolve(),
        },
        session: {
          sessionId: "session:background-control",
          sessionToken: "token:background-control",
          serverSeq: 0,
          acquireLegacyBackgroundExclusion(branch: string) {
            calls.push(["acquire", branch]);
            return Promise.resolve(status);
          },
          renewLegacyBackgroundExclusion(
            branch: string,
            generation: number,
          ) {
            calls.push(["renew", branch, generation]);
            return Promise.resolve(status);
          },
          releaseLegacyBackgroundExclusion(
            branch: string,
            generation: number,
          ) {
            calls.push(["release", branch, generation]);
            return Promise.resolve(exclusion);
          },
        } as never,
      });
    },
  });

  try {
    const provider = storage.open(space);
    assertEquals(sessionCreates, 0);
    assertEquals(
      await provider.acquireLegacyBackgroundExclusion?.(""),
      status,
    );
    assertEquals(sessionCreates, 1);
    assertEquals(
      await provider.renewLegacyBackgroundExclusion?.("", 7),
      status,
    );
    assertEquals(
      await provider.releaseLegacyBackgroundExclusion?.("", 7),
      exclusion,
    );
    assertEquals(calls, [
      ["acquire", ""],
      ["renew", "", 7],
      ["release", "", 7],
    ]);
  } finally {
    await storage.close();
  }
});
