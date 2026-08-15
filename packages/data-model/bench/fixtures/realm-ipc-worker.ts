// The far side of a `postMessage()` benchmark: it receives a realm-encoded
// tree, does what the message asks, and acks.
//
// Lives under `fixtures/` rather than beside the benchmarks because a file
// here is neither a `*.bench.ts` nor a test, and the coverage tooling counts
// anything else under `packages/` as source a suite failed to reach.
//
// The ack carries one boolean and nothing else. What a benchmark wants to know
// is what the send and the far-side work cost, and a reply carrying any part
// of the decoded value would put a second clone of it on the return leg and
// bury exactly that.

import type { RealmEncodedValue } from "@/codec-realm/interface.ts";
import { fabricFromRealmValue } from "@/codecs.ts";

/** What a benchmark asks the far side to do with what it sent. */
export type IpcRequest = {
  /**
   * `decode` reconstructs the value; `clone` leaves it alone, so that the
   * difference between the two is the decode and nothing else.
   */
  readonly kind: "decode" | "clone";

  /** The realm-encoded tree. */
  readonly payload: RealmEncodedValue;
};

/** What the far side reports. One boolean, so the return leg costs nothing. */
export type IpcAck = {
  readonly ok: boolean;
  readonly error?: string;
};

self.onmessage = (ev: MessageEvent<IpcRequest>) => {
  const { kind, payload } = ev.data;

  try {
    if (kind === "decode") {
      // The result is dropped, but the walk has run in full: `decode()` is
      // eager, so there is no lazy remainder for dropping it to skip.
      fabricFromRealmValue(payload);
    }

    self.postMessage({ ok: true } satisfies IpcAck);
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies IpcAck,
    );
  }
};
