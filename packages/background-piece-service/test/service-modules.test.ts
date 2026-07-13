import { describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { EXPERIMENTAL_ENV_VARS, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type {
  LegacyBackgroundExclusion,
  LegacyBackgroundExclusionStatus,
} from "@commonfabric/memory/v2";
import {
  isWorkerIPCResponse,
  WorkerIPCMessageType,
} from "../src/worker-ipc.ts";
import { loadEnv } from "../src/env.ts";
import {
  getIdentity,
  isValidDID,
  isValidPieceId,
  setBGPiece,
} from "../src/utils.ts";
import {
  BackgroundPieceService,
  type BackgroundPieceServiceOptions,
} from "../src/service.ts";
import { SpaceManager } from "../src/space-manager.ts";
import {
  WorkerController,
  WorkerControllerErrorEvent,
  WorkerState,
} from "../src/worker-controller.ts";
import {
  createRuntime as createMainRuntime,
  DEFAULT_WORKER_TIMEOUT_MS,
  type MainDependencies,
  parseWorkerTimeout,
  runIfMain as runMainIfMain,
  shutdown,
  startBackgroundPieceService,
} from "../src/main.ts";
import type { BGPieceEntry } from "../bgAdmin.tsx";
import {
  type CastAdminDependencies,
  createRuntime as createCastRuntime,
  defaultCastAdminDependencies,
  main as castAdminMain,
  requireCellCause,
  runIfMain as runCastIfMain,
} from "../cast-admin.ts";
import * as backgroundPieceService from "../src/lib.ts";

const TEST_DID = "did:key:z6Mktestspace";
const OTHER_DID = "did:key:z6Mkotherspace";
const PIECE_ID = `fid1:${"a".repeat(54)}`;
const OTHER_PIECE_ID = `fid1:${"b".repeat(54)}`;

async function runDenoSubprocess(args: string[]): Promise<void> {
  const coverageDir = Deno.env.get("DENO_COVERAGE_DIR");
  const command = new Deno.Command(Deno.execPath(), {
    args,
    env: coverageDir ? { DENO_COVERAGE_DIR: coverageDir } : undefined,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const decoder = new TextDecoder();
    throw new Error(
      `Subprocess failed with code ${code}\n${decoder.decode(stdout)}${
        decoder.decode(stderr)
      }`,
    );
  }
}

class FakeEntryCell {
  updates: Partial<BGPieceEntry>[] = [];
  sinks: ((value: BGPieceEntry) => void)[] = [];
  runtime = {
    editWithRetry: (fn: (tx: unknown) => void) => fn({}),
  };

  constructor(public value: BGPieceEntry) {}

  get(): BGPieceEntry {
    return this.value;
  }

  set(value: BGPieceEntry) {
    this.value = value;
    for (const sink of this.sinks) sink(value);
  }

  withTx(_tx: unknown) {
    return this;
  }

  update(update: Partial<BGPieceEntry>) {
    this.updates.push(update);
    this.value = { ...this.value, ...update };
  }

  sink(fn: (value: BGPieceEntry) => void) {
    this.sinks.push(fn);
    fn(this.value);
    return () => {
      this.sinks = this.sinks.filter((sink) => sink !== fn);
    };
  }
}

class FakePiecesCell {
  syncCount = 0;
  schemaSyncCount = 0;
  pushed: unknown[] = [];
  sinks: ((value: FakeEntryCell[]) => void)[] = [];

  constructor(public entries: FakeEntryCell[] = []) {}

  get() {
    return this.entries;
  }

  getAsLink() {
    return { "/": "fake-bg-pieces" };
  }

  sync() {
    this.syncCount++;
    return Promise.resolve();
  }

  asSchema(_schema: unknown) {
    return {
      sync: () => {
        this.schemaSyncCount++;
        return Promise.resolve();
      },
    };
  }

  withTx(_tx: unknown) {
    return this;
  }

  push(value: unknown) {
    this.pushed.push(value);
    this.entries.push(value as FakeEntryCell);
  }

  sink(fn: (value: FakeEntryCell[]) => void) {
    this.sinks.push(fn);
    fn(this.entries);
    return () => {
      this.sinks = this.sinks.filter((sink) => sink !== fn);
    };
  }

  emit(entries = this.entries) {
    this.entries = entries;
    for (const sink of this.sinks) sink(entries);
  }
}

function pieceEntry(
  overrides: Partial<BGPieceEntry> = {},
): BGPieceEntry {
  return {
    space: TEST_DID,
    pieceId: PIECE_ID,
    integration: "gmail",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    disabledAt: 0,
    lastRun: 0,
    status: "Initializing",
    ...overrides,
  };
}

function fakeRuntime(piecesCell: FakePiecesCell) {
  return {
    experimental: {
      modernCellRep: true,
      persistentSchedulerState: false,
    },
    storageManager: {
      syncedCount: 0,
      synced: function () {
        this.syncedCount++;
        return Promise.resolve();
      },
    },
    getCell(space: string, cause: string, schema: unknown) {
      this.lastGetCell = { space, cause, schema };
      return piecesCell;
    },
    lastGetCell: undefined as unknown,
    editWithRetry(fn: (tx: unknown) => void) {
      fn({});
    },
  };
}

function createUncachedCompileRuntime(url: string, identity: Identity) {
  return new Runtime({
    apiUrl: new URL(url),
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(url),
    }),
    cfcEnforcementMode: "disabled",
  });
}

class MockWorker extends EventTarget {
  static instances: MockWorker[] = [];
  static sendReady = true;
  static respondByDefault = true;
  messages: unknown[] = [];
  terminated = false;
  respond = MockWorker.respondByDefault;

  constructor(public url: string, public options: WorkerOptions) {
    super();
    MockWorker.instances.push(this);
    if (MockWorker.sendReady) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "ready", msgId: -1 },
          }),
        );
      });
    }
  }

  postMessage(message: { msgId: number; type: string }) {
    this.messages.push(message);
    if (this.respond) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { msgId: message.msgId },
          }),
        );
      });
    }
  }

  terminate() {
    this.terminated = true;
  }

  error(message = "worker boom") {
    const event = new ErrorEvent("error", { message });
    this.dispatchEvent(event);
  }
}

async function withMockWorker<T>(fn: () => Promise<T> | T): Promise<T> {
  const originalWorker = globalThis.Worker;
  MockWorker.instances = [];
  MockWorker.sendReady = true;
  MockWorker.respondByDefault = true;
  (globalThis as unknown as { Worker: typeof Worker }).Worker =
    MockWorker as unknown as typeof Worker;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { Worker: typeof Worker }).Worker =
      originalWorker;
  }
}

