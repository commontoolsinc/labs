/**
 * Measures what one dispatched handler event costs, phase by phase, as the
 * list its bound context reaches grows. Every sample sends one event through
 * the scheduler to a compiled handler and waits for its commit; the timed
 * interval runs from the send to the commit callback. The dispatch's phases —
 * presync, dependency preflight, argument read, body, post-run, commit — are
 * read back from the phase timers the runtime already keeps, so the whole
 * dispatch and its parts come from the same run. The runtime's drains after
 * the callback sit outside the timed interval, and so does the re-seeding
 * of the list after the one workload that writes to it, so every sample
 * dispatches over a list of the size its name states. Those timers are kept
 * per process, one active start per key, so the runtimes here run one at a
 * time.
 *
 * Two context shapes are measured. A handle context binds the list as a
 * `Writable` cell, which is what the lunch poll's handlers declare, so the
 * argument read mints a handle and the body decides what to read. A plain
 * context declares the list as a value, so the argument read materializes
 * every row before the body runs. Read counts are collected in a separate,
 * untimed pass with accounting enabled, and never in the timed samples.
 */

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const identity = await Identity.fromPassphrase("handler dispatch benchmark");
const space = identity.did();

const PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "type Vote = {",
  "  amount: number;",
  "  title: string;",
  "  metadata: { category: string; tags: string[] };",
  "};",
  "type Handle = { votes: Writable<Vote[]>; out: Writable<number> };",
  "type Plain = { votes: Vote[]; out: Writable<number> };",
  // One element by key, which is how the lunch poll reaches one vote.
  "const scalarKey = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.key(0).get().amount);",
  "});",
  // One element out of a whole-list read.
  "const scalarGet = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.get()[0].amount);",
  "});",
  "const walk = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  out.set(votes.get().reduce((sum, vote) => sum + vote.amount, 0));",
  "});",
  // A list write and an element write, the two shapes a vote cast takes.
  "const mutate = handler<unknown, Handle>((_ev, { votes, out }) => {",
  "  votes.key(0).key('amount').set(votes.key(0).get().amount + 1);",
  "  votes.push({",
  "    amount: 1,",
  "    title: 'added',",
  "    metadata: { category: 'example', tags: ['first', 'second'] },",
  "  });",
  "  out.set(votes.key(0).get().amount);",
  "});",
  "const plainScalar = handler<unknown, Plain>((_ev, { votes, out }) => {",
  "  out.set(votes[0].amount);",
  "});",
  "const plainWalk = handler<unknown, Plain>((_ev, { votes, out }) => {",
  "  out.set(votes.reduce((sum, vote) => sum + vote.amount, 0));",
  "});",
  "export default pattern<",
  "  { votes: Writable<Vote[]>; out: Writable<number> },",
  "  {",
  "    out: number;",
  "    scalarKey: Stream<unknown>;",
  "    scalarGet: Stream<unknown>;",
  "    walk: Stream<unknown>;",
  "    mutate: Stream<unknown>;",
  "    plainScalar: Stream<unknown>;",
  "    plainWalk: Stream<unknown>;",
  "  }",
  ">(({ votes, out }) => ({",
  "  out,",
  "  scalarKey: scalarKey({ votes, out }),",
  "  scalarGet: scalarGet({ votes, out }),",
  "  walk: walk({ votes, out }),",
  "  mutate: mutate({ votes, out }),",
  "  plainScalar: plainScalar({ votes, out }),",
  "  plainWalk: plainWalk({ votes, out }),",
  "}));",
].join("\n");

type Workload =
  | "scalarKey"
  | "scalarGet"
  | "walk"
  | "mutate"
  | "plainScalar"
  | "plainWalk";

const WORKLOADS: readonly Workload[] = [
  "scalarKey",
  "scalarGet",
  "walk",
  "mutate",
  "plainScalar",
  "plainWalk",
];

const SIZES = [74, 296, 1184] as const;

/** Phase timers a dispatch leaves behind, by logger and key path. */
const PHASES = [
  ["scheduler", "scheduler/execute/event/presyncInputs"],
  ["scheduler", "scheduler/execute/event/pullPopulateDependencies"],
  ["runner", "stream/readInputs"],
  ["runner", "stream/invokeJavaScriptImplementation"],
  ["runner", "stream/postRun"],
  ["scheduler", "scheduler/execute/event/handlerAction"],
  ["storage.v2.transaction", "commit/getNativeCommit"],
  ["storage.v2.transaction", "commit/validate"],
  ["storage.v2.transaction", "commit/commitNative"],
] as const;

type Sender = {
  send(
    value: unknown,
    onCommit: (tx: { status(): { status: string } }) => void,
  ): void;
};

