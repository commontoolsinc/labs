import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  setPatternRepository,
  setPatternSource,
  systemPatternSource,
} from "../src/index.ts";

const signer = await Identity.fromPassphrase("lazy system pattern updates");
const PARENT_PATH = "/api/patterns/system/lazy-update-parent.tsx";
// The `system:` ref that route path denotes — what a checked piece is stamped
// with, whichever legacy spelling it started from.
const PARENT_SOURCE = systemPatternSource("system/lazy-update-parent.tsx");
const SOURCE_PATH = "/api/patterns/system/lazy-update-test.tsx";
const SYMBOL = "TrackedPattern";

const parentSource = [
  `import { ${SYMBOL} } from "./lazy-update-test.tsx";`,
  `export { ${SYMBOL} };`,
  `export default ${SYMBOL};`,
  "",
].join("\n");

function source(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<Record<string, never>, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

function sourceWithRequiredInput(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<{ required: string }, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

function parentProgram(contents: string): RuntimeProgram {
  return {
    main: PARENT_PATH,
    mainExport: SYMBOL,
    files: [{
      name: PARENT_PATH,
      contents: parentSource,
    }, { name: SOURCE_PATH, contents }],
  };
}

// A program named the way `cf piece new` names one deployed from a file tree:
// every module by its path under the compile root, so the entry says nothing
// about what the host serves.
const FILE_TREE_PATH = "/main.tsx";

function fileTreeProgram(contents: string): RuntimeProgram {
  return {
    main: FILE_TREE_PATH,
    mainExport: SYMBOL,
    files: [
      { name: FILE_TREE_PATH, contents: parentSource },
      { name: "/lazy-update-test.tsx", contents },
    ],
  };
}

function identityFor(contents: string): Promise<string> {
  const files = new Map(
    parentProgram(contents).files.map(({ name, contents }) => [name, contents]),
  );
  return resolveEntryIdentity(
    PARENT_PATH,
    (name) =>
      files.has(name)
        ? Promise.resolve(files.get(name)!)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

describe("lazy system-pattern auto-update", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let identityGate: Deferred<void> | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    identityGate?.resolve();
    await runtime?.patternUpdater.idle();
    await runtime?.dispose();
  });

  function createRuntime(
    fetch: RuntimeFetch,
    systemPatternAutoUpdate = true,
  ): Runtime {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
      experimental: systemPatternAutoUpdate
        ? { systemPatternAutoUpdate: true }
        : { systemPatternAutoUpdate: false },
    });
    return runtime;
  }

  async function preparePiece(fetch: RuntimeFetch) {
    createRuntime(fetch);
    const space = signer.did();
    const initialIdentity = await identityFor(source("v1"));
    const initial = await runtime.patternManager.compilePattern(
      parentProgram(source("v1")),
      { space },
    );
    const recovered = await runtime.patternManager
      .getPatternSourceProgramByIdentity(initialIdentity, space);
    expect(recovered?.main).toBe(PARENT_PATH);
    const piece = runtime.getCell<{ marker?: string }>(
      space,
      `lazy-update-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, initial, {}, piece);
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: initialIdentity,
      symbol: SYMBOL,
    });
    return piece;
  }

  async function compileMarkerPattern(marker: string) {
    return await runtime.patternManager.compilePattern(
      parentProgram(source(marker)),
      { space: signer.did() },
    );
  }

  async function stampSource(piece: Cell<unknown>, origin: string) {
    const result = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, origin);
    });
    expect(result.error).toBeUndefined();
  }

  async function runScheduledCheck(piece: Cell<unknown>) {
    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();
    await runtime.idle();
  }

  async function waitForPatternIdentity(
    piece: Cell<unknown>,
    target: { identity: string; symbol: string },
    trigger: () => Promise<unknown> | unknown,
  ) {
    const reached = defer<void>();
    const cancel = piece.sinkMeta("patternIdentity", (value) => {
      if (
        typeof value === "object" && value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).identity === target.identity &&
        (value as Record<string, unknown>).symbol === target.symbol
      ) {
        reached.resolve();
      }
    });
    try {
      await trigger();
      await reached.promise;
      await runtime.patternUpdater.idle();
      await runtime.idle();
    } finally {
      cancel();
    }
  }

  async function rejectFirstFabricCommit(
    piece: Cell<unknown>,
    error: Error & { readyToRetry?: () => Promise<unknown> | unknown },
    expectedIdentity?: { identity: string; symbol: string },
  ) {
    const runningRef = getPatternIdentityRef(piece)!;
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    const originalEdit = runtime.edit.bind(runtime);
    let installed = false;

    try {
      runtime.patternManager.loadPatternByIdentity = (async (...args) => {
        const loaded = await originalLoad(...args);
        if (
          !installed && args[0] === runningRef.identity &&
          args[1] === runningRef.symbol
        ) {
          installed = true;
          runtime.edit = ((...editArgs: Parameters<typeof originalEdit>) => {
            runtime.edit = originalEdit;
            const tx = originalEdit(...editArgs);
            const commit = tx.commit.bind(tx);
            tx.commit = (async () => {
              tx.abort("simulated fabric source commit rejection");
              await commit();
              return { error } as Awaited<ReturnType<typeof commit>>;
            }) as typeof tx.commit;
            return tx;
          }) as typeof runtime.edit;
        }
        return loaded;
      }) as typeof runtime.patternManager.loadPatternByIdentity;
      if (expectedIdentity === undefined) {
        await runScheduledCheck(piece);
      } else {
        await waitForPatternIdentity(
          piece,
          expectedIdentity,
          () => runtime.patternUpdater.schedule(piece),
        );
      }
    } finally {
      runtime.edit = originalEdit;
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
    expect(installed).toBe(true);
  }

  it("honors disabled and disposed updater lifecycle gates", async () => {
    let fetches = 0;
    createRuntime(
      () => {
        fetches++;
        return Promise.reject(new Error("disabled updater fetched source"));
      },
      false,
    );
    const cell = runtime.getCell(signer.did(), crypto.randomUUID());
    const initial = await compileMarkerPattern("v1");
    await runtime.setup(undefined, initial, {}, cell);
    await stampSource(cell, PARENT_SOURCE);

    expect(
      await runtime.patternUpdater.checkDefaultPattern(cell, PARENT_PATH),
    ).toBe("skipped-disabled");

    runtime.experimental.systemPatternAutoUpdate = true;
    await runtime.patternUpdater.dispose();
    expect(
      await runtime.patternUpdater.checkDefaultPattern(cell, PARENT_PATH),
    ).toBe("current");
    const originalLink = cell.getAsNormalizedFullLink.bind(cell);
    const originalLoad = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
    let linkReads = 0;
    let sourceLoads = 0;
    try {
      cell.getAsNormalizedFullLink = (() => {
        linkReads++;
        return originalLink();
      }) as typeof cell.getAsNormalizedFullLink;
      runtime.patternManager.getPatternSourceProgramByIdentity = ((...args) => {
        sourceLoads++;
        return originalLoad(...args);
      }) as typeof runtime.patternManager.getPatternSourceProgramByIdentity;
      runtime.patternUpdater.schedule(cell);
      await runtime.patternUpdater.idle();
    } finally {
      cell.getAsNormalizedFullLink = originalLink;
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLoad;
    }
    expect(linkReads).toBe(0);
    expect(sourceLoads).toBe(0);
    expect(fetches).toBe(0);
  });

  it("contains synchronous and asynchronous scheduling failures", async () => {
    createRuntime(() => Promise.reject(new Error("unexpected fetch")));
    const space = signer.did();
    const synchronousFailure = {
      space,
      getAsNormalizedFullLink: () => {
        throw new Error("link unavailable");
      },
    } as unknown as Cell<unknown>;
    expect(() => runtime.patternUpdater.schedule(synchronousFailure)).not
      .toThrow();

    let spaceReads = 0;
    const asynchronousFailure = {
      get space() {
        spaceReads++;
        if (spaceReads === 1) throw new Error("space unavailable");
        return space;
      },
      getAsNormalizedFullLink: () => ({
        space,
        id: "of:async-pattern-update-schedule-failure",
      }),
    } as unknown as Cell<unknown>;
    runtime.patternUpdater.schedule(asynchronousFailure);
    await runtime.patternUpdater.idle();

    expect(spaceReads).toBe(2);
  });

  it("shares one in-flight check for duplicate schedules", async () => {
    const v1Identity = await identityFor(source("v1"));
    const identityRequested = defer();
    identityGate = defer();
    let identityFetches = 0;
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.searchParams.has("identity")) {
        identityFetches++;
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v1Identity);
      }
      return new Response("not found", { status: 404 });
    });

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    runtime.patternUpdater.schedule(piece);
    expect(identityFetches).toBe(1);

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    expect(identityFetches).toBe(1);
    expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
  });

  it("does not schedule a generic check for an explicitly handled root", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const defaultPattern = runtime.getSpaceCell(piece.space)
      .key("defaultPattern");
    const assigned = await runtime.editWithRetry((tx) => {
      defaultPattern.withTx(tx).set(piece.withTx(tx));
    });
    expect(assigned.error).toBeUndefined();

    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let defaultPatternSyncs = 0;
    storageManager.syncCell = ((cell) => {
      if (
        cell.resolveAsCell().equals(defaultPattern.resolveAsCell())
      ) defaultPatternSyncs++;
      return originalSyncCell(cell);
    }) as typeof storageManager.syncCell;

    try {
      expect(
        await runtime.start(piece, { schedulePatternUpdate: false }),
      ).toBe(true);
      await runtime.patternUpdater.idle();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }

    expect(defaultPatternSyncs).toBe(0);
    expect(fetches).toBe(0);
  });

  it("aborts an in-flight identity request during disposal", async () => {
    const identityRequested = defer<AbortSignal | undefined>();
    const abortObserved = defer();
    const piece = await preparePiece((_input, init) => {
      const signal = init?.signal ?? undefined;
      identityRequested.resolve(signal);
      if (signal === undefined) {
        return Promise.reject(
          new Error("identity request had no abort signal"),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved.resolve();
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });

    const start = runtime.start(piece);
    const signal = await identityRequested.promise;
    expect(signal).toBeDefined();
    expect(await start).toBe(true);
    const dispose = runtime.patternUpdater.dispose();
    await abortObserved.promise;
    await dispose;

    expect(signal!.aborted).toBe(true);
    expect(getPatternSource(piece)).toBeUndefined();
    expect(
      await runtime.patternUpdater.checkDefaultPattern(piece, PARENT_PATH),
    ).toBe("current");
  });

  it("disposes when an injected fetch ignores the abort signal", async () => {
    const identityRequested = defer<AbortSignal | undefined>();
    const ignoredFetch = defer<Response>();
    const piece = await preparePiece((_input, init) => {
      identityRequested.resolve(init?.signal ?? undefined);
      return ignoredFetch.promise;
    });

    const start = runtime.start(piece);
    const signal = await identityRequested.promise;
    expect(signal).toBeDefined();
    expect(await start).toBe(true);

    await runtime.patternUpdater.dispose();

    expect(signal!.aborted).toBe(true);
    expect(getPatternSource(piece)).toBeUndefined();
    ignoredFetch.resolve(new Response("late response"));
  });

  it("disposes when a completed identity response body never settles", async () => {
    const identityRequested = defer<AbortSignal | undefined>();
    const bodyRead = defer();
    let bodyController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    class StuckBodyResponse extends Response {
      constructor() {
        super(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
            },
          }),
        );
      }

      override text(): Promise<string> {
        bodyRead.resolve();
        return super.text();
      }
    }
    const piece = await preparePiece((_input, init) => {
      const signal = init?.signal ?? undefined;
      identityRequested.resolve(signal);
      return Promise.resolve(new StuckBodyResponse());
    });

    const start = runtime.start(piece);
    const signal = await identityRequested.promise;
    expect(signal).toBeDefined();
    expect(await start).toBe(true);
    await bodyRead.promise;
    await runtime.patternUpdater.dispose();

    expect(signal!.aborted).toBe(true);
    expect(getPatternSource(piece)).toBeUndefined();
    expect((await piece.pull())?.marker).toBe("v1");
    bodyController!.close();
  });

  it("skips a sourceless pattern whose compiled source cannot be recovered", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const originalGetSource = runtime.patternManager
      .getPatternSourceProgramByIdentity;
    runtime.patternManager.getPatternSourceProgramByIdentity =
      (() => Promise.resolve(undefined)) as typeof originalGetSource;

    try {
      runtime.patternUpdater.schedule(piece);
      await runtime.patternUpdater.idle();
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity =
        originalGetSource;
    }

    expect(fetches).toBe(0);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("leaves cf sources to their own resolver", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const update = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, "cf:published-pattern");
    });
    expect(update.error).toBeUndefined();

    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();

    expect(fetches).toBe(0);
    expect(getPatternSource(piece)).toBe("cf:published-pattern");
  });

  it("updates from a pinned fabric pattern", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("fabric update fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);

    await runScheduledCheck(piece);

    expect(getPatternIdentityRef(piece)).toEqual(targetRef);
    expect(getPieceSourceRevisions(piece).at(-1)?.operation).toBe(
      "origin-update",
    );
  });

  it("refuses fabric references that cannot name an update authority", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("invalid fabric source fetched web source"))
    );
    const originalRef = getPatternIdentityRef(piece);
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const sourcePiece = runtime.getCell(
      piece.space,
      `invalid-fabric-source-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, target, {}, sourcePiece);
    const sourceLink = sourcePiece.getAsNormalizedFullLink();
    const invalidOrigins = [
      `cf:pattern:${targetRef.identity}/nested.ts`,
      `cf:/friendly-space/${sourceLink.id}`,
      `cf://other.test/${piece.space}/${sourceLink.id}`,
    ];
    const originalLoad = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
    const originalLookup = runtime.getCellFromEntityId.bind(runtime);
    let sourceLoads = 0;

    try {
      runtime.patternManager.getPatternSourceProgramByIdentity = ((...args) => {
        sourceLoads++;
        return originalLoad(...args);
      }) as typeof runtime.patternManager.getPatternSourceProgramByIdentity;
      runtime.getCellFromEntityId = ((
        ...args: Parameters<Runtime["getCellFromEntityId"]>
      ) =>
        args[1] === sourceLink.id
          ? sourcePiece
          : originalLookup(...args)) as Runtime["getCellFromEntityId"];
      for (const origin of invalidOrigins) {
        await stampSource(piece, origin);
        await runScheduledCheck(piece);
        expect(getPatternIdentityRef(piece)).toEqual(originalRef);
        expect(getPatternSource(piece)).toBe(origin);
      }
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLoad;
      runtime.getCellFromEntityId = originalLookup;
    }
    expect(targetRef).not.toEqual(originalRef);
    expect(sourceLoads).toBe(0);
  });

  it("does not use a fabric source for the default-root update path", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("default fabric source fetched web source"))
    );
    const runningRef = getPatternIdentityRef(piece)!;
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);

    expect(
      await runtime.patternUpdater.checkDefaultPattern(piece, PARENT_PATH),
    ).toBe("current");
    expect(targetRef).not.toEqual(runningRef);
    expect(getPatternIdentityRef(piece)).toEqual(runningRef);
  });

  it("keeps the current pattern when a pinned fabric target is unavailable", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("missing fabric source fetched web source"))
    );
    const originalRef = getPatternIdentityRef(piece);
    await stampSource(
      piece,
      "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    await runScheduledCheck(piece);

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("rejects a pinned fabric update that changes the piece contract", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("incompatible fabric source fetched web source"))
    );
    const target = await runtime.patternManager.compilePattern(
      parentProgram(sourceWithRequiredInput("v2")),
      { space: piece.space },
    );
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);

    await runScheduledCheck(piece);

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("rechecks a fabric source after conflict catch-up", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("fabric conflict fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let readinessChecks = 0;
    const conflict = Object.assign(new Error("source commit conflicted"), {
      name: "ConflictError",
      readyToRetry: () => {
        readinessChecks++;
      },
    });

    await rejectFirstFabricCommit(piece, conflict, targetRef);

    expect(readinessChecks).toBe(1);
    expect(getPatternIdentityRef(piece)).toEqual(targetRef);
  });

  it("rechecks a fabric source after a local stale-basis rejection", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("fabric stale basis fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    const inconsistent = Object.assign(
      new Error("source commit read stale state"),
      { name: "StorageTransactionInconsistent" },
    );

    await rejectFirstFabricCommit(piece, inconsistent, targetRef);

    expect(getPatternIdentityRef(piece)).toEqual(targetRef);
  });

  it("leaves a fabric update pending when conflict catch-up ends", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("fabric conflict fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let readinessChecks = 0;
    const conflict = Object.assign(new Error("source commit conflicted"), {
      name: "ConflictError",
      readyToRetry: () => {
        readinessChecks++;
        return Promise.reject(new Error("source session ended"));
      },
    });

    await rejectFirstFabricCommit(piece, conflict);

    expect(readinessChecks).toBe(1);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("does not replace a default piece through its fabric origin", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("default fabric piece fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    const assigned = await runtime.editWithRetry((tx) => {
      runtime.getSpaceCell(piece.space).withTx(tx).key("defaultPattern")
        .set(piece.withTx(tx));
    });
    expect(assigned.error).toBeUndefined();

    await runScheduledCheck(piece);

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("does not apply a fabric update after the recorded origin changes", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("stale fabric piece fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    const changedOrigin = `cf:pattern:${originalRef!.identity}`;
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let changed = false;

    try {
      runtime.patternManager.loadPatternByIdentity = (async (...args) => {
        const loaded = await originalLoad(...args);
        if (!changed && args[0] === originalRef!.identity) {
          changed = true;
          await stampSource(piece, changedOrigin);
        }
        return loaded;
      }) as typeof runtime.patternManager.loadPatternByIdentity;
      await runScheduledCheck(piece);
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }

    expect(changed).toBe(true);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBe(changedOrigin);
  });

  it("stops a fabric update before opening its commit transaction", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("stopped fabric piece fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let stopped = false;

    try {
      runtime.patternManager.loadPatternByIdentity = (async (...args) => {
        const loaded = await originalLoad(...args);
        if (!stopped && args[0] === originalRef!.identity) {
          stopped = true;
          runtime.patternUpdater.unwatch(piece);
        }
        return loaded;
      }) as typeof runtime.patternManager.loadPatternByIdentity;
      await runScheduledCheck(piece);
    } finally {
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }

    expect(stopped).toBe(true);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("aborts a fabric update when commit preparation fails", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("failed fabric commit fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    const originalPrepare = runtime.prepareTxForCommit.bind(runtime);
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let prepareCalls = 0;
    let swapTx: ReturnType<Runtime["edit"]> | undefined;

    try {
      runtime.prepareTxForCommit = (tx) => {
        prepareCalls++;
        swapTx = tx;
        throw new Error("simulated fabric commit preparation failure");
      };
      await runScheduledCheck(piece);
    } finally {
      runtime.prepareTxForCommit = originalPrepare;
    }

    expect(prepareCalls).toBe(1);
    expect(swapTx?.status()).toMatchObject({
      status: "error",
      error: {
        name: "StorageTransactionAborted",
        reason: "fabric source update failed",
      },
    });
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("stops a fabric update after setup but before commit", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("stopped fabric setup fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    const originalSetup = runtime.setup.bind(runtime);
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let stopped = false;

    try {
      runtime.setup = ((...args: Parameters<typeof originalSetup>) => {
        const setup = originalSetup(...args);
        if (!stopped && args[0] !== undefined) {
          stopped = true;
          runtime.patternUpdater.unwatch(piece);
        }
        return setup;
      }) as typeof runtime.setup;
      await runScheduledCheck(piece);
    } finally {
      runtime.setup = originalSetup;
    }

    expect(stopped).toBe(true);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("rejects a fabric compile whose artifact does not match its source", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("mismatched fabric source fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const originalRef = getPatternIdentityRef(piece);
    const originalGetEntryRef = runtime.patternManager.getArtifactEntryRef.bind(
      runtime.patternManager,
    );
    await stampSource(piece, `cf:pattern:${targetRef.identity}`);
    let inspected = false;

    try {
      runtime.patternManager.getArtifactEntryRef = ((pattern) => {
        inspected = true;
        const entry = originalGetEntryRef(pattern);
        return entry === undefined
          ? undefined
          : { ...entry, symbol: "DifferentExport" };
      }) as typeof runtime.patternManager.getArtifactEntryRef;
      await runScheduledCheck(piece);
    } finally {
      runtime.patternManager.getArtifactEntryRef = originalGetEntryRef;
    }

    expect(inspected).toBe(true);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("rechecks when a fabric follower changes its recorded origin", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("fabric follower fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
    const sourcePiece = runtime.getCell(
      piece.space,
      `fabric-source-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, target, {}, sourcePiece);
    const sourceLink = sourcePiece.getAsNormalizedFullLink();
    await stampSource(
      piece,
      `cf:/${sourceLink.space}/${sourceLink.id}`,
    );
    await runScheduledCheck(piece);
    expect(getPatternIdentityRef(piece)).toEqual(targetRef);

    const secondTarget = await compileMarkerPattern("v3");
    const secondTargetRef = runtime.patternManager.getArtifactEntryRef(
      secondTarget,
    )!;
    const secondSource = runtime.getCell(
      piece.space,
      `fabric-source-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, secondTarget, {}, secondSource);
    const secondSourceLink = secondSource.getAsNormalizedFullLink();
    const secondOrigin = `cf:/${secondSourceLink.space}/${secondSourceLink.id}`;

    // This metadata notification is the only trigger for the second check.
    await waitForPatternIdentity(
      piece,
      secondTargetRef,
      () => stampSource(piece, secondOrigin),
    );

    expect(secondTargetRef).not.toEqual(targetRef);
    expect(getPatternSource(piece)).toBe(secondOrigin);
    expect(getPatternIdentityRef(piece)).toEqual(secondTargetRef);
  });

  it("ignores a retained follower callback after updater disposal", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("disposed fabric follower fetched web source"))
    );
    const sourcePiece = runtime.getCell(
      piece.space,
      `disposed-fabric-source-${crypto.randomUUID()}`,
    );
    const initial = await compileMarkerPattern("v1");
    await runtime.setup(undefined, initial, {}, sourcePiece);
    const sourceLink = sourcePiece.getAsNormalizedFullLink();
    const origin = `cf:/${sourceLink.space}/${sourceLink.id}`;
    const originalSinkMeta = piece.sinkMeta.bind(piece);
    let retainedCallback: Parameters<typeof piece.sinkMeta>[1] | undefined;

    try {
      piece.sinkMeta = ((field, callback, options) => {
        if (field === "patternSource") retainedCallback = callback;
        return originalSinkMeta(field, callback, options);
      }) as typeof piece.sinkMeta;
      await stampSource(piece, origin);
      await runScheduledCheck(piece);
      expect(retainedCallback).toBeDefined();
      const originalRef = getPatternIdentityRef(piece);
      const originalGetSource = runtime.patternManager
        .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
      let sourceLoads = 0;

      try {
        runtime.patternManager.getPatternSourceProgramByIdentity =
          ((...args) => {
            sourceLoads++;
            return originalGetSource(...args);
          }) as typeof runtime.patternManager.getPatternSourceProgramByIdentity;
        await runtime.patternUpdater.dispose();
        retainedCallback!(
          "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
        await runtime.patternUpdater.idle();
      } finally {
        runtime.patternManager.getPatternSourceProgramByIdentity =
          originalGetSource;
      }

      expect(sourceLoads).toBe(0);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPatternSource(piece)).toBe(origin);
    } finally {
      piece.sinkMeta = originalSinkMeta;
    }
  });

  it("does not install a fabric watcher when disposed during source sync", async () => {
    const piece = await preparePiece(() =>
      Promise.reject(new Error("stopped fabric sync fetched web source"))
    );
    const target = await compileMarkerPattern("v2");
    const sourcePiece = runtime.getCell(
      piece.space,
      `fabric-sync-source-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, target, {}, sourcePiece);
    const sourceLink = sourcePiece.getAsNormalizedFullLink();
    const originalSync = sourcePiece.sync.bind(sourcePiece);
    const originalSinkMeta = sourcePiece.sinkMeta.bind(sourcePiece);
    const originalLookup = runtime.getCellFromEntityId.bind(runtime);
    const originalRef = getPatternIdentityRef(piece);
    const syncEntered = defer<void>();
    const syncRelease = defer<void>();
    let syncCompletion: ReturnType<typeof originalSync> | undefined;
    let sourceSinks = 0;
    await stampSource(
      piece,
      `cf:/${sourceLink.space}/${sourceLink.id}`,
    );

    try {
      runtime.getCellFromEntityId =
        ((...args: Parameters<Runtime["getCellFromEntityId"]>) =>
          args[0] === sourceLink.space && args[1] === sourceLink.id
            ? sourcePiece
            : originalLookup(...args)) as Runtime[
            "getCellFromEntityId"
          ];
      sourcePiece.sinkMeta = ((field, callback, options) => {
        if (field === "patternIdentity") sourceSinks++;
        return originalSinkMeta(field, callback, options);
      }) as typeof sourcePiece.sinkMeta;
      sourcePiece.sync = (() => {
        syncCompletion = (async () => {
          syncEntered.resolve();
          await syncRelease.promise;
          return await originalSync();
        })();
        return syncCompletion;
      }) as typeof sourcePiece.sync;

      runtime.patternUpdater.schedule(piece);
      await syncEntered.promise;
      const disposal = runtime.patternUpdater.dispose();
      syncRelease.resolve();
      // The updater registered its continuation on this same promise before
      // the test did, so Promise reaction FIFO guarantees its in-operation
      // lifecycle check has run when this await returns.
      await syncCompletion!;
      await disposal;
    } finally {
      syncRelease.resolve();
      sourcePiece.sync = originalSync;
      sourcePiece.sinkMeta = originalSinkMeta;
      runtime.getCellFromEntityId = originalLookup;
    }

    expect(sourceSinks).toBe(0);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
  });

  it("leaves repository-pinned patterns untouched when they have a source", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const originalRef = getPatternIdentityRef(piece);
    const update = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, PARENT_PATH);
      setPatternRepository(piece, tx, "https://github.com/example/patterns");
    });
    expect(update.error).toBeUndefined();

    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();

    expect(fetches).toBe(0);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBe(PARENT_PATH);
  });

  it("does not repair provenance after the piece becomes the default", async () => {
    const v1Identity = await identityFor(source("v1"));
    const identityRequested = defer();
    identityGate = defer();
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.searchParams.has("identity")) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v1Identity);
      }
      return new Response("not found", { status: 404 });
    });

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    const promoted = await runtime.editWithRetry((tx) => {
      runtime.getSpaceCell(piece.space).withTx(tx).key("defaultPattern")
        .set(piece.withTx(tx));
    });
    expect(promoted.error).toBeUndefined();

    identityGate.resolve();
    await runtime.patternUpdater.idle();

    expect(getPatternSource(piece)).toBeUndefined();
    expect(getPatternIdentityRef(piece)?.symbol).toBe(SYMBOL);
  });

  it("does not swap identity after the piece becomes the default", async () => {
    const v2Identity = await identityFor(source("v2"));
    const identityRequested = defer();
    identityGate = defer();
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v2Identity);
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v2")
        : undefined;
      return new Response(contents ?? "not found", {
        status: contents === undefined ? 404 : 200,
      });
    });
    const originalRef = getPatternIdentityRef(piece);

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    const promoted = await runtime.editWithRetry((tx) => {
      runtime.getSpaceCell(piece.space).withTx(tx).key("defaultPattern")
        .set(piece.withTx(tx));
    });
    expect(promoted.error).toBeUndefined();

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
    expect((await piece.pull())?.marker).toBe("v1");
  });

  it("starts immediately, then updates a non-root pattern in the background", async () => {
    const v2Identity = await identityFor(source("v2"));
    const identityRequested = defer();
    identityGate = defer();
    const requested: Array<{ href: string; cache?: RequestCache }> = [];
    const piece = await preparePiece(async (input, init) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      requested.push({ href: url.href, cache: init?.cache });
      if (
        url.pathname === PARENT_PATH &&
        url.searchParams.has("identity")
      ) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v2Identity);
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v2")
        : undefined;
      return new Response(contents ?? "not found", {
        status: contents === undefined ? 404 : 200,
        headers: { "content-type": "text/typescript-jsx" },
      });
    });
    const v1Ref = getPatternIdentityRef(piece)!;

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    await runtime.idle();
    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(v1Ref);

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v2");
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: v2Identity,
      symbol: SYMBOL,
    });
    expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    expect(requested).toContainEqual({
      href: `http://toolshed.test${PARENT_PATH}?identity=`,
      cache: "no-cache",
    });
    expect(requested).toContainEqual({
      href: `http://toolshed.test${PARENT_PATH}`,
      cache: "no-cache",
    });
    expect(requested).toContainEqual({
      href: `http://toolshed.test${SOURCE_PATH}`,
      cache: "no-cache",
    });
  });

  it("does not retry a source swap after the piece stops", async () => {
    const v2Identity = await identityFor(source("v2"));
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        return Promise.resolve(new Response(v2Identity));
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v2")
        : undefined;
      return Promise.resolve(
        new Response(contents ?? "not found", {
          status: contents === undefined ? 404 : 200,
        }),
      );
    });
    const stamped = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, PARENT_SOURCE);
    });
    expect(stamped.error).toBeUndefined();
    expect(
      await runtime.start(piece, { schedulePatternUpdate: false }),
    ).toBe(true);
    await runtime.idle();

    const originalRef = getPatternIdentityRef(piece);
    const originalSetupRef = getPatternSetupIdentityRef(piece);
    const firstAttemptStaged = defer();
    const retryGate = defer();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const originalLoadPatternByIdentity = runtime.patternManager
      .loadPatternByIdentity.bind(runtime.patternManager);
    let swapAttempts = 0;
    let retryHarnessInstalled = false;
    runtime.patternManager.loadPatternByIdentity = (async (...args) => {
      const loaded = await originalLoadPatternByIdentity(...args);
      if (
        !retryHarnessInstalled && args[0] === originalRef!.identity &&
        args[1] === originalRef!.symbol
      ) {
        // This is the last awaited operation before the source-swap
        // editWithRetry. Install the harness here so compiler cache writes keep
        // their ordinary transaction behavior.
        retryHarnessInstalled = true;
        runtime.editWithRetry = ((fn, maxRetries) => {
          // Model a retryable rejection after the first callback has staged
          // the swap. The callback is the unit Runtime.editWithRetry invokes
          // again after conflict catch-up.
          const rejectedTx = runtime.edit();
          fn(rejectedTx);
          swapAttempts++;
          rejectedTx.abort("simulated retryable source-swap rejection");
          firstAttemptStaged.resolve();
          return retryGate.promise.then(() =>
            originalEditWithRetry((tx) => {
              swapAttempts++;
              return fn(tx);
            }, maxRetries)
          );
        }) as typeof runtime.editWithRetry;
      }
      return loaded;
    }) as typeof runtime.patternManager.loadPatternByIdentity;

    try {
      runtime.patternUpdater.schedule(piece);
      await firstAttemptStaged.promise;
      runtime.runner.stop(piece);
      retryGate.resolve();
      await runtime.patternUpdater.idle();
      await runtime.idle();
    } finally {
      retryGate.resolve();
      runtime.editWithRetry = originalEditWithRetry;
      runtime.patternManager.loadPatternByIdentity =
        originalLoadPatternByIdentity;
    }

    expect(retryHarnessInstalled).toBe(true);
    expect(swapAttempts).toBe(2);
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSetupIdentityRef(piece)).toEqual(originalSetupRef);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
  });

  it("records a proven system source when its identity is already current", async () => {
    const v1Identity = await identityFor(source("v1"));
    let sourceFetches = 0;
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname !== PARENT_PATH) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (!url.searchParams.has("identity")) sourceFetches++;
      return Promise.resolve(
        url.searchParams.has("identity")
          ? new Response(v1Identity)
          : new Response(parentSource),
      );
    });
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    expect(sourceFetches).toBe(0);
  });

  it("does not retry provenance repair after the piece stops", async () => {
    const v1Identity = await identityFor(source("v1"));
    let repairAttempts = 0;
    let retryHarnessInstalled = false;
    const originalEditWithRetry = {
      current: undefined as Runtime["editWithRetry"] | undefined,
    };
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname !== PARENT_PATH) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (url.searchParams.has("identity")) {
        originalEditWithRetry.current = runtime.editWithRetry.bind(runtime);
        runtime.editWithRetry = ((fn) => {
          retryHarnessInstalled = true;
          const first = runtime.edit();
          fn(first);
          repairAttempts++;
          first.abort("simulated provenance repair rejection");
          runtime.patternUpdater.unwatch(piece);
          const retry = runtime.edit();
          try {
            fn(retry);
          } catch (error) {
            repairAttempts++;
            retry.abort(error);
          }
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: "stopped provenance repair",
            },
          });
        }) as typeof runtime.editWithRetry;
        return Promise.resolve(new Response(v1Identity));
      }
      return Promise.resolve(new Response(parentSource));
    });

    try {
      runtime.patternUpdater.schedule(piece);
      await runtime.patternUpdater.idle();
    } finally {
      if (originalEditWithRetry.current !== undefined) {
        runtime.editWithRetry = originalEditWithRetry.current;
      }
    }

    expect(retryHarnessInstalled).toBe(true);
    expect(repairAttempts).toBe(2);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("does not fetch an entry filename that names no route", async () => {
    let fetches = 0;
    createRuntime(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const space = signer.did();
    const pattern = await runtime.patternManager.compilePattern(
      fileTreeProgram(source("v1")),
      { space },
    );
    const piece = runtime.getCell<{ marker?: string }>(
      space,
      `file-tree-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, pattern, {}, piece);
    const recovered = await runtime.patternManager
      .getPatternSourceProgramByIdentity(
        getPatternIdentityRef(piece)!.identity,
        space,
      );
    // The precondition this guards: a program deployed from a file tree names
    // its entry for the compile root, not for any route. Resolving that name
    // against the host reached the shell's SPA fallback, which answers 200 with
    // HTML for an unrouted path, and the HTML was then compiled as TSX.
    expect(recovered?.main).toBe(FILE_TREE_PATH);

    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();

    expect(fetches).toBe(0);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("re-stamps a legacy absolute origin as a system ref", async () => {
    const v1Identity = await identityFor(source("v1"));
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname !== PARENT_PATH) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        url.searchParams.has("identity")
          ? new Response(v1Identity)
          : new Response(parentSource),
      );
    });
    // The spelling a piece carries once a source transition recorded its route
    // path against the space's host.
    const legacyOrigin = new URL(PARENT_PATH, runtime.apiUrl).href;
    const stamped = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, legacyOrigin);
    });
    expect(stamped.error).toBeUndefined();
    const originalRef = getPatternIdentityRef(piece);

    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    // Re-spelling the origin is an origin change to the history, which is the
    // accepted cost of migrating in place: the pair below is what a reader of
    // the source panel sees once, per piece, and never again. Pinned here so
    // it stays a decision rather than a side effect.
    expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
      .toEqual(["baseline", "origin-update"]);
    // Both revisions name the same file, so the migration moves no source.
    const origins = getPieceSourceRevisions(piece).map((entry) => entry.origin);
    expect(origins).toEqual([legacyOrigin, PARENT_SOURCE]);
  });

  it("repairs an active legacy origin whose retained source probe failed", async () => {
    const v1Identity = await identityFor(source("v1"));
    let sourceFetches = 0;
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        return Promise.resolve(new Response(v1Identity));
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v1")
        : undefined;
      if (contents !== undefined) sourceFetches++;
      return Promise.resolve(
        new Response(contents ?? "not found", {
          status: contents === undefined ? 404 : 200,
        }),
      );
    });
    const stamped = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, PARENT_PATH);
    });
    expect(stamped.error).toBeUndefined();
    const getSource = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
    let failedProbe = false;
    runtime.patternManager.getPatternSourceProgramByIdentity = ((...args) => {
      if (!failedProbe) {
        failedProbe = true;
        return Promise.resolve(undefined);
      }
      return getSource(...args);
    }) as typeof runtime.patternManager.getPatternSourceProgramByIdentity;

    try {
      await runtime.start(piece);
      await runtime.patternUpdater.idle();
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = getSource;
    }

    expect(sourceFetches).toBeGreaterThan(0);
    expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
      .toEqual(["baseline", "origin-update"]);
    expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
  });

  it("rejects an unattended update that changes the piece contract", async () => {
    const incompatible = sourceWithRequiredInput("v2");
    const v2Identity = await identityFor(incompatible);
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        return Promise.resolve(new Response(v2Identity));
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? incompatible
        : undefined;
      return Promise.resolve(
        new Response(contents ?? "not found", {
          status: contents === undefined ? 404 : 200,
        }),
      );
    });
    const original = getPatternIdentityRef(piece);
    const stamped = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, PARENT_PATH);
    });
    expect(stamped.error).toBeUndefined();

    await runtime.start(piece);
    await runtime.patternUpdater.idle();

    expect(getPatternIdentityRef(piece)).toEqual(original);
    expect(getPieceSourceRevisions(piece)).toEqual([]);
    expect((await piece.pull())?.marker).toBe("v1");
  });

  it("leaves an ordinary pattern alone when its source has no identity route", async () => {
    const piece = await preparePiece(() =>
      Promise.resolve(new Response("not found", { status: 404 }))
    );
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("keeps the running pattern when the advertised source does not compile", async () => {
    const invalidSource = [
      "import { pattern } from 'commonfabric';",
      `export const ${SYMBOL} = pattern(() => ({ marker: ; }));`,
      "",
    ].join("\n");
    const invalidIdentity = await identityFor(invalidSource);
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        return Promise.resolve(new Response(invalidIdentity));
      }
      if (url.pathname === PARENT_PATH) {
        return Promise.resolve(new Response(parentSource));
      }
      if (url.pathname === SOURCE_PATH) {
        return Promise.resolve(new Response(invalidSource));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
  });
});