async function withRealWorker<T>(
  fn: (
    worker: Worker,
    nextMessage: (
      predicate?: (message: Record<string, unknown>) => boolean,
    ) => Promise<Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const worker = new Worker(new URL("../src/worker.ts", import.meta.url).href, {
    type: "module",
  });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }[] = [];

  worker.addEventListener("message", (event) => {
    const message = event.data as Record<string, unknown>;
    const waiterIndex = waiters.findIndex((waiter) =>
      waiter.predicate(message)
    );
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  const nextMessage = (
    predicate: (message: Record<string, unknown>) => boolean = () => true,
  ) => {
    const messageIndex = messages.findIndex(predicate);
    if (messageIndex >= 0) {
      const [message] = messages.splice(messageIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise<Record<string, unknown>>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  };

  try {
    return await fn(worker, nextMessage);
  } finally {
    worker.terminate();
  }
}

async function workerRequest(
  worker: Worker,
  nextMessage: (
    predicate?: (message: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>,
  msgId: number,
  type: WorkerIPCMessageType,
  data?: unknown,
) {
  worker.postMessage(
    data === undefined ? { msgId, type } : { msgId, type, data },
  );
  return await nextMessage((message) => message.msgId === msgId);
}

describe("background piece admin helpers", () => {
  it("executes helper behavior in an isolated compiler shim", async () => {
    await runDenoSubprocess([
      "run",
      "--allow-env",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--import-map",
      new URL("./bg-admin-import-map.json", import.meta.url).pathname,
      new URL("./bg-admin-module-subprocess.ts", import.meta.url).pathname,
    ]);
  });
});

describe("background piece utility functions", () => {
  it("validates worker IPC responses", () => {
    assert(isWorkerIPCResponse({ msgId: 1 }));
    assert(isWorkerIPCResponse({ msgId: 1, error: "failed" }));
    assert(!isWorkerIPCResponse({ msgId: "1" }));
    assert(!isWorkerIPCResponse({ msgId: 1, error: 42 }));
    assert(!isWorkerIPCResponse({ msgId: 1, type: 42 }));
  });

  it("validates dids and piece ids", () => {
    assert(isValidDID(TEST_DID));
    assert(!isValidDID("did:web:example"));
    assert(!isValidDID("did:key:x"));
    assert(isValidPieceId(PIECE_ID));
    assert(!isValidPieceId(""));
    assert(!isValidPieceId("short"));
  });

  it("loads environment defaults", () => {
    // EXPERIMENTAL_* flags are no longer part of EnvVars: createRuntime reads
    // them through the canonical runner mapping (CT-1814); see the
    // "creates a configured runtime" test below.
    const defaults = loadEnv(() => undefined);
    assertEquals(defaults.API_URL, "http://localhost:8000");
    assertEquals(defaults.OPERATOR_PASS, "implicit trust");
  });

  it("loads identities from a key file, a passphrase, or neither", async () => {
    const dir = await Deno.makeTempDir();
    const keyPath = `${dir}/identity.pem`;
    const pkcs8 = await Identity.generatePkcs8();
    await Deno.writeFile(keyPath, pkcs8);

    const fromFile = await getIdentity(keyPath);
    assertEquals(fromFile.did().startsWith("did:key:"), true);

    const fromPassphrase = await getIdentity(undefined, "operator");
    assertEquals(fromPassphrase.did().startsWith("did:key:"), true);

    await assertRejects(
      () => getIdentity(`${dir}/missing.pem`),
      Error,
      `Could not read key at ${dir}/missing.pem.`,
    );
    await assertRejects(
      () => getIdentity(),
      Error,
      "No IDENTITY or OPERATOR_PASS environemnt set.",
    );
    await Deno.remove(dir, { recursive: true });
  });

  it("adds a new background piece and re-enables an existing one", async () => {
    const piecesCell = new FakePiecesCell();
    const runtime = fakeRuntime(piecesCell);

    assertEquals(
      await setBGPiece({
        space: TEST_DID,
        pieceId: PIECE_ID,
        integration: "gmail",
        runtime: runtime as never,
      }),
      true,
    );
    assertEquals(piecesCell.pushed.length, 1);

    const existing = new FakeEntryCell(
      pieceEntry({ disabledAt: Date.now(), status: "Disabled" }),
    );
    piecesCell.entries = [existing];
    assertEquals(
      await setBGPiece({
        space: TEST_DID,
        pieceId: PIECE_ID,
        integration: "gmail",
        runtime: runtime as never,
      }),
      false,
    );
    assertEquals(existing.value.disabledAt, 0);
    assertEquals(existing.value.status, "Re-initializing");
  });
});

describe("BackgroundPieceService", () => {
  it("initializes once, groups enabled pieces by space, and stops removed spaces", async () => {
    const enabled = new FakeEntryCell(pieceEntry());
    const disabled = new FakeEntryCell(
      pieceEntry({ pieceId: OTHER_PIECE_ID, disabledAt: Date.now() }),
    );
    const empty = {
      get: () => undefined,
    };
    const piecesCell = new FakePiecesCell([
      enabled,
      disabled,
      empty as unknown as FakeEntryCell,
    ]);
    const runtime = fakeRuntime(piecesCell);
    const watched: string[][] = [];
    const stopped: string[] = [];
    const started: string[] = [];

    const service = new BackgroundPieceService({
      identity: await Identity.generate({ implementation: "noble" }),
      toolshedUrl: "http://localhost:8000",
      runtime: runtime as never,
      workerTimeoutMs: 123,
      createSpaceManager: (options) => ({
        start: () => started.push(options.did),
        stop: () => {
          stopped.push(options.did);
          return Promise.resolve();
        },
        watch: (entries) => {
          watched.push(entries.map((entry) => entry.get().pieceId));
          return () => {};
        },
      }),
    } as BackgroundPieceServiceOptions);

    await service.initialize();
    await service.initialize();
    assertEquals(started, [TEST_DID]);
    assertEquals(watched, [[PIECE_ID, OTHER_PIECE_ID]]);
    assertEquals(piecesCell.syncCount, 1);
    assertEquals(piecesCell.schemaSyncCount, 1);

    piecesCell.emit([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(stopped, [TEST_DID]);
    await service.stop();
  });

  it("returns immediately when stopped before it starts", async () => {
    const piecesCell = new FakePiecesCell();
    const service = new BackgroundPieceService({
      identity: await Identity.generate({ implementation: "noble" }),
      toolshedUrl: "http://localhost:8000",
      runtime: fakeRuntime(piecesCell) as never,
    });

    assertEquals(await service.stop(), []);
  });

  it("ignores piece updates after the service stops", async () => {
    const entry = new FakeEntryCell(pieceEntry());
    const piecesCell = new FakePiecesCell([entry]);
    const started: string[] = [];
    const stopped: string[] = [];
    const watched: string[][] = [];
    const service = new BackgroundPieceService({
      identity: await Identity.generate({ implementation: "noble" }),
      toolshedUrl: "http://localhost:8000",
      runtime: fakeRuntime(piecesCell) as never,
      createSpaceManager: (options) => ({
        start: () => started.push(options.did),
        stop: () => {
          stopped.push(options.did);
          return Promise.resolve();
        },
        watch: (entries) => {
          watched.push(entries.map((cell) => cell.get().pieceId));
          return () => {};
        },
      }),
    } as BackgroundPieceServiceOptions);

    await service.initialize();
    await service.stop();
    piecesCell.emit([
      new FakeEntryCell(pieceEntry({
        space: OTHER_DID,
        pieceId: OTHER_PIECE_ID,
      })),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(started, [TEST_DID]);
    assertEquals(stopped, [TEST_DID]);
    assertEquals(watched, [[PIECE_ID]]);
  });

  it("passes target-space exclusion control before starting a flagged manager", async () => {
    const entry = new FakeEntryCell(pieceEntry());
    const piecesCell = new FakePiecesCell([entry]);
    const runtime = fakeRuntime(piecesCell);
    (runtime.experimental as Record<string, unknown>).serverPrimaryExecution =
      true;
    const providerCalls: unknown[] = [];
    const exclusion: LegacyBackgroundExclusion = {
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:service",
      servicePrincipal: TEST_DID,
      expiresAt: 1_000,
    };
    (runtime.storageManager as never as {
      open: (did: string) => unknown;
    }).open = (did) => {
      providerCalls.push(["open", did]);
      return {
        acquireLegacyBackgroundExclusion: (branch: string) => {
          providerCalls.push(["acquire", branch]);
          return Promise.resolve({ exclusion, ready: true });
        },
        renewLegacyBackgroundExclusion: (
          branch: string,
          generation: number,
        ) => {
          providerCalls.push(["renew", branch, generation]);
          return Promise.resolve({ exclusion, ready: true });
        },
        releaseLegacyBackgroundExclusion: (
          branch: string,
          generation: number,
        ) => {
          providerCalls.push(["release", branch, generation]);
          return Promise.resolve(exclusion);
        },
      };
    };
    const lifecycle: string[] = [];
    let managerOptions:
      | ConstructorParameters<typeof SpaceManager>[0]
      | undefined;
    const service = new BackgroundPieceService({
      identity: await Identity.generate({ implementation: "noble" }),
      toolshedUrl: "http://localhost:8000",
      runtime: runtime as never,
      createSpaceManager: (options) => {
        managerOptions = options;
        return {
          start: () => lifecycle.push("start"),
          stop: () => Promise.resolve(),
          watch: () => {
            lifecycle.push("watch");
            return () => {};
          },
        };
      },
    });

    await service.initialize();
    assertEquals(lifecycle, ["watch", "start"]);
    assertEquals(providerCalls, [["open", TEST_DID]]);
    const control = managerOptions?.backgroundExclusion;
    assert(control);
    await control.acquire("");
    await control.renew("", 1);
    await control.release("", 1);
    assertEquals(providerCalls, [
      ["open", TEST_DID],
      ["acquire", ""],
      ["renew", "", 1],
      ["release", "", 1],
    ]);
    await service.stop();
  });
});

describe("SpaceManager", () => {
  it("acquires exclusion before worker construction and releases after shutdown", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const acquired = Promise.withResolvers<
      LegacyBackgroundExclusionStatus | null | undefined
    >();
    const shutdown = Promise.withResolvers<void>();
    const events: string[] = [];
    const exclusion: LegacyBackgroundExclusion = {
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:test",
      servicePrincipal: identity.did(),
      expiresAt: 1_100,
    };
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      deactivationTimeoutMs: 1,
      now: () => 100,
      setTimer: () => 1,
      clearTimer: () => {},
      backgroundExclusion: {
        acquire: (branch) => {
          events.push(`acquire:${branch}`);
          return acquired.promise;
        },
        renew: () =>
          Promise.resolve({ exclusion, ready: true, serverTime: 100 }),
        release: (_branch, generation) => {
          events.push(`release:${generation}`);
          return Promise.resolve(exclusion);
        },
      },
      createWorkerController: () => {
        events.push("worker:create");
        return {
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => {
            events.push("worker:shutdown");
            return shutdown.promise;
          },
          terminateNow: () => events.push("worker:terminate"),
        } as never;
      },
    });

    assertEquals(events, []);
    manager.start();
    await Promise.resolve();
    assertEquals(events, ["acquire:"]);
    assertEquals(events.includes("worker:create"), false);

    acquired.resolve({ exclusion, ready: true, serverTime: 100 });
    await manager.idle();
    assertEquals(events, ["acquire:", "worker:create"]);

    const stopping = manager.stop();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(events.includes("worker:shutdown"), true);
    assertEquals(events.includes("release:1"), false);
    shutdown.resolve();
    await stopping;
    assertEquals(events.at(-1), "release:1");
  });

  it("can stop every lifecycle after being restarted", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    let generation = 0;
    let workers = 0;
    let shutdowns = 0;
    let releases = 0;
    const status = (): LegacyBackgroundExclusionStatus => ({
      exclusion: {
        version: 1,
        space: TEST_DID,
        branch: "",
        exclusionGeneration: generation,
        holderId: "background:restart",
        servicePrincipal: identity.did(),
        expiresAt: 1_000,
      },
      ready: true,
      serverTime: 0,
    });
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
      backgroundExclusion: {
        acquire: () => {
          generation++;
          return Promise.resolve(status());
        },
        renew: () => Promise.resolve(status()),
        release: () => {
          releases++;
          return Promise.resolve(status().exclusion);
        },
      },
      createWorkerController: () => {
        workers++;
        return {
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => {
            shutdowns++;
            return Promise.resolve();
          },
          terminateNow: () => {},
        } as never;
      },
    });

    manager.start();
    await manager.idle();
    await manager.stop();
    manager.start();
    await manager.idle();
    await manager.stop();

    assertEquals(workers, 2);
    assertEquals(shutdowns, 2);
    assertEquals(releases, 2);
  });

  it("defers a restart until an overlapping stop lifecycle finishes", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const firstShutdown = Promise.withResolvers<void>();
    const secondShutdown = Promise.withResolvers<void>();
    let generation = 0;
    let workers = 0;
    const releases: number[] = [];
    const status = (): LegacyBackgroundExclusionStatus => ({
      exclusion: {
        version: 1,
        space: TEST_DID,
        branch: "",
        exclusionGeneration: generation,
        holderId: "background:overlapping-restart",
        servicePrincipal: identity.did(),
        expiresAt: 1_000,
      },
      ready: true,
      serverTime: 0,
    });
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      deactivationTimeoutMs: 100,
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
      backgroundExclusion: {
        acquire: () => {
          generation++;
          return Promise.resolve(status());
        },
        renew: () => Promise.resolve(status()),
        release: (_branch, exclusionGeneration) => {
          releases.push(exclusionGeneration);
          return Promise.resolve(status().exclusion);
        },
      },
      createWorkerController: () => {
        const worker = ++workers;
        return {
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => {
            if (worker === 1) return firstShutdown.promise;
            if (worker === 2) return secondShutdown.promise;
            return Promise.resolve();
          },
          terminateNow: () => {},
        } as never;
      },
    });

    manager.start();
    await manager.idle();
    (manager as never as { activePiece: FakeEntryCell | null }).activePiece =
      new FakeEntryCell(pieceEntry());

    const stopping = manager.stop();
    manager.start();
    await manager.idle();

    (manager as never as { activePiece: FakeEntryCell | null }).activePiece =
      null;
    firstShutdown.resolve();
    await stopping;
    await manager.idle();

    assertEquals(
      (manager as never as { isRunning: boolean }).isRunning,
      true,
    );
    assertEquals(workers, 2);
    assertEquals(releases, [1]);
    assertEquals(
      (manager as never as {
        backgroundExclusion: LegacyBackgroundExclusion | null;
      }).backgroundExclusion?.exclusionGeneration,
      2,
    );

    const secondStopping = manager.stop();
    manager.start();
    const finalStopping = manager.stop();
    secondShutdown.resolve();
    await Promise.all([secondStopping, finalStopping]);
    await manager.idle();

    assertEquals(
      (manager as never as { isRunning: boolean }).isRunning,
      false,
    );
    assertEquals(workers, 2);
    assertEquals(releases, [1, 2]);
    assertEquals(
      (manager as never as {
        backgroundExclusion: LegacyBackgroundExclusion | null;
      }).backgroundExclusion,
      null,
    );
  });

  it("waits for client drain and hard-fences renewal loss", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    let now = 100;
    let renewals = 0;
    let nextTimer = 0;
    const timers = new Map<
      number,
      { callback: () => void; delayMs: number; cleared: boolean }
    >();
    const events: string[] = [];
    const exclusion = (expiresAt: number): LegacyBackgroundExclusion => ({
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:test",
      servicePrincipal: identity.did(),
      expiresAt,
    });
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      deactivationTimeoutMs: 1,
      now: () => now,
      setTimer: (callback, delayMs) => {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs, cleared: false });
        return timer;
      },
      clearTimer: (timer) => {
        const current = timers.get(timer);
        if (current) current.cleared = true;
      },
      backgroundExclusion: {
        acquire: () =>
          Promise.resolve({
            exclusion: exclusion(1_100),
            ready: false,
            blockedUntil: 200,
            serverTime: 100,
          }),
        renew: () => {
          renewals++;
          return Promise.resolve(
            renewals === 1
              ? {
                exclusion: exclusion(1_200),
                ready: true,
                serverTime: 200,
              }
              : null,
          );
        },
        release: () => Promise.resolve(exclusion(now)),
      },
      createWorkerController: () => {
        events.push("worker:create");
        return {
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
          terminateNow: (reason: string) => events.push(`terminate:${reason}`),
        } as never;
      },
    });

    const runNextRenewal = async () => {
      const timer = [...timers.values()]
        .filter((entry) => !entry.cleared)
        .toSorted((left, right) => left.delayMs - right.delayMs)[0];
      assert(timer);
      timer.cleared = true;
      timer.callback();
      await Promise.resolve();
      await manager.idle();
    };

    manager.start();
    await Promise.resolve();
    await manager.idle();
    assertEquals(events, []);

    now = 200;
    await runNextRenewal();
    assertEquals(events, ["worker:create"]);

    now = 300;
    await runNextRenewal();
    assertEquals(events, [
      "worker:create",
      "terminate:background exclusion authority lost",
    ]);
    await manager.stop();
  });

  it("hard-fences at local expiry while renewal is hung", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    let now = 100;
    let nextTimer = 0;
    const timers = new Map<
      number,
      { callback: () => void; delayMs: number; cleared: boolean }
    >();
    const events: string[] = [];
    const exclusion: LegacyBackgroundExclusion = {
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:hung-renewal",
      servicePrincipal: identity.did(),
      expiresAt: 200,
    };
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      now: () => now,
      monotonicNow: () => now,
      setTimer: (callback, delayMs) => {
        const timer = ++nextTimer;
        timers.set(timer, { callback, delayMs, cleared: false });
        return timer;
      },
      clearTimer: (timer) => {
        const current = timers.get(timer);
        if (current) current.cleared = true;
      },
      backgroundExclusion: {
        acquire: () =>
          Promise.resolve({ exclusion, ready: true, serverTime: 100 }),
        renew: () => new Promise(() => {}),
        release: () => Promise.resolve(exclusion),
      },
      createWorkerController: () =>
        ({
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
          terminateNow: (reason: string) => events.push(reason),
        }) as never,
    });

    manager.start();
    await manager.idle();
    const activeTimers = () =>
      [...timers.values()].filter((entry) => !entry.cleared)
        .toSorted((left, right) => left.delayMs - right.delayMs);

    now = 150;
    const renewal = activeTimers()[0];
    renewal.cleared = true;
    renewal.callback();

    now = 200;
    const expiry = activeTimers()[0];
    expiry.cleared = true;
    expiry.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(events, ["background exclusion expired locally"]);
    await manager.stop();
  });

  it("anchors server-relative exclusion duration at request start despite clock skew", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const acquired = Promise.withResolvers<
      LegacyBackgroundExclusionStatus | null | undefined
    >();
    let monotonicNow = 0;
    let nextTimer = 0;
    const timers = new Map<number, { delayMs: number; cleared: boolean }>();
    const exclusion: LegacyBackgroundExclusion = {
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:skewed-clock",
      servicePrincipal: identity.did(),
      expiresAt: 200,
    };
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      now: () => -10_000,
      monotonicNow: () => monotonicNow,
      setTimer: (_callback, delayMs) => {
        const timer = ++nextTimer;
        timers.set(timer, { delayMs, cleared: false });
        return timer;
      },
      clearTimer: (timer) => {
        const current = timers.get(timer);
        if (current) current.cleared = true;
      },
      backgroundExclusion: {
        acquire: () => acquired.promise,
        renew: () => new Promise(() => {}),
        release: () => Promise.resolve(exclusion),
      },
      createWorkerController: () =>
        ({
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
          terminateNow: () => {},
        }) as never,
    });

    try {
      manager.start();
      await Promise.resolve();
      monotonicNow = 40;
      acquired.resolve({
        exclusion,
        ready: true,
        serverTime: 100,
      });
      await manager.idle();
      assertEquals(
        [...timers.values()].filter((timer) => !timer.cleared)
          .map((timer) => timer.delayMs).toSorted((a, b) => a - b),
        [30, 60],
      );
    } finally {
      await manager.stop();
    }
  });

  it("fails closed when an old server omits relative exclusion time", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    let workers = 0;
    const exclusion: LegacyBackgroundExclusion = {
      version: 1,
      space: TEST_DID,
      branch: "",
      exclusionGeneration: 1,
      holderId: "background:old-server",
      servicePrincipal: identity.did(),
      expiresAt: 200,
    };
    const manager = new SpaceManager({
      did: TEST_DID,
      toolshedUrl: "http://localhost:8000",
      identity,
      pollingIntervalMs: 1,
      now: () => 100,
      setTimer: () => 1,
      clearTimer: () => {},
      backgroundExclusion: {
        acquire: () => Promise.resolve({ exclusion, ready: true }),
        renew: () => Promise.resolve({ exclusion, ready: true }),
        release: () => Promise.resolve(exclusion),
      },
      createWorkerController: () => {
        workers++;
        return {
          initializeResolve: Promise.resolve(),
          addEventListener: () => {},
          removeEventListener: () => {},
          isReady: () => true,
          runPiece: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
          terminateNow: () => {},
        } as never;
      },
    });

    try {
      manager.start();
      await manager.idle();
      assertEquals(workers, 0);
    } finally {
      await manager.stop();
    }
  });

  it("schedules, runs, retries, disables, and removes pieces", async () => {
    await withMockWorker(async () => {
      const entry = new FakeEntryCell(pieceEntry());
      const workerCalls: string[] = [];
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
        rerunIntervalMs: 5,
      });

      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => true,
        runPiece: (cell: FakeEntryCell) => {
          workerCalls.push(cell.get().pieceId);
          return Promise.resolve();
        },
        shutdown: () => {
          workerCalls.push("shutdown");
          return Promise.resolve();
        },
      };

      const cancel = manager.watch([entry as never]);
      assertEquals(
        (manager as never as { enabledPieces: Map<string, unknown> })
          .enabledPieces.has(PIECE_ID),
        true,
      );

      await (manager as never as {
        processPiece: (pieceId: string, entry: FakeEntryCell) => Promise<void>;
      }).processPiece(PIECE_ID, entry);
      assertEquals(workerCalls, [PIECE_ID]);
      assertEquals(entry.value.status, "Success");

      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => true,
        runPiece: () => {
          throw new Error("graph failed");
        },
        shutdown: () => {
          workerCalls.push("shutdown");
          return Promise.resolve();
        },
      };
      await (manager as never as {
        processPiece: (pieceId: string, entry: FakeEntryCell) => Promise<void>;
      }).processPiece(PIECE_ID, entry);
      assertEquals(entry.value.status, "graph failed");
      await (manager as never as {
        processPiece: (pieceId: string, entry: FakeEntryCell) => Promise<void>;
      }).processPiece(PIECE_ID, entry);
      await (manager as never as {
        processPiece: (pieceId: string, entry: FakeEntryCell) => Promise<void>;
      }).processPiece(PIECE_ID, entry);
      assert(entry.value.disabledAt > 0);
      assertStringIncludes(entry.value.status, "Disabled: graph failed");

      await (manager as never as {
        processPiece: (pieceId: string, entry: FakeEntryCell) => Promise<void>;
      }).processPiece(PIECE_ID, entry);
      manager.watch([]);
      cancel();
      await manager.stop();
      assert(workerCalls.includes("shutdown"));
    });
  });

  it("starts and stops the execution loop", async () => {
    await withMockWorker(async () => {
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
      });
      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => false,
        shutdown: async () => {},
      };

      manager.start();
      manager.start();
      await new Promise((resolve) => setTimeout(resolve, 2));
      await manager.stop();
      assertEquals(
        (manager as never as { isRunning: boolean }).isRunning,
        false,
      );
    });
  });

  it("removes disabled and unwatched pieces and waits for active work on stop", async () => {
    await withMockWorker(async () => {
      const first = new FakeEntryCell(pieceEntry());
      const second = new FakeEntryCell(pieceEntry({ pieceId: OTHER_PIECE_ID }));
      const shutdowns: string[] = [];
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 10,
      });

      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => true,
        shutdown: () => {
          shutdowns.push("shutdown");
          return Promise.resolve();
        },
      };

      manager.watch([first as never, second as never]);
      first.set({ ...first.value, disabledAt: Date.now() });
      assertEquals(
        (manager as never as { enabledPieces: Map<string, unknown> })
          .enabledPieces.has(PIECE_ID),
        false,
      );

      manager.watch([first as never]);
      assertEquals(
        (manager as never as { enabledPieces: Map<string, unknown> })
          .enabledPieces.has(OTHER_PIECE_ID),
        false,
      );

      (manager as never as { activePiece: FakeEntryCell | null }).activePiece =
        second;
      setTimeout(() => {
        (manager as never as { activePiece: FakeEntryCell | null })
          .activePiece = null;
      }, 0);
      await manager.stop();
      assertEquals(shutdowns, ["shutdown"]);
    });
  });

  it("executes each branch of the scheduler loop", async () => {
    await withMockWorker(async () => {
      const entry = new FakeEntryCell(pieceEntry());
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
      });

      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => false,
        shutdown: () => Promise.resolve(),
      };
      (manager as never as { isRunning: boolean }).isRunning = true;
      setTimeout(() => {
        (manager as never as { isRunning: boolean }).isRunning = false;
      }, 2);
      await (manager as never as { execLoop: () => Promise<void> }).execLoop();

      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => true,
        shutdown: () => Promise.resolve(),
      };
      (manager as never as { activePiece: FakeEntryCell | null }).activePiece =
        entry;
      (manager as never as { isRunning: boolean }).isRunning = true;
      setTimeout(() => {
        (manager as never as { activePiece: FakeEntryCell | null })
          .activePiece = null;
        (manager as never as { isRunning: boolean }).isRunning = false;
      }, 2);
      await (manager as never as { execLoop: () => Promise<void> }).execLoop();

      (manager as never as { pendingTasks: unknown[] }).pendingTasks = [{
        pieceId: PIECE_ID,
        entry,
        timestamp: Date.now() + 10,
      }];
      (manager as never as { isRunning: boolean }).isRunning = true;
      setTimeout(() => {
        (manager as never as { isRunning: boolean }).isRunning = false;
      }, 2);
      await (manager as never as { execLoop: () => Promise<void> }).execLoop();

      const calls: string[] = [];
      (manager as never as { workerController: unknown }).workerController = {
        isReady: () => true,
        runPiece: () => {
          calls.push("run");
          (manager as never as { isRunning: boolean }).isRunning = false;
          return Promise.resolve();
        },
        shutdown: () => Promise.resolve(),
      };
      (manager as never as { enabledPieces: Map<string, FakeEntryCell> })
        .enabledPieces.set(PIECE_ID, entry);
      (manager as never as { failureTracking: Map<string, number> })
        .failureTracking.set(PIECE_ID, 1);
      (manager as never as { pendingTasks: unknown[] }).pendingTasks = [{
        pieceId: PIECE_ID,
        entry,
        timestamp: Date.now() - 1,
      }];
      (manager as never as { isRunning: boolean }).isRunning = true;
      await (manager as never as { execLoop: () => Promise<void> }).execLoop();
      assertEquals(calls, ["run"]);
      assertEquals(
        (manager as never as { failureTracking: Map<string, number> })
          .failureTracking.has(PIECE_ID),
        false,
      );
      await manager.stop();
    });
  });

  it("disables pieces and recreates workers after terminal failures", async () => {
    await withMockWorker(async () => {
      const entry = new FakeEntryCell(pieceEntry());
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
        timeoutMs: 1,
      });

      manager.watch([entry as never]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      MockWorker.instances.at(-1)!.error("terminal failure");
      await new Promise((resolve) => setTimeout(resolve, 5));

      assert(entry.value.disabledAt > 0);
      assertStringIncludes(entry.value.status, "TerminalError");
      assert(MockWorker.instances.length >= 2);
      await manager.stop();
    });
  });

  it("disables pieces when worker initialization fails", async () => {
    await withMockWorker(async () => {
      MockWorker.respondByDefault = false;
      const entry = new FakeEntryCell(pieceEntry());
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
        timeoutMs: 1,
      });
      manager.watch([entry as never]);
      setTimeout(() => {
        MockWorker.respondByDefault = true;
      }, 0);
      await new Promise((resolve) => setTimeout(resolve, 8));

      assert(entry.value.disabledAt > 0);
      assertStringIncludes(entry.value.status, "Failed to initialize worker");
      await manager.stop();
    });
  });

  it("logs when an old worker fails during restart", async () => {
    await withMockWorker(async () => {
      const manager = new SpaceManager({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        pollingIntervalMs: 1,
        deactivationTimeoutMs: 1,
      });
      let removed = false;
      (manager as never as { workerController: unknown }).workerController = {
        removeEventListener: () => {
          removed = true;
        },
        shutdown: () => Promise.reject(new Error("old shutdown failed")),
      };

      await (manager as never as {
        setupWorkerController: () => Promise<void>;
      }).setupWorkerController();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assertEquals(removed, true);
      await manager.stop();
    });
  });
});

