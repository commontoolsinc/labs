import { download } from "@denosaurs/plug";
import { assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import type { ExecutionLease } from "../v2.ts";

const SPACE = "did:key:z6Mk-engine-execution-lease-space";
const PRINCIPAL = "did:key:z6Mk-engine-execution-lease-user";

type WorkerReply =
  | { type: "booted" }
  | { type: "ready" }
  | { type: "result"; lease: ExecutionLease | null }
  | { type: "closed" }
  | { type: "error"; message: string; stack?: string };

const nextWorkerReply = (
  worker: Worker,
  type: WorkerReply["type"],
): Promise<WorkerReply> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.type === "error") {
        cleanup();
        reject(new Error(event.data.stack ?? event.data.message));
        return;
      }
      if (event.data.type !== type) return;
      cleanup();
      resolve(event.data);
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

Deno.test("two module Workers racing one store produce exactly one lease owner", async () => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/space.sqlite`).href;
  const sqlitePath = await download({
    name: "sqlite3",
    url: "https://github.com/denodrivers/sqlite3/releases/download/0.12.0/",
    suffixes: { aarch64: "_aarch64" },
  });
  const previousSqlitePath = Deno.env.get("DENO_SQLITE_PATH");
  Deno.env.set("DENO_SQLITE_PATH", sqlitePath);
  const fixture = new URL(
    "./fixtures/v2-execution-lease-worker.ts",
    import.meta.url,
  ).href;
  const first = new Worker(fixture, { type: "module" });
  const firstBooted = nextWorkerReply(first, "booted");
  const second = new Worker(fixture, { type: "module" });
  const secondBooted = nextWorkerReply(second, "booted");
  const workers = [first, second] as const;
  try {
    await Promise.all([firstBooted, secondBooted]);
    const firstReady = nextWorkerReply(first, "ready");
    first.postMessage({
      type: "init",
      store,
      space: SPACE,
      hostId: "host:first",
      onBehalfOf: PRINCIPAL,
      nowMs: 1_800_000_000_000,
      ttlMs: 30_000,
    });
    await firstReady;

    const secondReady = nextWorkerReply(second, "ready");
    second.postMessage({
      type: "init",
      store,
      space: SPACE,
      hostId: "host:second",
      onBehalfOf: PRINCIPAL,
      nowMs: 1_800_000_000_000,
      ttlMs: 30_000,
    });
    await secondReady;

    const results = workers.map((worker) => nextWorkerReply(worker, "result"));
    first.postMessage({ type: "go" });
    second.postMessage({ type: "go" });
    const replies = await Promise.all(results) as Array<
      Extract<WorkerReply, { type: "result" }>
    >;
    const winners = replies.flatMap((reply) =>
      reply.lease === null ? [] : [reply.lease]
    );
    assertEquals(winners.length, 1);
    assertEquals(winners[0].leaseGeneration, 1);
    assertEquals(new Set(winners.map((lease) => lease.hostId)).size, 1);

    const closed = workers.map((worker) => nextWorkerReply(worker, "closed"));
    first.postMessage({ type: "close" });
    second.postMessage({ type: "close" });
    await Promise.all(closed);
  } finally {
    first.terminate();
    second.terminate();
    if (previousSqlitePath === undefined) {
      Deno.env.delete("DENO_SQLITE_PATH");
    } else {
      Deno.env.set("DENO_SQLITE_PATH", previousSqlitePath);
    }
    await Deno.remove(directory, { recursive: true });
  }
});
