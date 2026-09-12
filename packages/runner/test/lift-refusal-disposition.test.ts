import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

type Item = { label: string };

/** A pattern whose computed reads the second row's required label. */
const PATTERN = [
  "import { computed, pattern } from 'commonfabric';",
  "type Item = { label: string };",
  "export default pattern<{ items: Item[] }, { second: string }>(",
  "  ({ items }) => ({ second: computed(() => items[1].label) }),",
  ");",
].join("\n");

describe("lift refusal disposition", () => {
  let env: SchedulerTestRuntime | undefined;

  afterEach(async () => {
    if (env !== undefined) await disposeSchedulerTestRuntime(env);
    env = undefined;
  });

  it("writes an undefined result when the body's synchronous read refuses", async () => {
    env = createSchedulerTestRuntime(import.meta.url, {
      experimental: { lazyMaterialization: true },
    });
    const { runtime, tx } = env;
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PATTERN }],
    }, { space, tx });
    const items = runtime.getCell<Item[]>(space, "items", undefined, tx);
    items.set([{ label: "a" }, { label: "bb" }]);
    const argument = runtime.getCell<{ items: unknown }>(
      space,
      "argument",
      undefined,
      tx,
    );
    argument.set({ items });
    const result = runtime.getCell<{ second?: string }>(
      space,
      "result",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, argument, result);
    await tx.commit();
    env.tx = runtime.edit();
    expect((await result.pull()).second).toBe("bb");

    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });
    const write = runtime.edit();
    items.key(1).withTx(write).set({ note: 2 } as unknown as Item);
    expect((await write.commit()).error).toBeUndefined();
    const after = await result.pull();
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();

    expect(errors).toEqual([]);
    expect(after.second).toBeUndefined();
  });
});