describe("background worker", () => {
  it("handles ready, invalid requests, initialization, run errors, and cleanup", async () => {
    await withRealWorker(async (worker, nextMessage) => {
      const identity = await Identity.generate({ implementation: "noble" });
      const ready = await nextMessage((message) => message.type === "ready");
      assertEquals(ready.msgId, -1);

      worker.postMessage({
        msgId: 1,
        type: "initialize",
        data: { rawIdentity: { privateKey: "secret" } },
      });
      const invalid = await nextMessage((message) => message.msgId === 1);
      assertStringIncludes(String(invalid.error), "<REDACTED>");

      const cleanupBeforeInitialize = await workerRequest(
        worker,
        nextMessage,
        2,
        WorkerIPCMessageType.Cleanup,
      );
      assertEquals("error" in cleanupBeforeInitialize, false);

      const runBeforeInitialize = await workerRequest(
        worker,
        nextMessage,
        3,
        WorkerIPCMessageType.Run,
        { pieceId: "bad" },
      );
      assertStringIncludes(
        String(runBeforeInitialize.error),
        "Worker session not initialized",
      );

      const initialized = await workerRequest(
        worker,
        nextMessage,
        4,
        WorkerIPCMessageType.Initialize,
        {
          did: identity.did(),
          toolshedUrl: "memory://bg-worker-test",
          rawIdentity: identity.serialize(),
          experimental: { modernCellRep: true },
        },
      );
      assertEquals("error" in initialized, false);

      const initializedAgain = await workerRequest(
        worker,
        nextMessage,
        5,
        WorkerIPCMessageType.Initialize,
        {
          did: identity.did(),
          toolshedUrl: "memory://bg-worker-test",
          rawIdentity: identity.serialize(),
        },
      );
      assertEquals("error" in initializedAgain, false);

      const invalidPiece = await workerRequest(
        worker,
        nextMessage,
        6,
        WorkerIPCMessageType.Run,
        { pieceId: "bad" },
      );
      assertStringIncludes(
        String(invalidPiece.error),
        "Piece ID is not a valid entity id",
      );

      const cleanup = await workerRequest(
        worker,
        nextMessage,
        7,
        WorkerIPCMessageType.Cleanup,
      );
      assertEquals("error" in cleanup, false);
      const cleanupAgain = await workerRequest(
        worker,
        nextMessage,
        8,
        WorkerIPCMessageType.Cleanup,
      );
      assertEquals("error" in cleanupAgain, false);
    });
  });

  it("executes module helper branches in an isolated subprocess", async () => {
    await runDenoSubprocess([
      "run",
      "--allow-env",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      new URL("./worker-module-subprocess.ts", import.meta.url).pathname,
    ]);
  });
});

