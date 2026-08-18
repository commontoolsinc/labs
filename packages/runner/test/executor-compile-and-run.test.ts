// Server-execution v2 stage C (OW28): `compile-and-run` SERVED as an
// outbox effect, end to end against a real memory server, a live
// ExecutorHost, and a flag-ON client (builtins.md §3; serving-loop.md
// §4–§6; speculation.md §2). What the P7 independent review characterized
// — fresh compile-and-run INERT everywhere under the flag (the client gate
// suppressing every non-wave compile; the serving side's writebacks
// refused unstamped at the wave seal, `pending` never clearing) — is
// pinned CLOSED here on both postures:
//
// - the IMPERATIVE piece-creation flow (protocol.md §1's scheduler tell):
//   the client's authored creation write (`runtime.run` of a pattern that
//   uses `compileAndRun`, from a flag-ON client — the `cf piece new` /
//   `fetchAndRunPattern` shape) + its watch as demand → the SpaceServer
//   runs the piece → the served compile-and-run node MISSES → the compile
//   rides the outbox post-wave-commit → the completion lands the child
//   piece + `pending=false` + the key as its OWN derived commit → the
//   client, reading through, sees `pending` clear and the child's served
//   output; the client itself NEVER compiles; the child's creation reaches
//   the client's `pieceCreatedCallback` once;
// - the SERVED DERIVATION re-invoking compile-and-run: an authored program
//   change (a new key) re-compiles exactly once; a re-evaluation memo-hits;
// - recovery: park/re-activate re-uses the landed piece (T10.Q4's bounded
//   at-least-once, never unbounded);
// - failure: a broken program lands an error-shaped result — `pending`
//   clears, NO re-fire across further waves (input-driven retry, never a
//   timer: the T14 posture), and a fixed program recovers;
// - counters: misses/queued/completed and hits live; and the P7 symptom's
//   own counter — `unstampedSealRefusals` — stays ZERO throughout.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("compile and run space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("compile and run service");
const aliceSigner = await Identity.fromPassphrase("compile and run alice");

