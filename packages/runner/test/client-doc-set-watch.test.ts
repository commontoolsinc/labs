// F4 client closure export (feed-adversarial-review FA3/FA4/FA8/FA15): behind
// the F3 doc-set watch subcapability, the client SpaceReplica exports its held
// replica doc set as an additive `docs` WatchSpec kind and demotes the steady-
// state schema-graph watches make-before-break. These tests pin the CLIENT
// contract by observing the exact watch messages the replica sends to a scripted
// server, plus flag-off byte-identity.
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type SessionSync,
  type SessionSyncRemove,
  type SessionSyncUpsert,
  setServerPrimaryExecutionConfig,
  setServerPrimaryExecutionDocSetWatchConfig,
} from "@commonfabric/memory/v2";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("client-doc-set-watch");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): { value: unknown } | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

/** A watch spec as seen on the wire — the graph kinds carry `query`, the F3
 * doc-set kind carries `docs`. */
type WireWatch = {
  id: string;
  kind: "graph" | "query" | "docs";
  query?: { roots?: Array<{ id: string }> };
  docs?: Array<{ id: string; scope?: string }>;
};
type WireWatchMessage = {
  type: string;
  requestId?: string;
  watches?: WireWatch[];
  commit?: unknown;
};

const upsert = (
  id: URI,
  seq: number,
  value: unknown,
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc: { value } as SessionSyncUpsert["doc"],
});

const fullSync = (
  toSeq: number,
  upserts: SessionSyncUpsert[],
  removes: SessionSyncRemove[] = [],
): SessionSync => ({ type: "sync", fromSeq: 0, toSeq, upserts, removes });

/**
 * Scripted server that advertises the negotiated protocol flags (the test sets
 * the ambient dials before connecting), answers a graph watch.add with the
 * root's closure, echoes a docs watch.set's members from its confirmed store,
 * accepts transacts, and records every watch registration for assertions.
 */
class DocSetWatchTransport extends ScriptedSessionTransport {
  /** Confirmed server-side docs, id -> {seq, value}. */
  readonly store = new Map<URI, { seq: number; value: unknown }>();
  /** Graph closures, root -> the doc ids delivered when it is watch.added. */
  readonly closures = new Map<URI, URI[]>();
  readonly watchAdds: WireWatch[][] = [];
  readonly watchSets: WireWatch[][] = [];
  /** Docs currently delivered through graph tracking — the real server's
   * session.entities surface, the base of the watch.set full-sync diff
   * (FW2/FB8: the scripted peer must emit the diff removes the real server
   * emits, or the demotion guards certify nothing). */
  readonly graphTracked = new Set<URI>();
  /** Current doc-set members (the real server's session.docSetMembers). */
  readonly members = new Set<URI>();
  #seq = 100;

  constructor() {
    super({ name: "doc-set-watch", sessionId: "session:doc-set-watch", space });
  }

  protected override ackServerSeq(): number {
    return 1;
  }

  /** The docs watches carried by the most recent watch.set, or undefined. */
  lastDocsWatch(): WireWatch | undefined {
    const last = this.watchSets.at(-1);
    return last?.find((watch) => watch.kind === "docs");
  }

