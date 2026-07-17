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
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionDocSetWatchConfig,
  type SessionSync,
  type SessionSyncRemove,
  type SessionSyncUpsert,
  setServerPrimaryExecutionConfig,
  setServerPrimaryExecutionDocSetWatchConfig,
} from "@commonfabric/memory/v2";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
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
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: ++this.#seq,
            sync: fullSync(this.#seq, this.#closureUpserts(roots)),
          },
        });
        return;
      }
      case "session.watch.set": {
        const watches = wire.watches ?? [];
        this.watchSets.push(watches);
        const memberIds = watches.flatMap((watch) =>
          watch.docs?.map((doc) => doc.id as URI) ??
            watch.query?.roots?.map((root) => root.id as URI) ?? []
        );
        this.respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: ++this.#seq,
            sync: fullSync(this.#seq, this.#closureUpserts(memberIds)),
          },
        });
        return;
      }
      case "transact": {
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
        return;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  /** Push an unsolicited server remove for `id` (a graph-diff retraction). */
  emitRemove(id: URI): void {
    this.store.delete(id);
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
  resetServerPrimaryExecutionConfig();
  resetServerPrimaryExecutionDocSetWatchConfig();
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