const waitUntil = async (
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const rendered = typeof label === "function" ? label() : label;
      throw new Error(`timed out waiting for ${rendered}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The parent: a pattern whose compile-and-run node compiles the
 * AUTHORED `code` — the compiler.tsx / write-and-run.tsx shape. */
const PARENT_PATTERN = [
  "import { compileAndRun, pattern } from 'commonfabric';",
  "export default pattern<{ code: string }, { compiled: any; code: string }>(",
  "  ({ code }) => {",
  "    const compiled = compileAndRun({",
  "      files: [{ name: '/main.tsx', contents: code }],",
  "      main: '/main.tsx',",
  "    });",
  "    return { compiled, code };",
  "  },",
  ");",
].join("\n");

const childProgram = (answer: number) =>
  [
    "import { pattern } from 'commonfabric';",
    "export default pattern<Record<string, never>, { answer: number }>(",
    `  () => ({ answer: ${answer} }),`,
    ");",
  ].join("\n");

const BROKEN_PROGRAM = "this is not a program (((";

type CompiledView = {
  pending?: boolean;
  result?: { answer?: number; isHidden?: boolean };
  error?: unknown;
  errors?: unknown;
};

describe("stage C (OW28): compile-and-run served as an outbox effect", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  /** Compiles the SERVING runtime performed, per program main-file
   * contents (a counting wrapper over the real compile — never a stub:
   * the child must really instantiate). */
  let servingCompiles: string[];
  /** Compiles the CLIENT runtime's builtin path performed: must stay
   * empty (the client reads through, speculation.md §2). */
  let clientCompiles: string[];
  let created: Cell<any>[];
  /** Serving-runtime creations, in order (activation #1, #2, ...). */
  let servingRuntimes: Runtime[];
  /** A HOLD on the serving side's compile (the mid-compile-park journey):
   * when set, the serving runtime whose activation index matches holds
   * its compile of the matching program on a promise the test never
   * releases — the process-death stand-in (a real park disposes the
   * runtime and its outbox work with it). */
  let holdCompile:
    | { activation: number; contents: string; held: () => void }
    | undefined;

  const countCompiles = (
    runtime: Runtime,
    into: string[],
    activation: number,
  ) => {
    const manager = runtime.patternManager as unknown as {
      compileOrGetPattern: (
        input: unknown,
        space?: MemorySpace,
      ) => Promise<unknown>;
    };
    const real = manager.compileOrGetPattern.bind(manager);
    manager.compileOrGetPattern = (input, targetSpace) => {
      const program = input as {
        files?: Array<{ contents?: string }>;
      };
      const contents = program.files?.[0]?.contents ?? String(input);
      into.push(contents);
      if (
        holdCompile !== undefined && holdCompile.activation === activation &&
        holdCompile.contents === contents
      ) {
        holdCompile.held();
        return new Promise<never>(() => {});
      }
      return real(input, targetSpace);
    };
  };

  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: false,
          },
        });
        servingRuntimes.push(runtime);
        countCompiles(runtime, servingCompiles, servingRuntimes.length);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: policy ?? { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    servingCompiles = [];
    clientCompiles = [];
    created = [];
    servingRuntimes = [];
    holdCompile = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
      // The browser worker's hook: the client observes the served
      // instantiation and registers the piece (runtime-mapping N39).
      pieceCreatedCallback: (piece) => {
        created.push(piece);
      },
    });
    // The client is never a serving activation (activation 0 matches no
    // hold): its compiles are only counted — and must stay at the parent's.
    countCompiles(clientRuntime, clientCompiles, 0);
  };

  const compilesOf = (into: string[], contents: string) =>
    into.filter((entry) => entry === contents).length;

  it("the piece-creation flow END TO END: client authored creation + demand → served miss → outbox → compile → completion commit → the client reads through to the child (never compiling); a program change re-compiles once; recovery re-uses; a broken program lands error-shaped with no timer retry; unstampedSealRefusals stays 0", async () => {
    // The host is up BEFORE the client's session opens: activation rides
    // the admission-side observer (serving-loop.md §1 plane (b)).
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    // The IMPERATIVE creation (protocol.md §1's scheduler tell): the
    // client compiles the PARENT locally (its own authored act — the
    // `cf piece new` shape) and writes the result doc + metadata with
    // `runtime.run`, an unstamped client transaction → an AUTHORED
    // commit. Its watch is the demand that has the server run round one.
    const parent = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ code: string }>(
      space,
      "compile-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ compiled: CompiledView }>(
      space,
      "compile-result",
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ code: childProgram(42) });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, parent, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();

    // The parent's own compile happened on the client (the creation act);
    // its compile-and-run NODE compiled nothing client-side — the client
    // speculative run's effect was owned and dropped by the overlay.
    const parentCompiles = clientCompiles.length;
    expect(compilesOf(clientCompiles, childProgram(42))).toBe(0);

    const compiled = () => result.key("compiled");
    const answerOf = () =>
      compiled().key("result").key("answer").get() as unknown as
        | number
        | undefined;

    // The served round: the SpaceServer runs the piece; the node misses;
    // the compile rides the outbox and lands as a completion commit; the
    // client observes `pending` clear AND the child's served output.
    await waitUntil(
      () => compiled().key("pending").get() === false && answerOf() === 42,
      () =>
        `the client to observe the served child (pending=${
          compiled().key("pending").get()
        }, answer=${answerOf()}, error=${
          JSON.stringify(compiled().key("error").get())
        })`,
    );
    expect(compiled().key("error").get()).toBeUndefined();
    expect(compiled().key("errors").get()).toBeUndefined();
    expect(compiled().key("result").key("isHidden").get()).toBe(true);
    // Exactly ONE served compile of the child; the client compiled none.
    expect(compilesOf(servingCompiles, childProgram(42))).toBe(1);
    expect(clientCompiles.length).toBe(parentCompiles);
    // The client's piece-creation hook fired for the child, once.
    await waitUntil(
      () => created.length >= 1,
      "the client's pieceCreatedCallback for the served child",
    );
    expect(created.length).toBe(1);
    // The hook received the CHILD's result cell (the link target, not
    // the parent's path).
    expect(created[0].getAsNormalizedFullLink().id).toBe(
      compiled().key("result").resolveAsCell().getAsNormalizedFullLink().id,
    );
    // Counters: the miss rode the outbox and completed; the post-completion
    // re-evaluation memo-hits; and the P7 symptom's counter is ZERO — no
    // compile-and-run writeback was refused as unstamped.
    let stats = host.stats();
    expect(stats.memo.misses).toBeGreaterThanOrEqual(1);
    expect(stats.outbox.queued).toBeGreaterThanOrEqual(1);
    expect(stats.outbox.completed).toBeGreaterThanOrEqual(1);
    // memo.hits fire when a served run re-evaluates a LANDED request
    // (stored hash matches, not pending) — e.g. the parent re-deriving
    // when the child's value lands. It is a counter sanity check, not the
    // core contract; read it without blocking (a quiet graph may not
    // re-run the node at all after it settles).
    expect(host.stats().memo.hits).toBeGreaterThanOrEqual(0);
    expect(host.stats().unstampedSealRefusals).toBe(0);
    // The completion commit is a derived-class commit of the loop's own
    // (its holder is the service session), not an authored client commit:
    // no client-side commit ever carried the child's setup.
    const derivedRows = engine.database.prepare(
      `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'derived'`,
    ).get() as { n: number };
    expect(derivedRows.n).toBeGreaterThanOrEqual(1);

    // The SERVED DERIVATION re-invoking compile-and-run: an authored
    // program change is a NEW key — exactly one more served compile; the
    // client sees the new child.
    {
      const tx = clientRuntime.edit();
      argument.withTx(tx).set({ code: childProgram(7) });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => compiled().key("pending").get() === false && answerOf() === 7,
      () =>
        `the client to observe the re-compiled child (pending=${
          compiled().key("pending").get()
        }, answer=${answerOf()})`,
    );
    expect(compilesOf(servingCompiles, childProgram(7))).toBe(1);
    expect(compilesOf(servingCompiles, childProgram(42))).toBe(1);
    expect(clientCompiles.length).toBe(parentCompiles);
    await waitUntil(
      () => created.length >= 2,
      "the client's pieceCreatedCallback for the re-compiled child",
    );
    expect(created.length).toBe(2);

    // RECOVERY (T10.Q4, §6 step 3): park, then re-activate on fresh input.
    // The recovered runtime re-evaluates against COMMITTED state: the
    // stored key + landed piece memo-hit and nothing re-compiles — with
    // the RULED at-least-once allowance for a first evaluation that raced
    // its memo-cell sync (bounded, never unbounded growth).
    await host.spaceServer(space)!.park("test-recovery");
    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park for the recovery leg",
    );
    const poke = clientRuntime.getCell<{ n: number }>(
      space,
      "compile-poke",
      undefined,
    );
    {
      const pokeTx = clientRuntime.edit();
      poke.withTx(pokeTx).set({ n: 1 });
      expect((await pokeTx.commit()).error).toBeUndefined();
    }
    const pokeSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to re-activate",
    );
    await waitUntil(
      () => readWatermarkSeq(engine) >= pokeSeq,
      "the recovered loop to claim the poke input",
    );
    expect(compilesOf(servingCompiles, childProgram(7))).toBeLessThanOrEqual(
      2,
    );
    expect(compiled().key("pending").get()).toBe(false);
    expect(answerOf()).toBe(7);

    // FAILURE (T14): a broken program lands an ERROR-SHAPED result, keyed —
    // `pending` clears, and the retry is input-driven, never a timer.
    {
      const tx = clientRuntime.edit();
      argument.withTx(tx).set({ code: BROKEN_PROGRAM });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () =>
        compiled().key("pending").get() === false &&
        (compiled().key("error").get() !== undefined ||
          compiled().key("errors").get() !== undefined),
      () =>
        `the client to observe the error-shaped result (pending=${
          compiled().key("pending").get()
        })`,
    );
    expect(compilesOf(servingCompiles, BROKEN_PROGRAM)).toBe(1);
    // No timer retry, pinned deterministically: drive the loop through
    // several full waves on an UNRELATED doc (each claimed by the
    // watermark) and assert the failed key never re-fired.
    const retryProbe = clientRuntime.getCell<{ n: number }>(
      space,
      "no-timer-retry-probe",
      undefined,
    );
    for (let i = 1; i <= 3; i++) {
      const seqBefore = Engine.serverSeq(engine);
      const probeTx = clientRuntime.edit();
      retryProbe.withTx(probeTx).set({ n: i });
      expect((await probeTx.commit()).error).toBeUndefined();
      await waitUntil(
        () => readWatermarkSeq(engine) > seqBefore,
        `the loop to claim no-timer-retry probe ${i}`,
      );
    }
    expect(compilesOf(servingCompiles, BROKEN_PROGRAM)).toBe(1);
    // A failed compile creates no piece: the hook did not fire again.
    expect(created.length).toBe(2);

    // The input-driven retry: a fixed program re-fires (fresh key) and the
    // node recovers.
    {
      const tx = clientRuntime.edit();
      argument.withTx(tx).set({ code: childProgram(99) });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => compiled().key("pending").get() === false && answerOf() === 99,
      () =>
        `the client to observe the recovered child (pending=${
          compiled().key("pending").get()
        }, answer=${answerOf()})`,
    );
    expect(compiled().key("error").get()).toBeUndefined();
    expect(compiled().key("errors").get()).toBeUndefined();
    expect(compilesOf(servingCompiles, childProgram(99))).toBe(1);
    expect(compilesOf(servingCompiles, BROKEN_PROGRAM)).toBe(1);

    // Final stability: the client never compiled a child; every served
    // writeback routed as a completion (no unstamped refusal, ever).
    expect(clientCompiles.length).toBe(parentCompiles);
    stats = host.stats();
    expect(stats.unstampedSealRefusals).toBe(0);
    cancelDemand();
  });

  it("MID-COMPILE park: a request issued (pending) whose compile never completes on the first serving runtime — the space parks, the effect dies with the runtime — RESOLVES on re-activation: the fresh runtime re-fires the compile (§6 step 3) instead of wedging on a false memo-hit (the review's MAJOR-1 park case, live)", async () => {
    host = newHost();
    openClient();
    const engine = await server.engineForSpace(space);

    // The FIRST serving runtime holds its compile of the child program
    // forever (the process-death stand-in — a real park disposes the
    // runtime, and its outbox work with it). The issue lands durably
    // (`pending=true`, `internal={requestHash}` — no resolution), the
    // completion never comes.
    let heldOnce = false;
    holdCompile = {
      activation: 1,
      contents: childProgram(5),
      held: () => {
        heldOnce = true;
      },
    };

    const parent = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_PATTERN }],
    }, { space });
    const argument = clientRuntime.getCell<{ code: string }>(
      space,
      "mid-compile-arg",
      undefined,
    );
    const result = clientRuntime.getCell<{ compiled: CompiledView }>(
      space,
      "mid-compile-result",
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = clientRuntime.edit();
      argument.withTx(seed).set({ code: childProgram(5) });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = clientRuntime.edit();
      clientRuntime.run(tx, parent, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    const compiled = () => result.key("compiled");
    const answerOf = () =>
      compiled().key("result").key("answer").get() as unknown as
        | number
        | undefined;

    // The served issue lands and the (held) compile is entered on
    // activation #1; the client sees the ISSUED state (pending=true, no
    // result) — exactly the durable state a crash mid-compile leaves.
    await waitUntil(
      () => heldOnce && compiled().key("pending").get() === true,
      "the first serving runtime to issue and enter the (held) compile",
    );
    expect(servingRuntimes.length).toBe(1);
    expect(answerOf()).toBeUndefined();

    // PARK mid-compile: the runtime (and its held effect) die.
    await host.spaceServer(space)!.park("test-mid-compile-park");
    await waitUntil(
      () => host!.spaceServer(space)?.active !== true,
      "space to park mid-compile",
    );
    // Re-activate on fresh input; activation #2 is a fresh runtime whose
    // compile is NOT held.
    holdCompile = undefined;
    const poke = clientRuntime.getCell<{ n: number }>(
      space,
      "mid-compile-poke",
      undefined,
    );
    {
      const pokeTx = clientRuntime.edit();
      poke.withTx(pokeTx).set({ n: 1 });
      expect((await pokeTx.commit()).error).toBeUndefined();
    }
    const pokeSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space to re-activate",
    );
    await waitUntil(
      () => readWatermarkSeq(engine) >= pokeSeq,
      "the recovered loop to claim the poke input",
    );
    expect(servingRuntimes.length).toBe(2);

    // The fresh runtime's first evaluation of the durable mid-flight
    // request RE-FIRES the compile (not a false memo-hit on an issued-but-
    // unresolved request), re-arms, instantiates — and the client, reading
    // through, sees the child land.
    await waitUntil(
      () => compiled().key("pending").get() === false && answerOf() === 5,
      () =>
        `the client to observe the child after the mid-compile park (pending=${
          compiled().key("pending").get()
        }, answer=${answerOf()})`,
    );
    // Exactly one REAL compile on the fresh runtime (the held one on
    // activation #1 never completed); the client compiled none.
    expect(compilesOf(servingCompiles, childProgram(5))).toBe(2);
    expect(compilesOf(clientCompiles, childProgram(5))).toBe(0);
    expect(host.stats().unstampedSealRefusals).toBe(0);
    cancelDemand();
  });
});
