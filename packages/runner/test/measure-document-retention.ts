#!/usr/bin/env deno run -A
/**
 * measure-document-retention.ts — what a space replica holds as a view pages
 *
 * Populates a space from one replica, then opens a second replica that starts
 * empty and slides a window of live subscriptions across the collection, one
 * page at a time. After each page it reports what that replica holds and how
 * much heap survives a collection.
 *
 * This is the shape of any view that pages through more data than fits on
 * screen, and it is the workload `experimentalDocumentRelease` exists for: run
 * it both ways to see what the setting is worth. Not a test — it takes a minute
 * and is run by hand. `packages/runner/test/document-release.test.ts` pins the
 * property it measures.
 *
 * Its neighbour `window-retention-probe.ts` measures a different thing, and the
 * two do not substitute for each other. That one drives a pattern projecting a
 * window over a list in a single runtime, and reports retained heap. Here the
 * reader is a second replica that has to pull what it reads, and the report is
 * the replica's own counts — documents held, identifiers watched, watch specs
 * installed. A single runtime already holds every document from having written
 * them, so it cannot show a replica gaining or shedding them.
 *
 * Usage:
 *   deno run -A --v8-flags=--expose-gc \
 *     packages/runner/test/measure-document-retention.ts \
 *     [--pages N] [--page-size N] [--release]
 *
 * `--expose-gc` is required: without it the heap column is allocation noise
 * rather than retained heap.
 */

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { URI } from "../src/storage/interface.ts";
import {
  makeSharedServer,
  openSharedServerRuntime,
} from "./shared-server-storage.ts";

const flag = (name: string): boolean => Deno.args.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const at = Deno.args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(Deno.args[at + 1]);
};

const pages = option("pages", 40);
const pageSize = option("page-size", 25);
const release = flag("release");
// deno-lint-ignore no-explicit-any
const collect = (globalThis as any).gc as (() => void) | undefined;
if (collect === undefined) {
  console.error(
    "Run with --v8-flags=--expose-gc; the heap column means nothing without it.",
  );
  Deno.exit(1);
}

const identity = await Identity.fromPassphrase("document retention measure");
const space = identity.did() as MemorySpace;
const server = makeSharedServer();

const total = pages * pageSize;
const ids = Array.from(
  { length: total },
  (_, index) => `of:row-${index}` as URI,
);

// Wide enough that retaining a row costs something measurable, so the heap
// column tracks the documents rather than the machinery around them.
const row = (index: number) => ({
  index,
  title: `Row ${index}`,
  body: "x".repeat(2048),
  tags: Array.from({ length: 16 }, (_, tag) => `tag-${index}-${tag}`),
});

console.log(`populating ${total} documents (${pages} pages of ${pageSize})`);
{
  const writer = openSharedServerRuntime(identity, server);
  for (let start = 0; start < total; start += pageSize) {
    const tx = writer.runtime.edit();
    for (let index = start; index < start + pageSize; index++) {
      writer.runtime
        .getCellFromLink({ space, id: ids[index], path: [] })
        .withTx(tx)
        .set(row(index));
    }
    await tx.commit();
  }
  await writer.runtime.settled();
  await writer.manager.synced();
  await writer.runtime.dispose();
  await writer.manager.close();
}

const reader = openSharedServerRuntime(identity, server, release);
console.log(`release=${release}`);
console.log("page\tdocs\twatched\twatches\theapMB");

for (let page = 0; page < pages; page++) {
  const cancels = ids
    .slice(page * pageSize, (page + 1) * pageSize)
    .map((id) =>
      reader.runtime.getCellFromLink({ space, id, path: [] }).sink(() => {})
    );
  await reader.runtime.settled();
  for (const cancel of cancels) cancel();
  await reader.runtime.settled();

  collect();
  collect();
  const held = reader.manager.open(space).replica.retentionStats!();
  const heapMB = (Deno.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);
  console.log(
    `${page}\t${held.documents}\t${held.watched}\t${held.watches}\t${heapMB}`,
  );
}

await reader.runtime.dispose();
await reader.manager.close();
await server.close();
