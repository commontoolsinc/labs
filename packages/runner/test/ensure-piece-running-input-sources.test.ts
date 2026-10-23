import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "ensure piece running input sources",
);
const space = signer.did();

// A handler a nested pattern defines, whose input the enclosing pattern
// derives: the event's stream belongs to the nested instance, and `doubled`
// is written only by the enclosing instance's `computed`.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "",
      "const record = handler<unknown, { doubled?: number; seen: Seen }>(",
      "  (_event, { doubled, seen }) => {",
      "    seen.set(doubled ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<",
      "  { doubled?: number; seen: Seen },",
      "  { record: Stream<unknown> }",
      ">(({ doubled, seen }) => ({ record: record({ doubled, seen }) }));",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { doubled: number; record: Stream<unknown> }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const nested = recorder({ doubled, seen: seen! });",
      "  return { doubled, record: nested.record };",
      "});",
    ].join("\n"),
  }],
};

const ARGUMENT_CAUSE = "input sources argument";
const RESULT_CAUSE = "input sources result";

describe("ensure-piece-running", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtimes: Runtime[];

  const newRuntime = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager?.close();
  });

  it("runs an event's nested handler against the input its enclosing piece derives now, not the one it derived last", async () => {
    // The first session runs the piece with `value` 1, so the store holds
    // `doubled` 2, then stops it and moves `value` to 5 with nothing running
    // to derive `doubled` again.
    const first = newRuntime();
    const compiled = await first.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const argument = first.getCell<{ value: number; seen?: number }>(
      space,
      ARGUMENT_CAUSE,
      compiled.argumentSchema,
    );
    const result = first.getCell<{ doubled: number }>(
      space,
      RESULT_CAUSE,
      compiled.resultSchema,
    );
    {
      const tx = first.edit();
      argument.withTx(tx).set({ value: 1 });
      first.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await result.pull();
    expect(result.get().doubled).toBe(2);
    const stream = result.key("record").resolveAsCell()
      .getAsNormalizedFullLink();
    first.runner.stop(result);
    {
      const tx = first.edit();
      argument.withTx(tx).key("value").set(5);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await first.idle();
    await first.storageManager.synced();

    // A second session, running nothing, takes an event on the nested
    // stream. Its handler reads `doubled` through the nested instance's
    // input, which only the enclosing instance writes.
    const second = newRuntime();
    second.scheduler.queueEvent(stream, {});
    await second.idle();

    const seen = second.getCell<{ seen?: number }>(
      space,
      ARGUMENT_CAUSE,
      { type: "object", properties: { seen: { type: "number" } } },
    );
    await seen.sync();
    expect(seen.get().seen).toBe(10);
  });
});