describe("WorkerController", () => {
  it("initializes, runs a piece, shuts down, and reports worker errors", async () => {
    await withMockWorker(async () => {
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
      });
      await controller.initializeResolve;
      assertEquals(controller.isReady(), true);

      const entry = new FakeEntryCell(pieceEntry());
      await controller.runPiece(entry as never);
      await controller.shutdown();
      const worker = MockWorker.instances[0];
      assertEquals(worker.terminated, true);
      assertEquals(
        worker.messages.map((message) =>
          (message as { type: WorkerIPCMessageType }).type
        ),
        [
          WorkerIPCMessageType.Initialize,
          WorkerIPCMessageType.Run,
          WorkerIPCMessageType.Cleanup,
        ],
      );

      const errorController = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
      });
      await errorController.initializeResolve;
      let errorSeen = false;
      errorController.addEventListener("error", (event) => {
        assert(event instanceof WorkerControllerErrorEvent);
        errorSeen = true;
      });
      MockWorker.instances.at(-1)!.error();
      assertEquals(errorSeen, true);
    });
  });

  it("rejects invalid state changes and timed out worker requests", async () => {
    await withMockWorker(async () => {
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        timeoutMs: 1,
      });
      await controller.initializeResolve;
      await assertRejects(
        () =>
          (controller as never as {
            startInitialize: () => Promise<void>;
          }).startInitialize(),
        Error,
        "Worker is not uninitialized.",
      );
      await controller.shutdown();
      await assertRejects(
        () => controller.shutdown(),
        Error,
        `Worker is already ${WorkerState.Terminated}.`,
      );

      MockWorker.sendReady = false;
      MockWorker.respondByDefault = false;
      const timeoutController = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        timeoutMs: 1,
      });
      await assertRejects(
        () =>
          (timeoutController as never as {
            exec: (type: WorkerIPCMessageType) => Promise<void>;
          }).exec(WorkerIPCMessageType.Cleanup),
        Error,
        "Worker timed out.",
      );

      await assertRejects(
        () =>
          (timeoutController as never as {
            startInitialize: () => Promise<void>;
          }).startInitialize(),
        Error,
        "Worker timed out.",
      );
    });
  });

  it("rejects work before ready and handles malformed worker responses", async () => {
    await withMockWorker(async () => {
      MockWorker.sendReady = false;
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        timeoutMs: 1,
      });
      await assertRejects(
        () => controller.runPiece(new FakeEntryCell(pieceEntry()) as never),
        Error,
        "Worker not ready.",
      );
      assertThrows(
        () =>
          (controller as never as {
            exec: (type: WorkerIPCMessageType) => Promise<void>;
          }).exec(WorkerIPCMessageType.Initialize),
        Error,
        "invalid IPC request.",
      );

      (controller as never as {
        onWorkerMessage: (event: MessageEvent) => void;
      }).onWorkerMessage(new MessageEvent("message", { data: { bad: true } }));
      (controller as never as {
        onWorkerMessage: (event: MessageEvent) => void;
      }).onWorkerMessage(new MessageEvent("message", { data: { msgId: 999 } }));
    });
  });

  it("rejects pending requests when shutting down", async () => {
    await withMockWorker(async () => {
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
        timeoutMs: 1,
      });
      await controller.initializeResolve;
      const worker = MockWorker.instances.at(-1)!;
      worker.respond = false;

      const pending = controller.runPiece(
        new FakeEntryCell(pieceEntry()) as never,
      )
        .then(
          () => "resolved",
          (error) => error instanceof Error ? error.message : String(error),
        );
      await controller.shutdown();
      assertEquals(await pending, "Worker shutting down.");
    });
  });

  it("terminates immediately when background authority is lost", async () => {
    await withMockWorker(async () => {
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
      });
      await controller.initializeResolve;
      const worker = MockWorker.instances.at(-1)!;
      worker.respond = false;
      const pending = controller.runPiece(
        new FakeEntryCell(pieceEntry()) as never,
      ).then(
        () => "resolved",
        (error) => error instanceof Error ? error.message : String(error),
      );

      controller.terminateNow("background execution authority lost");
      controller.terminateNow("already terminated");

      assertEquals(worker.terminated, true);
      assertEquals(controller.isReady(), false);
      assertEquals(await pending, "background execution authority lost");
    });
  });

  it("rejects requests when the worker returns an error response", async () => {
    await withMockWorker(async () => {
      const controller = new WorkerController({
        did: TEST_DID,
        toolshedUrl: "http://localhost:8000",
        identity: await Identity.generate({ implementation: "noble" }),
      });
      await controller.initializeResolve;
      const worker = MockWorker.instances.at(-1)!;
      worker.respond = false;

      const pending = (controller as never as {
        exec: (type: WorkerIPCMessageType) => Promise<void>;
      }).exec(WorkerIPCMessageType.Cleanup);
      const message = worker.messages.at(-1) as { msgId: number };
      (controller as never as {
        onWorkerMessage: (event: MessageEvent) => void;
      }).onWorkerMessage(
        new MessageEvent("message", {
          data: { msgId: message.msgId, error: "worker failed" },
        }),
      );

      await assertRejects(() => pending, Error, "worker failed");
    });
  });
});

