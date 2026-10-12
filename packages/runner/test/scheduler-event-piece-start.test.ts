import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Pattern } from "../src/builder/types.ts";
import {
  ensurePieceRunningVerdict,
  type EnsurePieceVerdict,
} from "../src/ensure-piece-running.ts";
import {
  getDerivedInternalCell,
  getMetaCell,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import { EventDroppedError } from "../src/scheduler/backpressure.ts";
import { EVENT_DEFERRAL_DROP_THRESHOLD } from "../src/scheduler/constants.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("scheduler event piece start");
const space = signer.did();

const patternIdentity = {
  identity: "test-scheduler-event-piece-start",
  symbol: "default",
};

type LoadPieceForEvent = (
  runtime: Runtime,
  eventLink: NormalizedFullLink,
) => Promise<EnsurePieceVerdict>;

// Replaces the scheduler's piece-start seam. The seam is a `readonly` optional
// on the state, so the write narrows the state object rather than the
// scheduler.
function setLoadPieceForEvent(
  runtime: Runtime,
  load: LoadPieceForEvent,
): void {
  (runtime.scheduler.accessForTestingOnly.eventQueueState as {
    loadPieceForEvent?: LoadPieceForEvent;
  }).loadPieceForEvent = load;
}

// Returns a function that resolves `true` once a queued event next begins
// waiting for its piece, or `false` if `settled` settles first. The wait
// subscribes to storage in the same synchronous step that registers it, so a
// commit made once this resolves `true` is one the wait sees.
function onEachWaitBegins(
  runtime: Runtime,
): (settled: Promise<unknown>) => Promise<boolean> {
  const waits = runtime.scheduler.accessForTestingOnly.eventQueueState
    .pieceStartWaits;
  const add = waits.add.bind(waits);
  let began = Promise.withResolvers<void>();
  waits.add = (event: QueuedEvent) => {
    add(event);
    began.resolve();
    return waits;
  };
  return async (settled) => {
    const waited = await Promise.race([
      began.promise.then(() => true),
      settled.then(() => false),
    ]);
    began = Promise.withResolvers<void>();
    return waited;
  };
}

describe("scheduler-event-piece-start", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let runtimeA: Runtime;
  let runtimeB: Runtime;
  let handled: unknown[];
  let errors: Error[];

  // Each runtime is one participant: a send from `runtimeA` reaches a piece
  // that `runtimeB` creates, through the shared server alone.
  function newRuntime(
    storage: EmulatedStorageManager,
    options: Pick<RuntimeOptions, "commitBackpressure"> = {},
  ): Runtime {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...options,
    });
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: { events: { type: "object" } },
      },
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
      ],
      result: { events: { $alias: { partialCause: "events", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown) => {
              handled.push(event);
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
          },
          outputs: {},
        },
      ],
    };
    runtime.patternManager.associatePatternIdentity(
      trustPattern(runtime, pattern),
      patternIdentity,
    );
    return runtime;
  }

  // The link of the stream of the piece whose result document is `name`,
  // which the piece's creation commit writes. Reading it writes nothing.
  function streamLink(runtime: Runtime, name: string): NormalizedFullLink {
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, name, undefined, tx);
    const link = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx).getAsNormalizedFullLink();
    tx.abort("read only");
    return link;
  }

  // Commits the piece whose result document is `name`, pattern pointer
  // included, as one creation commit.
  async function createPiece(runtime: Runtime, name: string): Promise<void> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell(space, name, undefined, tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx);
    resultCell.setRaw({ events: eventsCell.getAsWriteRedirectLink() });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(eventsCell, resultCell);
    argumentCell.set({});
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  // Queues `event` on `link` the way a send from a handler does, and resolves
  // with the status of the transaction the event settles on.
  function send(
    runtime: Runtime,
    link: NormalizedFullLink,
    event: unknown,
  ): Promise<string> {
    const settled = Promise.withResolvers<string>();
    runtime.scheduler.queueEvent(
      link,
      event,
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );
    return settled.promise;
  }

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    handled = [];
    errors = [];
    runtimeA = newRuntime(storageA);
    runtimeB = newRuntime(storageB);
    runtimeA.scheduler.onError((error) => errors.push(error));
  });

  afterEach(async () => {
    await runtimeA.runner.idlePieceInstantiationSettlements();
    await runtimeB.dispose({ closeStorage: false });
    await runtimeA.dispose({ closeStorage: false });
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  it("delivers a send made before its piece exists once another runtime's creation commit lands", async () => {
    const link = streamLink(runtimeA, "created-later");
    const verdicts: EnsurePieceVerdict[] = [];
    setLoadPieceForEvent(runtimeA, async (runtime, eventLink) => {
      const verdict = await ensurePieceRunningVerdict(runtime, eventLink);
      verdicts.push(verdict);
      return verdict;
    });
    const waitBegins = onEachWaitBegins(runtimeA);

    const sentAt = performance.now();
    const status = send(runtimeA, link, { offer: "room-1" });
    expect(await waitBegins(status)).toBe(true);
    await createPiece(runtimeB, "created-later");

    expect(await status).toBe("done");
    // The end of the retry window asks once more as well, and would find the
    // piece too. Ending sooner is what says the commit ended the wait.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(handled).toEqual([{ offer: "room-1" }]);
    expect(errors).toEqual([]);
    expect(verdicts.map(({ started, reason }) => ({ started, reason })))
      .toEqual([
        { started: false, reason: "no-pattern-meta" },
        { started: true, reason: undefined },
      ]);
  });

  it("delivers a send whose piece has no graph installed once a handler registers for its stream", async () => {
    const link = streamLink(runtimeA, "between-graphs");
    setLoadPieceForEvent(runtimeA, () =>
      Promise.resolve({
        started: true,
        graphIsInstalled: () => false,
        observedDocIds: [],
      }));
    const waitBegins = onEachWaitBegins(runtimeA);

    const sentAt = performance.now();
    const status = send(runtimeA, link, "queued");
    expect(await waitBegins(status)).toBe(true);
    runtimeA.scheduler.addEventHandler((_tx, event) => {
      handled.push(event);
    }, link);

    expect(await status).toBe("done");
    // As above: the retry window's end would find the handler too.
    expect(performance.now() - sentAt).toBeLessThan(
      runtimeA.commitBackpressure.retryWindowMs,
    );
    expect(handled).toEqual(["queued"]);
    expect(errors).toEqual([]);
  });

  it("reports an `EventDroppedError` once the re-attempt budget is spent", async () => {
    const link = streamLink(runtimeA, "never-a-piece");
    const tx = runtimeA.edit();
    const watched = runtimeA.getCell<number>(space, "watched", undefined, tx);
    watched.set(0);
    await tx.commit().settled;
    let attempts = 0;
    setLoadPieceForEvent(runtimeA, () => {
      attempts++;
      return Promise.resolve({
        started: false,
        reason: "no-pattern-meta",
        rootIsEmpty: true,
        observedDocIds: [watched.getAsNormalizedFullLink().id],
      });
    });
    const waitBegins = onEachWaitBegins(runtimeA);

    const status = send(runtimeA, link, "queued");
    for (let write = 1; write <= EVENT_DEFERRAL_DROP_THRESHOLD; write++) {
      expect(await waitBegins(status)).toBe(true);
      const writeTx = runtimeA.edit();
      watched.withTx(writeTx).set(write);
      await writeTx.commit().settled;
    }

    expect(await status).toBe("error");
    expect(attempts).toBe(EVENT_DEFERRAL_DROP_THRESHOLD + 1);
    expect(handled).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect((errors[0] as EventDroppedError).attempts).toBe(
      EVENT_DEFERRAL_DROP_THRESHOLD + 1,
    );
  });

  it("reports an `EventDroppedError` once the retry window ends with nothing re-arming the wait", async () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage, {
      commitBackpressure: { retryWindowMs: 0 },
    });
    const windowErrors: Error[] = [];
    runtime.scheduler.onError((error) => windowErrors.push(error));
    try {
      let attempts = 0;
      setLoadPieceForEvent(runtime, () => {
        attempts++;
        return Promise.resolve({
          started: false,
          reason: "no-pattern-meta",
          rootIsEmpty: true,
          observedDocIds: ["of:never-written"],
        });
      });

      const status = await send(
        runtime,
        streamLink(runtime, "window"),
        "queued",
      );

      expect(status).toBe("error");
      expect(attempts).toBe(2);
      expect(windowErrors.length).toBe(1);
      expect(windowErrors[0]).toBeInstanceOf(EventDroppedError);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  });

  it("reports an `EventDroppedError` at once for a send to a document that is not a piece", async () => {
    const tx = runtimeA.edit();
    const plain = runtimeA.getCell<number>(space, "plain", undefined, tx);
    plain.set(1);
    await tx.commit().settled;

    const status = await send(
      runtimeA,
      plain.getAsNormalizedFullLink(),
      "queued",
    );

    expect(status).toBe("error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect((errors[0] as EventDroppedError).attempts).toBe(1);
  });

  it("reports an `EventDroppedError` for a send whose piece start throws", async () => {
    setLoadPieceForEvent(runtimeA, () => Promise.reject(new Error("boom")));

    const status = await send(
      runtimeA,
      streamLink(runtimeA, "throws"),
      "queued",
    );

    expect(status).toBe("error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(EventDroppedError);
    expect(errors[0].message).toContain("failed: boom");
  });

  it("settles a waiting send with an error when its runtime is disposed", async () => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = newRuntime(storage);
    const disposeErrors: Error[] = [];
    runtime.scheduler.onError((error) => disposeErrors.push(error));
    setLoadPieceForEvent(runtime, () =>
      Promise.resolve({
        started: false,
        reason: "no-pattern-meta",
        rootIsEmpty: true,
        observedDocIds: ["of:never-written"],
      }));
    const waitBegins = onEachWaitBegins(runtime);

    const status = send(runtime, streamLink(runtime, "disposed"), "queued");
    expect(await waitBegins(status)).toBe(true);
    await runtime.dispose({ closeStorage: false });
    await storage.close();

    expect(await status).toBe("error");
    expect(disposeErrors).toEqual([]);
  });
});
