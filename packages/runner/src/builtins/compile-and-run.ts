import { type BuiltInCompileAndRunParams } from "commonfabric";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { Program } from "@commonfabric/js-compiler";
import { CompilerError } from "@commonfabric/js-compiler/errors";
import type { CellScope } from "../builder/types.ts";
import { resolvedCellScope, scopedCell } from "./scope-policy.ts";
import { narrowestScope } from "../scope.ts";

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
 */
export function compileAndRun(
  inputsCell: Cell<BuiltInCompileAndRunParams<any>>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<string | undefined>;
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
  let cellScope: CellScope | undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort any in-flight compilation if it's still pending.
    abortController?.abort("Pattern stopped");
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    // TODO(seefeld): Ideally, this cell already has this schema, because we set
    // it on the node itself.
    const program: Program = inputsCell.asSchema({
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
    }).withTx(tx).get();
    const input = inputsCell.withTx(tx).key("input");
    const outputScope = narrowestScope([
      tx.getNarrowestReadScope(),
      resolvedCellScope(runtime, tx, input),
    ]);

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
      }
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { compile: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);
      pending.send(false);

      const baseResult = runtime.getCell<string | undefined>(
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

      sendResult(tx, { pending, result, error, errors });
      cellsInitialized = true;
      cellScope = outputScope;
    }

    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const errorWithLog = error.withTx(tx);
    const errorsWithLog = errors.withTx(tx);

    const hash = hashOf(program ?? { files: [], main: "" }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash) return;

    // Check if inputs are undefined/empty (e.g., during rehydration before cells load)
    const hasValidInputs = program && program.main && program.files &&
      program.files.length > 0;

    // Special case: if inputs are invalid AND this is the hash for empty inputs,
    // the user intentionally cleared them - proceed to clear outputs
    const emptyInputsHash = hashOf({ files: [], main: "" }).toString();
    const isIntentionallyEmpty = !hasValidInputs && hash === emptyInputsHash;

    // If we have a previous valid result and inputs are currently invalid (likely rehydrating),
    // don't clear the outputs - just wait for real inputs to load
    // BUT if inputs are intentionally empty, we should clear
    if (
      !hasValidInputs && previousCallHash && previousCallHash !== hash &&
      !isIntentionallyEmpty
    ) {
      // Don't update previousCallHash - we'll wait for valid inputs
      return;
    }

    previousCallHash = hash;

    // Abort any in-flight compilation before starting a new one
    abortController?.abort("New compilation started");
    abortController = new AbortController();
    requestId = crypto.randomUUID();

    runtime.runner.stop(result);
    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    errorsWithLog.set(undefined);

    // Undefined inputs => Undefined output, not pending
    if (!hasValidInputs) {
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

    // Capture requestId for this compilation run
    const thisRequestId = requestId;

    // A failed commit DROPS the outbox (`clearPostCommitOutbox` in
    // `storage/extended-storage-transaction.ts`), so the compile below never
    // starts. `previousCallHash` was already advanced above and is an
    // IN-MEMORY marker, so the scheduler's conflict re-run would early-return
    // on `hash === previousCallHash` and strand `pending` at true with nothing
    // ever publishing a result. Release it so the re-run re-issues.
    //
    // This is the `compileAndRun` analogue of the marker-ordering hazard that
    // `sqliteQuery` documents (8cb00bbf8), in its weaker form: sqlite's
    // `requestHash` marker is DURABLE and doubles as the dedup gate, so a side
    // that wrote it without issuing wedged the side that was supposed to
    // issue. This marker is per-node and in memory, so it can only strand the
    // node that owns it — and only for as long as this callback does not run.
    //
    // `addCommitCallback` covers both rejection paths (the storage commit
    // rejecting, and `rejectCommitBeforeStorage`'s CFC refusal), but NOT
    // `abort()`, which drops the outbox without dispatching callbacks. The one
    // abort of a reactive action transaction is the `RetryImmediately` path
    // (`scheduler/run.ts:582`), and that signal can only be raised by an
    // `inSpace("name")` read — every read in this action happens above, before
    // the marker advances — so the gap is unreachable from here. A thrown
    // action error does NOT abort: the scheduler still commits (`run.ts:558`).
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (commitResult.error === undefined) return;
      if (previousCallHash === hash) previousCallHash = undefined;
    });

    // The compile and the pattern run go on the post-commit OUTBOX rather than
    // firing inline, because that is the only path by which `sourceAction`
    // reaches an async continuation: the outbox flush runs each effect inside
    // `runWithTransactionSourceAction(tx.sourceAction, …)`, and every
    // `Runtime.edit()` underneath it — the `editWithRetry` calls below and
    // `runSynced`'s own setup — inherits it (`runtime.ts:1372`). Without that,
    // the writes that publish the compile result are unattributable and no
    // executor claim can cover them. Modelled on
    // `enqueueSinkRequestPostCommitEffect` (`cfc/sink-request.ts`), which is how
    // `llmDialog` gets the same context.
    //
    // Two deliberate omissions, both because `compileAndRun` is a COMPUTATION
    // whose kind is still under review (see the header docblock of
    // `test/compile-and-run-servability.test.ts`):
    //  - no sink-request policy input: there is no external sink here, only
    //    local compilation and a nested pattern run;
    //  - no `externalSinkDisposition()` double-execution gate: it can only
    //    answer "allow" for a computation, and asking pins the transaction's
    //    effect authority to "client" as a side effect, which would prejudge
    //    that review. Whoever settles it adds the gate BEFORE
    //    `pendingWithLog.set(true)` above, per sqliteQuery's ordering note.
    //
    // The flush is FIRE-AND-FORGET on purpose. The async context is captured
    // where `.catch`/`.finally`/`.then` are registered, which is inside the
    // flush, so the continuations carry the source action without the flush
    // awaiting them. Awaiting would make the scheduler's action commit block on
    // an arbitrary compiled pattern running to completion — a scheduling
    // change, and not this one. `hasPendingPostCommitEffects()` does now make
    // this commit tracked async work (`scheduler/run.ts:675`), so `settled()`
    // waits for the flush to have STARTED the compile, not to have finished it.
    tx.enqueuePostCommitEffect({
      id: `compileAndRun:${thisRequestId}`,
      idempotencyKey: `compileAndRun:${thisRequestId}`,
      kind: "compile-and-run",
      flush: () => {
        // Superseded between the action body and the flush: the newer run set
        // its own `pending` and enqueued its own effect, so this one is dead.
        if (requestId !== thisRequestId) return;

        const compilePromise = runtime.patternManager
          .compileOrGetPattern(program, parentCell.space)
          .catch(
            (err) => {
              // Only process this error if the request hasn't been superseded
              if (requestId !== thisRequestId) return;
              if (abortController?.signal.aborted) return;

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
            if (requestId !== thisRequestId) return;
            // Always clear pending state, even if cancelled, to avoid stuck
            // state

            runtime.editWithRetry((asyncTx) => {
              pending.withTx(asyncTx).set(false);
            });
          });

        compilePromise.then((pattern) => {
          // Only run the result if this is still the current request
          if (requestId !== thisRequestId) return;
          if (abortController?.signal.aborted) return;

          if (pattern) {
            // TODO(ja): to support editting of existing pieces / running with
            // inputs from other pieces, we will need to think more about
            // how we pass input into the builtin.

            // No `isHidden` write here. It used to mark the compiled result
            // hidden so the piece this builtin AUTO-registered stayed out of
            // the default app's Patterns list; `pieceCreatedCallback` is gone,
            // so nothing registers the result any more — registering is an
            // `addPiece` handler's job
            // (docs/common/conventions/adding-pieces.md), and a pattern that
            // deliberately registers the result wants it visible. The write was
            // also never observable: `runSynced` replaces this same document's
            // whole `/value` from its setup transaction one commit later, and
            // wins deterministically because the call below is un-awaited.
            // Measured in `compile-and-run-servability.test.ts`.
            runtime.runSynced(result, pattern, input.get());
          }
          // TODO(seefeld): Add capturing runtime errors.
        });
      },
    });
  };
}
