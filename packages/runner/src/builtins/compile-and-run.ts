import { type BuiltInCompileAndRunParams } from "commonfabric";
import type { JSONSchema } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Program } from "@commonfabric/js-compiler";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { CellScope } from "../builder/types.ts";
import { resolvedCellScope, scopedCell } from "./scope-policy.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import { narrowestScope } from "../scope.ts";

/**
 * The compile request's memo cell (server-execution v2 stage C, OW28;
 * serving-loop.md §4). Exists only under EXPERIMENTAL_SERVER_EXECUTION
 * (the OFF arm keeps its in-memory `previousCallHash` dedupe, so a reload
 * re-compiles — cache-hit cheap, never an observable shape).
 *
 * - `requestHash` — the request the node's cells reflect. Written by the
 *   requesting DERIVATION at issue and re-asserted at every outcome.
 * - `resolvedHash` — the RESOLUTION marker: set (== `requestHash`) on
 *   every TERMINAL outcome (a landed piece, an error-shaped result, or a
 *   synchronous invalid-inputs / main-not-found outcome). The §4 HIT rule
 *   keys on THIS, not on `pending`: the cell-init writes `pending=false`
 *   on a fresh closure's first run (the loading-state default), so a
 *   durable `pending=true` mid-compile request would read `pending=false`
 *   there and a pending-based hit would FALSELY treat it as landed
 *   (rendering an empty result forever — the recovery-mid-flight wedge).
 *   `resolvedHash` is never written by init, so it distinguishes issued
 *   from resolved across a crash/park.
 * - `compiledHash` — set by the compile EFFECT's marked completion once
 *   the program is compiled and cached: it RE-ARMS the derivation (a
 *   tracked read of this cell) WITHOUT marking resolved (the instantiation
 *   is still pending), so the re-run reaches the instantiate branch. On a
 *   cold process (recovery) the cache misses and the compile re-issues
 *   (§6 step 3); the child's own durable pattern pointer lets the loop
 *   resume a LANDED child regardless.
 */
type CompileMemo = {
  requestHash?: string;
  resolvedHash?: string;
  compiledHash?: string;
};

/** The compile program shape the builtin hashes: `{ files, main }` —
 * `input` is NOT part of the request identity (today's contract: a
 * changed argument does not re-compile). */
/** A PLAIN deep copy of the program's `{ main, files }` — the ON arm
 * passes this (never the raw `asSchema` proxy) to `compileOrGetPattern`
 * and to `getCompiledPatternForProgramSync`. The content cache keys on
 * `createRef({ src })`, and a query-result PROXY serializes there
 * INSENSITIVE to nested `contents` (two distinct programs collapse to one
 * key — the sync lookup then hands a re-compile the PRIOR program), even
 * though `hashOf` reads the proxy correctly. Both the compile and the
 * lookup use this plain form, so distinct programs cache distinctly. */
function plainProgramOf(program: Program): Program {
  return {
    main: program?.main ?? "",
    files: (program?.files ?? []).map((file) => ({
      name: file?.name,
      contents: file?.contents,
    })) as Program["files"],
  };
}

const programSchema: JSONSchema = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          contents: { type: "string" },
        },
        required: ["name", "contents"],
      },
      default: [],
    },
    main: { type: "string", default: "" },
  },
  required: ["files", "main"],
};

/**
 * Compile a pattern/module and run it.
 *
 * @param files - Map of `{ filename: string }` to source code.
 * @param main - The name of the main pattern to run.
 * @param input - Inputs passed to the pattern once compiled.
 *
 * @returns { result?: any, error?: string, errors?: Array<{line: number, column: number, message: string, type: string, file?: string}>, pending: boolean }
 *   - `result` is the result of the pattern, or undefined.
 *   - `error` error string that occurred during compilation or execution, or
 *     undefined.
 *   - `errors` structured error array with line/column/file information for
 *     compilation errors.
 *   - `pending` is true if the pattern is still being compiled.
 *
 * Note that if an error occurs during execution, both `result` and `error` can
 * be defined. (Note: Runtime errors are not currently handled).
 *
 * Under EXPERIMENTAL_SERVER_EXECUTION (server-execution v2 stage C, OW28;
 * builtins.md §3, serving-loop.md §4–§5) the compile is served as an
 * OUTBOX EFFECT and the instantiation is an ordinary consequence of the
 * served graph run — see {@link compileAndRunServed}. The OFF arm is
 * byte-identical to the pre-port builtin (a floating compile promise with
 * unmarked writebacks) and lives in {@link compileAndRunOff}.
 */
