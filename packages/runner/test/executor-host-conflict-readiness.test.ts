import { assert, assertEquals } from "@std/assert";
import {
  installHostConflictRetryBarrier,
} from "../src/storage/v2-host-conflict-readiness.ts";

Deno.test(
  "executor host conflict readiness accepts cross-realm errors and waits for accepted commits",
  async () => {
    const originalReady = Promise.withResolvers<void>();
    const acceptedCommits = Promise.withResolvers<void>();
    const calls: string[] = [];
    const conflict = Object.assign(Object.create(null), {
      name: "ConflictError",
      readyToRetry: () => {
        calls.push("original-ready");
        return originalReady.promise;
      },
    });
    assert(!(conflict instanceof Error));

    const installed = installHostConflictRetryBarrier(conflict, {
      acceptedCommitsSettled: async () => {
        calls.push("accepted-commits");
        await acceptedCommits.promise;
      },
      markCaughtUp: () => calls.push("caught-up"),
    });
    assertEquals(installed, true);

    let settled = false;
    const ready = conflict.readyToRetry().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assertEquals(calls, ["original-ready"]);
    assertEquals(settled, false);

    originalReady.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(calls, ["original-ready", "accepted-commits"]);
    assertEquals(settled, false);

    acceptedCommits.resolve();
    await ready;
    assertEquals(calls, [
      "original-ready",
      "accepted-commits",
      "caught-up",
    ]);
  },
);
