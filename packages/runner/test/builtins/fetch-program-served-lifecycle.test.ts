/** Pins request and publication ownership around served program resolution. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { serverSeq } from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import {
  fetchProgram,
  type ProgramResult,
} from "../../src/builtins/fetch-program.ts";
import { computeInputHashFromValue } from "../../src/builtins/fetch-utils.ts";
import type { Cell } from "../../src/cell.ts";
import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveRunContextOf,
} from "../../src/executor/wave.ts";
import type { raw } from "../../src/module.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const service = await Identity.fromPassphrase("program-lifecycle-service");
const alice = await Identity.fromPassphrase("program-lifecycle-alice");
const bob = await Identity.fromPassphrase("program-lifecycle-bob");
const space = service.did();
const aliceOne = { principal: alice.did(), sessionId: "alice-one" };
const aliceTwo = { principal: alice.did(), sessionId: "alice-two" };
const bobOne = { principal: bob.did(), sessionId: "bob-one" };
const url = "https://example.test/program-lifecycle.ts";

type ResultCells = {
  pending: Cell<boolean>;
  result: Cell<ProgramResult | undefined>;
  error: Cell<unknown>;
};

describe("fetch-program-served-lifecycle", () => {
  let server: ReturnType<typeof newSharedServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let commitBatch: (
    txs: IExtendedStorageTransaction[],
    withdraw?: boolean,
  ) => Promise<void>;
  const transactions: IExtendedStorageTransaction[] = [];

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const engine = await server.engineForSpace(space);
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(service.did()),
    });
    expect(lease.acquire()).toBe(true);
    manager = EmulatedStorageManager.connectTo(server, { as: service });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
      cfcFlowLabels: "off",
    });
    const sink = new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: lease.holder,
    });
    let heldWave: WaveAccumulator | undefined;
    runtime.installSealDestination({
      deferSealedEffects: () => heldWave !== undefined,
      seal: async (tx) => {
        if (heldWave) return heldWave.seal(tx);
        if (!waveRunContextOf(tx)) {
          stampWaveRunContext(tx, {
            kind: "bookkeeping",
            actionId: "program-fixture-completion",
            scopeKeyIdentity: tx.tx.scopeKeyIdentity,
          });
        }
        const wave = new WaveAccumulator({
          space,
          basisSeq: serverSeq(engine),
          scopeKeyIdentity: runtime.scopeKeyIdentity,
          replicaFor: (space) => manager.open(space).replica,
          lease,
        });
        const sealed = await wave.seal(tx);
        if (sealed.error) return sealed;
        const outcome = await wave.commitWave(sink);
        await wave.settled();
        expect(outcome.aborted).toBeUndefined();
        expect(
          outcome.dispositions.every((entry) => entry.kind === "committed"),
        ).toBe(true);
        return sealed;
      },
    });
    commitBatch = async (txs, withdraw = false) => {
      const wave = new WaveAccumulator({
        space,
        basisSeq: serverSeq(engine),
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (space) => manager.open(space).replica,
        lease,
      });
      heldWave = wave;
      try {
        for (const tx of txs) {
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }
        if (withdraw) wave.abandon("fixture withdrawal");
        else {
          const outcome = await wave.commitWave(sink);
          expect(outcome.aborted).toBeUndefined();
          expect(
            outcome.dispositions.every((entry) => entry.kind === "committed"),
          ).toBe(true);
        }
        await wave.settled();
      } finally {
        heldWave = undefined;
        wave.abandon("fixture cleanup");
      }
      await runtime.settled();
    };
  });

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort();
    await manager.synced();
    try {
      await runtime.dispose({ closeStorage: false });
    } finally {
      await manager.close();
      await server.close();
    }
  });

  function edit(identity: ScopeKeyIdentity) {
    const tx = runtime.edit();
    transactions.push(tx);
    stampWaveRunContext(tx, {
      kind: "derivation",
      actionId: "program-publication",
      scopeKeyIdentity: identity,
      attributionFromScope: true,
    });
    tx.tx.scopeKeyIdentity = identity;
    return tx;
  }

  async function commit(tx: IExtendedStorageTransaction) {
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.settled();
  }

  /** Holds dispatch independently from commit and records real publications. */
  function fixture(bindingScope: "space" | "session" = "space") {
    const input = runtime.getCell<{ url: string }>(space, "program-input");
    const parent = runtime.getCell<{ selected?: string }>(
      space,
      "program-parent",
    );
    const binding = runtime.getCellFromLink<{ selected?: string }>({
      ...parent.getAsNormalizedFullLink(),
      scope: bindingScope,
    });
    const userUrl = runtime.getCellFromLink<string>({
      ...runtime.getCell(space, "program-url").getAsNormalizedFullLink(),
      scope: "user",
    });
    const sessionUrl = runtime.getCellFromLink<string>({
      ...runtime.getCell(space, "program-session-url")
        .getAsNormalizedFullLink(),
      scope: "session",
    });
    const cancels: Array<() => void> = [];
    const dispatches: Array<() => void | Promise<void>> = [];
    const accepted: Array<() => void> = [];
    const publications: Array<{ scope?: string; session?: string }> = [];
    let resultCells: ResultCells;
    const builtin: Parameters<typeof raw<{ url: string }, ResultCells>>[0] =
      fetchProgram;
    const action = builtin(
      input,
      (tx, cells) => {
        resultCells = cells;
        const scope = cells.result.getAsNormalizedFullLink().scope;
        publications.push({
          scope,
          session: tx.tx.scopeKeyIdentity?.sessionId,
        });
        binding.withTx(tx).set({ selected: scope });
      },
      (cancel) => {
        if (cancel) cancels.push(cancel);
      },
      [parent],
      parent,
      runtime,
      binding.getAsNormalizedFullLink(),
      false,
      binding.getAsNormalizedFullLink(),
    );
    if (typeof action !== "function") {
      throw new Error("Expected raw program action");
    }

    const run = action;

    async function seed(identity: ScopeKeyIdentity, scope: "user" | "session") {
      const tx = edit(identity);
      if (scope === "session") {
        sessionUrl.withTx(tx).set(url);
        userUrl.withTx(tx).set(sessionUrl as unknown as string);
      } else userUrl.withTx(tx).set(url);
      input.withTx(tx).key("url").set(userUrl as unknown as string);
      await commit(tx);
    }

    function stage(
      identity: ScopeKeyIdentity,
      holdDispatch = true,
      deferAcceptance = false,
    ) {
      const tx = edit(identity);
      if (holdDispatch) {
        const enqueue = tx.enqueuePostCommitEffect.bind(tx);
        tx.enqueuePostCommitEffect = (effect) => {
          dispatches.push(() => effect.flush(tx));
          enqueue({ ...effect, flush: () => {} });
        };
      }
      const register = tx.addCommitCallback.bind(tx);
      using _acceptance = deferAcceptance
        ? stub(tx, "addCommitCallback", (callback) =>
          register((...args) => {
            accepted.push(() => callback(...args));
          }))
        : undefined;
      run(tx);
      return tx;
    }

    function read<T>(cell: Cell<T>, identity: ScopeKeyIdentity): T {
      const tx = runtime.readTx();
      tx.tx.scopeKeyIdentity = identity;
      return cell.withTx(tx).get();
    }

    function cacheState(identity: ScopeKeyIdentity, scope: "user" | "session") {
      const cache = runtime.getCellFromLink<
        Record<string, { state: { type: string } }>
      >({
        ...runtime.getCell(space, { fetchProgram: { cache: [parent] } })
          .getAsNormalizedFullLink(),
        scope,
      });
      const hash = computeInputHashFromValue({ url });
      return read(cache, identity)?.[hash]?.state.type;
    }

    return {
      seed,
      stage,
      read,
      cacheState,
      binding,
      cancels,
      dispatches,
      accepted,
      publications,
      get resultCells() {
        return resultCells;
      },
    };
  }

  it("releases an accepted claim stopped before dispatch", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    await commit(f.stage(aliceOne));
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    using network = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("Unexpected HTTP dispatch")),
    );
    f.cancels[0]();
    await runtime.settled();
    expect(f.cacheState(aliceOne, "user")).toBe("idle");
    expect(f.dispatches).toHaveLength(1);
    await f.dispatches[0]();
    await runtime.settled();
    expect(network.calls).toHaveLength(0);
  });

  it("keeps a different actor's accepted scope selected after an older refusal", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    await f.seed(bobOne, "session");
    const old = f.stage(aliceOne);
    expect(f.publications.at(-1)?.scope).toBe("user");
    await commit(f.stage(bobOne));
    expect(f.read(f.binding, bobOne)?.selected).toBe("session");
    expect(old.getCfcState().outbox).toHaveLength(1);
    old.getCfcState().outbox[0].abandon?.(new Error("older actor refused"));
    await runtime.settled();
    expect(f.read(f.binding, bobOne)?.selected).toBe("session");
    f.cancels[0]();
    await runtime.settled();
  });

  it("owns an older accepted request without restoring its replaced binding", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    await f.seed(bobOne, "session");
    await commit(f.stage(aliceOne, true, true));
    await commit(f.stage(bobOne));
    expect(f.read(f.binding, bobOne)?.selected).toBe("session");
    for (const callback of f.accepted) callback();
    await runtime.settled();
    expect(f.read(f.binding, bobOne)?.selected).toBe("session");
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    expect(f.cacheState(bobOne, "session")).toBe("fetching");
    f.cancels[0]();
    await runtime.settled();
    expect(f.cacheState(aliceOne, "user")).toBe("idle");
    expect(f.cacheState(bobOne, "session")).toBe("idle");
    expect(f.read(f.binding, bobOne)?.selected).toBe("session");
  });

  it("announces a shared pending result to an independently refused binding", async () => {
    const f = fixture("session");
    await f.seed(aliceOne, "user");
    const old = f.stage(aliceOne);
    await commit(f.stage(aliceTwo));
    expect(f.read(f.binding, aliceTwo)?.selected).toBe("user");
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    old.getCfcState().outbox[0].abandon?.(new Error("first binding refused"));
    await runtime.settled();
    expect(f.read(f.binding, aliceOne)?.selected).toBe("user");
    expect(f.read(f.binding, aliceTwo)?.selected).toBe("user");
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    f.cancels[0]();
    await runtime.settled();
  });

  it("releases an accepted claim when its release check skips dispatch", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    const tx = f.stage(aliceOne);
    await commit(tx);
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    const state = tx.getCfcState();
    using _state = stub(tx, "getCfcState", () =>
      ({
        ...state,
        prepare: {
          status: "prepared",
          digest: "program-release-refusal",
          input: {
            consumedReads: [],
            attemptedWrites: [],
            writes: [],
            writeAttemptLog: [],
            dereferenceTraces: [],
            triggerReads: [],
            writePolicyInputs: [],
          },
        },
      }) satisfies ReturnType<typeof tx.getCfcState>);
    using network = stub(
      globalThis,
      "fetch",
      () => Promise.reject(new Error("Unexpected HTTP dispatch")),
    );
    await f.dispatches[0]();
    await runtime.settled();
    expect(network.calls).toHaveLength(0);
    expect(f.cacheState(aliceOne, "user")).toBe("idle");
    using edits = spy(runtime, "edit");
    f.cancels[0]();
    expect(edits.calls).toHaveLength(0);
  });

  async function acceptedAttachments(f: ReturnType<typeof fixture>) {
    await f.seed(aliceOne, "user");
    const first = f.stage(aliceOne, true, true);
    await commit(first);
    expect(f.cacheState(aliceOne, "user")).toBe("fetching");
    const later = Date.now() + 10_001;
    const second = (() => {
      using _clock = stub(Date, "now", () => later);
      return f.stage(aliceOne, true, true);
    })();
    await commit(second);
    expect(f.dispatches).toHaveLength(2);
    for (const callback of f.accepted) callback();
    await runtime.settled();
    return [first, second];
  }

  function rejectRelease(tx: IExtendedStorageTransaction) {
    const state = tx.getCfcState();
    return stub(tx, "getCfcState", () =>
      ({
        ...state,
        prepare: {
          status: "prepared",
          digest: "program-release-refusal",
          input: {
            consumedReads: [],
            attemptedWrites: [],
            writes: [],
            writeAttemptLog: [],
            dereferenceTraces: [],
            triggerReads: [],
            writePolicyInputs: [],
          },
        },
      }) satisfies ReturnType<typeof tx.getCfcState>);
  }

  for (const rejected of [0, 1]) {
    it(`completes the surviving claim when accepted attachment ${rejected + 1} fails release`, async () => {
      const f = fixture();
      const attachments = await acceptedAttachments(f);
      using _state = rejectRelease(attachments[rejected]);
      using network = stub(globalThis, "fetch", () =>
        Promise.resolve(
          new Response('export default { result: "done" };', {
            headers: { "content-type": "application/javascript" },
          }),
        ));
      try {
        await f.dispatches[rejected]();
        await runtime.settled();
        expect(network.calls).toHaveLength(0);
        expect(f.cacheState(aliceOne, "user")).toBe("fetching");
        await f.dispatches[1 - rejected]();
        await runtime.settled();
        expect(network.calls).toHaveLength(1);
        expect(f.cacheState(aliceOne, "user")).toBe("success");
        using edits = spy(runtime, "edit");
        f.cancels[0]();
        expect(edits.calls).toHaveLength(0);
      } finally {
        f.cancels[0]();
        await runtime.settled();
      }
    });

    it(`releases the claim when every accepted attachment fails release starting with ${rejected + 1}`, async () => {
      const f = fixture();
      const attachments = await acceptedAttachments(f);
      using _first = rejectRelease(attachments[0]);
      using _second = rejectRelease(attachments[1]);
      using network = stub(
        globalThis,
        "fetch",
        () => Promise.reject(new Error("Unexpected HTTP dispatch")),
      );
      await f.dispatches[rejected]();
      await runtime.settled();
      expect(f.cacheState(aliceOne, "user")).toBe("fetching");
      await f.dispatches[1 - rejected]();
      await runtime.settled();
      expect(network.calls).toHaveLength(0);
      expect(f.cacheState(aliceOne, "user")).toBe("idle");
      using edits = spy(runtime, "edit");
      f.cancels[0]();
      expect(edits.calls).toHaveLength(0);
    });
  }

  it("preserves earlier refusal ownership when a newer scope publication is withdrawn", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    await f.seed(bobOne, "session");
    const old = f.stage(aliceOne);
    await commitBatch([f.stage(bobOne)], true);
    expect(f.read(f.binding, bobOne)?.selected).toBeUndefined();
    old.getCfcState().outbox[0].abandon?.(new Error("older request refused"));
    await runtime.settled();
    expect(f.read(f.binding, aliceOne)?.selected).toBe("user");
    f.cancels[0]();
    await runtime.settled();
  });

  it("retires completed work when accepted bookkeeping arrives later", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    using network = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response('export default { result: "done" };', {
          headers: { "content-type": "application/javascript" },
        }),
      ));
    await commit(f.stage(aliceOne, false, true));
    expect(network.calls).toHaveLength(1);
    expect(f.cacheState(aliceOne, "user")).toBe("success");
    for (const callback of f.accepted) callback();
    using edits = spy(runtime, "edit");
    f.cancels[0]();
    expect(edits.calls).toHaveLength(0);
  });

  it("does not publish a refused request after its inputs select another scope", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    const old = f.stage(aliceOne);
    await f.seed(aliceOne, "session");
    const announcements = f.publications.length;
    old.getCfcState().outbox[0].abandon?.(new Error("unselected request"));
    await runtime.settled();
    expect(f.publications).toHaveLength(announcements);
    expect(f.read(f.binding, aliceOne)).toBeUndefined();
    expect(f.cacheState(aliceOne, "user")).toBe("error");
    f.cancels[0]();
  });

  it("does not restore a refused binding after graph teardown", async () => {
    const f = fixture();
    await f.seed(aliceOne, "user");
    const old = f.stage(aliceOne);
    f.cancels[0]();
    const announcements = f.publications.length;
    using edits = spy(runtime, "edit");
    old.getCfcState().outbox[0].abandon?.(new Error("stopped request"));
    await runtime.settled();
    expect(edits.calls).toHaveLength(0);
    expect(f.publications).toHaveLength(announcements);
    expect(f.read(f.binding, aliceOne)).toBeUndefined();
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`suppresses ${outcome} after stop while completion waits for idle`, async () => {
      const f = fixture();
      await f.seed(aliceOne, "user");
      await commit(f.stage(aliceOne));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      using _network = stub(
        globalThis,
        "fetch",
        () =>
          outcome === "success"
            ? Promise.resolve(new Response("export default 42;"))
            : Promise.reject(new Error("program network failure")),
      );
      using _idle = stub(runtime, "idle", () => {
        entered.resolve();
        return release.promise;
      });
      try {
        await f.dispatches[0]();
        await entered.promise;
        using _stamp = stub(runtime, "stampServerRun", () => {
          throw new Error("teardown unavailable");
        });
        f.cancels[0]();
        release.resolve();
        await runtime.settled();
        expect(f.cacheState(aliceOne, "user")).toBe("fetching");
      } finally {
        release.resolve();
      }
    });
  }
});
