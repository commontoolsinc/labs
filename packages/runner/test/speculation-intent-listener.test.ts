// The speculation overlay's INTENT LISTENER (server-execution v2 stage C
// design (e), RULED 2026-08-18; speculation.md §4 step 2, §5; events.md
// §5): the client watches its fired intents' stream sidecar for the
// tracked entry's own `consequenced` / `status` / `error` mark — the
// SANCTIONED value-plane carrier of the pushed commit's `consequenceOf`
// — through ONE non-reactive storage-notification listener keyed on the
// OUTSTANDING intent set, not through a schema-less whole-sidecar
// `cell.sink` (a scheduler effect that re-read every entry, followed
// payload links, and paid the CFC probe on every sidecar change:
// O(entries²) per change, the attribution's dominant client term).
//
// Pins 1–11 (design §3.4), each with its killing mutation (3 and 4 are
// folded into pin 1's step; 11 is the OFF witness), plus the pins the
// independent review of W2 added (MAJ-1, MIN-1, MIN-4 — named by
// finding):
//  1. a consequenced / dropped / errored mark on a TRACKED id retires the
//     intent (mutation: listener never installed → the intent stays
//     outstanding; the echo would linger until the watermark backstop);
//  2. a mark on an UNTRACKED id is ignored (mutation: drop the
//     outstanding-set guard);
//  3. outcome subscribers hear dropped / errored, never consequenced;
//  4. waitForIntentConsequence resolves for each terminal kind, memo
//     consumed;
//  5. per-check cost O(outstanding): 1000 consequenced entries + 1
//     outstanding → the mark's check visits ≤ 2 entries and mints ZERO
//     transactions (mutation witness: a full scan visits 1001; a
//     tx-minting check calls runtime.edit);
//  6. no scheduler effect: no `sink:…/of:stream-events:` node in the
//     graph after a fire (mutation: keep the cell.sink) — e2e;
//  7. a duplicate fire whose consequence already landed resolves AT
//     trackIntent and leaks no listener (mutation: skip the immediate
//     check);
//  8. close() releases the listener; no check runs after close (mutation:
//     forget the release);
//  9. the check runs in a MICROTASK, never inside notification dispatch
//     (mutation: act inline);
// 10. the check has run by the time `storageManager.synced()` /
//     `runtime.idle()` armed at the mark's frame resolve, and by the
//     time the mark is VISIBLE on a macrotask poll — no extra turn (the
//     timing guard, e2e; mutation: defer the check to a macrotask);
// 11. OFF byte-identity: no overlay, no listener OFF (e2e);
// MAJ-1. a re-entrant trackIntent inside an outcome callback applies
//     each retired id exactly once (mutation: gate the check on its
//     pre-loop snapshot instead of the LIVE tracked set);
// MIN-1. one notification spanning two tracked sidecars checks both
//     (mutation: record only the first wanted change per notification);
// MIN-4. the sidecar watch is re-kicked on every fire, so a transient
//     first-sync failure heals (mutation: kick once per sidecar state).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IStorageNotification,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { SpeculationOverlayDestination } from "../src/speculation/overlay-destination.ts";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  flushMicrotasks,
  scriptedIntentManager,
} from "./speculation-intent-test-utils.ts";

const SPACE = "did:key:z6MkIntentListenerSpace" as MemorySpace;
const SIDECAR = "of:stream-events:listener-a";

/** A destination over the scripted notification seam. `edit` throws and
 * counts: the intent path must never mint a transaction. */
const scriptedDestination = () => {
  const scripted = scriptedIntentManager();
  let edits = 0;
  const runtime = {
    storageManager: scripted.manager,
    edit: () => {
      edits += 1;
      throw new Error("the intent path must not mint transactions");
    },
    getCellFromLink: () => {
      throw new Error("the intent path must not build cells");
    },
  } as never;
  const destination = new SpeculationOverlayDestination(runtime);
  return { scripted, destination, edits: () => edits };
};