export function compileAndRun(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let abortController: AbortController | undefined = undefined;
  // OFF-arm only: the in-memory request dedupe (unchanged).
  let previousCallHash: string | undefined = undefined;
  let requestId: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let error: Cell<string | undefined>;
  let errors: Cell<
    | Array<
      {
        line: number;
        column: number;
        message: string;
        type: string;
        file?: string;
      }
    >
    | undefined
  >;
  /** ON arm only: the §4 memo cell (see {@link CompileMemo}). */
  let internal: Cell<CompileMemo | undefined>;
  /** ON arm, client posture only: the last LANDED request hash this
   * closure reported through `pieceCreatedCallback` — a flag-ON client
   * never compiles, so it reports the served instantiation on OBSERVING
   * the landing, once per landed request (runtime-mapping.md N39). */
  let reportedCreatedHash: string | undefined = undefined;
  let cellScope: CellScope | undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort any in-flight compilation if it's still pending.
    abortController?.abort("Pattern stopped");
  });

  const on = runtime.experimental.serverExecution === true;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    // TODO(seefeld): Ideally, this cell already has this schema, because we set
    // it on the node itself.
    const program = inputsCell.asSchema<Program>(programSchema).withTx(tx)
      .get();
    const input = inputsCell.withTx(tx).key("input");
    const outputScope = narrowestScope([
      tx.getNarrowestReadScope(),
      resolvedCellScope(runtime, tx, input),
    ]);

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
        reportedCreatedHash = undefined;
      }
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { compile: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);
      pending.send(false);

      const baseResult = runtime.getCell<any | undefined>(
        parentCell.space,
        { compile: { result: cause } },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      const baseError = runtime.getCell<string | undefined>(
        parentCell.space,
        { compile: { error: cause } },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      const baseErrors = runtime.getCell<
        | Array<
          {
            line: number;
            column: number;
            message: string;
            type: string;
            file?: string;
          }
        >
        | undefined
      >(
        parentCell.space,
        { compile: { errors: cause } },
        undefined,
        tx,
      );
      errors = scopedCell(runtime, tx, baseErrors, outputScope);

      if (on) {
        // The §4 memo cell (ON arm only — the OFF arm's cell set is
        // unchanged). Not linked from the node's outputs, so it is synced
        // here like fetch's internal cell: the first evaluation on a fresh
        // runtime may read it unreplicated and re-miss once (T10.Q4's
        // accepted at-least-once), and the arrival re-arms the action.
        const baseInternal = runtime.getCell<CompileMemo | undefined>(
          parentCell.space,
          { compile: { internal: cause } },
          undefined,
          tx,
        );
        internal = scopedCell(runtime, tx, baseInternal, outputScope);
        internal.sync();
      }

      sendResult(tx, { pending, result, error, errors });
      cellsInitialized = true;
      cellScope = outputScope;
    }

    const hash = hashOf(program ?? { files: [], main: "" }).toString();
    const hasValidInputs = !!(program && program.main && program.files &&
      program.files.length > 0);
    const emptyInputsHash = hashOf({ files: [], main: "" }).toString();
    const isIntentionallyEmpty = !hasValidInputs && hash === emptyInputsHash;

    if (on) {
      compileAndRunServed(runtime, tx, {
        inputsCell,
        parentCell,
        cells: { pending, result, error, errors, internal },
        program,
        hash,
        hasValidInputs,
        isIntentionallyEmpty,
        reportCreated: (landedHash) => {
          if (reportedCreatedHash === landedHash) return false;
          reportedCreatedHash = landedHash;
          return true;
        },
        abort: () => {
          abortController?.abort("New compilation started");
          abortController = new AbortController();
          return abortController.signal;
        },
      });
      return;
    }

    // ---- OFF arm (byte-identical to the pre-port builtin) ----
    compileAndRunOff(runtime, tx, {
      inputsCell,
      parentCell,
      cells: { pending, result, error, errors },
      program,
      hash,
      hasValidInputs,
      isIntentionallyEmpty,
      previousCallHash,
      setPreviousCallHash: (h) => {
        previousCallHash = h;
      },
      newRequestId: () => {
        abortController?.abort("New compilation started");
        abortController = new AbortController();
        requestId = crypto.randomUUID();
        return requestId;
      },
      currentRequestId: () => requestId,
      abortSignal: () => abortController?.signal,
    });
  };
}

