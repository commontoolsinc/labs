/**
 * The far side of a `postMessage()` benchmark: it receives what was sent, does
 * what the message asks, and acks.
 *
 * Lives under `fixtures/` rather than beside the benchmarks because a file
 * here is neither a `*.bench.ts` nor a test, and the coverage tooling counts
 * anything else under `packages/` as source a suite failed to reach.
 *
 * The ack carries one boolean and nothing else. What a benchmark wants to know
 * is what the send and the far-side work cost, and a reply carrying any part
 * of the decoded value would put a second clone of it on the return leg and
 * bury exactly that.
 */

import type { RealmEncodedValue } from "@/codec-realm/interface.ts";
import { fabricFromRealmValue } from "@/codecs.ts";

/** What a benchmark asks the far side to do with what it sent. */
export type IpcRequest = {
  /**
   * `decode` reconstructs the value; `clone` leaves it alone, so that the
   * difference between the two is the decode and nothing else. `status-quo`
   * is neither: the payload arrived unencoded, as a connection relying on
   * structured cloning alone sends it, and there is nothing for this side to
   * do -- which is the point, that being the whole of the old far side's work.
   */
  readonly kind: "decode" | "clone" | "status-quo";

  /**
   * What was sent: a realm-encoded tree for `decode` and `clone`, and the
   * bare value for `status-quo`.
   */
  readonly payload: RealmEncodedValue | unknown;
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
      fabricFromRealmValue(payload as RealmEncodedValue);
    }
    // `clone` and `status-quo` both do nothing here, for different reasons:
    // the first to isolate the decode, the second because the old far side
    // genuinely had no work to do.

    self.postMessage({ ok: true } satisfies IpcAck);
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies IpcAck,
    );
  }
};
