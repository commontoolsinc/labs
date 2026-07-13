import { assertEquals } from "@std/assert";
import { SelectiveDemandWakeQueue } from "../src/executor/selective-demand-wake.ts";

Deno.test("selective demand wakes coalesce rapid stale piece batches", async () => {
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue((pieceIds) => {
    batches.push([...pieceIds]);
    return Promise.resolve();
  });

  queue.push(["space:of:b", "space:of:a"]);
  queue.push(["space:of:a"]);
  queue.push(["space:of:c"]);
  await queue.settled();

  assertEquals(batches, [[
    "space:of:a",
    "space:of:b",
    "space:of:c",
  ]]);
});

Deno.test("selective demand wakes retain commits arriving during a pull", async () => {
  const firstPull = Promise.withResolvers<void>();
  const releaseFirstPull = Promise.withResolvers<void>();
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue(async (pieceIds) => {
    batches.push([...pieceIds]);
    if (batches.length === 1) {
      firstPull.resolve();
      await releaseFirstPull.promise;
    }
  });

  queue.push(["space:of:first"]);
  await firstPull.promise;
  queue.push(["space:of:second", "space:of:second"]);
  releaseFirstPull.resolve();
  await queue.settled();

  assertEquals(batches, [
    ["space:of:first"],
    ["space:of:second"],
  ]);
});