/** The ON-arm action (server-execution v2 stage C, OW28). The COMPILE is
 * an outbox effect; the INSTANTIATION is an ordinary consequence of the
 * served derivation run (builtins.md §3). Cleanly separated so the OFF
 * arm below stays the untouched original. */
function compileAndRunServed(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  ctx: {
    inputsCell: Cell<BuiltInCompileAndRunParams<any>>;
    parentCell: Cell<any>;
    cells: {
      pending: Cell<boolean>;
      result: Cell<any | undefined>;
      error: Cell<string | undefined>;
      errors: Cell<unknown>;
      internal: Cell<CompileMemo | undefined>;
    };
    program: Program;
    hash: string;
    hasValidInputs: boolean;
    isIntentionallyEmpty: boolean;
    /** Report the client's piece-creation hook once per landed request. */
    reportCreated: (landedHash: string) => boolean;
    /** Abort any prior in-flight compile and return a fresh signal. */
    abort: () => AbortSignal;
  },
): void {
  const { inputsCell, parentCell, cells, program, hash } = ctx;
  const { pending, result, error, errors, internal } = cells;
  const pendingT = pending.withTx(tx);
  const resultT = result.withTx(tx);
  const errorT = error.withTx(tx);
  const errorsT = errors.withTx(tx);
  const internalT = internal.withTx(tx);
  const memo = internalT.get();
  const stored = memo?.requestHash;
  const currentlyPending = pendingT.get();

  // The §4 HIT rule: this request already RESOLVED (a landed piece, an
  // error-shaped result, or a synchronous outcome) — the RESOLUTION marker
  // matches the request. The node's cells ARE its value; no effect fires.
  // This is what makes recovery safe (the loop resumes the child from its
  // durable pattern pointer) and what lets the CLIENT read through to the
  // served result (speculation.md §2). Keyed on `resolvedHash`, NOT on
  // `pending`: the cell-init clobbers `pending=false` on a fresh closure,
  // so a pending-based hit would falsely fire for a durable mid-compile
  // request on recovery (see CompileMemo). Sound because every terminal
  // path writes `resolvedHash === requestHash` in the SAME transaction as
  // its outcome.
  if (stored === hash && memo?.resolvedHash === hash) {
    runtime.effectMemoObserver?.({ kind: "hit", id: `compileAndRun:${hash}` });
    // The client's piece-creation hook (browser worker only): fired once
    // per LANDED successful compile, on observing the landing — the same
    // registration the OFF arm's compile completion fires (`pieces.add`
    // is idempotent). Nothing on the serving runtime and the OFF arm
    // reaches this branch.
    if (
      runtime.pieceCreatedCallback !== undefined &&
      ctx.hasValidInputs &&
      errorT.get() === undefined &&
      errorsT.get() === undefined &&
      ctx.reportCreated(hash)
    ) {
      runtime.pieceCreatedCallback(result);
    }
    return;
  }

  // The CLIENT reads through — for EVERY outcome, not only the compiled
  // one. A flag-ON non-serving run never compiles or instantiates
  // (speculation.md §2's effectful read-through) and writes NOTHING
  // speculatively — not even the synchronous invalid-inputs /
  // main-not-found outcomes below, which the SERVER decides identically
  // and lands as committed cells the client's hit rule above then reads
  // through. A speculative write here would only add an overlay entry
  // that must retire before the server's committed cells are visible,
  // delaying the read-through (a `pending=true` echo measurably delayed
  // the served `pending=false`); the parent's `ifElse(pending || (!result
  // && !error))` already renders the loading state while the served cells
  // are empty.
  if (!runtime.servingPosture) return;

  // ---- SERVING (the SpaceServer's runtime) from here on. Every scheduler
  // run on the serving runtime is wave-stamped by the SpaceServer's
  // stamper (serving-loop.md §3d), so the writes below seal into the wave
  // and the enqueued effect is deferred to the outbox; an UNSTAMPED
  // serving-runtime run would refuse loudly at the seal (§3d's refusal,
  // counted in `unstampedSealRefusals` — the E2E pins it at ZERO across
  // every served compile-and-run leg), never silently mis-route. ----

  // A fresh request (or a re-issue): the cells must reflect THIS hash.
  const reissue = stored !== hash;

  // Invalid inputs. Undefined/empty inputs => undefined output, not
  // pending; but a rehydration blip (invalid inputs while a prior valid
  // request stands) waits for the real inputs — UNLESS intentionally
  // cleared. Decided synchronously (no compile), the same way the OFF arm
  // decides it.
  if (!ctx.hasValidInputs) {
    if (stored !== undefined && stored !== hash && !ctx.isIntentionallyEmpty) {
      // Rehydration blip: keep the prior landed request; wait for inputs.
      return;
    }
    if (reissue || currentlyPending !== false) {
      runtime.runner.stop(result);
      ctx.abort();
      resultT.set(undefined);
      errorT.set(undefined);
      errorsT.set(undefined);
      pendingT.set(false);
      internalT.set({ requestHash: hash, resolvedHash: hash });
    }
    return;
  }

  // Main file not found => error, not pending (synchronous, as OFF).
  if (!program.files.some((file) => file?.name === program.main)) {
    if (reissue) {
      runtime.runner.stop(result);
      ctx.abort();
      resultT.set(undefined);
      errorsT.set(undefined);
      errorT.set(`"${program.main}" not found in files`);
      pendingT.set(false);
      internalT.set({ requestHash: hash, resolvedHash: hash });
    }
    return;
  }

  // A valid program: instantiate from the process compile cache when the
  // compile effect has already run (this session); otherwise issue +
  // enqueue the compile effect. The instantiation happens HERE, in the
  // derivation — the loop's own run, correctly scoped, atomic with respect
  // to the loop's piece machinery (a racing async flush loses the
  // re-instantiate to the loop's resume of the prior child).
  const plainProgram = plainProgramOf(program);
  const compiled = runtime.patternManager.getCompiledPatternForProgramSync(
    plainProgram,
  );
  if (compiled !== undefined) {
    // Tear down any prior child on this result cell before re-instantiating
    // (runSynced/run do not stop an existing registration, so a re-compile
    // over a running child would no-op its start and keep serving the old
    // one). Then instantiate the child in-run: its setup writes are
    // derivation-class (the result-as-pattern shape, builtins.md §3), and
    // the child's own body runs as ordinary served derivations. The setup
    // stores the child's `patternIdentity` pointer, which lets the loop
    // resume it after a park/crash.
    runtime.runner.stop(result);
    // TODO(ja): to support editing of existing pieces / running with inputs
    // from other pieces, we will need to think more about how we pass input
    // into the builtin.
    runtime.run(tx, compiled, inputsCell.withTx(tx).key("input").get(), result);
    resultT.key("isHidden").set(true);
    errorT.set(undefined);
    errorsT.set(undefined);
    pendingT.set(false);
    internalT.set({
      requestHash: hash,
      compiledHash: hash,
      resolvedHash: hash,
    });
    return;
  }

  // Not compiled (in this process). Issue (pending) and enqueue the compile
  // effect only when genuinely (re)issuing:
  //  - a NEW program (`reissue`); OR
  //  - a request not currently in flight for THIS run — `currentlyPending
  //    !== true`. On a FRESH closure the cell-init clobbered `pending=false`
  //    (the loading default), so a durable mid-compile request on RECOVERY
  //    (park / crash / a dropped or refused completion — every one of which
  //    ends the serving runtime and re-activates a fresh one) reads
  //    `pending=false` here and RE-FIRES the compile (§6 step 3's re-miss);
  //    OR
  //  - the effect's re-arm LANDED (`compiledHash === hash`) but the process
  //    compile cache no longer holds the entry (FIFO eviction between the
  //    effect and this run): re-fire rather than wedge — the effect
  //    re-compiles (cache miss → real compile) and re-arms again.
  // Within a session, the issue's own `pending=true` write (init is
  // skipped on re-runs) makes a same-hash re-arm-wait re-run read
  // `pending===true` with no `compiledHash` yet — so it does NOT re-abort
  // the in-flight compile or re-enqueue (the re-compile-forever bug); it
  // waits for the `compiledHash` re-arm to reach the instantiate branch
  // above.
  //
  // Posture, stated: a same-hash request whose completion commit FAILED
  // on a LIVE runtime that did not park (an infrastructure failure the
  // outbox counts as `outbox.failed`) stays pending until the space
  // re-activates or the inputs change — the request-hash builtins'
  // identical posture (fetch's in-memory claim `myRequestId` blocks
  // re-issue the same way; "recovery is §6's re-miss on the next
  // activation, or an input change"). No timer or dirtiness-driven retry
  // is invented here (T14; the retry rule is input-driven).
  const needIssue = reissue ||
    (currentlyPending !== true && errorT.get() === undefined &&
      resultT.get() === undefined) ||
    memo?.compiledHash === hash;
  if (!needIssue) return;
  const signal = ctx.abort();
  runtime.runner.stop(result);
  resultT.set(undefined);
  errorT.set(undefined);
  errorsT.set(undefined);
  pendingT.set(true);
  internalT.set({ requestHash: hash });
  const effectKey = effectTargetKey(`compileAndRun:${hash}`, result);
  const requestProgram = plainProgram;
  const space = parentCell.space;
  tx.enqueuePostCommitEffect({
    id: `compileAndRun:${hash}`,
    idempotencyKey: effectKey,
    kind: "compile-and-run",
    flush: () => {
      // Only the SERVING loop reaches here: a flag-ON client returned
      // above (`!servingPosture`) without enqueuing, so this effect exists
      // only on the serving runtime. `signal.aborted` skips a superseded
      // request (the program changed before the post-commit flush ran).
      if (signal.aborted) return;
      const work = performServedCompile(
        runtime,
        inputsCell,
        space,
        { pending, error, errors, internal },
        requestProgram,
        hash,
        effectKey,
        signal,
      );
      // Tracked as async builtin work owned by this run: the outbox
      // captures it during the flush's synchronous prefix (its settlement
      // is the effect's completion; a rejection counts outbox.failed).
      runtime.trackAsyncWork(work, parentCell);
    },
  });
}

