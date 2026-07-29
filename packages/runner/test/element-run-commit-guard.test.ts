import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createElementRunCommitGuard } from "../src/builtins/element-run-commit-guard.ts";
import type { InitialRunGateController } from "../src/scheduler/initial-run-gate.ts";

// deno-lint-ignore-file no-explicit-any

type CommitCallback = (tx: MockTransaction, result: any) => void;

interface MockTransaction {
  commitCallbacks: CommitCallback[];
  verdictCallbacks: CommitCallback[];
  addCommitCallback(callback: CommitCallback): boolean;
  addVerdictCallback(callback: CommitCallback): void;
}

interface GateState {
  controller: InitialRunGateController;
  releases: number;
  cancellations: number;
}

interface Setup {
  guard: ReturnType<typeof createElementRunCommitGuard>;
  elementRuns: Map<string, { resultCell: any; lastIndex: number }>;
  fallbackReleases: any[];
  tracked: Promise<unknown>[];
}

function transaction(acceptSettleCallbacks = true): MockTransaction {
  const tx: MockTransaction = {
    commitCallbacks: [],
    verdictCallbacks: [],
    addCommitCallback(callback) {
      if (!acceptSettleCallbacks) return false;
      tx.commitCallbacks.push(callback);
      return true;
    },
    addVerdictCallback(callback) {
      tx.verdictCallbacks.push(callback);
    },
  };
  return tx;
}

function finish(tx: MockTransaction, error?: unknown): void {
  for (const callback of tx.verdictCallbacks) {
    callback(tx, error === undefined ? { ok: {} } : { error });
  }
  for (const callback of tx.commitCallbacks) {
    callback(tx, error === undefined ? { ok: {} } : { error });
  }
}

function sealVerdict(tx: MockTransaction, error?: unknown): void {
  for (const callback of tx.verdictCallbacks) {
    callback(tx, error === undefined ? { ok: {} } : { error });
  }
}

function gate(): GateState {
  let released = false;
  let cancelled = false;
  const callbacks = new Set<() => void>();
  const settleCallbacks = new Set<
    (status: "released" | "cancelled") => void
  >();
  const state: GateState = {
    releases: 0,
    cancellations: 0,
    controller: {
      gate: {
        isReleased: () => released,
        status: () =>
          released
            ? "released" as const
            : cancelled
            ? "cancelled" as const
            : "pending" as const,
        onRelease(callback) {
          if (released) callback();
          else if (!cancelled) callbacks.add(callback);
          return () => callbacks.delete(callback);
        },
        onSettle(callback) {
          if (released) callback("released");
          else if (cancelled) callback("cancelled");
          else settleCallbacks.add(callback);
          return () => settleCallbacks.delete(callback);
        },
      },
      release() {
        if (released || cancelled) return;
        released = true;
        state.releases++;
        for (const callback of callbacks) callback();
        callbacks.clear();
        for (const callback of settleCallbacks) callback("released");
        settleCallbacks.clear();
      },
      cancel() {
        if (released || cancelled) return;
        cancelled = true;
        state.cancellations++;
        callbacks.clear();
        for (const callback of settleCallbacks) callback("cancelled");
        settleCallbacks.clear();
      },
    },
  };
  return state;
}

function setup(onFallbackRelease?: (cell: any) => void): Setup {
  const elementRuns = new Map<
    string,
    { resultCell: any; lastIndex: number }
  >();
  const fallbackReleases: any[] = [];
  const tracked: Promise<unknown>[] = [];
  const runtime = {
    runner: {
      releaseChild: (cell: any) => {
        fallbackReleases.push(cell);
        onFallbackRelease?.(cell);
      },
    },
    storageManager: {
      trackUntilSettled: (work: Promise<unknown>) => tracked.push(work),
    },
  };
  const guard = createElementRunCommitGuard({
    runtime: runtime as any,
    elementRuns: elementRuns as any,
  });
  return { guard, elementRuns, fallbackReleases, tracked };
}