describe("intent listener — scripted notification seam (design (e) pins 1–5, 7–9; review pins MAJ-1, MIN-1, MIN-4)", () => {
  it("pin 1 + 3 + 4: a consequenced mark retires SILENTLY; errored and dropped marks retire AND signal; waitForIntentConsequence resolves per terminal kind (memo consumed); the listener releases with the last tracked id", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const outcomes: string[] = [];
    const unsubscribe = destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    scripted.seed(SPACE, SIDECAR, { entries: [] });

    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    destination.trackIntent(SPACE, SIDECAR, "evt-3");
    expect(destination.pendingIntentCount).toBe(3);
    // The listener is installed ONCE, and the sidecar is kept watched
    // through the schema-less selector (contract points 2(i)/2(ii)) —
    // the watch is kicked on EVERY fire (a covered watch is a replica
    // no-op; a transiently failed one is retried — review MIN-4).
    expect(destination.intentListenerInstalled).toBe(true);
    expect(scripted.subscribers.size).toBe(1);
    expect(scripted.syncs).toEqual(
      Array(3).fill(`${SPACE}\0${SIDECAR}\0space`),
    );

    // The appends land (no marks yet): the intents stay outstanding.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [
        { eventId: "evt-1", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "evt-2", stream: { id: "s", path: [] }, seq: 2 },
        { eventId: "evt-3", stream: { id: "s", path: [] }, seq: 3 },
      ];
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(3);

    // consequenced: retires silently (no outcome signal); the waiter
    // resolves `consequenced`.
    const consequenced = destination.waitForIntentConsequence(SPACE, "evt-1");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
    }, [["value", "entries", "0", "consequenced"]]);
    await flushMicrotasks();
    expect((await consequenced).kind).toBe("consequenced");
    expect(destination.pendingIntentCount).toBe(2);
    expect(outcomes).toEqual([]);

    // errored: retires AND signals; the memo is consumed by a LATE waiter.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![1].consequenced = true;
      value.entries![1].error = "boom";
    }, [
      ["value", "entries", "1", "consequenced"],
      ["value", "entries", "1", "error"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:evt-2"]);
    const errored = await destination.waitForIntentConsequence(SPACE, "evt-2");
    expect(errored).toEqual({ kind: "errored", reason: "boom" });
    // ...and consumed: a second waiter would hang (memo gone) — probe by
    // racing it against a resolved sentinel.
    const second = await Promise.race([
      destination.waitForIntentConsequence(SPACE, "evt-2"),
      Promise.resolve("still-waiting"),
    ]);
    expect(second).toBe("still-waiting");

    // dropped: retires AND signals; the LAST tracked id releases the
    // listener (contract point 5) — the subscription is gone.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![2].status = "dropped";
      value.entries![2].reason = "gone";
    }, [
      ["value", "entries", "2", "status"],
      ["value", "entries", "2", "reason"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:evt-2", "dropped:evt-3"]);
    expect(
      (await destination.waitForIntentConsequence(SPACE, "evt-3")).kind,
    ).toBe("dropped");
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentListenerInstalled).toBe(false);
    expect(scripted.subscribers.size).toBe(0);
    // ZERO transactions on the whole path.
    expect(edits()).toBe(0);

    // The refusal path (a deterministic admission refusal at discharge):
    // retires + signals without any store state, and never re-installs a
    // listener for a set that empties at once.
    destination.trackIntent(SPACE, "of:stream-events:listener-b", "evt-r");
    expect(destination.intentListenerInstalled).toBe(true);
    destination.resolveIntent(SPACE, "of:stream-events:listener-b", "evt-r", {
      kind: "refused",
      reason: "undeclared",
    });
    expect(outcomes).toEqual([
      "errored:evt-2",
      "dropped:evt-3",
      "refused:evt-r",
    ]);
    expect(destination.intentListenerInstalled).toBe(false);
    unsubscribe();
    destination.close();
  });

  it("pin 2: a mark on an UNTRACKED id is ignored — no signal, no retirement, the tracked id stays outstanding (mutation: drop the outstanding-set guard → the untracked entry's drop notice signals)", async () => {
    const { scripted, destination } = scriptedDestination();
    const outcomes: string[] = [];
    destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        { eventId: "other-1", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "mine", stream: { id: "s", path: [] }, seq: 2 },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "mine");
    // Another client's entry drops; mine is untouched.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "theirs";
    }, [["value", "entries", "0", "status"]]);
    await flushMicrotasks();
    expect(outcomes).toEqual([]);
    expect(destination.pendingIntentCount).toBe(1);
    expect(destination.intentListenerInstalled).toBe(true);
    // A mark on an untracked id in the SAME check as mine: only mine acts.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
      value.entries![1].consequenced = true;
      value.entries![1].error = "mine-failed";
    }, [
      ["value", "entries", "0", "consequenced"],
      ["value", "entries", "1", "consequenced"],
      ["value", "entries", "1", "error"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:mine"]);
    expect(destination.pendingIntentCount).toBe(0);
    destination.close();
  });

  it("pin 5: per-check cost is O(outstanding), never O(history): a sidecar with 1000 consequenced entries and ONE outstanding intent — the mark's check visits ≤ 2 entries and mints zero transactions (mutation witness: a full scan visits 1001)", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const history = Array.from({ length: 1000 }, (_, index) => ({
      eventId: `old-${index}`,
      stream: { id: "s", path: [] },
      seq: index + 1,
      consequenced: true,
    }));
    scripted.seed(SPACE, SIDECAR, { entries: history });
    // A fresh fire: the immediate check finds no entry (the append has
    // not landed) — ONE raw array walk at trackIntent, no transaction.
    destination.trackIntent(SPACE, SIDECAR, "fresh");
    const visitsAfterTrack = destination.intentCheckVisits;
    expect(destination.intentCheckCount).toBe(1);
    expect(visitsAfterTrack).toBe(1000);
    // The append lands at the tail (no index in the change path): the
    // backward scan locates it in ONE visit and stops.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries!.push({
        eventId: "fresh",
        stream: { id: "s", path: [] },
        seq: 1001,
      });
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(2);
    expect(destination.intentCheckVisits - visitsAfterTrack).toBe(1);
    expect(destination.pendingIntentCount).toBe(1);
    // The MARK arrives with its leaf path: the verified hint locates the
    // entry directly — one visit, the intent resolves, zero transactions.
    const before = destination.intentCheckVisits;
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![1000].consequenced = true;
    }, [["value", "entries", "1000", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(3);
    expect(destination.intentCheckVisits - before).toBeLessThanOrEqual(2);
    expect(destination.pendingIntentCount).toBe(0);
    expect(edits()).toBe(0);
    // A STALE hint (the index moved: a concurrent entry landed ahead of
    // ours) is verified by eventId and falls back to the tail scan —
    // still O(outstanding), never a wrong resolution.
    destination.trackIntent(SPACE, SIDECAR, "moved");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries!.push(
        { eventId: "theirs", stream: { id: "s", path: [] }, seq: 1002 },
        { eventId: "moved", stream: { id: "s", path: [] }, seq: 1003 },
      );
    }, [["value", "entries"]]);
    await flushMicrotasks();
    const beforeStale = destination.intentCheckVisits;
    scripted.deliver(SPACE, SIDECAR, (value) => {
      // The mark lands on index 1002 ("moved"); the delivered hint names
      // 1001 ("theirs") — a moved index.
      value.entries![1002].consequenced = true;
    }, [["value", "entries", "1001", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentCheckVisits - beforeStale).toBeLessThanOrEqual(3);
    destination.close();
  });

  it("pin 7: a duplicate fire whose consequence ALREADY landed resolves at trackIntent (T25) — the waiter resolves at once, no listener is installed, nothing leaks (mutation: skip the immediate check → the listener installs and the intent stays outstanding)", async () => {
    const { scripted, destination } = scriptedDestination();
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        {
          eventId: "old-1",
          stream: { id: "s", path: [] },
          seq: 1,
          consequenced: true,
        },
        {
          eventId: "dup",
          stream: { id: "s", path: [] },
          seq: 2,
          consequenced: true,
        },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "dup");
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentListenerInstalled).toBe(false);
    expect(scripted.subscribers.size).toBe(0);
    expect(
      (await destination.waitForIntentConsequence(SPACE, "dup")).kind,
    ).toBe("consequenced");
    // The sidecar was still put on watch (the stream stays subscribed).
    expect(scripted.syncs.length).toBe(1);
    // A second live intent on the same sidecar installs the listener.
    destination.trackIntent(SPACE, SIDECAR, "live");
    expect(destination.intentListenerInstalled).toBe(true);
    expect(destination.intentListenerInstallCount).toBe(1);
    destination.close();
  });

  it("pin 8: close() releases the listener and no check runs after it (mutation: forget the release → the subscription survives and a later delivery still checks)", async () => {
    const { scripted, destination } = scriptedDestination();
    scripted.seed(SPACE, SIDECAR, { entries: [] });
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    expect(scripted.subscribers.size).toBe(1);
    const checksBefore = destination.intentCheckCount;
    // A delivery already dispatched (its microtask pending) when close()
    // runs must not check either.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [{
        eventId: "evt-1",
        stream: { id: "s", path: [] },
        seq: 1,
        consequenced: true,
      }];
    }, [["value", "entries"]]);
    destination.close();
    await flushMicrotasks();
    expect(scripted.subscribers.size).toBe(0);
    expect(destination.intentCheckCount).toBe(checksBefore);
    // Nothing after close subscribes or checks.
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    await flushMicrotasks();
    expect(scripted.subscribers.size).toBe(0);
    expect(destination.intentCheckCount).toBe(checksBefore);
  });

  it("pin 9: the check runs in a MICROTASK, never inside the notification dispatch — a subscriber's outcome callback observes no dispatch on the stack; the intent is still outstanding when `next` returns (mutation: act inline → the callback runs mid-dispatch)", async () => {
    const { scripted, destination } = scriptedDestination();
    let sawDispatching: boolean | undefined;
    destination.subscribeIntentOutcomes(() => {
      sawDispatching = scripted.dispatching();
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [{ eventId: "evt-1", stream: { id: "s", path: [] }, seq: 1 }],
    });
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "late";
    }, [["value", "entries", "0", "status"]]);
    // Synchronously after dispatch: nothing acted yet.
    expect(destination.pendingIntentCount).toBe(1);
    expect(sawDispatching).toBeUndefined();
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    expect(sawDispatching).toBe(false);
    // A burst of notifications coalesces into ONE check per sidecar.
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    const checks = destination.intentCheckCount;
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "eventWatermark"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(checks + 1);
    // A storage RESET re-checks every tracked sidecar in the space (the
    // doc may have been re-populated), still off the dispatch stack.
    scripted.reset(SPACE);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(checks + 2);
    destination.close();
  });

  it("review MAJ-1: a RE-ENTRANT trackIntent inside an outcome callback (a retry-on-drop UI subscriber re-firing on the same sidecar) applies each retired id exactly ONCE — the outer check re-reads the LIVE tracked set per entry, never its pre-loop snapshot (mutation: gate `consider` on the snapshot only → `dropped:X` is delivered twice and a stale memo is left behind)", async () => {
    const { scripted, destination } = scriptedDestination();
    const outcomes: string[] = [];
    const consequences: Array<Promise<{ kind: string }>> = [];
    let refired = false;
    destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
      // The UI hook events.md §5 mandates, consuming the memo as it
      // hears the outcome (the send path's durable-ack coupling does
      // exactly this) ...
      consequences.push(
        destination.waitForIntentConsequence(outcome.space, outcome.eventId),
      );
      // ... and re-firing ONCE on the first drop: a fresh intent on the
      // SAME sidecar, whose `trackIntent` runs an INNER immediate check
      // while the OUTER check is still iterating its hinted indices.
      if (!refired) {
        refired = true;
        destination.trackIntent(SPACE, SIDECAR, "retry");
      }
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        { eventId: "X", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "Z", stream: { id: "s", path: [] }, seq: 2 },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "X");
    destination.trackIntent(SPACE, SIDECAR, "Z");
    expect(destination.pendingIntentCount).toBe(2);
    // ONE notification marks both dropped; the hints name Z first, then
    // X — so the outer check retires Z, the subscriber re-fires, the
    // inner check retires X from the tail, and the outer check then
    // reaches its hint for X with X already retired.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "x-gone";
      value.entries![1].status = "dropped";
      value.entries![1].reason = "z-gone";
    }, [
      ["value", "entries", "1", "status"],
      ["value", "entries", "0", "status"],
    ]);
    await flushMicrotasks();
    // Exactly one outcome per retired id, in retirement order.
    expect(outcomes).toEqual(["dropped:Z", "dropped:X"]);
    // Only the retry is outstanding; the listener stays for it.
    expect(destination.pendingIntentCount).toBe(1);
    expect(destination.intentListenerInstalled).toBe(true);
    // Each consequence settled once, as the outcome said ...
    expect((await Promise.all(consequences)).map((c) => c.kind)).toEqual([
      "dropped",
      "dropped",
    ]);
    // ... and no ORPHANED memo was left by a second settle: a fresh
    // waiter for X hangs (memo consumed by the subscriber above).
    const again = await Promise.race([
      destination.waitForIntentConsequence(SPACE, "X"),
      Promise.resolve("still-waiting"),
    ]);
    expect(again).toBe("still-waiting");
    destination.close();
  });

  it("review MIN-1: ONE notification whose merged changes span TWO tracked sidecars (one frame carrying a wave commit that marks two streams this client fired) checks BOTH — each sidecar gets its own coalesced check, both intents retire (mutation: record only the first wanted change per notification → the second sidecar's intent stays outstanding until its next own change)", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const SIDECAR_B = "of:stream-events:listener-b";
    scripted.seed(SPACE, SIDECAR, {
      entries: [{ eventId: "a-1", stream: { id: "s", path: [] }, seq: 1 }],
    });
    scripted.seed(SPACE, SIDECAR_B, {
      entries: [{ eventId: "b-1", stream: { id: "t", path: [] }, seq: 1 }],
    });
    destination.trackIntent(SPACE, SIDECAR, "a-1");
    destination.trackIntent(SPACE, SIDECAR_B, "b-1");
    expect(destination.pendingIntentCount).toBe(2);
    expect(scripted.subscribers.size).toBe(1);
    const checks = destination.intentCheckCount;
    const waitA = destination.waitForIntentConsequence(SPACE, "a-1");
    const waitB = destination.waitForIntentConsequence(SPACE, "b-1");
    // One frame, one notification, changes on both docs — A's mark first
    // in the merged list, B's second.
    scripted.deliverMany(SPACE, [
      {
        id: SIDECAR,
        mutate: (value) => {
          value.entries![0].consequenced = true;
        },
        paths: [["value", "entries", "0", "consequenced"]],
      },
      {
        id: SIDECAR_B,
        mutate: (value) => {
          value.entries![0].consequenced = true;
        },
        paths: [["value", "entries", "0", "consequenced"]],
      },
    ]);
    // Nothing acts inline ...
    expect(destination.pendingIntentCount).toBe(2);
    await flushMicrotasks();
    // ... then ONE check per sidecar, and both intents are retired.
    expect(destination.intentCheckCount).toBe(checks + 2);
    expect(destination.pendingIntentCount).toBe(0);
    expect((await waitA).kind).toBe("consequenced");
    expect((await waitB).kind).toBe("consequenced");
    expect(destination.intentListenerInstalled).toBe(false);
    expect(edits()).toBe(0);
    destination.close();
  });

  it("review MIN-4: the sidecar WATCH is re-kicked on EVERY fire, not once per sidecar — a transient failure of the first `sync` (loud: `intent-watch-failed`) heals on the next trackIntent on that stream instead of leaving it unwatched until the set drains (mutation: kick only when the sidecar state is created → the second fire issues no sync)", async () => {
    const { scripted, destination } = scriptedDestination();
    const failures = () =>
      getLoggerCountsBreakdown()["speculation-overlay"]
        ?.["intent-watch-failed"]?.total ?? 0;
    const failuresBefore = failures();
    scripted.seed(SPACE, SIDECAR, { entries: [] });
    // The first fire's watch kick fails transiently (the pull errored:
    // the replica dropped its tracker entry, nothing is watching).
    scripted.failNextSync();
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    expect(scripted.syncs.length).toBe(1);
    await flushMicrotasks();
    expect(failures()).toBe(failuresBefore + 1);
    expect(destination.pendingIntentCount).toBe(1);
    // A second fire on the SAME sidecar while the first is outstanding
    // re-issues the watch (a covered watch is a replica no-op; a failed
    // one is retried here).
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    expect(scripted.syncs.length).toBe(2);
    expect(scripted.syncs[1]).toBe(`${SPACE}\0${SIDECAR}\0space`);
    await flushMicrotasks();
    expect(failures()).toBe(failuresBefore + 1);
    destination.close();
  });
});