/**
 * The served compile effect's work (ON arm; see {@link compileAndRunServed}):
 * compile the program (caching + persisting it), then land a marked
 * COMPLETION commit that either RE-ARMS the instantiating derivation
 * (`compiledHash`) on success, or writes the error-shaped result on a
 * compile failure. The instantiation itself is NOT done here — it is the
 * derivation's job (the loop's own run) — because a post-commit flush's
 * instantiation races the loop's resume of the prior child and loses.
 *
 * Rejects only when the completion itself cannot commit (the outbox counts
 * `outbox.failed`; recovery is §6's re-miss). An effect-level failure (the
 * compile rejecting) is an error-shaped RESULT, never a rejection.
 */
async function performServedCompile(
  runtime: Runtime,
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  space: string,
  cells: {
    pending: Cell<boolean>;
    error: Cell<string | undefined>;
    errors: Cell<unknown>;
    internal: Cell<CompileMemo | undefined>;
  },
  program: Program,
  hash: string,
  effectKey: string,
  signal: AbortSignal,
): Promise<void> {
  /** The request the cells reflect NOW (re-read through the completion
   * transaction, so a superseded request writes nothing — the new
   * request's own effect owns the cells; serving-loop.md §4's failure/
   * retry rule and the FP6 structural basis re-read). */
  const stillCurrent = (tx: IExtendedStorageTransaction): boolean => {
    if (signal.aborted) return false;
    const current = inputsCell.asSchema<Program>(programSchema).withTx(tx)
      .get();
    return hashOf(current ?? { files: [], main: "" }).toString() === hash;
  };
  let pattern: Awaited<
    ReturnType<typeof runtime.patternManager.compileOrGetPattern>
  >;
  try {
    pattern = await runtime.patternManager.compileOrGetPattern(
      program,
      space as never,
    );
  } catch (err) {
    if (signal.aborted) return;
    // The compile failed: an error-shaped result, keyed, in one completion
    // commit — retries are input-driven (a new hash), never timers (T14).
    const written = await runtime.editWithRetry((tx) => {
      markEffectCompletion(tx, effectKey);
      if (!stillCurrent(tx)) return;
      if (err instanceof CompilerError) {
        const structuredErrors = err.errors.map((e) => ({
          line: e.line ?? 1,
          column: e.column ?? 1,
          message: e.message,
          type: e.type,
          file: e.file,
        }));
        cells.errors.withTx(tx).set(structuredErrors);
      } else {
        const message = err instanceof Error
          ? err.message + (err.stack ? "\n" + err.stack : "")
          : String(err);
        cells.error.withTx(tx).set(message);
      }
      cells.pending.withTx(tx).set(false);
      cells.internal.withTx(tx).set({ requestHash: hash, resolvedHash: hash });
    });
    if (written.error !== undefined) {
      throw new Error(
        `compileAndRun error writeback failed to commit: ${written.error.message}`,
        { cause: err },
      );
    }
    return;
  }
  if (signal.aborted) return;
  if (!pattern) {
    // No pattern (a module without a default entry): today's OFF-arm
    // outcome is "not pending, no result, no error"; land the same, keyed,
    // so the request memo-hits instead of re-firing.
    const written = await runtime.editWithRetry((tx) => {
      markEffectCompletion(tx, effectKey);
      if (!stillCurrent(tx)) return;
      cells.pending.withTx(tx).set(false);
      cells.internal.withTx(tx).set({ requestHash: hash, resolvedHash: hash });
    });
    if (written.error !== undefined) {
      throw new Error(
        `compileAndRun completion failed to commit: ${written.error.message}`,
      );
    }
    return;
  }
  // Success: the pattern is now in the process compile cache. RE-ARM the
  // instantiating derivation — `compiledHash` is a tracked read, so this
  // marked completion dirties the action, which then sync-hits the cache
  // and instantiates the child (correctly scoped, no race). `pending`
  // stays true until that instantiation lands `pending=false`.
  const written = await runtime.editWithRetry((tx) => {
    markEffectCompletion(tx, effectKey);
    if (!stillCurrent(tx)) return;
    cells.internal.withTx(tx).set({ requestHash: hash, compiledHash: hash });
  });
  if (written.error !== undefined) {
    throw new Error(
      `compileAndRun re-arm completion failed to commit: ${written.error.message}`,
    );
  }
  // TODO(seefeld): Add capturing runtime errors.
}