describe("background piece service entry point", () => {
  it("parses worker timeouts", () => {
    assertEquals(parseWorkerTimeout([]), DEFAULT_WORKER_TIMEOUT_MS);
    assertEquals(parseWorkerTimeout(["--timeout", "42"]), 42);
    assertEquals(
      parseWorkerTimeout(["--timeout", "nope"]),
      DEFAULT_WORKER_TIMEOUT_MS,
    );
  });

  it("creates a configured runtime", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const runtime = createMainRuntime(
      {
        API_URL: "memory://main-runtime-test",
        OPERATOR_PASS: "operator",
        IDENTITY: undefined,
        ENV: "test",
        OTEL_ENABLED: false,
        OTEL_SERVICE_NAME: "bg-piece-service",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      },
      identity,
      // Experimental flags flow through the injectable reader and the
      // canonical runner mapping, not EnvVars (CT-1814).
      (key) => key === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
    );
    assertEquals(runtime.experimental.modernCellRep, true);
    await runtime.dispose();
  });

  it("starts the service and wires shutdown handlers", async () => {
    const signals: Record<string, () => void> = {};
    const exitCodes: number[] = [];
    const service = {
      initializeCalled: 0,
      stopCalled: 0,
      initialize() {
        this.initializeCalled++;
        return Promise.resolve();
      },
      stop() {
        this.stopCalled++;
        return Promise.resolve([]);
      },
    };
    const dependencies: MainDependencies = {
      env: {
        API_URL: "http://localhost:8000",
        OPERATOR_PASS: "operator",
        IDENTITY: undefined,
        ENV: "test",
        OTEL_ENABLED: false,
        OTEL_SERVICE_NAME: "bg-piece-service",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      },
      getIdentity: async () =>
        await Identity.generate({ implementation: "noble" }),
      createRuntime: (_env, _identity) => ({ fakeRuntime: true } as never),
      createService: (options) => {
        assertEquals(options.toolshedUrl, "http://localhost:8000");
        assertEquals(options.workerTimeoutMs, 99);
        return service as never;
      },
      addSignalListener: ((signal: Deno.Signal, handler: () => void) => {
        signals[signal] = handler;
      }) as typeof Deno.addSignalListener,
      exit: ((code?: number) => {
        exitCodes.push(code ?? 0);
      }) as typeof Deno.exit,
      log: () => {},
    };

    assertEquals(
      await startBackgroundPieceService(["--timeout", "99"], dependencies),
      service,
    );
    assertEquals(service.initializeCalled, 1);
    assert(Object.keys(signals).includes("SIGINT"));
    assert(Object.keys(signals).includes("SIGTERM"));

    try {
      signals.SIGINT();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } catch (_error) {
      // The fake exit throws so the test can observe it.
    }
    assertEquals(service.stopCalled, 1);
    assertEquals(exitCodes, [0]);
  });

  const failingDeps = (
    initialize: () => Promise<unknown>,
  ): MainDependencies => ({
    env: {
      API_URL: "http://localhost:8000",
      OPERATOR_PASS: "operator",
      IDENTITY: undefined,
      ENV: "test",
      OTEL_ENABLED: false,
      OTEL_SERVICE_NAME: "bg-piece-service",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    },
    getIdentity: async () =>
      await Identity.generate({ implementation: "noble" }),
    createRuntime: (_env, _identity) => ({ fakeRuntime: true } as never),
    createService: () =>
      ({ initialize, stop: () => Promise.resolve([]) }) as never,
    addSignalListener: (() => {}) as typeof Deno.addSignalListener,
    exit: (() => {}) as typeof Deno.exit,
    log: () => {},
  });

  it("records an Error failure on the startup span and rethrows", async () => {
    await assertRejects(
      () =>
        startBackgroundPieceService(
          [],
          failingDeps(() => Promise.reject(new Error("initialize boom"))),
        ),
      Error,
      "initialize boom",
    );
  });

  it("records a non-Error failure on the startup span and rethrows", async () => {
    await assertRejects(() =>
      startBackgroundPieceService(
        [],
        failingDeps(() => Promise.reject("string boom")),
      )
    );
  });

  it("builds a shutdown callback", async () => {
    const calls: string[] = [];
    const callback = shutdown(
      {
        stop: () => {
          calls.push("stop");
          return Promise.resolve([]);
        },
      },
      ((code?: number) => {
        calls.push(`exit:${code}`);
      }) as typeof Deno.exit,
    );
    try {
      callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } catch (_error) {
      // The fake exit throws so the test can observe it.
    }
    assertEquals(calls, ["stop", "exit:0"]);
  });

  it("still exits when stop() rejects", async () => {
    const calls: string[] = [];
    const callback = shutdown(
      {
        stop: () => {
          calls.push("stop");
          return Promise.reject(new Error("stop boom"));
        },
      },
      ((code?: number) => {
        calls.push(`exit:${code}`);
      }) as typeof Deno.exit,
    );
    // A rejected stop()/flush must still reach exit(0) — otherwise the signal
    // handler hangs until the orchestrator force-kills the process.
    await callback();
    assertEquals(calls, ["stop", "exit:0"]);
  });

  it("runs the service entry point only when invoked as main", async () => {
    let calls = 0;
    await runMainIfMain(false, () => {
      calls++;
      return Promise.resolve();
    });
    await runMainIfMain(true, () => {
      calls++;
      return Promise.resolve();
    });
    assertEquals(calls, 1);
  });
});

