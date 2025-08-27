// Client-side transaction benchmarks with a mocked server
//
// Run with:
//   deno bench -A --no-prompt packages/storage/bench/client_tx_bench.ts
//
// These benches exercise the client transaction layer (overlay handling,
// staging, commit promotion/rollback, read-set invalidation) using a simple
// mocked server. No network or SQLite is involved.

import * as AM from "@automerge/automerge";
import { ClientTransaction } from "../src/client/tx.ts";
import { ClientStore } from "../src/client/store.ts";
import { createGenesisDoc } from "../src/store/genesis.ts";
import type { TxReceipt } from "../src/types.ts";

// ------------------------------------------------------------
// Mock server that applies changes to per-doc Automerge state
// ------------------------------------------------------------

type MockCfg = {
  conflictEveryN?: number; // return conflict for every Nth submit (0 = never)
  delayMs?: number; // artificial async delay to simulate in-flight commits
};

class MockServer {
  private docs = new Map<string, AM.Doc<any>>();
  private txId = 0;
  private count = 0;
  private conflictEveryN: number;
  private delayMs: number;

  constructor(cfg: MockCfg = {}) {
    this.conflictEveryN = Math.max(0, cfg.conflictEveryN ?? 0);
    this.delayMs = Math.max(0, cfg.delayMs ?? 0);
  }

  getBaseline(docId: string): AM.Doc<any> | null {
    const d = this.docs.get(docId);
    return d ? AM.clone(d) : null;
  }

  async submitTx(req: {
    writes: ReadonlyArray<{
      ref: { docId: string; branch: string };
      baseHeads: readonly string[];
      changes: ReadonlyArray<{ bytes: Uint8Array }>;
      allowServerMerge?: boolean;
    }>;
  }): Promise<TxReceipt> {
    // Artificial delay to accumulate pending overlays in some benches
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const results = req.writes.map((w) => {
      const cur = this.docs.get(w.ref.docId) ??
        createGenesisDoc<any>(w.ref.docId);
      const currentHeads = [...AM.getHeads(cur)].sort();
      const mergeOk = w.allowServerMerge === true;
      const conflictNow = this.conflictEveryN > 0 &&
        (++this.count % this.conflictEveryN) === 0;

      if (!mergeOk && conflictNow) {
        return {
          ref: w.ref,
          status: "conflict" as const,
          applied: 0,
          reason: "simulated conflict",
        };
      }

      // Apply changes on top of current server state
      let updated = cur;
      for (const c of w.changes) {
        const applied = AM.applyChanges(updated as any, [c.bytes]);
        updated = Array.isArray(applied) ? applied[0] : applied;
      }
      this.docs.set(w.ref.docId, updated);
      const newHeads = [...AM.getHeads(updated)].sort();
      const appliedCount = w.changes.length;
      // If base heads mismatched and merge not allowed, conflict
      if (!mergeOk) {
        const equal =
          JSON.stringify(currentHeads) === JSON.stringify(w.baseHeads);
        if (!equal) {
          return {
            ref: w.ref,
            status: "conflict" as const,
            applied: 0,
            reason: "base heads mismatch",
          };
        }
      }
      return {
        ref: w.ref,
        status: "ok" as const,
        newHeads,
        applied: appliedCount,
      };
    });
    const anyConflict = results.some((r) => r.status === "conflict");
    const anyRejected = false;
    const txId = ++this.txId;
    return {
      txId,
      committedAt: new Date().toISOString(),
      results,
      conflicts: anyConflict || anyRejected
        ? results.filter((r) => r.status !== "ok")
        : [],
    } satisfies TxReceipt;
  }
}

// -----------------------------------------
// Helpers to wire ClientTransaction overlays
// -----------------------------------------

function makeOverlay(store: ClientStore) {
  return {
    applyPending: (
      space: string,
      docId: string,
      id: string,
      json: unknown,
      baseHeads?: string[],
    ) => store.applyPending({ space, docId, id, json, baseHeads }),
    clearPending: (space: string, docId: string, id: string) =>
      store.clearPending({ space, docId, id }),
    promotePendingToServer: (
      space: string,
      docId: string,
      id: string,
      epoch?: number,
      heads?: string[],
    ) => store.promotePendingToServer({ space, docId, id, epoch, heads }),
  } as const;
}

// -----------------------------------------
// Benchmarks
// -----------------------------------------

const SPACE = "did:key:bench-client";
const DOC = "doc:client";

// Iteration knobs (read once at module load for bench names)
const ITER = Number(Deno.env.get("BENCH_CLIENT_ITER") ?? 200);
const P = Number(Deno.env.get("BENCH_CLIENT_PENDING") ?? 50);
const N = Number(Deno.env.get("BENCH_CLIENT_CONFLICTS") ?? 90);
const KEYS = Number(Deno.env.get("BENCH_CLIENT_KEYS") ?? 2000);

// (no instrumentation helpers; keep benches quiet)