/** The OFF arm — byte-identical to the pre-port builtin: a floating
 * compile promise with unmarked writebacks, the in-memory
 * `previousCallHash` dedupe, and `pieceCreatedCallback` at compile
 * completion. Extracted verbatim so the ON arm above cannot perturb it. */
function compileAndRunOff(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  ctx: {
    inputsCell: Cell<BuiltInCompileAndRunParams<any>>;
    parentCell: Cell<any>;
    cells: {
      pending: Cell<boolean>;
      result: Cell<any | undefined>;
      error: Cell<string | undefined>;
      errors: Cell<unknown>;
    };
    program: Program;
    hash: string;
    hasValidInputs: boolean;
    isIntentionallyEmpty: boolean;
    previousCallHash: string | undefined;
    setPreviousCallHash: (hash: string) => void;
    newRequestId: () => string;
    currentRequestId: () => string | undefined;
    abortSignal: () => AbortSignal | undefined;
  },
): void {
  const { inputsCell, parentCell, cells, program, hash } = ctx;
  const { pending, result, error, errors } = cells;
  const input = inputsCell.withTx(tx).key("input");
  const pendingWithLog = pending.withTx(tx);
  const resultWithLog = result.withTx(tx);
  const errorWithLog = error.withTx(tx);
  const errorsWithLog = errors.withTx(tx);

  // Return if the same request is being made again, either concurrently (same
  // as previousCallHash) or when rehydrated from storage.
  if (hash === ctx.previousCallHash) return;

  // If we have a previous valid result and inputs are currently invalid
  // (likely rehydrating), don't clear the outputs — wait for real inputs.
  // BUT if inputs are intentionally empty, we should clear.
  if (
    !ctx.hasValidInputs && ctx.previousCallHash &&
    ctx.previousCallHash !== hash && !ctx.isIntentionallyEmpty
  ) {
    return;
  }

  ctx.setPreviousCallHash(hash);

  const thisRequestId = ctx.newRequestId();

  runtime.runner.stop(result);
  resultWithLog.set(undefined);
  errorWithLog.set(undefined);
  errorsWithLog.set(undefined);

  // Undefined inputs => Undefined output, not pending
  if (!ctx.hasValidInputs) {
    pendingWithLog.set(false);
    return;
  }

  // Main file not found => Error, not pending
  if (!program.files.some((file) => file?.name === program.main)) {
    errorWithLog.set(`"${program.main}" not found in files`);
    pendingWithLog.set(false);
    return;
  }

  // Now we're sure that we have a new file to compile
  pendingWithLog.set(true);

  const compilePromise = runtime.patternManager
    .compileOrGetPattern(program, parentCell.space)
    .catch(
      (err) => {
        // Only process this error if the request hasn't been superseded
        if (ctx.currentRequestId() !== thisRequestId) return;
        if (ctx.abortSignal()?.aborted) return;

        runtime.editWithRetry((asyncTx) => {
          // Extract structured errors if this is a CompilerError
          if (err instanceof CompilerError) {
            const structuredErrors = err.errors.map((e) => ({
              line: e.line ?? 1,
              column: e.column ?? 1,
              message: e.message,
              type: e.type,
              file: e.file,
            }));
            errors.withTx(asyncTx).set(structuredErrors);
          } else {
            error.withTx(asyncTx).set(
              err.message + (err.stack ? "\n" + err.stack : ""),
            );
          }
        });
      },
    ).finally(() => {
      // Only update pending if this is still the current request
      if (ctx.currentRequestId() !== thisRequestId) return;
      // Always clear pending state, even if cancelled, to avoid stuck state

      runtime.editWithRetry((asyncTx) => {
        pending.withTx(asyncTx).set(false);
      });
    });

  compilePromise.then((pattern) => {
    // Only run the result if this is still the current request
    if (ctx.currentRequestId() !== thisRequestId) return;
    if (ctx.abortSignal()?.aborted) return;

    if (pattern) {
      // TODO(ja): to support editting of existing pieces / running with
      // inputs from other pieces, we will need to think more about
      // how we pass input into the builtin.

      runtime.runSynced(result, pattern, input.get());
      runtime.editWithRetry((asyncTx) => {
        result.withTx(asyncTx).key("isHidden").set(true);
      });
      runtime.pieceCreatedCallback?.(result);
    }
    // TODO(seefeld): Add capturing runtime errors.
  });
}
