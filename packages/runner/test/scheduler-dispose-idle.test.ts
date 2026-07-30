/**
 * `idle()` on a disposed scheduler, and the teardown that depends on it.
 *
 * `execute()` returns immediately once the scheduler is disposed, and it is the
 * only thing that drains `idlePromises`. So every park on that list — whether
 * it happened before dispose or is requested after — is a park forever unless
 * dispose accounts for it. `Runtime.dispose()` awaits `scheduler.idle()` twice,
 * which is how that became a hang rather than a leak for any caller that had
 * already quiesced the scheduler by hand.
 *
 * Deliberately no wall-clock bound on the awaits below: the failure being
 * pinned IS "this never resolves", so a hung test is the faithful report of it,
 * and a bound whose early fire fails a healthy run is the thing
 * docs/development/waiting-in-tests.md tells you not to add.
 */

import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("scheduler dispose idle");

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => new Runtime({ apiUrl: new URL(import.meta.url), storageManager });

/**
 * Leaves the scheduler with work it will never get to run: an effect
 * subscription queues execution, so `scheduled` is set and `idle()` takes a
 * parking branch rather than the "nothing to do" one.
 */
const subscribeIdleBlockingEffect = (runtime: Runtime): void => {
  const action: Action = () => {};
  runtime.scheduler.subscribe(
    action,
    { reads: [], shallowReads: [], writes: [] },
    { isEffect: true, debounce: 50 },
  );
};

describe("scheduler.dispose() and idle()", () => {
  it("resolves an idle() requested after dispose", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      subscribeIdleBlockingEffect(runtime);
      runtime.scheduler.dispose();

      // Verified by mutation: without the disposed branch in waitForQuiescence
      // this never settles, and it is the FIRST case to go red — dispose
      // draining the parked list cannot reach an idle() that has not been
      // requested yet.
      await runtime.scheduler.idle();
    } finally {
      // The full teardown, which the case below is what makes possible.
      await runtime.dispose();
    }
  });

  it("resolves an idle() already parked when dispose arrives", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      subscribeIdleBlockingEffect(runtime);
      const parked = runtime.scheduler.idle();
      runtime.scheduler.dispose();

      // The waiter above was pushed BEFORE dispose, so the branch that covers
      // the previous case cannot reach it — only dispose draining the list can.
      // Verified by mutation: dropping that drain reds this case with the
      // previous one still passing, which is what keeps the two mechanisms
      // separately pinned rather than one masking the other.
      await parked;
    } finally {
      // The full teardown, which the case below is what makes possible.
      await runtime.dispose();
    }
  });

  it("lets Runtime.dispose() compose with an already-disposed scheduler", async () => {
    // The end-to-end shape, and the reason the two cases above are worth
    // pinning: a test that quiesced the scheduler by hand could not then run
    // the real teardown, so it closed storage directly and skipped
    // `patternUpdater.dispose()`, `settlePointerCommits()` and `popFrame()`.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    subscribeIdleBlockingEffect(runtime);
    runtime.scheduler.dispose();

    await runtime.dispose();
  });
});
