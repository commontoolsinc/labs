import { download } from "@denosaurs/plug";
import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import type { ExecutionLease } from "../v2.ts";

const SPACE = "did:key:z6Mk-execution-lease-transaction-clock";
const INITIAL_NOW_MS = 1_000;
const LEASE_TTL_MS = 100_000;
const CLAIM_TTL_MS = 10_000;

type WorkerReply =
  | { type: "booted" }
  | { type: "holder-ready" }
  | { type: "executor-ready"; expiresAt: number; claimExpiresAt: number }
  | { type: "locked" }
  | { type: "released" }
  | { type: "renew-starting" }
  | { type: "commit-starting" }
  | {
    type: "clock-sampled";
    operation: "renew" | "commit" | "claimed-commit";
    nowMs: number;
  }
  | { type: "claim-selected"; nowMs: number }
  | { type: "renew-result"; lease: ExecutionLease | null }
  | {
    type: "commit-result";
    accepted: boolean;
    seq?: number;
    errorName?: string;
    errorMessage?: string;
    document: unknown;
  }
  | { type: "closed" }
  | { type: "error"; message: string; stack?: string };

const nextWorkerReply = <T extends WorkerReply["type"]>(
  worker: Worker,
  type: T,
): Promise<Extract<WorkerReply, { type: T }>> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.type === "error") {
        cleanup();
        reject(new Error(event.data.stack ?? event.data.message));
        return;
      }
      if (event.data.type !== type) return;
      cleanup();
      resolve(event.data as Extract<WorkerReply, { type: T }>);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });

type Harness = {
  executor: Worker;
  holder: Worker;
  clock: Int32Array;
  gate: Int32Array;
  expiresAt: number;
  claimExpiresAt: number;
};

