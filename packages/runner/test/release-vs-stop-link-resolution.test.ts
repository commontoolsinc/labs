/**
 * Re-homed regression pin for #5388's release-vs-stop authority split.
 *
 * The original pin ("releasing a target before link resolution preserves the
 * held start") lived in `reload-rehydration-safety.test.ts`, which server-
 * execution v2 Phase 1 stage C deleted together with the persisted-observation
 * machinery the rest of that file exercised. The behavior it pins is not
 * observation-dependent: a release names only the child registration it owns,
 * so a start still resolving toward the same target must survive it without a
 * pre-resolution tombstone — where a stop() of the target invalidates that
 * held start. Only the generic scheduler test runtime is needed, so the pin
 * lives here on its own.
 */

import { expect } from "@std/expect";

import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const double = lift((input: number) => input * 2);",
      "export default pattern<{ value: number }>(({ value }) => ({",
      "  doubled: double(value),",
      "}));",
    ].join("\n"),
  }],
};

Deno.test("releasing a target before link resolution preserves the held start", async () => {
  const env = createSchedulerTestRuntime(import.meta.url, {});
  try {
    const { runtime, tx } = env;
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const input = runtime.getCell<number>(
      space,
      "pre-resolution-release-input",
      undefined,
      tx,
    );
    input.withTx(tx).set(5);
    const target = runtime.getCell<{ doubled: number }>(
      space,
      "pre-resolution-release-target",
      undefined,
      tx,
    );
    // run() gives the target a plain child registration: live in `cancels`,
    // with no independent lifetime recorded for it, so the release below
    // reaches the registration instead of declining.
    runtime.run(tx, compiled, { value: input }, target);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.cancels.size).toBe(1);

    const link = runtime.getCell<unknown>(
      space,
      "pre-resolution-release-alias",
    );
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const targetLink = target.getAsLink();
    let resolved = false;
    link.getRaw = (() =>
      resolved ? targetLink : undefined) as typeof link.getRaw;
    link.sync = (() => {
      syncStarted.resolve();
      return releaseSync.promise.then(() => {
        resolved = true;
        return link;
      });
    }) as typeof link.sync;

    const lifecycleState = runtime.runner.accessForTestingOnly;
    const start = runtime.start(link);
    await syncStarted.promise;
    // The release stops the child registration it owns, and leaves the start
    // still resolving toward the same target without a tombstone.
    runtime.runner.releaseChild(target, undefined);
    expect(runtime.runner.cancels.size).toBe(0);
    expect(
      [...lifecycleState.activeStartAttempts][0]?.preResolutionStopKeys.size,
    ).toBe(0);
    releaseSync.resolve();

    expect(await start).toBe(true);
    expect(runtime.runner.cancels.size).toBe(1);
    expect(await target.pull()).toEqual({ doubled: 10 });
    runtime.runner.stop(target);
  } finally {
    await disposeSchedulerTestRuntime(env);
  }
});