function create(
  setup: Setup,
  tx: MockTransaction,
  lastIndex = 2,
): {
  resultCell: any;
  gateState: GateState;
  releases: any[];
} {
  const resultCell: any = {};
  const gateState = gate();
  const releases: any[] = [];
  setup.elementRuns.set("k", { resultCell, lastIndex });
  setup.guard.trackPresent(tx as any, "k", resultCell, lastIndex, {
    created: true,
    release: () => {
      releases.push(resultCell);
      return true;
    },
    initialRunGate: gateState.controller,
  });
  return { resultCell, gateState, releases };
}

describe("list child transaction tracking", () => {
  it("releases a new child's initial run only after commit", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const child = create(s, tx, 3);

    expect(child.gateState.releases).toBe(0);
    expect(s.tracked).toHaveLength(1);
    sealVerdict(tx);
    expect(child.gateState.releases).toBe(0);
    finish(tx);

    expect(child.gateState.releases).toBe(1);
    expect(child.gateState.cancellations).toBe(0);
    expect(child.releases).toEqual([]);
    expect(s.elementRuns.get("k")?.lastIndex).toBe(3);
    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 3, true),
    ).toBe(false);
    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 4, true),
    ).toBe(true);
    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 4, false),
    ).toBe(false);
  });

  it("removes and releases a new run when every setup transaction fails", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const child = create(s, tx);

    finish(tx, { name: "RowLabelCommitError" });

    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.gateState.releases).toBe(0);
    expect(child.gateState.cancellations).toBe(1);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("opens the gate when another owner preserves the child start", () => {
    const s = setup();
    const tx = transaction();
    const resultCell: any = {};
    const gateState = gate();
    s.elementRuns.set("k", { resultCell, lastIndex: 2 });
    s.guard.begin(tx as any);
    s.guard.trackPresent(tx as any, "k", resultCell, 2, {
      created: true,
      release: () => false,
      initialRunGate: gateState.controller,
    });

    finish(tx, { name: "RowLabelCommitError" });

    expect(s.elementRuns.has("k")).toBe(false);
    expect(gateState.releases).toBe(1);
    expect(gateState.cancellations).toBe(0);
  });

  it("keeps a creation while a later self-contained reconcile is pending", () => {
    const s = setup();
    const first = transaction();
    const second = transaction();
    s.guard.begin(first as any);
    const child = create(s, first, 2);
    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 2, true),
    ).toBe(true);
    s.guard.begin(second as any);
    s.guard.trackPresent(second as any, "k", child.resultCell, 7);

    finish(first, { name: "ConflictError" });
    expect(s.elementRuns.has("k")).toBe(true);
    expect(child.releases).toEqual([]);
    expect(child.gateState.releases).toBe(0);

    finish(second);
    expect(s.elementRuns.get("k")?.lastIndex).toBe(7);
    expect(child.gateState.releases).toBe(1);
  });

  for (
    const errorName of [
      "ConflictError",
      "StorageTransactionInconsistent",
    ]
  ) {
    it(`reuses a new run after ${errorName}`, () => {
      const s = setup();
      const rejected = transaction();
      s.guard.begin(rejected as any);
      const child = create(s, rejected, 3);

      finish(rejected, { name: errorName });

      expect(s.elementRuns.has("k")).toBe(true);
      expect(child.gateState.releases).toBe(0);
      expect(child.gateState.cancellations).toBe(0);
      expect(child.releases).toEqual([]);
      expect(
        s.guard.needsPresentSetup("k", child.resultCell, 3, true),
      ).toBe(true);

      const committed = transaction();
      s.guard.begin(committed as any);
      s.guard.trackPresent(committed as any, "k", child.resultCell, 3);
      finish(committed);

      expect(child.gateState.releases).toBe(1);
      expect(s.elementRuns.get("k")?.lastIndex).toBe(3);
    });
  }

  it("releases a stale run after a definitive failure", () => {
    const s = setup();
    const stale = transaction();
    s.guard.begin(stale as any);
    const child = create(s, stale);
    finish(stale, { name: "ConflictError" });

    const rejected = transaction();
    s.guard.begin(rejected as any);
    s.guard.trackPresent(rejected as any, "k", child.resultCell, 2);
    finish(rejected, { name: "RowLabelCommitError" });

    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.gateState.cancellations).toBe(1);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("applies the latest successful intent when commits finish out of order", () => {
    const s = setup();
    const first = transaction();
    const second = transaction();
    s.guard.begin(first as any);
    const child = create(s, first);
    s.guard.begin(second as any);
    s.guard.trackRemoval(second as any, "k", child.resultCell);

    finish(second);
    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.gateState.cancellations).toBe(1);
    expect(child.releases).toEqual([child.resultCell]);

    finish(first);
    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.gateState.releases).toBe(0);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("updates a committed run's index only after a successful reconcile", () => {
    const s = setup();
    const createTx = transaction();
    s.guard.begin(createTx as any);
    const child = create(s, createTx, 4);
    finish(createTx);

    const rejected = transaction();
    s.guard.begin(rejected as any);
    s.guard.trackPresent(rejected as any, "k", child.resultCell, 8);
    finish(rejected, { name: "ConflictError" });
    expect(s.elementRuns.get("k")?.lastIndex).toBe(4);

    const committed = transaction();
    s.guard.begin(committed as any);
    s.guard.trackPresent(committed as any, "k", child.resultCell, 9);
    finish(committed);
    expect(s.elementRuns.get("k")?.lastIndex).toBe(9);
  });

  it("re-stages an index restored while another index remains pending", () => {
    const s = setup();
    const createTx = transaction();
    s.guard.begin(createTx as any);
    const child = create(s, createTx, 0);
    finish(createTx);

    const moved = transaction();
    s.guard.begin(moved as any);
    s.guard.trackPresent(moved as any, "k", child.resultCell, 1);

    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 0, true),
    ).toBe(true);

    const restored = transaction();
    s.guard.begin(restored as any);
    s.guard.trackPresent(restored as any, "k", child.resultCell, 0);
    finish(moved);
    finish(restored);

    expect(s.elementRuns.get("k")?.lastIndex).toBe(0);
  });

  it("releases a committed child only after its removal commits", () => {
    const s = setup();
    const createTx = transaction();
    s.guard.begin(createTx as any);
    const child = create(s, createTx);
    finish(createTx);

    const removeTx = transaction();
    s.guard.begin(removeTx as any);
    s.guard.trackRemoval(removeTx as any, "k", child.resultCell);
    expect(s.elementRuns.has("k")).toBe(true);
    finish(removeTx);

    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("keeps a committed child after a rejected removal", () => {
    const s = setup();
    const createTx = transaction();
    s.guard.begin(createTx as any);
    const child = create(s, createTx);
    finish(createTx);

    const removeTx = transaction();
    s.guard.begin(removeTx as any);
    s.guard.trackRemoval(removeTx as any, "k", child.resultCell);
    finish(removeTx, { name: "RowLabelCommitError" });

    expect(s.elementRuns.has("k")).toBe(true);
    expect(child.releases).toEqual([]);
  });

  it("settles an action abort as a rejected creation", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const child = create(s, tx);

    s.guard.abort(tx as any);
    finish(tx);

    expect(s.elementRuns.has("k")).toBe(false);
    expect(child.gateState.cancellations).toBe(1);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("allows later reconciles while an earlier commit remains pending", () => {
    const s = setup();
    const first = transaction();
    const second = transaction();

    s.guard.begin(first as any);
    s.guard.begin(second as any);

    expect(first.commitCallbacks).toHaveLength(1);
    expect(second.commitCallbacks).toHaveLength(1);
  });

  it("ignores a comparison transaction that discards settle callbacks", () => {
    const s = setup();
    const committed = transaction();
    s.guard.begin(committed as any);
    const child = create(s, committed, 2);

    const comparison = transaction(false);
    expect(s.guard.begin(comparison as any)).toBe(false);
    s.guard.trackPresent(comparison as any, "k", child.resultCell, 7);

    expect(s.tracked).toHaveLength(1);
    expect(comparison.commitCallbacks).toEqual([]);
    finish(committed);

    expect(child.gateState.releases).toBe(1);
    expect(s.elementRuns.get("k")?.lastIndex).toBe(2);
    expect(
      s.guard.needsPresentSetup("k", child.resultCell, 2, true),
    ).toBe(false);
  });

  it("cancels pending gates and releases owned children", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const child = create(s, tx);

    s.guard.cancel();
    finish(tx);

    expect(s.elementRuns.size).toBe(0);
    expect(child.gateState.cancellations).toBe(1);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("does not change a replacement run for the same key", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const child = create(s, tx);
    const replacement = { resultCell: {}, lastIndex: 7 };
    s.elementRuns.set("k", replacement);

    finish(tx, { name: "RowLabelCommitError" });

    expect(s.elementRuns.get("k")).toBe(replacement);
    expect(child.releases).toEqual([child.resultCell]);
  });

  it("settles every child when one release throws", () => {
    const s = setup();
    const tx = transaction();
    s.guard.begin(tx as any);
    const firstCell: any = {};
    const secondCell: any = {};
    const firstGate = gate();
    const secondGate = gate();
    let firstReleaseCalls = 0;
    let secondReleaseCalls = 0;
    s.elementRuns.set("first", { resultCell: firstCell, lastIndex: 0 });
    s.elementRuns.set("second", { resultCell: secondCell, lastIndex: 1 });
    s.guard.trackPresent(tx as any, "first", firstCell, 0, {
      created: true,
      release: () => {
        firstReleaseCalls++;
        if (firstReleaseCalls === 1) throw new Error("release failed");
        return true;
      },
      initialRunGate: firstGate.controller,
    });
    s.guard.trackPresent(tx as any, "second", secondCell, 1, {
      created: true,
      release: () => {
        secondReleaseCalls++;
        return true;
      },
      initialRunGate: secondGate.controller,
    });

    expect(() => finish(tx, { name: "RowLabelCommitError" })).toThrow(
      "release failed",
    );
    expect(s.elementRuns.size).toBe(0);
    expect(firstReleaseCalls).toBe(2);
    expect(secondReleaseCalls).toBe(1);
    expect(firstGate.cancellations).toBe(1);
    expect(secondGate.cancellations).toBe(1);
  });

  it("rejects unregistered and duplicate transaction tracking", () => {
    const s = setup();
    const tx = transaction();
    const resultCell: any = {};
    s.elementRuns.set("k", { resultCell, lastIndex: 0 });

    expect(() => s.guard.trackPresent(tx as any, "k", resultCell, 0)).toThrow(
      "List child change was not registered by begin()",
    );
    expect(s.guard.begin(tx as any)).toBe(true);
    expect(() => s.guard.begin(tx as any)).toThrow(
      "List coordinator registered a transaction twice",
    );
  });

  it("ignores absent and mismatched element runs", () => {
    const s = setup();
    const tx = transaction();
    const resultCell: any = {};
    const otherCell: any = {};
    s.guard.begin(tx as any);

    s.guard.trackPresent(tx as any, "missing", resultCell, 0);
    s.guard.trackRemoval(tx as any, "missing", resultCell);
    s.elementRuns.set("k", { resultCell, lastIndex: 0 });
    s.guard.trackPresent(tx as any, "k", otherCell, 0);
    s.guard.trackRemoval(tx as any, "k", otherCell);
    finish(tx);

    expect(s.elementRuns.get("k")?.resultCell).toBe(resultCell);
    expect(s.fallbackReleases).toEqual([]);
  });

  it("tracks and releases a child that predates the guard", () => {
    const s = setup();
    const resultCell: any = {};
    s.elementRuns.set("k", { resultCell, lastIndex: 4 });
    const present = transaction();
    s.guard.begin(present as any);
    s.guard.trackPresent(present as any, "k", resultCell, 7);
    finish(present);

    expect(s.elementRuns.get("k")?.lastIndex).toBe(7);

    const removal = transaction();
    s.guard.begin(removal as any);
    s.guard.trackRemoval(removal as any, "k", resultCell);
    finish(removal);

    expect(s.elementRuns.has("k")).toBe(false);
    expect(s.fallbackReleases).toEqual([resultCell]);
  });

  it("releases an old state when the registry replaces its result cell", () => {
    const s = setup();
    const first = transaction();
    s.guard.begin(first as any);
    const child = create(s, first);
    finish(first);

    const replacementCell: any = {};
    s.elementRuns.set("k", { resultCell: replacementCell, lastIndex: 9 });
    const replacement = transaction();
    s.guard.begin(replacement as any);
    s.guard.trackPresent(replacement as any, "k", replacementCell, 9);
    finish(replacement);

    expect(child.releases).toEqual([child.resultCell]);
    expect(s.elementRuns.get("k")?.resultCell).toBe(replacementCell);
  });

  it("combines failures from both child release attempts", () => {
    const s = setup();
    const tx = transaction();
    const resultCell: any = {};
    const gateState = gate();
    let releaseCalls = 0;
    s.elementRuns.set("k", { resultCell, lastIndex: 0 });
    s.guard.begin(tx as any);
    s.guard.trackPresent(tx as any, "k", resultCell, 0, {
      created: true,
      release: () => {
        releaseCalls++;
        throw new Error(`release ${releaseCalls} failed`);
      },
      initialRunGate: gateState.controller,
    });

    expect(() => finish(tx, { name: "RowLabelCommitError" })).toThrow(
      "Multiple list child cleanups failed",
    );
    expect(releaseCalls).toBe(2);
    expect(gateState.cancellations).toBe(1);
    expect(s.elementRuns.has("k")).toBe(false);
  });

  it("reports an initial-run gate cleanup failure", () => {
    const s = setup();
    const tx = transaction();
    const resultCell: any = {};
    const gateState = gate();
    gateState.controller.cancel = () => {
      throw new Error("gate cancellation failed");
    };
    s.elementRuns.set("k", { resultCell, lastIndex: 0 });
    s.guard.begin(tx as any);
    s.guard.trackPresent(tx as any, "k", resultCell, 0, {
      created: true,
      release: () => true,
      initialRunGate: gateState.controller,
    });

    expect(() => finish(tx, { name: "RowLabelCommitError" })).toThrow(
      "gate cancellation failed",
    );
    expect(s.elementRuns.has("k")).toBe(false);
  });

  it("continues cancellation after tracked and untracked releases fail", () => {
    const untrackedCell: any = {};
    const s = setup((cell) => {
      if (cell === untrackedCell) throw new Error("fallback release failed");
    });
    const tx = transaction();
    const trackedCell: any = {};
    s.elementRuns.set("tracked", { resultCell: trackedCell, lastIndex: 0 });
    s.guard.begin(tx as any);
    s.guard.trackPresent(tx as any, "tracked", trackedCell, 0, {
      created: true,
      release: () => {
        throw new Error("tracked release failed");
      },
    });
    s.elementRuns.set("untracked", { resultCell: untrackedCell, lastIndex: 1 });

    expect(() => s.guard.cancel()).toThrow(
      "Multiple list child cleanups failed",
    );
    expect(s.fallbackReleases).toEqual([untrackedCell]);
    expect(s.elementRuns.size).toBe(0);
  });

  it("makes every ownership operation inert after cancellation", () => {
    const s = setup();
    const resultCell: any = {};
    s.guard.cancel();

    expect(s.guard.begin(transaction() as any)).toBe(false);
    s.guard.trackPresent(transaction() as any, "k", resultCell, 0);
    s.guard.trackRemoval(transaction() as any, "k", resultCell);
    s.guard.cancel();

    expect(s.elementRuns.size).toBe(0);
  });
});