const withHarness = async (
  run: (harness: Harness) => Promise<void>,
): Promise<void> => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/`);
  const sqlitePath = await download({
    name: "sqlite3",
    url: "https://github.com/denodrivers/sqlite3/releases/download/0.12.0/",
    suffixes: { aarch64: "_aarch64" },
  });
  const previousSqlitePath = Deno.env.get("DENO_SQLITE_PATH");
  Deno.env.set("DENO_SQLITE_PATH", sqlitePath);

  const fixture = new URL(
    "./fixtures/v2-execution-lease-transaction-clock-worker.ts",
    import.meta.url,
  ).href;
  const clock = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  const gate = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  Atomics.store(clock, 0, INITIAL_NOW_MS);
  Atomics.store(gate, 0, 0);

  const executor = new Worker(fixture, { type: "module" });
  const holder = new Worker(fixture, { type: "module" });
  let executorInitialized = false;
  let holderInitialized = false;
  try {
    await Promise.all([
      nextWorkerReply(executor, "booted"),
      nextWorkerReply(holder, "booted"),
    ]);

    const executorReady = nextWorkerReply(executor, "executor-ready");
    executor.postMessage({
      type: "init-executor",
      store: store.href,
      space: SPACE,
      clock: clock.buffer,
      leaseTtlMs: LEASE_TTL_MS,
      claimTtlMs: CLAIM_TTL_MS,
    });
    const ready = await executorReady;
    executorInitialized = true;

    const holderReady = nextWorkerReply(holder, "holder-ready");
    holder.postMessage({
      type: "init-holder",
      database: resolveSpaceStoreUrl(store, SPACE).href,
      gate: gate.buffer,
    });
    await holderReady;
    holderInitialized = true;

    await run({
      executor,
      holder,
      clock,
      gate,
      expiresAt: ready.expiresAt,
      claimExpiresAt: ready.claimExpiresAt,
    });
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);

    const closes: Promise<unknown>[] = [];
    if (holderInitialized) {
      closes.push(nextWorkerReply(holder, "closed"));
      holder.postMessage({ type: "close" });
    }
    if (executorInitialized) {
      closes.push(nextWorkerReply(executor, "closed"));
      executor.postMessage({ type: "close" });
    }
    await Promise.allSettled(closes);
    holder.terminate();
    executor.terminate();

    if (previousSqlitePath === undefined) {
      Deno.env.delete("DENO_SQLITE_PATH");
    } else {
      Deno.env.set("DENO_SQLITE_PATH", previousSqlitePath);
    }
    await Deno.remove(directory, { recursive: true });
  }
};

const holdWriteLock = async (harness: Harness): Promise<void> => {
  const locked = nextWorkerReply(harness.holder, "locked");
  harness.holder.postMessage({ type: "hold-lock" });
  await locked;
};

const releaseWriteLock = async (harness: Harness): Promise<void> => {
  const released = nextWorkerReply(harness.holder, "released");
  Atomics.store(harness.gate, 0, 1);
  Atomics.notify(harness.gate, 0);
  await released;
};

Deno.test("execution lease renewal samples the configured clock after BEGIN IMMEDIATE", async () => {
  await withHarness(async (harness) => {
    Atomics.store(harness.clock, 0, harness.expiresAt - 1);
    await holdWriteLock(harness);

    const starting = nextWorkerReply(harness.executor, "renew-starting");
    const sampled = nextWorkerReply(harness.executor, "clock-sampled");
    const result = nextWorkerReply(harness.executor, "renew-result");
    harness.executor.postMessage({ type: "renew" });
    await starting;

    Atomics.store(harness.clock, 0, harness.expiresAt + 1);
    await releaseWriteLock(harness);

    assertEquals(await sampled, {
      type: "clock-sampled",
      operation: "renew",
      nowMs: harness.expiresAt + 1,
    });

    assertEquals(
      (await result).lease,
      null,
      "an elapsed lease must not renew after waiting for the write lock",
    );
  });
});

Deno.test("leased commits sample the configured clock after BEGIN IMMEDIATE", async () => {
  await withHarness(async (harness) => {
    Atomics.store(harness.clock, 0, harness.expiresAt - 1);
    await holdWriteLock(harness);

    const starting = nextWorkerReply(harness.executor, "commit-starting");
    const sampled = nextWorkerReply(harness.executor, "clock-sampled");
    const result = nextWorkerReply(harness.executor, "commit-result");
    harness.executor.postMessage({ type: "commit" });
    await starting;

    Atomics.store(harness.clock, 0, harness.expiresAt + 1);
    await releaseWriteLock(harness);

    assertEquals(await sampled, {
      type: "clock-sampled",
      operation: "commit",
      nowMs: harness.expiresAt + 1,
    });

    const commit = await result;
    assertEquals(
      commit.accepted,
      false,
      "an elapsed lease must not commit after waiting for the write lock",
    );
    assertEquals(commit.errorName, "ExecutionLeaseFenceError");
    assertEquals(commit.errorMessage?.includes("execution lease"), true);
    assertEquals(commit.document, null);
  });
});

Deno.test("claimed commits reject a claim that expires after selection but before transaction apply", async () => {
  await withHarness(async (harness) => {
    Atomics.store(harness.clock, 0, harness.claimExpiresAt - 1);
    await holdWriteLock(harness);

    const starting = nextWorkerReply(harness.executor, "commit-starting");
    const selected = nextWorkerReply(harness.executor, "claim-selected");
    const sampled = nextWorkerReply(harness.executor, "clock-sampled");
    const result = nextWorkerReply(harness.executor, "commit-result");
    harness.executor.postMessage({ type: "claimed-commit" });
    await starting;

    assertEquals(await selected, {
      type: "claim-selected",
      nowMs: harness.claimExpiresAt - 1,
    });
    Atomics.store(harness.clock, 0, harness.claimExpiresAt);
    await releaseWriteLock(harness);

    assertEquals(await sampled, {
      type: "clock-sampled",
      operation: "claimed-commit",
      nowMs: harness.claimExpiresAt,
    });
    const commit = await result;
    assertEquals(commit.accepted, false);
    assertEquals(commit.errorName, "ExecutionLeaseFenceError");
    assertEquals(commit.errorMessage?.includes("execution claim"), true);
    assertEquals(commit.document, null);
  });
});