// ─── e2e: the real replica, the real relay, a real serving side ─────────

const spaceSigner = await Identity.fromPassphrase("intent listener space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("intent listener service");
const aliceSigner = await Identity.fromPassphrase("intent listener alice");

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

const waitUntil = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

describe("intent listener — end to end (design (e) pins 6, 10, 11)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager | undefined;
  let clientRuntime: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    clientRuntime = undefined;
    clientManager = undefined;
    await server.close();
  });

  const openClient = (options: { serverExecution: boolean }) => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: options.serverExecution },
    });
    clientManager = manager;
    clientRuntime = runtime;
    return { manager, runtime };
  };

  const standUp = async (runtime: Runtime, prefix: string) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: BUMP_PATTERN }],
    }, { space });
    const argument = runtime.getCell<{ value: number }>(
      space,
      `${prefix}-arg`,
      undefined,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${prefix}-result`,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = runtime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { argument, result };
  };

  const streamEventsSinkNodes = (runtime: Runtime) =>
    runtime.scheduler.getGraphSnapshot().nodes.filter((node) =>
      node.id.startsWith("sink:") && node.id.includes("/of:stream-events:")
    );

  it("pin 6: a fire installs the listener, keeps the sidecar watched, and registers NO scheduler effect for the watch — no `sink:…/of:stream-events:` node in the graph, before or after the append lands (mutation: keep the cell.sink → a sink node appears)", async () => {
    const { manager, runtime } = openClient({ serverExecution: true });
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(runtime, "pin6");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();

    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    const overlay = runtime.speculationOverlay!;
    expect(overlay).toBeDefined();
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    await runtime.idle();
    await manager.synced();
    // The append landed durably (no serving side: nothing marks it, so
    // the intent stays outstanding and the listener stays installed).
    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    // The client keeps the stream subscribed while its intent is
    // outstanding: the sidecar doc arrives in ITS replica.
    await waitUntil(
      () =>
        ((manager.open(space).replica.getDocument(sidecarId as never, "space")
          ?.value as StreamEventsDocValue | undefined)?.entries?.length ??
          0) === 1,
      "the sidecar to arrive at the client",
    );
    await runtime.idle();
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);
    // The arrival was checked (a notification-driven check), and the
    // check located the entry in O(1) from the tail.
    expect(overlay.intentCheckCount).toBeGreaterThanOrEqual(2);
    // (e)'s second step (design §5 item 13): the EFFECTS CHANNEL watches
    // its session doc through the same listener shape — no
    // `sink:…/<effects doc>` scheduler node either (mutation: keep the
    // effects-doc cell.sink → a sink node appears).
    const channel = runtime.effectsChannel!;
    expect(channel).toBeDefined();
    expect(channel.listenerInstalled).toBe(true);
    const effectsSinkNodes = runtime.scheduler.getGraphSnapshot().nodes
      .filter((node) =>
        node.id.startsWith("sink:") &&
        node.id.includes(`/${SERVER_EXECUTION_EFFECTS_DOC_ID}/`)
      );
    expect(effectsSinkNodes.length).toBe(0);
    cancelDemand();
  });

  it("pin 10 (+1 e2e): the served mark resolves the intent through the REAL notification path — the check has run by the time `synced()` / `idle()` armed at the mark's frame resolve, and by the time the mark is visible on a macrotask poll (no extra turn), with O(1) visits on that check; the echo retires and the durable ack settles (mutation: defer the check to a macrotask)", async () => {
    const { manager, runtime } = openClient({ serverExecution: true });
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(runtime, "pin10");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();

    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const servingManager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const servingRuntime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: servingManager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: false,
          },
        });
        return {
          runtime: servingRuntime,
          dispose: async () => {
            await servingRuntime.dispose();
            await servingManager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

    let ackStatus: string | undefined;
    (result.key("bump") as unknown as {
      send(
        value: unknown,
        onCommit?: (tx: { status(): { status: string } }) => void,
      ): unknown;
    }).send({}, (ackTx) => {
      ackStatus = ackTx.status().status;
    });
    const overlay = runtime.speculationOverlay!;
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);

    await waitUntil(
      () => sidecarIdsIn(engine).length === 1,
      "the event append to land",
    );
    const sidecarId = sidecarIdsIn(engine)[0];
    const clientEntry = () =>
      (manager.open(space).replica.getDocument(sidecarId as never, "space")
        ?.value as StreamEventsDocValue | undefined)?.entries?.[0];
    // Design pin 10's statement proper (the timing regression guard,
    // since the watch left the scheduler): the check HAS RUN by the time
    // `storageManager.synced()` / `runtime.idle()` resolve after the
    // frame that carries the mark. Observed from a subscriber registered
    // AFTER the listener (the relay runs subscribers in insertion order,
    // so the listener has already queued its microtask check when this
    // one sees the same notification), which arms both barriers AT that
    // frame — their continuations must find the intent resolved
    // (mutation: defer the check to a macrotask → both read 1).
    const afterMarkFrame = new Map<string, number>();
    const probe: IStorageNotification = {
      next: (notification) => {
        if (notification.type === "reset" || afterMarkFrame.size > 0) {
          return undefined;
        }
        let touchesSidecar = false;
        for (const change of notification.changes) {
          if (change.address.id === sidecarId) touchesSidecar = true;
        }
        if (!touchesSidecar || clientEntry()?.consequenced !== true) {
          return undefined;
        }
        afterMarkFrame.set("armed", overlay.pendingIntentCount);
        manager.synced().then(() => {
          afterMarkFrame.set("synced", overlay.pendingIntentCount);
        });
        runtime.idle().then(() => {
          afterMarkFrame.set("idle", overlay.pendingIntentCount);
        });
        return undefined;
      },
    };
    manager.subscribe(probe);
    // The mark becomes VISIBLE in the client replica in some frame; the
    // predicate polls on macrotask ticks, so the frame's microtask check
    // has run by the time the predicate first reads true — the intent
    // must be resolved in the SAME read, with no further wait.
    await waitUntil(
      () => clientEntry()?.consequenced === true,
      "the consequenced mark to arrive at the client",
    );
    expect(overlay.pendingIntentCount).toBe(0);
    expect(overlay.intentListenerInstalled).toBe(false);
    await waitUntil(
      () => afterMarkFrame.has("synced") && afterMarkFrame.has("idle"),
      "the synced()/idle() barriers armed at the mark's frame",
    );
    manager.unsubscribe(probe);
    // Still outstanding INSIDE the frame's dispatch (the check never acts
    // inline — contract point 3) ...
    expect(afterMarkFrame.get("armed")).toBe(1);
    // ... and resolved by the time either barrier armed there resolves.
    expect(afterMarkFrame.get("synced")).toBe(0);
    expect(afterMarkFrame.get("idle")).toBe(0);
    // Every notified check on a one-entry sidecar is O(1).
    expect(overlay.intentCheckMaxVisits).toBeLessThanOrEqual(2);
    // No scheduler effect ever existed for the watch.
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    // The echo retired and the authoritative value renders; the durable
    // ack settled from the consequence, non-error.
    await waitUntil(
      () => overlay.entryCount(space) === 0,
      "the echo to retire",
    );
    await waitUntil(
      () => (argument.key("value").get() as number | undefined) === 1,
      "the authoritative value to render",
    );
    await waitUntil(() => ackStatus !== undefined, "the durable ack");
    expect(ackStatus).not.toBe("error");
    cancelDemand();
  });

  it("pin 11: OFF byte-identity — a flag-OFF client has no overlay and installs no listener; a fire runs the handler locally as before", async () => {
    const { manager, runtime } = openClient({ serverExecution: false });
    let subscribes = 0;
    const original = manager.subscribe.bind(manager);
    manager.subscribe = (subscription) => {
      subscribes += 1;
      original(subscription);
    };
    const { argument, result } = await standUp(runtime, "pin11");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();
    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    await runtime.idle();
    await manager.synced();
    expect(runtime.speculationOverlay).toBeUndefined();
    expect(subscribes).toBe(0);
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    await waitUntil(
      () => (argument.key("value").get() as number | undefined) === 1,
      "the local handler result",
    );
    cancelDemand();
  });
});
