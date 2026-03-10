/// <cts-enable />
import { assertEquals } from "@std/assert";
import { Runtime } from "../src/runtime.ts";
import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("computed throws error", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    runtime,
  });

  const testPattern = pattern<{ input: number }>(({ input }) => {
    // deno-lint-ignore no-explicit-any
    const poisoned = (lift((val: number) => {
      if (val > 1) throw new Error("Poisoned!");
      return `got: ${val}`;
    })(input) as any).for("poisoned");

    // deno-lint-ignore no-explicit-any
    const healthy = (lift((p: string) => `healthy: ${p}`)(poisoned) as any).for(
      "healthy",
    );

    return { poisoned, healthy };
  });

  const resultCell = runtime.getCell(space, "test-instance");

  let errorCaught = false;

  const errorHandlers = (runtime.scheduler as any).errorHandlers;
  errorHandlers.add((_err: Error, _action: unknown) => {
    errorCaught = true;
  });

  // trigger computation 0
  runtime.setup(undefined, testPattern, { input: 0 }, resultCell);
  runtime.start(resultCell);

  const initial = (await resultCell.pull()) as any;
  assertEquals(initial.poisoned, "got: 0");
  assertEquals(initial.healthy, "healthy: got: 0");

  // trigger computation 1
  const argumentCell = resultCell.getArgumentCell<{ input: number }>()!;
  const tx1 = runtime.edit();
  argumentCell.withTx(tx1).set({ input: 1 });
  await tx1.commit();

  const updated1 = (await resultCell.pull()) as any;
  assertEquals(updated1.poisoned, "got: 1");
  assertEquals(updated1.healthy, "healthy: got: 1");

  // now throw error (val > 1 triggers throw in the lift)
  const tx2 = runtime.edit();
  argumentCell.withTx(tx2).set({ input: 2 });
  await tx2.commit();

  await runtime.scheduler.idle();

  // What is the value of poisoned now?
  const proxy: any = resultCell.getAsQueryResult();

  assertEquals(proxy.poisoned, undefined);
  assertEquals(proxy.healthy, undefined);

  assertEquals(errorCaught, true);

  popFrame(frame);
  await runtime.dispose();
  await storageManager.close();
});