  #closureUpserts(roots: URI[]): SessionSyncUpsert[] {
    const ids = new Set<URI>();
    for (const root of roots) {
      ids.add(root);
      for (const child of this.closures.get(root) ?? []) ids.add(child);
    }
    const out: SessionSyncUpsert[] = [];
    for (const id of ids) {
      const held = this.store.get(id);
      if (held !== undefined) out.push(upsert(id, held.seq, held.value));
    }
    return out;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    const wire = message as unknown as WireWatchMessage;
    switch (message.type) {
      case "session.watch.add": {
        const watches = wire.watches ?? [];
        this.watchAdds.push(watches);
        const roots = watches.flatMap((watch) =>
          watch.query?.roots?.map((root) => root.id as URI) ?? []
        );
        const upserts = this.#closureUpserts(roots);
        // Additive: the delivered closure joins the graph-tracked surface.
        for (const entry of upserts) this.graphTracked.add(entry.id as URI);
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: ++this.#seq,
            sync: fullSync(this.#seq, upserts),
          },
        });
        return;
      }
      case "session.watch.set": {
        if (this.holdWatchSets) {
          this.heldWatchSets.push(message);
          return;
        }
        this.processWatchSet(message);
        return;
      }
      case "transact": {
        if (this.holdTransacts) {
          this.heldTransacts.push(message);
          return;
        }
        this.#respondTransactOk(message);
        return;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  /** When set, watch.set requests are parked UNPROCESSED — the test releases
   * them with `releaseOneHeldWatchSet` / `releaseHeldWatchSets`. Processing
   * happens at RELEASE time (diffed against the then-current graph surface),
   * modeling the real server processing a replace after later traffic — a
   * demand pull's watch.add — already landed: the make-before-break race
   * window of the 2026-07-24 composed-browser finding. */
  holdWatchSets = false;
  readonly heldWatchSets: ScriptedTransportMessage[] = [];

  releaseOneHeldWatchSet(): void {
    const held = this.heldWatchSets.shift();
    if (held !== undefined) this.processWatchSet(held);
  }

  releaseHeldWatchSets(): void {
    while (this.heldWatchSets.length > 0) this.releaseOneHeldWatchSet();
  }

  protected processWatchSet(message: ScriptedTransportMessage): void {
    const wire = message as unknown as WireWatchMessage;
    const watches = wire.watches ?? [];
    this.watchSets.push(watches);
    {
      // Replace semantics, conforming to the real (FW1-fixed) server: the
      // next graph surface is the closure of the set's graph watches; docs
      // watches contribute exact member seeds, never closure expansion.
      const graphRoots = watches.flatMap((watch) =>
        watch.kind === "docs"
          ? []
          : watch.query?.roots?.map((root) => root.id as URI) ?? []
      );
      const memberIds = watches.flatMap((watch) =>
        watch.kind === "docs"
          ? watch.docs?.map((doc) => doc.id as URI) ?? []
          : []
      );
      const graphUpserts = this.#closureUpserts(graphRoots);
      const nextGraphIds = new Set(
        graphUpserts.map((entry) => entry.id as URI),
      );
      const nextMembers = new Set(memberIds);
      // The real server's full-sync diff: previously graph-tracked docs
      // absent from the next graph surface remove — UNLESS the incoming
      // set holds them as members (FW1's suppressDocSetMemberRemoves; the
      // FB1 fix). A doc in neither surface is a genuine shrink remove.
      const removes: SessionSyncRemove[] = [...this.graphTracked]
        .filter((id) => !nextGraphIds.has(id) && !nextMembers.has(id))
        .map((id) => ({ branch: "", id }));
      const seen = new Set(graphUpserts.map((entry) => entry.id));
      const memberSeeds: SessionSyncUpsert[] = [];
      for (const id of nextMembers) {
        if (seen.has(id)) continue;
        const held = this.store.get(id);
        if (held !== undefined) {
          memberSeeds.push(upsert(id, held.seq, held.value));
        }
      }
      this.graphTracked.clear();
      for (const id of nextGraphIds) this.graphTracked.add(id);
      this.members.clear();
      for (const id of nextMembers) this.members.add(id);
      this.respond({
        type: "response",
        requestId: message.requestId!,
        ok: {
          serverSeq: ++this.#seq,
          sync: fullSync(this.#seq, [...graphUpserts, ...memberSeeds], removes),
        },
      });
    }
  }

  /** When set, transact requests are parked instead of answered — the test
   * releases them with `releaseHeldTransacts` to control WHEN a commit
   * confirms or rejects relative to the membership reconciles around it. */
  holdTransacts = false;
  readonly heldTransacts: ScriptedTransportMessage[] = [];

  releaseHeldTransacts(verdict: "confirm" | "reject"): void {
    for (const held of this.heldTransacts.splice(0)) {
      if (verdict === "reject") {
        this.respond({
          type: "response",
          requestId: held.requestId!,
          error: { name: "TransactionError", message: "scripted rejection" },
        });
        continue;
      }
      this.#respondTransactOk(held);
    }
  }

  #respondTransactOk(message: ScriptedTransportMessage): void {
    const commit = message.commit as
      | { operations?: Array<{ op: string; id: URI }> }
      | undefined;
    const seq = ++this.#seq;
    for (const op of commit?.operations ?? []) {
      if (op.op !== "delete") {
        this.store.set(op.id, { seq, value: this.store.get(op.id)?.value });
      }
    }
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: {
        seq,
        branch: "",
        revisions: (commit?.operations ?? []).map((op, opIndex) => ({
          id: op.id,
          branch: "",
          seq,
          opIndex,
          commitSeq: seq,
          op: op.op,
        })),
      },
    });
  }

  /** Push an unsolicited server remove for `id` (a graph-diff retraction —
   * per FW1 the real server only emits these for docs that are NOT current
   * members, so the scripted push models a genuine surface shrink). */
  emitRemove(id: URI): void {
    this.store.delete(id);
    this.graphTracked.delete(id);
    this.emitSync(fullSync(++this.#seq, [], [{ branch: "", id }]));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("condition not reached");
};

function setUp(transport: DocSetWatchTransport) {
  const factory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create(
    { as: signer, memoryHost: new URL("memory://runner-doc-set-watch") },
    factory,
  );
  const provider = storageManager.open(space) as TestProvider;
  return { storageManager, provider };
}

const ROOT = "of:doc-set-root" as URI;
const CHILD = "of:doc-set-child" as URI;
const INTERMEDIATE = "of:doc-set-intermediate" as URI;
const LINKED = "of:doc-set-linked-target" as URI;

Deno.test("flag-on: a boot-root graph watch is demoted to doc-set membership covering the held closure", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    // The cold pull registers a subscribing graph watch (boot root).
    assert(
      transport.watchAdds.length >= 1,
      "cold pull registers a graph watch",
    );
    assert(
      transport.watchAdds.flat().every((w) => w.kind === "graph"),
      "cold discovery uses graph watches",
    );
    // The scheduled reconcile demotes it to a single docs-membership watch.
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    const docsWatch = transport.lastDocsWatch()!;
    const memberIds = new Set(docsWatch.docs?.map((d) => d.id));
    assertEquals(memberIds.has(ROOT), true, "root is a member");
    assertEquals(memberIds.has(CHILD), true, "held child closure is a member");
    // Make-before-break demotion: the replace set carries ONLY the docs watch,
    // dropping the graph watch (no graph watch survives in the same set).
    const lastSet = transport.watchSets.at(-1)!;
    assertEquals(
      lastSet.some((w) => w.kind === "graph"),
      false,
      "the graph watch is dropped in the demoting watch.set",
    );
    // Declared scope only on the wire (FA2): never a resolved scope key.
    assert(
      docsWatch.docs?.every((d) =>
        d.scope === undefined || d.scope === "space"
      ),
      "members carry declared scope only",
    );
    // FB1's client-side guard, bindable now that the transport emits the real
    // server's diff removes: the demotion must NOT evict the held closure.
    await flush();
    assertEquals(
      (provider.get(ROOT)?.value as { child?: URI })?.child,
      CHILD,
      "the held root survives its own demotion",
    );
    assertEquals(
      (provider.get(CHILD)?.value as { n?: number })?.n,
      1,
      "the held child survives its own demotion",
    );
    // Steady state, not the pull → demote → evict livelock: once the
    // demotion settles, no re-pull and no re-demotion churn.
    const addsAfter = transport.watchAdds.length;
    const setsAfter = transport.watchSets.length;
    await flush();
    assertEquals(
      transport.watchAdds.length,
      addsAfter,
      "no re-pull churn after the demotion settles",
    );
    assertEquals(
      transport.watchSets.length,
      setsAfter,
      "no re-demotion churn after the demotion settles",
    );
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-on: a speculative write target held only in the overlay is exported as a member", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { n: 1 } });
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    // Write a brand-new doc that is NEVER read — a claimed chain intermediate /
    // cross-doc backlink write target held only in the pending overlay.
    const tx = storageManager.edit();
    const write = tx.write(
      { space, id: INTERMEDIATE, type: DOCUMENT_MIME, path: ["value", "n"] },
      2,
    );
    assert(write.ok, "write applies");
    const commit = tx.commit();
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === INTERMEDIATE) ===
        true
    );
    const members = new Set(
      transport.lastDocsWatch()?.docs?.map((d) => d.id),
    );
    assertEquals(
      members.has(INTERMEDIATE),
      true,
      "the written-not-read target is a member before its commit settles",
    );
    await commit;
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-on: an unlink retraction evicts the doc in the same step and re-pulls on the next read", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === CHILD) === true
    );
    // Let the demotion fully settle (its response re-delivers the members) so
    // the unlink below is a steady-state retraction, not a race with the
    // in-flight initial registration.
    await flush();
    assertEquals(
      (provider.get(CHILD)?.value as { n?: number })?.n,
      1,
      "child is held",
    );
    const setsBefore = transport.watchSets.length;
    // The child leaves the read closure (unlink): a graph-diff remove arrives.
    transport.emitRemove(CHILD);
    // Same-step eviction: the record is gone, so a read now misses.
    await waitFor(() => provider.get(CHILD) === undefined);
    // A shrinking re-registration drops the child from the served membership.
    await waitFor(() =>
      transport.watchSets.length > setsBefore &&
      transport.lastDocsWatch()?.docs?.some((d) => d.id === CHILD) !== true
    );
    // The next read re-pulls (a fresh cold graph watch for the evicted id).
    const addsBefore = transport.watchAdds.length;
    transport.store.set(CHILD, { seq: 5, value: { n: 2 } });
    await provider.sync(CHILD, { path: [], schema: false });
    assert(
      transport.watchAdds.length > addsBefore,
      "the evicted doc re-pulls rather than reading a stale hit",
    );
    assertEquals(
      (provider.get(CHILD)?.value as { n?: number })?.n,
      2,
      "the re-pull delivers the current value",
    );
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-on: eviction hands back the runtime/manager pull latches so the traversal read path re-pulls (FB7)", async () => {
  // FA4's binding text — "any membership retraction evicts the doc from the
  // replica in the same step so the next read misses and re-pulls" — must hold
  // on the PRODUCTION read path (traversal -> reportMissingLinkTarget ->
  // Runtime.ensureLinkedDocLoaded), not just bare provider.sync. That path is
  // gated by two manager-lifetime dedup latches (Runtime.missingDocLoadKicks,
  // StorageManager #docPullKicks) whose justification — "the first pull leaves
  // a live server-side watch behind" — is exactly the invariant a membership
  // retraction breaks. If eviction does not hand both back, the re-read is
  // deduped away and the reader goes silently stale (FA4's forbidden
  // stale-hit).
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { n: 1 } });
  transport.store.set(LINKED, { seq: 1, value: { n: 1 } });
  const { storageManager, provider } = setUp(transport);
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: {
      serverPrimaryExecution: true,
      serverPrimaryExecutionDocSetWatch: true,
    },
  });
  try {
    // Engage the doc-set surface: the cold pull demotes to a docs watch.
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    await flush();

    // A traversal read misses LINKED; the missing-link kick pulls it,
    // populating BOTH lifetime dedup latches on the way.
    const link = {
      space,
      id: LINKED,
      path: [] as readonly string[],
    } as Parameters<typeof rt.ensureLinkedDocLoaded>[0];
    rt.ensureLinkedDocLoaded(link, space);
    await (storageManager.crossSpaceSettled?.() ?? Promise.resolve());
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === LINKED) === true
    );
    await flush();
    assertEquals(
      (provider.get(LINKED)?.value as { n?: number })?.n,
      1,
      "the kicked pull delivered the target",
    );

    // A membership retraction evicts LINKED from the replica (FA4 same-step)
    // and shrinks the export.
    transport.emitRemove(LINKED);
    await waitFor(() => provider.get(LINKED) === undefined);
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === LINKED) !== true
    );

    // Another device re-links LINKED: the doc exists again server-side with a
    // NEWER value ...
    transport.store.set(LINKED, { seq: 9, value: { n: 2 } });

    // ... and the reader traverses to it again. The read must miss and
    // RE-PULL. With either latch still set, no fetch is ever issued: LINKED
    // is no longer a member and no graph watch survives demotion, so nothing
    // ever delivers it — the reader renders undefined until runtime restart.
    const addsBefore = transport.watchAdds.length;
    rt.ensureLinkedDocLoaded(link, space);
    await (storageManager.crossSpaceSettled?.() ?? Promise.resolve());
    assert(
      transport.watchAdds.length > addsBefore,
      "the re-linked doc's traversal read issues a fresh pull " +
        "(no fetch = the reader goes silently stale)",
    );
    await flush();
    assertEquals(
      (provider.get(LINKED)?.value as { n?: number })?.n,
      2,
      "the re-pull delivers the current value",
    );
  } finally {
    await rt.dispose();
    await storageManager.close();
  }
});

