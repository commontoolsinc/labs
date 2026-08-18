import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";

Deno.test("frozen interval #now keeps a restored value", async () => {
  const signer = await Identity.fromPassphrase("frozen interval now test");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    intervalNowMode: "frozen",
  });

  try {
    const intervalMs = 300_000;
    const captured = Date.UTC(2026, 6, 30, 21, 30);
    const tx = runtime.edit();
    runtime.getCell<number>(
      space,
      { wish: { now: true, interval: intervalMs } },
      undefined,
      tx,
    ).set(captured);

    const { commonfabric } = createTrustedBuilder(runtime);
    const intervalNow = commonfabric.pattern(() => ({
      now: commonfabric.wish({ query: "#now/300" }),
    }));
    const result = runtime.getCell<{ now?: { result?: number } }>(
      space,
      "frozen interval now result",
      undefined,
      tx,
    );
    runtime.run(tx, intervalNow, {}, result);
    await tx.commit();

    await result.pull();
    expect(result.key("now").get()?.result).toBe(captured);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
