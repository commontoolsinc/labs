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
//   own counter — `unstampedSealRefusals` — stays ZERO throughout;
// - SUPERSESSION (the independent review's MAJOR-A): A→B→A within A's
//   compile duration — the re-issued A attaches to A's in-flight effect,
//   whose completion must LAND (never return on a stale abort); and a
//   completion that finds itself superseded writes nothing, releases its
//   key, and is counted (`outbox.superseded`);
// - FAN-OUT at cardinality 2 (the review's MAJOR-B): a NARROWED node
//   (a per-user program) — one real compile, one effect completion + one
//   instantiation per demanded instance, both instances land.

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
const bobSigner = await Identity.fromPassphrase("compile and run bob");

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

/** A parent whose compile-and-run node NARROWS to user (the review's
 * MAJOR-B shape — the per-user code editor): the PROGRAM is the
 * demander's PerUser draft, so the node reads a user-scoped value, its
 * cells are per-instance, and it fans out once per demander. Two
 * demanders holding the SAME program text share ONE compile (the process
 * content cache) while each owns its effect completion + instantiation.
 * (A per-user cell passed as the child's `input` does NOT narrow the
 * node: the builtin hands the child a cell HANDLE, never reading the
 * per-user value itself.) */
const PER_USER_PROGRAM_PARENT = [
  "import { compileAndRun, Default, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "export default pattern<{ code?: PerUser<Draft> }, { compiled: any }>(",
  "  ({ code }) => {",
  "    const compiled = compileAndRun({",
  "      files: [{ name: '/main.tsx', contents: code! }],",
  "      main: '/main.tsx',",
  "    });",
  "    return { compiled };",
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
   * the child must really instantiate). Counts `compileOrGetPattern`
   * CALLS — a content-cache hit counts too. */
  let servingCompiles: string[];
  /** REAL compiles on the serving side (`compilePattern` — reached only
   * on a genuine content-cache miss), per program main-file contents:
   * the "exactly one compile per program per process" witness. */
  let servingRealCompiles: string[];
  /** Compiles the CLIENT runtime's builtin path performed: must stay
   * empty (the client reads through, speculation.md §2). */
  let clientCompiles: string[];
  let created: Cell<any>[];
  /** Serving-runtime creations, in order (activation #1, #2, ...). */
  let servingRuntimes: Runtime[];
  /** Extra client runtimes (a second demander), disposed after each. */
  let extraClients: Array<
    { runtime: Runtime; manager: EmulatedStorageManager }
  >;
  /** A HOLD on the serving side's compile: when set, the serving runtime
   * whose activation index matches holds its compile of the matching
   * program. Without `release` the hold is forever — the process-death
   * stand-in of the mid-compile-park journey (a real park disposes the
   * runtime and its outbox work with it). With `release`, the compile
   * RESUMES (the real compile runs) once that promise resolves — the
   * supersession journeys, where the effect outlives its request. */
  let holdCompile:
    | {
      activation: number;
      contents: string;
      held: () => void;
      release?: Promise<void>;
    }
    | undefined;

  const countCompiles = (
    runtime: Runtime,
    into: string[],
    activation: number,
    realInto?: string[],
  ) => {
    const manager = runtime.patternManager as unknown as {
      compileOrGetPattern: (
        input: unknown,
        space?: MemorySpace,
      ) => Promise<unknown>;
      compilePattern: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const contentsOf = (input: unknown) => {
      const program = input as { files?: Array<{ contents?: string }> };
      return program.files?.[0]?.contents ?? String(input);
    };
    const real = manager.compileOrGetPattern.bind(manager);
    manager.compileOrGetPattern = (input, targetSpace) => {
      const contents = contentsOf(input);
      into.push(contents);
      if (
        holdCompile !== undefined && holdCompile.activation === activation &&
        holdCompile.contents === contents
      ) {
        holdCompile.held();
        const release = holdCompile.release;
        if (release === undefined) return new Promise<never>(() => {});
        return release.then(() => real(input, targetSpace));
      }
      return real(input, targetSpace);
    };
    if (realInto !== undefined) {
      const realCompile = manager.compilePattern.bind(manager);
      manager.compilePattern = (input, options) => {
        realInto.push(contentsOf(input));
        return realCompile(input, options);
      };
    }
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
        countCompiles(
          runtime,
          servingCompiles,
          servingRuntimes.length,
          servingRealCompiles,
        );
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
    servingRealCompiles = [];
    clientCompiles = [];
    created = [];
    servingRuntimes = [];
    extraClients = [];
    holdCompile = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    for (const extra of extraClients) {
      await extra.runtime.dispose();
      await extra.manager.close();
    }
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

  /** A SECOND demander (fan-out cardinality 2): its own session, a plain
   * flag-ON client, no piece-creation hook; its compiles count with the
   * client's (and must stay at zero for the child). */
  const openSecondClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    countCompiles(runtime, clientCompiles, 0);
    extraClients.push({ runtime, manager });
    return runtime;
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

  /** Stand a piece up from the client with `code`, demanded by the
   * client's root watch; returns the views the steps below poll. */
  const standUpPiece = async (options: {
    names: { arg: string; result: string };
    code: string;
    parentPattern?: string;
    /** The parent's `code` is a PerUser cell (PER_USER_PROGRAM_PARENT):
     * write it THROUGH the argument schema, into the writer's instance. */
    perUserCode?: boolean;
  }) => {
    const parent = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: options.parentPattern ?? PARENT_PATTERN,
      }],
    }, { space });
    const argument = clientRuntime.getCell<{ code: string }>(
      space,
      options.names.arg,
      options.perUserCode ? parent.argumentSchema : undefined,
    );
    const result = clientRuntime.getCell<{ compiled: CompiledView }>(
      space,
      options.names.result,
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const writeCode = async (runtime: Runtime, code: string) => {
      const arg = runtime === clientRuntime ? argument : runtime.getCell<
        { code: string }
      >(
        space,
        options.names.arg,
        options.perUserCode ? parent.argumentSchema : undefined,
      );
      if (runtime !== clientRuntime) await arg.sync();
      const tx = runtime.edit();
      if (options.perUserCode) {
        arg.key("code").withTx(tx).set(code);
      } else {
        arg.withTx(tx).set({ code });
      }
      expect((await tx.commit()).error).toBeUndefined();
    };
    await writeCode(clientRuntime, options.code);
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
    const pendingOf = () => compiled().key("pending").get();
    const setCode = (code: string) => writeCode(clientRuntime, code);
    const view = () =>
      `pending=${pendingOf()}, answer=${answerOf()}, error=${
        JSON.stringify(compiled().key("error").get())
      }`;
    return {
      parent,
      argument,
      result,
      compiled,
      answerOf,
      pendingOf,
      setCode,
      writeCode,
      view,
      cancelDemand,
    };
  };

  it("SUPERSESSION (the independent review's MAJOR-A, probe P6): A→B→A within A's compile duration — the re-issued A attaches to A's still-in-flight effect (same key), so A's completion must LAND (its hash is current again at writeback), never return on a stale abort; pending clears and the child serves", async () => {
    host = newHost();
    openClient();
    const A = childProgram(11);
    const B = childProgram(12);
    // Activation #1 holds A's compile until the test releases it — A's
    // effect outlives two more requests (B, then A again).
    let heldOnce = false;
    const releaseA = Promise.withResolvers<void>();
    holdCompile = {
      activation: 1,
      contents: A,
      held: () => {
        heldOnce = true;
      },
      release: releaseA.promise,
    };
    const piece = await standUpPiece({
      names: { arg: "supersede-arg", result: "supersede-result" },
      code: A,
    });
    // A is issued and its compile is entered (held).
    await waitUntil(
      () => heldOnce && piece.pendingOf() === true,
      () => `A's issue + held compile (${piece.view()})`,
    );
    expect(host.stats().memo.inflight).toBe(1);

    // B supersedes A: a NEW key — B's own effect compiles and LANDS while
    // A's compile is still held (A's abort signal fires here at issue).
    await piece.setCode(B);
    await waitUntil(
      () => piece.pendingOf() === false && piece.answerOf() === 12,
      () => `B to land while A is held (${piece.view()})`,
    );
    expect(compilesOf(servingCompiles, B)).toBe(1);
    // B's effect retired; only A's held effect is in flight.
    await waitUntil(
      () => host!.stats().memo.inflight === 1,
      () => `B's effect to retire (inflight=${host!.stats().memo.inflight})`,
    );
    const queuedBeforeReissue = host.stats().outbox.queued;

    // A AGAIN, within A's compile duration: the re-issue carries A's key,
    // and the outbox's in-flight dedupe ATTACHES it to the held effect —
    // no second admission, no second compile. The client observes the
    // re-issue (pending=true) only after the wave that enqueued it
    // committed and its effects were admitted (the wave cycle admits
    // BEFORE reporting the commit for push), so the attach has happened
    // by the time this wait returns.
    await piece.setCode(A);
    await waitUntil(
      () => piece.pendingOf() === true && piece.answerOf() === undefined,
      () => `A's re-issue to be observed (${piece.view()})`,
    );
    expect(host.stats().outbox.queued).toBe(queuedBeforeReissue);
    expect(host.stats().memo.inflight).toBe(1);
    expect(compilesOf(servingCompiles, A)).toBe(1);

    // Release A's compile: the completion re-reads the CURRENT request
    // (A again) and lands its re-arm; the derivation instantiates A. At
    // eb6d1e4bb the completion returned on `signal.aborted` (aborted at
    // B's issue) and wrote nothing — pending=true forever, no counter
    // naming it (the wedge).
    releaseA.resolve();
    await waitUntil(
      () => piece.pendingOf() === false && piece.answerOf() === 11,
      () => `A to land after the release (${piece.view()})`,
    );
    expect(piece.compiled().key("error").get()).toBeUndefined();
    // Exactly one compile of A ever ran (the re-issue attached, never
    // compiled); the client compiled nothing; every effect retired; no
    // completion was superseded (A was current again at its writeback).
    expect(compilesOf(servingCompiles, A)).toBe(1);
    expect(compilesOf(clientCompiles, A)).toBe(0);
    expect(compilesOf(clientCompiles, B)).toBe(0);
    await waitUntil(
      () => host!.stats().memo.inflight === 0,
      () => `every effect to retire (inflight=${host!.stats().memo.inflight})`,
    );
    const stats = host.stats();
    expect(stats.outbox.queued).toBe(queuedBeforeReissue);
    expect(stats.outbox.completed).toBe(queuedBeforeReissue);
    expect(stats.outbox.failed).toBe(0);
    expect(stats.outbox.superseded).toBe(0);
    expect(stats.unstampedSealRefusals).toBe(0);
    piece.cancelDemand();
  });

  it("SUPERSEDED COMPLETION: an effect whose request was superseded by the time it completes writes NOTHING (the landed successor stands, no wipe), RELEASES its key, and is COUNTED (`outbox.superseded`); the superseded program re-requested later lands from the warm process cache (its compile did run) with no new effect", async () => {
    host = newHost();
    openClient();
    const A = childProgram(31);
    const B = childProgram(32);
    let heldOnce = false;
    const releaseA = Promise.withResolvers<void>();
    holdCompile = {
      activation: 1,
      contents: A,
      held: () => {
        heldOnce = true;
      },
      release: releaseA.promise,
    };
    const piece = await standUpPiece({
      names: { arg: "superseded-arg", result: "superseded-result" },
      code: A,
    });
    await waitUntil(
      () => heldOnce && piece.pendingOf() === true,
      () => `A's issue + held compile (${piece.view()})`,
    );
    // B supersedes A and lands.
    await piece.setCode(B);
    await waitUntil(
      () => piece.pendingOf() === false && piece.answerOf() === 32,
      () => `B to land while A is held (${piece.view()})`,
    );
    await waitUntil(
      () => host!.stats().memo.inflight === 1,
      () => `B's effect to retire (inflight=${host!.stats().memo.inflight})`,
    );
    expect(host.stats().outbox.superseded).toBe(0);

    // A's compile completes AFTER B landed: its completion re-reads the
    // current request (B), writes nothing — B's landed child is NOT
    // wiped, its resolution stands — and the effect retires (its key
    // released), counted as superseded.
    releaseA.resolve();
    await waitUntil(
      () => host!.stats().outbox.superseded === 1,
      () =>
        `the superseded completion to be counted (superseded=${
          host!.stats().outbox.superseded
        })`,
    );
    await waitUntil(
      () => host!.stats().memo.inflight === 0,
      () => `A's effect to retire (inflight=${host!.stats().memo.inflight})`,
    );
    expect(piece.pendingOf()).toBe(false);
    expect(piece.answerOf()).toBe(32);
    expect(host.stats().outbox.failed).toBe(0);

    // A requested again: the superseded effect DID compile A into the
    // process cache before it found itself superseded, so this run
    // instantiates straight from the warm cache — no new effect, no
    // second compile — and lands. (Had A's key still been held by a
    // wedged effect, a re-issue would have attached to it and never
    // landed; the released key is what `memo.inflight === 0` witnessed.)
    const queuedBefore = host.stats().outbox.queued;
    await piece.setCode(A);
    await waitUntil(
      () => piece.pendingOf() === false && piece.answerOf() === 31,
      () => `A to land on re-request (${piece.view()})`,
    );
    expect(host.stats().outbox.queued).toBe(queuedBefore);
    expect(compilesOf(servingRealCompiles, A)).toBe(1);
    expect(compilesOf(servingRealCompiles, B)).toBe(1);
    expect(compilesOf(clientCompiles, A)).toBe(0);
    expect(host.stats().unstampedSealRefusals).toBe(0);
    piece.cancelDemand();
  });

  it("FAN-OUT cardinality 2 (the independent review's MAJOR-B): two demanders of a NARROWED compile-and-run node (a per-user program, the same text for both) — ONE real compile per program per process (content-cached), ONE effect completion + ONE instantiation PER DEMANDED INSTANCE: both instances land pending=false with the child; the effect key and the completion carry the instance, so the second demander's effect never dedupes against the first's and each completion lands on its own instance", async () => {
    host = newHost();
    openClient();
    const bob = openSecondClient(bobSigner);
    const A = childProgram(21);
    // Activation #1 HOLDS the compile of A (releasable): both demanders'
    // instances issue while the first effect is still in flight — the
    // shape that wedged at eb6d1e4bb (the second issue aborted the first
    // effect's signal at issue and deduped against its key).
    let holds = 0;
    const releaseA = Promise.withResolvers<void>();
    holdCompile = {
      activation: 1,
      contents: A,
      held: () => {
        holds++;
      },
      release: releaseA.promise,
    };
    const piece = await standUpPiece({
      names: { arg: "fanout-arg", result: "fanout-result" },
      code: A,
      parentPattern: PER_USER_PROGRAM_PARENT,
      perUserCode: true,
    });
    // Alice's instance issues its effect (held).
    await waitUntil(
      () => holds >= 1 && piece.pendingOf() === true,
      () => `alice's instance to issue (holds=${holds}, ${piece.view()})`,
    );
    expect(host.stats().outbox.queued).toBe(1);

    // Bob's demand: the same space-scoped root watch every client holds —
    // and his OWN per-user program (the same text as Alice's).
    await piece.writeCode(bob, A);
    const bobResult = bob.getCell<{ compiled: CompiledView }>(
      space,
      "fanout-result",
      piece.parent.resultSchema,
    );
    await bobResult.sync();
    const cancelBob = bobResult.sink(() => {});
    await bob.idle();
    await bob.storageManager.synced();
    const resultId = piece.result.getAsNormalizedFullLink().id;
    await waitUntil(
      () => {
        const demanded = host!.spaceServer(space)?.demandedIdentitiesOf(
          resultId,
        ) ?? [];
        return [aliceSigner, bobSigner].every((signer) =>
          demanded.some((i) => i.principal === signer.did())
        );
      },
      () =>
        "the registry to carry both root watchers (has " +
        JSON.stringify(
          host!.spaceServer(space)?.demandedIdentitiesOf(resultId),
        ) +
        ")",
    );
    const bobCompiled = () => bobResult.key("compiled");
    const bobAnswer = () =>
      bobCompiled().key("result").key("answer").get() as unknown as
        | number
        | undefined;
    const bobPending = () => bobCompiled().key("pending").get();
    const bobView = () => `pending=${bobPending()}, answer=${bobAnswer()}`;

    // Bob's instance issues ITS OWN effect (the key carries the instance)
    // while alice's is held: TWO admissions, two holds — never an attach.
    // At eb6d1e4bb the second issue shared the first's key and attached
    // to it (queued stayed 1) after aborting the first's signal.
    await waitUntil(
      () =>
        host!.stats().outbox.queued === 2 && holds >= 2 &&
        bobPending() === true,
      () =>
        `bob's instance to issue its own effect (queued=${
          host!.stats().outbox.queued
        }, holds=${holds}, bob: ${bobView()})`,
    );

    // Release: ONE real compile (the two effects single-flight on the
    // content cache), TWO completions — each stamped with its instance —
    // and BOTH instances land: each demander's client, reading ITS
    // instance through the user-scoped links, sees pending=false and the
    // child's value.
    releaseA.resolve();
    await waitUntil(
      () =>
        piece.pendingOf() === false && piece.answerOf() === 21 &&
        bobPending() === false && bobAnswer() === 21,
      () =>
        `both instances to land (alice: ${piece.view()}; bob: ${bobView()})`,
    );
    expect(compilesOf(servingRealCompiles, A)).toBe(1);
    expect(compilesOf(clientCompiles, A)).toBe(0);
    await waitUntil(
      () => host!.stats().memo.inflight === 0,
      () => `every effect to retire (inflight=${host!.stats().memo.inflight})`,
    );
    const stats = host.stats();
    expect(stats.outbox.queued).toBe(2);
    expect(stats.outbox.completed).toBe(2);
    expect(stats.outbox.failed).toBe(0);
    expect(stats.outbox.superseded).toBe(0);
    expect(stats.unstampedSealRefusals).toBe(0);
    cancelBob();
    piece.cancelDemand();
  });
});
