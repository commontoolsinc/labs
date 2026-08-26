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
 * Every subject is like-for-like: both arms carry the same data, so the ratio
 * between them is a cost rather than an artifact. Where the two arms need
 * different values to manage that they get them -- bytes cross as a
 * `Uint8Array` under the status quo, which structured cloning carries
 * natively, and as a `FabricBytes` under the envelope.
 *
 * A payload the status quo cannot carry at all has no place here. Timing a
 * crossing that arrives damaged against one that arrives whole produces a
 * ratio that reads as a regression and means nothing, so the instance-bearing
 * shapes are measured by the in-realm benchmarks instead.
 *
 * Run with:
 *
 *     deno bench --allow-read --no-check bench/ipc-status-quo.bench.ts
 */

import { realmFromFabricValue } from "@/codecs.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";
import type { FabricValue } from "@/interface.ts";
import {
  makeJsonPassThroughOmnibus,
  makeObject,
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
const MEGABYTE = 1024 * 1024;

/**
 * What each arm sends. `statusQuo` defaults to the same value the envelope
 * arm carries, and differs only where carrying the same data takes a different
 * shape on the old path.
 */
type Subject = {
  readonly name: string;
  readonly value: FabricValue;
  readonly statusQuo?: unknown;
};

const SUBJECTS: readonly Subject[] = [
  // A small cell value: one container, a handful of members.
  { name: "small record", value: makeObject(10) },
  // A flat object of 100 numbers: one container, many members.
  { name: "flat 100 members", value: OBJECTS[3]![1] },
  // ~400 containers of plain data. The shape a VDOM batch or a cell update has.
  { name: "nested 100 records", value: makeJsonPassThroughOmnibus(100) },
  // Ten times that, for the scaling.
  { name: "nested 1000 records", value: makeJsonPassThroughOmnibus(1000) },
  // A megabyte of bytes, carried both ways: a bare `Uint8Array` is how the
  // status quo moves bytes at all, structured cloning carrying one natively,
  // and a `FabricBytes` is how they cross now. Same bytes, both arriving.
  {
    name: "1MB of bytes",
    value: new FabricBytes(new Uint8Array(MEGABYTE)),
    statusQuo: new Uint8Array(MEGABYTE),
  },
];

for (const { name, value, statusQuo } of SUBJECTS) {
  const before = statusQuo ?? value;

  Deno.bench({
    name: `status quo — ${name}`,
    group: name,
    baseline: true,
  }, async () => {
    await farSide.send({ kind: "status-quo", payload: before });
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
