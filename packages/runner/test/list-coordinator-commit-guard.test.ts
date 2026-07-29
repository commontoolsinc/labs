import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "list coordinator commit guard",
);
const space = signer.did();

type ListOp =
  | "mapWithPattern"
  | "filterWithPattern"
  | "flatMapWithPattern";

describe("a list coordinator whose first reconcile is discarded", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  function abortFirstElementSetup(): {
    restore(): void;
    aborted(): boolean;
  } {
    const originalRunChild = runtime.runner.runChild;
    let didAbort = false;
    let setups = 0;
    runtime.runner.runChild = ((
      ...args: Parameters<typeof originalRunChild>
    ) => {
      const run = Reflect.apply(originalRunChild, runtime.runner, args);
      setups++;
      if (setups === 1) {
        const childTx = args[0];
        const originalCommit = childTx.commit.bind(childTx);
        childTx.commit = (() => {
          expect(childTx.abort("abort the first element setup").error)
            .toBeUndefined();
          didAbort = true;
          return originalCommit();
        }) as typeof childTx.commit;
      }
      return run;
    }) as typeof runtime.runner.runChild;
    return {
      restore: () => {
        runtime.runner.runChild = originalRunChild;
      },
      aborted: () => didAbort,
    };
  }

  function observeDiscardedElementSetups(): {
    restore(): void;
    count(): number;
  } {
    const originalRun = runtime.runner.run;
    let discardedSetups = 0;
    runtime.runner.run = ((
      ...args: Parameters<typeof originalRun>
    ) => {
      const tx = args[0];
      if (!tx) throw new Error("Runner child setup has no transaction");
      if (!tx.addCommitCallback(() => {})) discardedSetups++;
      return Reflect.apply(originalRun, runtime.runner, args);
    }) as typeof runtime.runner.run;
    return {
      restore: () => {
        runtime.runner.run = originalRun;
      },
      count: () => discardedSetups,
    };
  }

  function injectListAppendDuringChildSetup(
    result: Cell<{ items: number[]; derived: unknown }>,
  ): {
    restore(): void;
    comparisonSetups(): number;
    injectedCommit(): Promise<unknown> | undefined;
  } {
    const originalRunChild = runtime.runner.runChild;
    let injected = false;
    let comparisonSetups = 0;
    let injectedCommit: Promise<unknown> | undefined;
    runtime.runner.runChild = ((
      ...args: Parameters<typeof originalRunChild>
    ) => {
      const tx = args[0];
      if (!tx) throw new Error("Runner child setup has no transaction");
      const ownsSettlement = tx.addCommitCallback(() => {});
      if (!ownsSettlement) comparisonSetups++;
      if (!injected && ownsSettlement) {
        injected = true;
        Promise.resolve().then(() => {
          const interloper = runtime.edit();
          result.key("items").withTx(interloper).set([3, 4]);
          injectedCommit = interloper.commit();
        });
      }
      return Reflect.apply(originalRunChild, runtime.runner, args);
    }) as typeof runtime.runner.runChild;
    return {
      restore: () => {
        runtime.runner.runChild = originalRunChild;
      },
      comparisonSetups: () => comparisonSetups,
      injectedCommit: () => injectedCommit,
    };
  }

  async function runListPattern(
    listOp: ListOp,
    opBody: (element: any) => any,
    label: string,
  ): Promise<Cell<any>> {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const operation = pattern<{ element: number }>(({ element }) =>
      lift(opBody)(element)
    );
    const parentPattern = pattern(() => {
      const items = cell<number[]>([3]);
      return {
        items,
        derived: (items as unknown as Record<string, any>)[listOp](
          operation,
          {},
        ),
      };
    });
    const setupTx = runtime.edit();
    const parent = runtime.getCell<{ items: number[]; derived: unknown }>(
      space,
      label,
      undefined,
      setupTx,
    );
    const result = runtime.run(setupTx, parentPattern, {}, parent);
    expect((await setupTx.commit()).error).toBeUndefined();
    return result;
  }

  for (
    const [name, listOp, opBody, expected] of [
      ["map", "mapWithPattern", (value: number) => value * 2, [6]],
      ["filter", "filterWithPattern", (value: number) => value > 1, [3]],
      ["flatMap", "flatMapWithPattern", (value: number) => [value, value], [
        3,
        3,
      ]],
    ] as const
  ) {
    it(`rebuilds a ${name} element and its container`, async () => {
      const abort = abortFirstElementSetup();
      try {
        const result = await runListPattern(
          listOp,
          opBody,
          `discarded first reconcile ${name}`,
        );
        const stopReading = result.key("derived").sink(() => {});
        try {
          await runtime.scheduler.idleWithPendingCommits();
          expect(abort.aborted()).toBe(true);
          expect(await result.key("derived").pull()).toEqual([...expected]);
        } finally {
          stopReading();
        }
      } finally {
        abort.restore();
      }
    });

    it(`does not start ${name} children in an idempotency comparison`, async () => {
      const discardedSetups = observeDiscardedElementSetups();
      runtime.enableIdempotencyCheck();
      try {
        const result = await runListPattern(
          listOp,
          opBody,
          `idempotency comparison ${name}`,
        );
        const stopReading = result.key("derived").sink(() => {});
        try {
          await runtime.scheduler.idleWithPendingCommits();
          expect(await result.key("derived").pull()).toEqual([...expected]);
          expect(discardedSetups.count()).toBe(0);
          expect(runtime.getIdempotencyViolations()).toEqual([]);
        } finally {
          stopReading();
        }
      } finally {
        discardedSetups.restore();
      }
    });

    it(`reconciles a ${name} append that lands before comparison`, async () => {
      const result = await runListPattern(
        listOp,
        opBody,
        `idempotency comparison source race ${name}`,
      );
      const injection = injectListAppendDuringChildSetup(result);
      runtime.enableIdempotencyCheck();
      const stopReading = result.key("derived").sink(() => {});
      try {
        await runtime.scheduler.idleWithPendingCommits();
        await injection.injectedCommit();
        await runtime.scheduler.idleWithPendingCommits();
        expect(await result.key("derived").pull()).toEqual(
          name === "flatMap"
            ? [3, 3, 4, 4]
            : name === "filter"
            ? [3, 4]
            : [6, 8],
        );
        expect(injection.comparisonSetups()).toBe(0);
        expect(runtime.getIdempotencyViolations()).toEqual([]);
      } finally {
        stopReading();
        injection.restore();
      }
    });
  }
});
