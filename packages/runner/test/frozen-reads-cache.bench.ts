/**
 * Benches the per-doc frozen-reads cache invalidation policy in the v2
 * storage transaction. The hot pattern: prime the cache by reading at K
 * sibling subtrees of a single document, then alternate {one write into
 * subtree 0} with {K-1 reads at subtrees 1..K-1}. With blanket
 * `frozenReads.clear()` every write evicts every sibling entry; with
 * prefix-aware invalidation those sibling entries survive and the post-write
 * reads stay cache hits.
 *
 * Run with:
 *   deno bench --allow-ffi --allow-env --allow-read \
 *     --allow-write=/tmp,/var/folders test/frozen-reads-cache.bench.ts
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("frozen-reads-cache-bench");
const space = signer.did();
const type = "application/json" as const;

const SUBTREE_COUNT = 16;
const ITERATIONS = 200;

const SUBTREE_KEYS = Array.from(
  { length: SUBTREE_COUNT },
  (_, i) => `sub${i}`,
);

const ID = "of:frozen-reads-cache-bench" as const;

const seedValue = () => {
  const value: Record<string, unknown> = {};
  for (const key of SUBTREE_KEYS) {
    value[key] = { count: 0, label: key };
  }
  return { value };
};

function setupPrimedTransaction() {
  const storage = StorageManager.emulate({ as: signer });
  const tx = storage.edit();

  const write = tx.write({ space, id: ID, type, path: [] }, seedValue());
  if (write.error) throw write.error;

  // Prime the per-doc cache with one read per sibling subtree.
  for (const key of SUBTREE_KEYS) {
    const r = tx.read({ space, id: ID, type, path: ["value", key] });
    if (r.error) throw r.error;
  }

  return { storage, tx };
}

Deno.bench({
  name: `frozenReads: ${ITERATIONS}x {write subtree 0; read other ${
    SUBTREE_COUNT - 1
  } siblings}`,
  baseline: true,
  async fn() {
    const { storage, tx } = setupPrimedTransaction();

    for (let i = 0; i < ITERATIONS; i++) {
      // Write into a single sibling's `.count`. Under blanket invalidation,
      // this evicts every cached sibling read. Under prefix-aware
      // invalidation, only the chain of `["value", "sub0", "count"]` is
      // dropped.
      const w = tx.write({
        space,
        id: ID,
        type,
        path: ["value", "sub0", "count"],
      }, i + 1);
      if (w.error) throw w.error;

      // Read the other siblings -- these should be cache hits under
      // prefix-aware invalidation.
      for (let k = 1; k < SUBTREE_COUNT; k++) {
        const r = tx.read({
          space,
          id: ID,
          type,
          path: ["value", SUBTREE_KEYS[k]],
        });
        if (r.error) throw r.error;
      }
    }

    await storage.close();
  },
});

Deno.bench({
  name: `frozenReads: ${ITERATIONS}x {write subtree 0; read same sibling once}`,
  async fn() {
    // Control bench: a single post-write read at a sibling. Cache-clear
    // policy still affects this (one re-traverse per write under blanket
    // invalidation, zero under prefix-aware), but the per-iteration constant
    // overhead from the write itself dominates more, so the relative
    // speedup should be smaller than the multi-sibling case above.
    const { storage, tx } = setupPrimedTransaction();

    for (let i = 0; i < ITERATIONS; i++) {
      const w = tx.write({
        space,
        id: ID,
        type,
        path: ["value", "sub0", "count"],
      }, i + 1);
      if (w.error) throw w.error;

      const r = tx.read({ space, id: ID, type, path: ["value", "sub1"] });
      if (r.error) throw r.error;
    }

    await storage.close();
  },
});