/** A runtime with the pattern running over a seeded list of `size` rows. */
async function prepare(size: number, readStats: boolean) {
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  if (readStats) {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
  }
  const tx = runtime.edit();
  const compiled = await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: PATTERN }],
  }, { space, tx });
  const rows = Array.from({ length: size }, (_, index) => ({
    amount: index + 1,
    title: `Row ${index}`,
    metadata: { category: "example", tags: ["first", "second"] },
  }));
  const votes = runtime.getCell<typeof rows>(space, "votes", undefined, tx);
  votes.set(rows);
  const initialAmount = rows[0].amount;
  const out = runtime.getCell<number>(space, "out", undefined, tx);
  out.set(0);
  const argument = runtime.getCell<{ votes: unknown; out: unknown }>(
    space,
    "argument",
    undefined,
    tx,
  );
  argument.set({ votes, out });
  const result = runtime.getCell<Record<string, unknown>>(
    space,
    "result",
    compiled.resultSchema,
    tx,
  );
  runtime.run(tx, compiled, argument, result);
  const committed = await tx.commit();
  if (committed.error) throw new Error("Benchmark seeding failed");
  await runtime.idle();

  /** Sends one event and resolves, with the elapsed time, at its commit. */
  const dispatch = async (workload: Workload): Promise<number> => {
    const settled = Promise.withResolvers<string>();
    const start = performance.now();
    (result.key(workload) as unknown as Sender).send({}, (commitTx) => {
      settled.resolve(commitTx.status().status);
    });
    const status = await settled.promise;
    const elapsed = performance.now() - start;
    if (status !== "done") {
      throw new Error(`Dispatch of ${workload} settled as ${status}`);
    }
    return elapsed;
  };

  /** Waits for whatever the dispatch left running. */
  const drain = async (): Promise<void> => {
    await runtime.idle();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** Puts the list back as it was seeded, so a write leaves no trace. */
  const reseed = async (): Promise<void> => {
    const write = runtime.edit();
    votes.withTx(write).set(rows);
    out.withTx(write).set(0);
    const written = await write.commit();
    if (written.error) throw new Error("Benchmark re-seeding failed");
    await drain();
  };

  const expected = (workload: Workload): number => {
    switch (workload) {
      case "scalarKey":
      case "scalarGet":
      case "plainScalar":
        return initialAmount;
      case "mutate":
        return initialAmount + 1;
      case "walk":
      case "plainWalk":
        return size * (size + 1) / 2;
    }
  };

  const dispose = async () => {
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  };

  return { runtime, out, dispatch, drain, reseed, expected, dispose };
}

/** The phase timers' last samples, in milliseconds, keyed by phase path. */
function lastPhaseTimes(): Record<string, number> {
  const times: Record<string, number> = {};
  for (const [loggerName, key] of PHASES) {
    times[key] = getLogger(loggerName).getTimeStats(key)?.lastTime ?? 0;
  }
  return times;
}

/** Heap in use after a full collection, or `undefined` without `--expose-gc`. */
function collectedHeapUsed(): number | undefined {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) return undefined;
  gc();
  return Deno.memoryUsage().heapUsed;
}

//
// Read counts and allocation, collected once per variant before any timed
// sample, with accounting enabled
//

for (const size of SIZES) {
  for (const workload of WORKLOADS) {
    const prepared = await prepare(size, true);
    const attempts: Record<string, unknown>[] = [];
    const preflights: Record<string, unknown>[] = [];
    const onTelemetry = (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type === "scheduler.read-attempt") {
        attempts.push({ kind: marker.kind, ...marker.reads });
      }
      if (marker.type === "scheduler.event.preflight") {
        preflights.push({
          skipped: marker.skipped,
          readCount: marker.readCount,
          shallowReadCount: marker.shallowReadCount,
          populateMs: marker.populateMs,
          txToLogMs: marker.txToLogMs,
          depCommitMs: marker.depCommitMs,
          collectMs: marker.collectMs,
          scheduleMs: marker.scheduleMs,
        });
      }
    };
    const { nodes } = prepared.runtime.scheduler.accessForTestingOnly;
    const nodesBefore = nodes.effects.size + nodes.computations.size;
    const heapBefore = collectedHeapUsed();
    prepared.runtime.telemetry.addEventListener("telemetry", onTelemetry);
    await prepared.dispatch(workload);
    await prepared.drain();
    prepared.runtime.telemetry.removeEventListener("telemetry", onTelemetry);
    // Retained after the dispatch settled and the heap was collected again,
    // so this is what the dispatch left behind rather than what it allocated
    // while running.
    const heapAfter = collectedHeapUsed();
    const nodesAfter = nodes.effects.size + nodes.computations.size;
    benchDiagnostic(JSON.stringify({
      size,
      workload,
      nodesBefore,
      nodesAfter,
      retainedBytes: heapBefore !== undefined && heapAfter !== undefined
        ? heapAfter - heapBefore
        : undefined,
      preflights,
      attempts,
    }));
    await prepared.dispose();
  }
}

//
// Timed samples, with accounting disabled
//

for (const size of SIZES) {
  for (const workload of WORKLOADS) {
    let dispatches = 0;
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    Deno.bench({
      name: `${workload} (${size} rows)`,
      group: `handler-dispatch-${size}`,
      baseline: workload === "scalarKey",
      n: 7,
      warmup: 1,
      async fn(b) {
        prepared ??= await prepare(size, false);
        if (workload === "mutate" && dispatches > 0) await prepared.reseed();
        b.start();
        const elapsed = await prepared.dispatch(workload);
        b.end();
        await prepared.drain();
        dispatches += 1;
        const value = prepared.out.get();
        const expected = prepared.expected(workload);
        if (value !== expected) {
          throw new Error(`Expected ${expected}, received ${value}`);
        }
        benchDiagnostic(JSON.stringify({
          size,
          workload,
          dispatch: dispatches,
          elapsed,
          phases: lastPhaseTimes(),
        }));
      },
    });
  }
}
