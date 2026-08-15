/**
 * What this format costs across the boundary it exists for: a real Deno
 * `Worker`, a real `postMessage()`, a decode on the far side, and an ack back.
 *
 * Run with:
 *
 *     deno bench --allow-read --no-check bench/codec-realm-ipc.bench.ts
 *
 * `--allow-read` because starting a `Worker` reads its module from disk.
 *
 * Every subject is measured twice, and the pair is the point. A `decode` case
 * asks the far side to reconstruct the value; a `clone` case asks it to leave
 * the tree alone and ack. Both pay the same send, the same structured clone
 * and the same return leg, so **the difference between them is the far-side
 * decode and nothing else** -- which is the number to take away, since the
 * transport underneath it is not this format's to change.
 *
 * The two together also say what fraction of a crossing this format is
 * responsible for at all. If `clone` dominates, the encoding is not where the
 * cost lives and tuning it buys little.
 *
 * One message is in flight at a time. That is what a `Deno.bench()` iteration
 * can measure -- an iteration is one round trip, so a pipeline of overlapping
 * sends would report throughput while the harness is timing latency -- and it
 * is the shape the worker IPC this format exists for actually uses.
 *
 * The sender's tree is reused across iterations rather than re-encoded.
 * `postMessage()` clones, so the far side consumes its own copy: ceding is a
 * promise to the *decoder*, and the sender is not the decoder here. Same-realm
 * that is exactly the distinction `decode()`'s contract turns on.
 */

import { realmFromFabricValue } from "../src/codecs.ts";
import type { FabricValue } from "../src/interface.ts";
import type { RealmCodecValue } from "../src/codec-realm/interface.ts";
import {
  JSON_PASS_THROUGH_OMNIBUSES,
  makeOmnibus,
  OBJECTS,
  REALM_PASS_THROUGH_OMNIBUSES,
} from "./fixtures/codec-fixtures.ts";
import type { IpcAck, IpcRequest } from "./fixtures/realm-ipc-worker.ts";

/**
 * One worker, kept for the whole run, with one message outstanding at a time.
 *
 * A fresh worker per iteration would measure worker startup, which is
 * milliseconds against microseconds of payload and would swamp everything this
 * file is trying to see.
 */
class FarSide {
  readonly #worker: Worker;
  #pending: ((ack: IpcAck) => void) | undefined;

  constructor() {
    this.#worker = new Worker(
      import.meta.resolve("./fixtures/realm-ipc-worker.ts"),
      { type: "module" },
    );

    this.#worker.onmessage = (ev: MessageEvent<IpcAck>) => {
      const settle = this.#pending;
      this.#pending = undefined;
      settle?.(ev.data);
    };
  }

  /** Sends one request and resolves when the far side acks it. */
  send(request: IpcRequest): Promise<IpcAck> {
    return new Promise((resolve) => {
      this.#pending = resolve;
      this.#worker.postMessage(request);
    });
  }

  /** Ends the run. */
  close(): void {
    this.#worker.terminate();
  }
}

const farSide = new FarSide();

/**
 * Subjects worth a crossing. Fewer than the in-realm benchmark measures: an
 * iteration here is a round trip rather than a call, so the matrix is kept to
 * the shapes that answer a different question from each other.
 */
const SUBJECTS: readonly (readonly [string, FabricValue])[] = [
  // Plain data, no codec anywhere in it. The floor.
  ["plain-000100", OBJECTS[3]![1]],
  // Only what JSON carries too, against only what cloning carries -- the same
  // pair the in-realm benchmark prices, priced again with a transport under it.
  ["json-pass-through-000100", JSON_PASS_THROUGH_OMNIBUSES[1]![1]],
  ["pass-through-000100", REALM_PASS_THROUGH_OMNIBUSES[1]![1]],
  // Every codec at once, bytes included, so the far side has real work.
  ["omnibus-000100", makeOmnibus(100)],
  // A byte payload large enough that copying it is the story.
  ["omnibus-001000", makeOmnibus(1000)],
];

/** Encoded once; `postMessage()` clones, so the far side never consumes this. */
const ENCODED: readonly (readonly [string, RealmCodecValue])[] = SUBJECTS.map(
  ([name, value]) => [name, realmFromFabricValue(value)] as const,
);

// Warm up both paths, so the first measured iteration is not paying for the
// worker's module graph or its first compile.
for (const [, payload] of ENCODED) {
  await farSide.send({ kind: "clone", payload });
  await farSide.send({ kind: "decode", payload });
}

for (const [name, payload] of ENCODED) {
  Deno.bench({
    name: `clone-only ${name}`,
    group: `ipc-${name}`,
    baseline: true,
    async fn() {
      await farSide.send({ kind: "clone", payload });
    },
  });

  Deno.bench({
    name: `decode ${name}`,
    group: `ipc-${name}`,
    async fn() {
      await farSide.send({ kind: "decode", payload });
    },
  });
}

globalThis.addEventListener("unload", () => farSide.close());
