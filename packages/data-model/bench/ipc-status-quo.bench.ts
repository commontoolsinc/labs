/**
 * What the envelope encoding costs a crossing, end to end, against the
 * connection as it was.
 *
 * The other IPC benchmark isolates the far-side decode by holding everything
 * else equal. This one answers the question a reviewer actually asks: what
 * does a message cost now, against what it cost before, with `postMessage()`
 * and the receipt on the far side inside the measurement.
 *
 * Two arms, both a full round trip through a real `Worker`:
 *
 * - `status quo` posts the bare value, as a connection relying on structured
 *   cloning alone does. The far side has nothing to do; structured cloning
 *   already did all of it.
 * - `envelope` encodes, posts the encoding, and the far side decodes it.
 *
 * **The encode is inside the timed region**, unlike the other file's, because
 * it is part of what the change costs a sender. So is the decode.
 *
 * Where the two arms are not equivalent, the status quo is the lossy one and
 * the subject says so: structured cloning strips a fabric class to `{}`, so
 * `bytes` and `omnibus` under `status quo` are measuring a crossing that
 * arrives damaged. They are kept because the timing is still the timing the
 * connection had.
 *
 * Run with:
 *
 *     deno bench --allow-read --no-check bench/ipc-status-quo.bench.ts
 */

import { realmFromFabricValue } from "@/codecs.ts";
import type { FabricValue } from "@/interface.ts";
import {
  BYTES,
  makeJsonPassThroughOmnibus,
  makeObject,
  makeOmnibus,
  OBJECTS,
} from "./fixtures/codec-fixtures.ts";
import type { IpcAck, IpcRequest } from "./fixtures/realm-ipc-worker.ts";

type PendingRequest = {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
};

/** One worker for the whole run, one message outstanding at a time. */
class FarSide {
  readonly #worker: Worker;
  #pending: PendingRequest | undefined;

  constructor() {
    this.#worker = new Worker(
      import.meta.resolve("./fixtures/realm-ipc-worker.ts"),
      { type: "module" },
    );

    this.#worker.onmessage = (ev: MessageEvent<IpcAck>) => {
      const pending = this.#pending;
      this.#pending = undefined;
      if (ev.data.ok) pending?.resolve();
      else pending?.reject(new Error(`Far side refused: ${ev.data.error}`));
    };
  }

  /**
   * Sends one request and settles when the far side acks.
   *
   * @throws If the far side reports failure. An unexamined ack is what makes a
   *   benchmark measure the wrong thing silently.
   */
  send(request: IpcRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#worker.postMessage(request);
    });
  }

  close(): void {
    this.#worker.terminate();
  }
}

const farSide = new FarSide();

/**
 * A spread of payload shapes rather than sizes of one shape: what a crossing
 * costs turns on how many containers a walk visits and whether anything needs
 * encoding at all, and these differ in both.
 *
 * `lossy` marks a subject the status quo does not actually carry, so a reader
 * does not take its timing for a like-for-like comparison.
 */
const SUBJECTS: readonly (readonly [string, FabricValue, boolean])[] = [
  // A small cell value: one container, a handful of members.
  ["small record", makeObject(10), false],
  // A flat object of 100 numbers: one container, many members.
  ["flat 100 members", OBJECTS[3]![1], false],
  // ~400 containers of plain data. The shape a VDOM batch or a cell update has.
  ["nested 100 records", makeJsonPassThroughOmnibus(100), false],
  // Ten times that, for the scaling.
  ["nested 1000 records", makeJsonPassThroughOmnibus(1000), false],
  // 1 MB of bytes: one value, no containers, and the status quo loses it.
  ["1MB FabricBytes", BYTES[BYTES.length - 1]![1], true],
  // Every codec, instances included; the status quo loses those too.
  ["omnibus 100 leaves", makeOmnibus(100), true],
];

for (const [name, value, lossy] of SUBJECTS) {
  const label = lossy ? `${name} (lossy)` : name;

  Deno.bench({
    name: `status quo — ${label}`,
    group: name,
    baseline: true,
  }, async () => {
    await farSide.send({ kind: "status-quo", payload: value });
  });

  Deno.bench({ name: `envelope — ${name}`, group: name }, async () => {
    // Encoded here, inside the measurement: the send pays for it.
    await farSide.send({
      kind: "decode",
      payload: realmFromFabricValue(value),
    });
  });
}

globalThis.addEventListener("unload", () => farSide.close());