Deno.test("flag-on: a doc the replica no longer holds leaves the export — an aged session's member set equals a fresh session's (FB27)", async () => {
  // FA8's client-side half: exported membership derives from what the replica
  // HOLDS (FA4 — confirmed AND pending/overlay layers). A record whose every
  // layer has emptied (here: a rejected commit dropping the only pending
  // overlay of a written-not-read doc) no longer holds the doc, so it must
  // leave the export within one reconcile cycle — otherwise an aged session's
  // member set grows without bound and never equals a fresh session's.
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { n: 1 } });
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    await flush();

    // Mount: while its commit is in flight the pending overlay HOLDS the
    // written-not-read doc, so it is exported (the FA4 speculative-write
    // membership the fixture above pins — that contract must stay intact).
    transport.holdTransacts = true;
    const tx = storageManager.edit();
    const write = tx.write(
      { space, id: INTERMEDIATE, type: DOCUMENT_MIME, path: ["value", "n"] },
      2,
    );
    assert(write.ok, "write applies");
    const commit = tx.commit();
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === INTERMEDIATE) ===
        true
    );

    // Release: the commit rejects, dropping the doc's only pending overlay.
    // The replica now holds nothing for it (no confirmed state, no pending).
    transport.releaseHeldTransacts("reject");
    const result = await commit;
    assert(result.error !== undefined, "the commit was rejected");

    // The released doc leaves the export within one reconcile cycle.
    await flush();
    assertEquals(
      transport.lastDocsWatch()?.docs?.some((d) => d.id === INTERMEDIATE),
      false,
      "a doc the replica no longer holds leaves the export",
    );

    // FA8 acceptance: the aged session's member set equals a fresh session's
    // for the same held set.
    const freshTransport = new DocSetWatchTransport();
    freshTransport.store.set(ROOT, { seq: 1, value: { n: 1 } });
    const fresh = setUp(freshTransport);
    try {
      await fresh.provider.sync(ROOT, { path: [], schema: false });
      await waitFor(() => freshTransport.lastDocsWatch() !== undefined);
      const memberIds = (t: DocSetWatchTransport) =>
        [...new Set(t.lastDocsWatch()?.docs?.map((d) => d.id) ?? [])].sort();
      assertEquals(
        memberIds(transport),
        memberIds(freshTransport),
        "the aged session's member set equals a fresh session's",
      );
    } finally {
      await fresh.storageManager.close();
    }
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-on: doc-set membership survives reconnect and is re-registered", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    const setsBefore = transport.watchSets.length;
    // Sever the connection; the client reconnects and re-issues its watch set
    // (which now carries the docs watch) after authoritative catch-up.
    (transport as unknown as { disconnect(): void }).disconnect();
    await waitFor(() =>
      transport.watchSets.length > setsBefore &&
      transport.lastDocsWatch()?.docs?.some((d) => d.id === CHILD) === true
    );
    assertEquals(
      transport.lastDocsWatch()?.docs?.some((d) => d.id === ROOT),
      true,
      "membership is re-registered on reconnect",
    );
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-off: the client never registers a docs watch (byte-identical to graph watches)", async () => {
  // Explicitly OFF, not `reset`: the base dial defaults ON since 2026-08-01,
  // so reset would leave this measuring "doc-set dial off" rather than the
  // flag-off arm this test is named for.
  setServerPrimaryExecutionConfig(false);
  setServerPrimaryExecutionDocSetWatchConfig(false);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await flush();
    assertEquals(
      transport.watchSets.length,
      0,
      "flag-off registers no watch.set demotion",
    );
    assertEquals(
      transport.watchAdds.flat().every((w) => w.kind === "graph"),
      true,
      "flag-off uses only graph watches",
    );
    assertEquals(
      transport.watchAdds.flat().some((w) => w.kind === "docs"),
      false,
      "flag-off never sends a docs watch",
    );
  } finally {
    await storageManager.close();
  }
});

