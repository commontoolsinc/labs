import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const navigatedProcessKeys = new WeakMap<Runtime, Set<string>>();

function processKeyFor(cell: Cell<any>): string | undefined {
  try {
    const link = cell.getAsNormalizedFullLink();
    return `${link.space}/${link.id}`;
  } catch {
    return undefined;
  }
}

function hasNavigatedProcess(runtime: Runtime, key: string): boolean {
  return navigatedProcessKeys.get(runtime)?.has(key) ?? false;
}

function markNavigatedProcess(runtime: Runtime, key: string): void {
  let keys = navigatedProcessKeys.get(runtime);
  if (!keys) {
    keys = new Set();
    navigatedProcessKeys.set(runtime, keys);
  }
  keys.add(key);
}

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
  let resultCell: Cell<boolean>;
  const processKey = processKeyFor(parentCell);

  const action: Action = (tx: IExtendedStorageTransaction) => {
    // The main reason we might be called again after navigating is that the
    // transaction to update the result cell failed, so we'll just set it again.
    if (navigated) {
      resultCell?.withTx(tx).set(true);
      return;
    }

    // Initialize the result cell if it hasn't been initialized yet.
    if (!isInitialized) {
      resultCell = runtime.getCell<any>(
        parentCell.space,
        { navigateTo: { result: cause } },
        { type: "boolean" },
        tx,
      );

      resultCell.sync();

      sendResult(tx, resultCell);

      isInitialized = true;
    }

    if (processKey && hasNavigatedProcess(runtime, processKey)) {
      resultCell.withTx(tx).set(true);
      return;
    }

    // If the result cell is already true, we've already navigated.
    if (resultCell.withTx(tx).get()) return;

    // Read with a schema that won't subscribe to the whole piece
    const inputsWithLog = inputsCell.asSchema({
      type: "object",
      properties: {},
      asCell: ["cell"],
    })
      .withTx(tx);
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

      navigated = true;
      if (processKey) {
        markNavigatedProcess(runtime, processKey);
      }
      tx.enqueuePostCommitEffect({
        id: `navigate-to:${JSON.stringify(resolvedTarget.getAsLink())}`,
        kind: "navigate-to",
        idempotencyKey: `navigate-to:${
          JSON.stringify(resolvedTarget.getAsLink())
        }`,
        async flush() {
          await runtime.navigateCallback!(resolvedTarget);
        },
      });
      resultCell.set(true);
    }
  };

  return {
    action,
    isEffect: true,
  };
}
