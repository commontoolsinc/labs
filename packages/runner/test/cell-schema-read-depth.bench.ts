/**
 * Guards repeated schema-read cost across schema DEPTH on one unchanged doc.
 *
 * Each iteration seeds one list and performs one warm get() outside the timed
 * window. Explicit plain-data array schemas should then reuse that immutable
 * materialization until storage reports a change; the timed loop measures the
 * cache-hit path through schemas of increasing depth:
 *
 *   - schemaless            → the baseline proxy path
 *   - items: true           → schema path entered, zero per-item validation
 *   - items: {type:object}  → permissive object schema (no properties)
 *   - full item schema      → every field declared
 *
 * The warm read still exercises the full validateAndTransform → traverse →
 * deep-freeze path during benchmark setup. If a schema variant falls out of
 * ambient-cache eligibility, its timed result immediately returns to scaling
 * with N and schema depth.
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