// ---------------------------------------------------------------------------
// The 2026-07-24 composed-browser findings (first real-browser F5 engagement
// after FW6 unlocked negotiation): two client-side reconcile defects the
// clause-level tests above structurally missed because every flow here had
// settled between membership changes. Note the client session serializes
// watch MUTATIONS behind a mutex (runWatchMutation), so the race vehicle is
// PUSH-delivered closure growth (session/effect frames are not mutex-gated),
// and the reconcile-stampede symptom is queued stale-snapshot watch.sets
// draining one after another, not concurrent wire requests.
// ---------------------------------------------------------------------------

Deno.test("flag-on: push-delivered closure growth is NOT evicted by a stale-snapshot replace (make-before-break gap)", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    // Boot: closure held, demoted to a registered docs watch.
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    await flush();

    // Open the race window: the next replace's round-trip stays in flight.
    transport.holdWatchSets = true;

    // A membership change whose reconcile snapshot CANNOT include LINKED
    // (nothing has delivered it yet): an overlay write target.
    const tx = storageManager.edit();
    const write = tx.write(
      { space, id: INTERMEDIATE, type: DOCUMENT_MIME, path: ["value", "n"] },
      7,
    );
    assert(write.ok, "overlay write applies");
    const commit = tx.commit();
    await waitFor(() => transport.heldWatchSets.length >= 1);

    // Server-push closure growth lands while that replace is in flight (a
    // residual graph watch's refresh delivering a new doc): LINKED is now
    // HELD client-side but not in the in-flight snapshot, and the server's
    // graph surface tracks it.
    transport.store.set(LINKED, { seq: 50, value: { n: 42 } });
    transport.graphTracked.add(LINKED);
    transport.emitSync(fullSync(51, [upsert(LINKED, 50, { n: 42 })]));
    await waitFor(() =>
      (provider.get(LINKED)?.value as { n?: number })?.n === 42
    );

    // The stale-snapshot replace lands: its diff drops LINKED (graph-tracked,
    // not a member of THAT snapshot) — the exact frame the real FW1-fixed
    // server emits. Releasing only this one keeps any queued reconcile from
    // masking an eviction with a member reseed.
    transport.releaseOneHeldWatchSet();
    await flush();
    assertEquals(
      (provider.get(LINKED)?.value as { n?: number })?.n,
      42,
      "a held doc the registered membership merely lags is NOT evicted",
    );

    // The healing reconcile registers it as a member.
    transport.holdWatchSets = false;
    transport.releaseHeldWatchSets();
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === LINKED) === true
    );
    await commit;
  } finally {
    await storageManager.close();
  }
});

