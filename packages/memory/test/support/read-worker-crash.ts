/**
 * The read worker `v2/sqlite/read-worker.ts`, except that it throws on a read
 * of {@link CRASHING_READ}, standing in for a worker that dies while it runs
 * one.
 */

import "../../v2/sqlite/read-worker.ts";
import type { ReadWorkerRequest } from "../../v2/sqlite/read-worker-protocol.ts";

/** The statement this worker dies reading; the pool's test names it too. */
const CRASHING_READ = "SELECT 'crash'";

// The worker module installed its handler and announced itself as it was
// evaluated, and a message is delivered only once this module's evaluation
// has finished, so every request reaches the wrapper.
const handle = self.onmessage;
self.onmessage = (event: MessageEvent<ReadWorkerRequest>) => {
  if (event.data.type === "query" && event.data.sql === CRASHING_READ) {
    throw new Error("the read worker crashed");
  }
  handle?.call(self, event);
};
