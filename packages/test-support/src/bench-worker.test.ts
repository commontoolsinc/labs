import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { BenchWorker } from "./bench-worker.ts";

/** A far side that fails on startup, before any request can be in flight. */
const DIES_AT_ONCE =
  `data:application/javascript,throw new Error("dead on arrival");`;

/** A far side that acknowledges whatever it is sent. */
const ACKS =
  `data:application/javascript,self.onmessage=()=>self.postMessage({ok:true});`;

/** A far side that refuses whatever it is sent. */
const REFUSES =
  `data:application/javascript,self.onmessage=()=>self.postMessage({ok:false,error:"no"});`;

describe("BenchWorker", () => {
  describe("send()", () => {
    it("resolves when the far side acknowledges", async () => {
      const worker = new BenchWorker<number>(ACKS);

      try {
        await worker.send(1);
      } finally {
        worker.close();
      }
    });

    it("rejects when the far side refuses", async () => {
      const worker = new BenchWorker<number>(REFUSES);

      try {
        await expect(worker.send(1)).rejects.toThrow("Far side refused");
      } finally {
        worker.close();
      }
    });

    it("rejects rather than hanging when the far side died before the send", async () => {
      // The case a benchmark cannot survive: a worker that fails during startup
      // has no request to reject, so a failure not recorded then leaves every
      // later send waiting on an acknowledgement that cannot come. A hung
      // benchmark reports nothing at all, where a failed one reports why.
      const worker = new BenchWorker<number>(DIES_AT_ONCE);

      try {
        // Give the startup failure a turn to arrive, which is what puts the
        // send after it rather than in a race with it.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await expect(worker.send(1)).rejects.toThrow("Far side failed");
      } finally {
        worker.close();
      }
    });
  });
});
