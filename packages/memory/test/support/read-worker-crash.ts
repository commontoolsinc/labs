/**
 * A read worker that announces itself as `v2/sqlite/read-worker.ts` does, and
 * then throws on the first request it is sent, standing in for a worker that
 * dies while it runs a read.
 */

import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import type { ReadWorkerReply } from "../../v2/sqlite/read-worker-protocol.ts";

self.onmessage = () => {
  throw new Error("the read worker crashed");
};

const ready: ReadWorkerReply = {
  type: "ready",
  lifetimeLock: await holdWorkerLifetimeLock(),
};
self.postMessage(ready);
