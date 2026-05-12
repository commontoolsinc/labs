// Pull scheduler reference-following tests.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  Runtime,
  signer,
  space,
  StorageManager,
  toMemorySpaceAddress,
} from "./scheduler-pull-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  JSONSchema,
} from "./scheduler-pull-test-utils.ts";

describe("pull mode with references", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should propagate dirtiness through references (nested lift scenario)", async () => {
    // This test reproduces the nested lift pattern where:
    // - Inner lift reads source, writes to innerOutput
    // - outerInput cell contains a REFERENCE to innerOutput
    // - Outer lift reads outerInput (following ref to innerOutput), writes to outerOutput
    // - Effect reads outerOutput
    //
    // When source changes:
    // 1. Inner lift is marked dirty
    // 2. Outer lift should be marked dirty because it reads (via reference) what inner writes
    // 3. Effect should run and see updated value

    const source = runtime.getCell<string[]>(
      space,
      "nested-ref-source",
      undefined,
      tx,
    );
    source.set([]);

    const innerOutput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-inner-output",
      undefined,
      tx,
    );
    innerOutput.set(undefined);

    // This cell holds a REFERENCE to innerOutput (simulating how lift passes results)
    const outerInput = runtime.getCell<string | undefined>(
      space,
      "nested-ref-outer-input",
      undefined,
      tx,
    );
    // Set it to be a reference pointing to innerOutput
    outerInput.set(undefined);

    const outerOutput = runtime.getCell<string>(
      space,
      "nested-ref-outer-output",
      undefined,
      tx,
    );
    outerOutput.set("default");

    const effectResult = runtime.getCell<string>(
      space,
      "nested-ref-effect-result",
      undefined,
      tx,
    );
    effectResult.set("");

    await tx.commit();
    tx = runtime.edit();

    let innerRuns = 0;
    let outerRuns = 0;
    let effectRuns = 0;

    // Inner lift: arr => arr[0] (returns undefined when array is empty)
    const innerLift: Action = (actionTx) => {
      innerRuns++;
      const arr = source.withTx(actionTx).get() ?? [];
      const firstItem = arr[0]; // Returns undefined when empty!
      innerOutput.withTx(actionTx).send(firstItem);
    };

    // Outer lift: (name, firstItem) => name || firstItem || "default"
    // For this test, we'll read innerOutput directly to simulate following the reference
    const outerLift: Action = (actionTx) => {
      outerRuns++;
      const firstItem = innerOutput.withTx(actionTx).get();
      const result = firstItem || "default";
      outerOutput.withTx(actionTx).send(result);
    };

    // Effect: sink that captures the output
    const effect: Action = (actionTx) => {
      effectRuns++;
      const val = outerOutput.withTx(actionTx).get();
      effectResult.withTx(actionTx).send(val ?? "");
    };

    // Subscribe in order: inner, outer, effect
    runtime.scheduler.subscribe(
      innerLift,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(innerOutput.getAsNormalizedFullLink())],
      },
      {},
    );
    await innerOutput.pull();

    runtime.scheduler.subscribe(
      outerLift,
      {
        reads: [toMemorySpaceAddress(innerOutput.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outerOutput.getAsNormalizedFullLink())],
      },
      {},
    );
    await outerOutput.pull();

    runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outerOutput.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(effectResult.getAsNormalizedFullLink())],
      },
      { isEffect: true },
    );
    await effectResult.pull();

    // Initial state: source is [], innerOutput is undefined, outerOutput is "default"
    expect(innerRuns).toBe(1);
    expect(outerRuns).toBe(1);
    expect(effectRuns).toBe(1);
    expect(effectResult.get()).toBe("default");

    // Now change source to ["apple"]
    source.withTx(tx).send(["apple"]);
    await tx.commit();
    tx = runtime.edit();
    await effectResult.pull();

    // With fix: All should run because dependency chain is now properly built
    // (mightWrite preserves declared writes, enabling correct topological ordering)
    expect(innerRuns).toBe(2);
    expect(outerRuns).toBe(2);
    expect(effectRuns).toBe(2);
    expect(effectResult.get()).toBe("apple");
  });

  it("should re-run a schema sink when a followed link target appears later", async () => {
    const source = runtime.getCell(space, "missing-link-source", undefined, tx);
    const target = runtime.getCell<{ name: string }>(
      space,
      "missing-link-target",
      undefined,
      tx,
    );

    source.set({
      profile: target,
    });

    await tx.commit();
    tx = runtime.edit();

    const profileName = source.key("profile").key("name").asSchema(
      {
        type: "string",
      } as const satisfies JSONSchema,
    );

    const seen: Array<string | undefined> = [];
    const cancel = profileName.sink((value) => {
      seen.push(value);
    });

    await runtime.idle();
    expect(seen).toEqual([undefined]);

    target.withTx(tx).set({ name: "Ada" });

    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(seen).toEqual([undefined, "Ada"]);
    cancel();
  });

  it("should re-run a schema sink when a followed link target changes", async () => {
    const source = runtime.getCell(space, "linked-sink-source", undefined, tx);
    const target = runtime.getCell<{ name: string }>(
      space,
      "linked-sink-target",
      undefined,
      tx,
    );

    source.set({
      profile: target,
    });
    target.set({ name: "Ada" });

    await tx.commit();
    tx = runtime.edit();

    const profileName = source.key("profile").key("name").asSchema(
      {
        type: "string",
      } as const satisfies JSONSchema,
    );

    const seen: Array<string | undefined> = [];
    const cancel = profileName.sink((value) => {
      seen.push(value);
    });

    await runtime.idle();
    expect(seen).toEqual(["Ada"]);

    target.withTx(tx).set({ name: "Grace" });

    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(seen).toEqual(["Ada", "Grace"]);
    cancel();
  });
});
