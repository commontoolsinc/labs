import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { patternIdentityKey } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  ISpaceReplica,
} from "../src/storage/interface.ts";
import { LocalReadUnavailable } from "../src/storage/local-read-policy.ts";
import { viewInputFingerprint } from "../src/view-input-basis.ts";

const signer = await Identity.fromPassphrase("initial view currency");
const space = signer.did();
const source = { identity: "currency-fixture", symbol: "default" };
const identity = patternIdentityKey(source);

describe("view-server-currency", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let replica: Required<ISpaceReplica>;
  let root: Cell<unknown>;
  let input: Cell<number>;
  let upstream: Cell<number>;
  let middle: Cell<number>;
  let output: Cell<number>;
  let plan: ViewPlan;
  let emit: (plans: readonly ViewPlan[]) => void;
  let interests: ViewInterest[];
  let restore: (() => void)[];
  let coverage: (() => void)[];
  let uncovered: Set<string>;
  let runs: number;
  let completedRuns: number;

  /** Fingerprints the value the scheduler actually reads through a cell. */
  function basis(cell: Cell<number>) {
    const link = cell.getAsNormalizedFullLink();
    const path = ["value", ...link.path];
    return {
      id: link.id,
      scope: link.scope,
      path,
      fingerprint: viewInputFingerprint(
        replica.getDocument(link.id, link.scope),
        path,
      ),
    };
  }

  /** Registers a real guarded computation over the resident test values. */
  function register(options: { adopt?: boolean; isEffect?: boolean } = {}) {
    const action: Action = Object.assign((tx: IExtendedStorageTransaction) => {
      runs++;
      output.withTx(tx).set(input.withTx(tx).get() + middle.withTx(tx).get());
      completedRuns++;
    }, {
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "visible",
      viewLocalOnly: true,
      writes: [output.getAsNormalizedFullLink()],
    });
    runtime.scheduler.register(action, {
      adoptViewIdentity: options.adopt === false ? undefined : identity,
      isEffect: options.isEffect,
    });
    return action;
  }

  /** Reads the current proof without registering or running a computation. */
  function proof(expectedIdentity = identity) {
    return runtime.viewReplication.initialViewDependencies(
      root.getAsNormalizedFullLink(),
      "visible",
      expectedIdentity,
    );
  }

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    replica = storage.open(space).replica as Required<ISpaceReplica>;
    restore = [];
    interests = [];
    coverage = [];
    uncovered = new Set();
    runs = 0;
    completedRuns = 0;
    restore.push(
      stub(replica, "supportsViewReplication", () => Promise.resolve(true))
        .restore,
      stub(replica, "viewReplicationSupported", () => true).restore,
      stub(replica, "subscribeViewPlans", (observer) => {
        emit = observer;
        observer([]);
        return () => {};
      }).restore,
      stub(replica, "setViewInterests", (views) => {
        interests = views;
        return Promise.resolve(true);
      }).restore,
      stub(runtime.runner, "startViewPiece", () => Promise.resolve(undefined))
        .restore,
    );
    const hasCoverage = replica.hasLocalDocumentCoverage.bind(replica);
    const subscribeCoverage = replica.subscribeLocalCoverage.bind(replica);
    restore.push(
      stub(
        replica,
        "hasLocalDocumentCoverage",
        (id, scope) => !uncovered.has(id) && hasCoverage(id, scope),
      ).restore,
      stub(replica, "subscribeLocalCoverage", (observer) => {
        coverage.push(() => observer([]));
        return subscribeCoverage(observer);
      }).restore,
    );
    root = runtime.getCell(space, "currency root", undefined);
    input = runtime.getCell(space, "currency input", { type: "number" });
    upstream = runtime.getCell(space, "currency upstream", { type: "number" });
    middle = runtime.getCell(space, "currency middle", { type: "number" });
    output = runtime.getCell(space, "currency output", { type: "number" });
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        source,
        rawMetaWriteAuthorization,
      );
      input.withTx(tx).set(3);
      upstream.withTx(tx).set(2);
      middle.withTx(tx).set(4);
      output.withTx(tx).set(7);
    });
    await runtime.storageManager.synced();
    await runtime.viewReplication.mount(root, "screen");
    plan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: ["visible"],
      inputs: [input, middle, output].map((cell) =>
        cell.getAsNormalizedFullLink()
      ),
      pieces: [{
        ...root.getAsNormalizedFullLink(),
        patternIdentity: identity,
      }],
      producers: [{
        id: "visible",
        writes: [basis(output)],
        basis: {
          reads: [basis(input), basis(middle)],
          outputs: [basis(output)],
        },
      }, {
        id: "upstream",
        writes: [basis(middle)],
        basis: { reads: [basis(upstream)], outputs: [basis(middle)] },
      }],
    };
    emit([plan]);
    await runtime.idle();
  });

  afterEach(async () => {
    await runtime.dispose();
    for (const undo of restore.reverse()) undo();
    await storage.close();
  });

  it("adopts only initial registrations and executes first and subsequent edits", async () => {
    const action = register();
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect(runs).toBe(0);
    expect(output.get()).toBe(7);
    for (const value of [5, 8]) {
      await runtime.editWithRetry((tx) => input.withTx(tx).set(value));
      await runtime.idle();
      expect(output.get()).toBe(value + 4);
    }
    expect(runs).toBe(2);
    runtime.scheduler.register(action, { adoptViewIdentity: identity });
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    cancel();
  });

  it("keeps unchanged evidence current through plan and coverage notifications", async () => {
    register();
    const cancel = output.sink(() => {});
    emit([{ ...plan, generation: 2 }]);
    for (const notify of coverage) notify();
    await runtime.idle();
    expect(runs).toBe(0);
    cancel();
  });

  for (const field of ["input", "output", "ancestor"] as const) {
    it(`rejects a changed ${field} value`, async () => {
      const cell = field === "input"
        ? input
        : field === "output"
        ? output
        : upstream;
      await runtime.editWithRetry((tx) => cell.withTx(tx).set(99));
      expect(proof()).toBeUndefined();
      expect(runtime.scheduler.isDirty(register())).toBe(true);
    });
  }

  it("rejects missing and cyclic producer evidence", () => {
    const producer = plan.producers![1];
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...producer,
        basis: undefined,
      }],
    }]);
    expect(proof()).toBeUndefined();
    emit([{
      ...plan,
      generation: 3,
      producers: [plan.producers![0], {
        ...producer,
        basis: { reads: [basis(output)], outputs: [basis(middle)] },
      }],
    }]);
    expect(proof()).toBeUndefined();
  });

  it("requires the bound source, admitted inputs, eligibility, and own coverage", async () => {
    expect(proof("other#default")).toBeUndefined();
    const id = input.getAsNormalizedFullLink().id;
    uncovered.add(id);
    expect(proof()).toBeUndefined();
    uncovered.delete(id);
    emit([{ ...plan, generation: 2, inputs: [] }]);
    expect(proof()).toBeUndefined();
    emit([{ ...plan, generation: 3, eligibleActions: [] }]);
    expect(proof()).toBeUndefined();
    emit([{ ...plan, generation: 4 }]);
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        { ...source, identity: "replacement" },
        rawMetaWriteAuthorization,
      )
    );
    expect(proof()).toBeUndefined();
  });

  it("wakes on output changes and reestablishes the computed value", async () => {
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    await runtime.editWithRetry((tx) => output.withTx(tx).set(99));
    await runtime.idle();
    expect(runs).toBe(1);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("tracks transitive producer reads and resumes after same-value settlement", async () => {
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    await runtime.editWithRetry((tx) => upstream.withTx(tx).set(3));
    await runtime.idle();
    expect(output.get()).toBe(7);
    expect(runs).toBeGreaterThan(0);
    const attempts = runs;
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...plan.producers![1],
        basis: { reads: [basis(upstream)], outputs: [basis(middle)] },
      }],
    }]);
    await runtime.idle();
    expect(runs).toBeGreaterThan(attempts);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("retires adopted evidence on coverage loss and parks without overwriting", async () => {
    const action = register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    uncovered.add(input.getAsNormalizedFullLink().id);
    for (const notify of [...coverage]) notify();
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.idle();
    expect(output.get()).toBe(7);
    uncovered.clear();
    for (const notify of [...coverage]) notify();
    await runtime.idle();
    expect(runs).toBeGreaterThan(0);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("rechecks omitted ancestors on plan changes without claiming a local outcome", async () => {
    uncovered.add(upstream.getAsNormalizedFullLink().id);
    // No local intent touches the ancestor that the server alone retains.
    restore.push(
      stub(replica, "speculationRetirementView", () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [],
      })).restore,
    );
    const action = register();
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect(runs).toBe(0);
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...plan.producers![1],
        basis: undefined,
      }],
    }]);
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.idle();
    expect(output.get()).toBe(7);
    cancel();
  });

  it("fences source changes and stale plans after a remount", async () => {
    const action = register();
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        { ...source, identity: "replacement" },
        rawMetaWriteAuthorization,
      )
    );
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.viewReplication.mount(root, "screen");
    emit([plan]);
    expect(proof()).toBeUndefined();
    expect(runtime.viewReplication.eligible(space, "visible")).toBe(false);
  });

  it("checks server evidence when a dependent reads an adopted producer", () => {
    register();
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "consumer"],
    }]);
    const documentAt = replica.getDocument.bind(replica);
    restore.push(
      stub(replica, "getDocument", (id, scope) => {
        return id === upstream.getAsNormalizedFullLink().id
          ? { value: 99 }
          : documentAt(id, scope);
      }).restore,
    );
    const consumer: Action = Object.assign(() => {}, {
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "consumer",
      viewLocalOnly: true,
    });
    const tx = runtime.edit();
    try {
      runtime.scheduler.prepareViewAction(tx, consumer);
      expect(() => output.withTx(tx).get()).toThrow(LocalReadUnavailable);
    } finally {
      tx.abort();
    }
  });

  it("wakes two adopted nodes through a shared basis and a same-value local producer", async () => {
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "upstream"],
      inputs: [...plan.inputs!, upstream.getAsNormalizedFullLink()],
    }]);
    let upstreamRuns = 0;
    const producer: Action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        upstreamRuns++;
        upstream.withTx(tx).get();
        middle.withTx(tx).set(4);
      },
      {
        viewPiece: root.getAsNormalizedFullLink(),
        viewNodeId: "upstream",
        viewLocalOnly: true,
        writes: [middle.getAsNormalizedFullLink()],
      },
    );
    runtime.scheduler.register(producer, { adoptViewIdentity: identity });
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect([upstreamRuns, runs]).toEqual([0, 0]);
    await runtime.editWithRetry((tx) => upstream.withTx(tx).set(3));
    await runtime.idle();
    expect(upstreamRuns).toBe(1);
    expect(completedRuns).toBe(1);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("rejects a plan replacement during initial proof validation", () => {
    const documentAt = replica.getDocument.bind(replica);
    let replaced = false;
    restore.push(
      stub(replica, "getDocument", (id, scope) => {
        if (!replaced) {
          replaced = true;
          emit([{ ...plan, generation: 2 }]);
        }
        return documentAt(id, scope);
      }).restore,
    );
    expect(runtime.scheduler.isDirty(register())).toBe(true);
    expect(replaced).toBe(true);
  });

  it("does not adopt an old runtime after a replacement acquires its replica", async () => {
    const replacement = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    try {
      await replacement.viewReplication.enable(space);
      expect(proof()).toBeUndefined();
      expect(runtime.scheduler.isDirty(register())).toBe(true);
    } finally {
      await replacement.dispose({ closeStorage: false });
    }
  });

  it("keeps effect and ordinary registrations on their execution path", () => {
    expect(runtime.scheduler.isDirty(register({ isEffect: true }))).toBe(true);
    expect(runtime.scheduler.isDirty(register({ adopt: false }))).toBe(true);
  });
});
