import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("scope-probe");
const space = signer.did();
const sm = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: sm,
});

// An argument whose items are their own documents (links), which is what a
// real list argument looks like.
const w = runtime.edit();
runtime.getCell(space, "probe", undefined, w).set({
  items: [{ label: "a" }, { label: "b" }],
  title: "t",
});
await w.commit();

const schema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" } } },
    },
    title: { type: "string" },
  },
} as const;

const collect = (lazy: boolean) => {
  const tx = runtime.edit();
  if (lazy) tx.markLazyMaterialize(true);
  const v = runtime.getCell(space, "probe", schema, tx).get() as any;
  // Same body both ways: read everything, so the sets are comparable.
  JSON.stringify(v);
  const acts = getTransactionReadActivities(tx) ?? [];
  return {
    tx,
    set: new Set(
      acts.map((a: any) =>
        `${a.space === space ? "SELF" : a.space}|${
          a.scope ?? "space"
        }|${a.id}|${a.path.join("/")}|${a.nonRecursive ? "shallow" : "deep"}`
      ),
    ),
  };
};

const eager = collect(false);
const lazy = collect(true);
const only = (a: Set<string>, b: Set<string>) =>
  [...a].filter((x) => !b.has(x));
console.log("=== lazy-only reads:");
for (const x of only(lazy.set, eager.set)) console.log("  " + x);
console.log("=== eager-only reads:");
for (const x of only(eager.set, lazy.set)) console.log("  " + x);
console.log(`counts eager=${eager.set.size} lazy=${lazy.set.size}`);
await eager.tx.commit();
await lazy.tx.commit();
await runtime.dispose();
await sm.close();
