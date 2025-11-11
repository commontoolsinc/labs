import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { HttpProgramResolver } from "@commontools/js-runtime/program.ts";
import { resolveProgram } from "@commontools/js-runtime/typescript/resolver.ts";
import { TARGET } from "@commontools/js-runtime/typescript/options.ts";

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

/**
 * Fetch and resolve a program from a URL.
 * Returns { pending, result: { files, main }, error }
 */
export function fetchProgram(
  inputsCell: Cell<{ url: string }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let pending: Cell<boolean>;
  let result: Cell<ProgramResult | undefined>;
  let error: Cell<string | undefined>;
  let initialized = false;

  return (tx: IExtendedStorageTransaction) => {
    // Initialize cells once
    if (!initialized) {
      pending = runtime.getCell(
        parentCell.space,
        { fetchProgram: { pending: cause } },
        undefined,
        tx,
      );
      result = runtime.getCell(
        parentCell.space,
        { fetchProgram: { result: cause } },
        undefined,
        tx,
      );
      error = runtime.getCell(
        parentCell.space,
        { fetchProgram: { error: cause } },
        undefined,
        tx,
      );

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);

      pending.sync();
      result.sync();
      error.sync();

      initialized = true;
    }

    // Send cell references
    sendResult(tx, { pending, result, error });

    const { url } = inputsCell.getAsQueryResult([], tx);

    // If no URL, clear everything
    if (!url) {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      return;
    }

    // Check if already pending or already have result for this URL
    const isPending = pending.withTx(tx).get();
    if (isPending) return;

    // Start resolution
    pending.withTx(tx).set(true);

    (async () => {
      try {
        const resolver = new HttpProgramResolver(url);
        const program = await resolveProgram(resolver, {
          unresolvedModules: { type: "allow-all" },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        });

        await runtime.idle();

        runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set({
            files: program.files,
            main: program.main,
          });
          error.withTx(tx).set(undefined);
        });
      } catch (err) {
        await runtime.idle();

        runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(undefined);
          error.withTx(tx).set(
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    })();
  };
}
