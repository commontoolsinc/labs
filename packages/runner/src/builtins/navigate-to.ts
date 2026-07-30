import { type Cell, createCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function navigateTo(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let isInitialized = false;
  let navigated = false;
  let navigationAttempt = 0;
  let resultCell: Cell<boolean>;
  /**
   * The SESSION-scoped result instance this node mints and writes. It is not a
   * registered output cell — the registered output holds only a link to it — so
   * the generically minted `ServerBuiltinActionDescriptor` (`runner.ts`) cannot
   * see it, and without publishing it here a claimed server-side run writes
   * outside its declared surface and de-claims fail-closed. Same
   * splice-in-place idiom as `llm-dialog.ts`: the runner captures this array's
   * IDENTITY at registration (`runner.ts`, `serverBuiltinRuntimeWrites`) and
   * reads it fresh on every run, so the first run's mint reaches the descriptor
   * that was authored before it.
   *
   * This declaration is also the design's safety hinge
   * (`docs/specs/server-side-execution/navigate-to-server-side.md` §6 item 2).
   * `session` scope is admitted ONLY at session lane rank
   * (`scheduler/servability.ts` `laneAdmitsScope`), so declaring it is what
   * pins the action's `contextRank` to `"session"` and makes a space- or
   * user-rank navigate claim — the shapes that would reach a co-tenant or
   * another device — structurally unreachable. Drop it and the action silently
   * becomes space rank, where claim delivery has no principal filter at all.
   */
  const serverBuiltinRuntimeWrites: NormalizedFullLink[] = [];
  const targetCellSchema = {
    type: "object",
    properties: {},
    asCell: ["cell"],
  } as const;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      const baseResultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );
      resultCell = createCell(
        runtime,
        {
          ...baseResultCell.getAsNormalizedFullLink(),
          scope: "session",
        },
        tx,
      );

      resultCell.sync();

      serverBuiltinRuntimeWrites.splice(
        0,
        serverBuiltinRuntimeWrites.length,
        resultCell.getAsNormalizedFullLink(),
      );

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole piece
    const inputsWithLog = inputsCell.asSchema(targetCellSchema).withTx(tx);
    const target = inputsWithLog.get();

    // Pattern creation can yield a navigable cell before every reactive
    // dependency has materialized its value. The cell identity is enough for
    // navigation; requiring a current value can block valid piece targets.
    if (target) {
      if (!runtime.navigateCallback) {
        throw new Error("navigateCallback is not set");
      }

      // Resolve to root piece - follows links until path is empty
      const resolvedTarget = target.resolveAsCell();
      const navigateCallback = runtime.navigateCallback;

      const previousNavigated = navigated;
      const thisAttempt = ++navigationAttempt;
      navigated = true;
      tx.addCommitCallback((_committedTx, commitResult) => {
        if (commitResult.error && navigationAttempt === thisAttempt) {
          navigated = previousNavigated;
        }
      });
      // Navigation is an external effect: release it only after a successful
      // commit. The outbox promise is tracked explicitly so runtime.settled()
      // cannot race async shell navigation.
      const targetLink = resolvedTarget.getAsNormalizedFullLink();
      tx.enqueuePostCommitEffect({
        // The outbox deduplicates by id within a transaction. Encode the full
        // normalized link as a tuple so scoped targets remain distinct and path
        // segments containing separators cannot collide.
        id: `navigateTo:${
          JSON.stringify([
            targetLink.space,
            targetLink.scope,
            targetLink.id,
            targetLink.path,
          ])
        }`,
        kind: "navigateTo",
        flush: async () => {
          if (navigationAttempt !== thisAttempt) return;
          const work = Promise.resolve().then(() =>
            navigateCallback(resolvedTarget)
          );
          runtime.trackAsyncWork(work);
          try {
            await work;
          } catch (error) {
            console.error("navigateTo callback failed:", error);
          }
        },
      });
      resultCell.withTx(tx).set(true);
      runtime.scheduler.queueExecution();
    }
  };

  // Attached to a named const rather than inline in the returned literal, for
  // the reason `llm-dialog.ts` records: the effect-kind pin in
  // `test/builtin-effect-registry.test.ts` regex-matches
  // `return { … isEffect: true` and cannot see past a nested brace, so an
  // inline `Object.assign(action, { … })` reads to it as "the factory stopped
  // declaring isEffect". Keep the plumbing out of the literal.
  const navigateAction = Object.assign(action, { serverBuiltinRuntimeWrites });

  return {
    action: navigateAction,
    isEffect: true,
    useDeclaredReadsAsDependencies: true,
  };
}
