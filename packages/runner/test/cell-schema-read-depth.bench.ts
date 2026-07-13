/**
 * Decomposes the schema-path read cost by schema DEPTH on one unchanged doc.
 *
 * Companion to cell-set-flat-index-list.bench.ts: that bench showed schema
 * get() of an unchanged N-item list costs ~19µs/item PER READ (~63× the
 * schemaless path, no memoization). This bench answers WHERE that cost
 * lives by reading the SAME stored 1000-item list through schemas of
 * increasing depth:
 *
 *   - schemaless            → the baseline proxy path
 *   - items: true           → schema path entered, zero per-item validation
 *   - items: {type:object}  → permissive object schema (no properties)
 *   - full item schema      → every field declared
 *
 * Result shape (M-series MacBook): schemaless ~0.6ms/read; items:true
 * ~18ms/read — i.e. merely ENTERING the schema path costs ~32× even when
 * validating nothing per item; a PERMISSIVE object schema is the worst
 * case (~40ms/read, full recursive walk per element); the fully-declared
 * schema is cheaper than permissive (~28ms). Field validation is not the
 * cost — the per-node traversal machinery (tracked reads, link handling,
 * freeze-discipline checks, fresh result allocation; GC ≈ 39% of ticks
 * under profile) is. A V8 profile of the same loop bottoms out in
 * validateAndTransform → traverse → deep-freeze checkValue.
 *
 * Environment controls:
 * - SCHEMA_READ_DEPTH_N: list size, default 1000
 * - SCHEMA_READ_DEPTH_READS: get() calls per bench iteration, default 100
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench schema read depth");
const space = signer.did();

const N = Number(Deno.env.get("SCHEMA_READ_DEPTH_N") ?? "1000");
const READS = Number(Deno.env.get("SCHEMA_READ_DEPTH_READS") ?? "100");

const items = Array.from({ length: N }, (_, i) => ({
  data: {
    group: "Pages",
    id: `People/P${i % 40}/Notes/entry-${i}.md`,
    kind: "page",
    label: `entry-${i}`,
    name: `entry-${i}`,
    path: `People/P${i % 40}/Notes/entry-${i}.md`,
  },
  group: "Pages",
  label: `entry-${i}`,
  searchAliases: [`People/P${i % 40}/Notes/entry-${i}.md`],
  value: `page:People/P${i % 40}/Notes/entry-${i}.md`,
}));

const FULL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        group: { type: "string" },
        id: { type: "string" },
        kind: { type: "string" },
        label: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
      },
    },
    group: { type: "string" },
    label: { type: "string" },
    searchAliases: { type: "array", items: { type: "string" } },
    value: { type: "string" },
  },
} as const satisfies JSONSchema;

const VARIANTS: [string, JSONSchema | undefined][] = [
  ["schemaless", undefined],
  ["items:true (passthrough)", { type: "array", items: true }],
  ["items:{type:object} (permissive)", {
    type: "array",
    items: { type: "object" },
  }],
  ["full item schema", { type: "array", items: FULL_ITEM_SCHEMA }],
];

function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  return { runtime, storageManager };
}

async function seed(
  runtime: Runtime,
): Promise<IExtendedStorageTransaction> {
  const tx = runtime.edit();
  runtime.getCell<typeof items>(space, "schema-read-depth-doc", undefined, tx)
    .set(items);
  await tx.commit();
  return tx;
}

for (const [label, schema] of VARIANTS) {
  Deno.bench({
    name: `schema read depth - ${label} - get() x${READS} (${N} items)`,
    group: "schema-read-depth",
    baseline: schema === undefined,
    async fn(b) {
      const { runtime, storageManager } = setup();
      await seed(runtime);
      const cell = runtime.getCell(
        space,
        "schema-read-depth-doc",
        schema as JSONSchema | undefined,
      );
      cell.get(); // warm
      b.start();
      for (let i = 0; i < READS; i++) cell.get();
      b.end();
      await runtime.dispose();
      await storageManager.close();
    },
  });
}