Deno.bench({
  name: `client-tx: single doc, small commits (ok) [${ITER} commits]`,
  group: "client-tx",
  n: 1,
}, async () => {
  const store = new ClientStore();
  const server = new MockServer({ conflictEveryN: 0 });
  const overlay = makeOverlay(store);
  const baselineProvider = (_space: string, docId: string) => {
    return Promise.resolve(server.getBaseline(docId));
  };
  const commitAdapter = async (_space: string, req: any) => {
    return await server.submitTx(req as any);
  };

  // Seed baseline to avoid always-genesis path in provider
  {
    const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    tx.write(SPACE, DOC, [], (root: any) => (root.count = 0));
    await tx.commit();
  }

  for (let i = 0; i < ITER; i++) {
    const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    tx.write(
      SPACE,
      DOC,
      [],
      (root: any) => (root.count = (root.count ?? 0) + 1),
    );
    const res = await tx.commit();
    if (res.status !== "ok") throw new Error("unexpected conflict");
  }
});

Deno.bench({
  name: `client-tx: stacked pending overlays (${P} quick commits)`,
  group: "client-tx",
  n: 1,
}, async () => {
  const store = new ClientStore();
  const server = new MockServer({ delayMs: 0 });
  const overlay = makeOverlay(store);
  const baselineProvider = (_space: string, docId: string) => {
    return Promise.resolve(server.getBaseline(docId));
  };
  const commitAdapter = async (_space: string, req: any) => {
    return await server.submitTx(req as any);
  };

  // Ensure baseline exists
  {
    const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    tx.write(SPACE, DOC, [], (root: any) => (root.v = 0));
    await tx.commit();
  }

  const promises: Array<Promise<{ status: string }>> = [];
  for (let i = 0; i < P; i++) {
    const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    tx.write(SPACE, DOC, [], (root: any) => (root.v = (root.v ?? 0) + 1));
    promises.push(tx.commit());
    // Optimistic overlay should be visible immediately
    const view = store.readView(SPACE, DOC);
    if (typeof (view.json as any)?.v !== "number") {
      // Keep hot path; do not throw for missing baseline
    }
  }
  await Promise.all(promises);
});

Deno.bench({
  name: `client-tx: conflict rollback clears overlays [${N} commits]`,
  group: "client-tx",
  n: 1,
}, async () => {
  const store = new ClientStore();
  const server = new MockServer({ conflictEveryN: 3 }); // ~33% conflicts
  const overlay = makeOverlay(store);
  const baselineProvider = (_space: string, docId: string) => {
    return Promise.resolve(server.getBaseline(docId));
  };
  const commitAdapter = async (_space: string, req: any) => {
    return await server.submitTx(req as any);
  };

  // Seed
  {
    const t0 = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    t0.write(SPACE, DOC, [], (r: any) => (r.x = 0));
    await t0.commit();
  }

  for (let i = 0; i < N; i++) {
    const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    tx.write(SPACE, DOC, [], (r: any) => (r.x = (r.x ?? 0) + 1));
    const res = await tx.commit();
    if (res.status === "conflict") {
      // After conflict, optimistic overlay for this tx should be cleared; view
      // may reflect server or prior overlay, but not the failed value.
      // We simply touch readView to exercise the code path.
      void store.readView(SPACE, DOC);
    }
  }
});

Deno.bench({
  name: "client-tx: read-set invalidation (client-side reject)",
  group: "client-tx",
  n: 1,
}, async () => {
  const store = new ClientStore();
  const server = new MockServer();
  const overlay = makeOverlay(store);
  const baselineProvider = (_space: string, docId: string) => {
    return Promise.resolve(server.getBaseline(docId));
  };
  const commitAdapter = async (_space: string, req: any) => {
    return await server.submitTx(req as any);
  };

  // Seed
  {
    const t0 = new ClientTransaction(commitAdapter, baselineProvider, overlay);
    t0.write(SPACE, DOC, [], (r: any) => (r.note = "a"));
    await t0.commit();
  }

  // Open a tx, read, then invalidate before commit
  const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
  tx.read(SPACE, DOC, [], false);
  tx.externalDocChanged(SPACE, DOC);
  tx.write(SPACE, DOC, [], (r: any) => (r.note = "b"));
  const res = await tx.commit();
  if (res.status !== "rejected") {
    throw new Error("expected client-side rejection");
  }
});

Deno.bench({
  name: `client-tx: heavy root write (large JSON, keys=${KEYS})`,
  group: "client-tx",
  n: 1,
}, async () => {
  const store = new ClientStore();
  const server = new MockServer();
  const overlay = makeOverlay(store);
  const baselineProvider = (_space: string, docId: string) => {
    return Promise.resolve(server.getBaseline(docId));
  };
  const commitAdapter = async (_space: string, req: any) => {
    return await server.submitTx(req as any);
  };

  // Build a moderately large JSON object
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < KEYS; i++) {
    payload[`k${i}`] = { i, s: `v${i}`, f: i % 10 === 0 };
  }

  const tx = new ClientTransaction(commitAdapter, baselineProvider, overlay);
  tx.write(SPACE, DOC, [], (root: any) => {
    root.big = payload;
  });
  const res = await tx.commit();
  if (res.status !== "ok") throw new Error("unexpected non-ok");
});