describe("cast admin entry point", () => {
  function fakeCastDependencies(
    overrides: Partial<CastAdminDependencies> = {},
  ): CastAdminDependencies & { exitCodes: number[] } {
    const exitCodes: number[] = [];
    const targetCell = {
      syncCount: 0,
      sync() {
        this.syncCount++;
        return Promise.resolve();
      },
    };
    const runtime = {
      storageManager: {
        syncedCount: 0,
        synced() {
          this.syncedCount++;
          return Promise.resolve();
        },
      },
      getCell(space: string, cause: string, schema: unknown) {
        this.lastGetCell = { space, cause, schema };
        return targetCell;
      },
      lastGetCell: undefined as unknown,
    };

    return {
      args: ["--patternPath", "bgAdmin.tsx"],
      envGet: (key) =>
        key === "API_URL"
          ? "http://localhost:8000"
          : key === "OPERATOR_PASS"
          ? "operator"
          : undefined,
      getIdentity: async () =>
        await Identity.generate({ implementation: "noble" }),
      createRuntime: () => runtime as never,
      readTextFile: () =>
        Promise.resolve("export default pattern(() => ({}));"),
      createSession: () => Promise.resolve({ fakeSession: true } as never),
      createPieceManager: () => ({
        ready: Promise.resolve(),
        runPersistent: () => Promise.resolve({ entityId: "fid1:cast" }),
      }),
      compileAndSavePattern: () =>
        Promise.resolve({ fakePattern: true } as never),
      exit: ((code?: number) => {
        exitCodes.push(code ?? 0);
      }) as typeof Deno.exit,
      log: () => {},
      error: () => {},
      ...overrides,
      exitCodes,
    };
  }

  it("builds default dependencies and validates the target cell cause", async () => {
    assertEquals(requireCellCause("bg-pieces"), "bg-pieces");
    assertThrows(
      () => requireCellCause(undefined),
      Error,
      "Cell ID is required",
    );

    const dependencies = defaultCastAdminDependencies();
    assertEquals(dependencies.args, Deno.args);
    assertEquals(dependencies.envGet, Deno.env.get);

    const identity = await Identity.generate({ implementation: "noble" });
    const runtime = createCastRuntime("memory://cast-default-deps", identity);
    try {
      const session = await dependencies.createSession({
        identity,
        spaceDid: identity.did() as never,
      });
      const pieceManager = dependencies.createPieceManager(session, runtime);
      await pieceManager.ready;
    } finally {
      await runtime.dispose();
    }
  });

  it("compiles the actual admin pattern source", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const runtime = createUncachedCompileRuntime(
      "memory://cast-admin-compile",
      identity,
    );
    try {
      const source = await Deno.readTextFile(
        new URL("../bgAdmin.tsx", import.meta.url),
      );
      const pattern = await defaultCastAdminDependencies()
        .compileAndSavePattern(
          runtime,
          source,
          { space: identity.did() },
        );
      assert(pattern);
    } finally {
      await runtime.dispose();
    }
  });

  it("exits with usage when no pattern path is provided", async () => {
    const errors: unknown[][] = [];
    const dependencies = fakeCastDependencies({
      args: [],
      error: (...args: unknown[]) => errors.push(args),
    });
    await castAdminMain(dependencies);
    assertEquals((dependencies as never as { exitCodes: number[] }).exitCodes, [
      1,
    ]);
    assertStringIncludes(String(errors[0][0]), "Usage:");
  });

  it("casts the admin pattern and exits successfully", async () => {
    const logs: unknown[][] = [];
    const dependencies = fakeCastDependencies({
      log: (...args: unknown[]) => logs.push(args),
    });
    await castAdminMain(dependencies);
    assertEquals((dependencies as never as { exitCodes: number[] }).exitCodes, [
      0,
    ]);
    assert(
      logs.some((entry) => entry.includes("Pattern compiled successfully")),
    );
    assert(logs.some((entry) => entry.includes("Pattern cast successfully!")));
  });

  it("creates the cast runtime", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const runtime = createCastRuntime("memory://cast-runtime-test", identity);
    const cell = runtime.getCell(identity.did(), "cast-runtime-test", {
      type: "object",
      properties: {},
    });
    await cell.sync();
    await runtime.storageManager.synced();
    await runtime.dispose();
  });

  it("threads the injected env reader into the cast runtime's experimental flags", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const consulted = new Set<string>();
    const runtime = createCastRuntime(
      "memory://cast-env-reader",
      identity,
      (key) => {
        consulted.add(key);
        return undefined;
      },
    );
    try {
      // The canonical mapping consults the reader passed through the
      // CastAdminDependencies boundary — not process env — for every
      // env-wired EXPERIMENTAL_* flag.
      for (const envVar of Object.values(EXPERIMENTAL_ENV_VARS)) {
        if (envVar !== null) assert(consulted.has(envVar));
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("syncs and exits with failure when casting fails with quit", async () => {
    const errors: unknown[][] = [];
    const dependencies = fakeCastDependencies({
      args: ["--patternPath", "bgAdmin.tsx", "--quit"],
      compileAndSavePattern: () => {
        throw new Error("compile failed");
      },
      error: (...args: unknown[]) => errors.push(args),
    });
    await castAdminMain(dependencies);
    assertEquals((dependencies as never as { exitCodes: number[] }).exitCodes, [
      1,
    ]);
    assertStringIncludes(String(errors[0][1]), "compile failed");
  });

  it("runs the cast entry point only when invoked as main", async () => {
    let calls = 0;
    await runCastIfMain(false, () => {
      calls++;
      return Promise.resolve();
    });
    await runCastIfMain(true, () => {
      calls++;
      return Promise.resolve();
    });
    assertEquals(calls, 1);
  });
});

describe("package exports", () => {
  it("exposes the background service API", () => {
    assert(backgroundPieceService.BackgroundPieceService);
    assert(backgroundPieceService.BG_CELL_CAUSE);
    assert(backgroundPieceService.BG_SYSTEM_SPACE_ID);
    assert(backgroundPieceService.BGPieceEntrySchema);
    assert(backgroundPieceService.setBGPiece);
  });
});
