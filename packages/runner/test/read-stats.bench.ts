/** Measures read accounting overhead for a full reduction of linked rows. */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { startReadStats } from "../src/read-stats.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("read-stats-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});
const write = runtime.edit();
const rows = runtime.getCell<{ n: number }[]>(signer.did(), "rows", {
  type: "array",
  items: { type: "object", properties: { n: { type: "number" } } },
}, write);
rows.set(Array.from({ length: 1000 }, (_, n) => ({ n })));
await write.commit();
await storageManager.synced();

for (const enabled of [false, true]) {
  Deno.bench({
    name: enabled ? "read accounting enabled" : "read accounting disabled",
    group: "reduce 1000 linked rows",
    baseline: !enabled,
    fn() {
      const tx = runtime.edit();
      tx.markLazyMaterialize();
      const finish = enabled ? startReadStats(tx) : undefined;
      try {
        const total = rows.withTx(tx).get().reduce(
          (sum, row) => sum + row.n,
          0,
        );
        if (total !== 499500) throw new Error("Unexpected reduction result");
      } finally {
        finish?.(0);
        tx.abort();
      }
    },
  });
}