Deno.test("flag-on: a burst of membership changes coalesces into one trailing reconcile (no stale-snapshot stampede)", async () => {
  setServerPrimaryExecutionConfig(true);
  setServerPrimaryExecutionDocSetWatchConfig(true);
  const SECOND = "of:doc-set-second" as URI;
  const THIRD = "of:doc-set-third" as URI;
  const transport = new DocSetWatchTransport();
  transport.store.set(ROOT, { seq: 1, value: { child: CHILD } });
  transport.store.set(CHILD, { seq: 1, value: { n: 1 } });
  transport.closures.set(ROOT, [CHILD]);
  const { storageManager, provider } = setUp(transport);
  try {
    await provider.sync(ROOT, { path: [], schema: false });
    await waitFor(() => transport.lastDocsWatch() !== undefined);
    await flush();
    const setsAfterBoot = transport.watchSets.length;

    // First membership change: its reconcile round-trip is parked in flight.
    transport.holdWatchSets = true;
    const tx = storageManager.edit();
    const write = tx.write(
      { space, id: INTERMEDIATE, type: DOCUMENT_MIME, path: ["value", "n"] },
      7,
    );
    assert(write.ok, "overlay write applies");
    const commit = tx.commit();
    await waitFor(() => transport.heldWatchSets.length >= 1);

    // Two more membership changes while the replace is in flight. Without
    // serialization each schedules its OWN reconcile whose stale snapshot
    // drains through the watch-mutation mutex as an extra watch.set; with it
    // they latch into ONE trailing reconcile carrying the accumulated set.
    for (const [doc, value] of [[SECOND, 8], [THIRD, 9]] as const) {
      const burst = storageManager.edit();
      const burstWrite = burst.write(
        { space, id: doc, type: DOCUMENT_MIME, path: ["value", "n"] },
        value,
      );
      assert(burstWrite.ok, "burst write applies");
      await burst.commit();
      await flush();
    }

    transport.holdWatchSets = false;
    transport.releaseHeldWatchSets();
    await waitFor(() =>
      transport.lastDocsWatch()?.docs?.some((d) => d.id === THIRD) === true
    );
    await flush();
    // Boot set + the parked stale set + exactly ONE trailing coalesced set.
    assertEquals(
      transport.watchSets.length - setsAfterBoot,
      2,
      "burst changes coalesce into a single trailing watch.set",
    );
    const members = new Set(transport.lastDocsWatch()?.docs?.map((d) => d.id));
    for (const doc of [ROOT, CHILD, INTERMEDIATE, SECOND, THIRD]) {
      assertEquals(members.has(doc), true, `${doc} is a member`);
    }
    await commit;
  } finally {
    await storageManager.close();
  }
});
