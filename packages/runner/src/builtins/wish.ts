import { ALL_CHARMS_ID } from "@commontools/charm";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { EntityId } from "../create-ref.ts";

type WishResolution = {
  entityId: EntityId;
  path?: readonly string[];
};

const WISH_TARGETS: Record<string, WishResolution> = {
  "#/allCharms": { entityId: { "/": ALL_CHARMS_ID } },
};

function resolveWishTarget(
  wish: string,
  runtime: IRuntime,
  space: MemorySpace,
  tx: IExtendedStorageTransaction,
): Cell<unknown> | undefined {
  const target = WISH_TARGETS[wish];
  if (!target) return undefined;

  const path = target.path ? [...target.path] : [];
  return runtime.getCellFromEntityId(
    space,
    target.entityId,
    path,
    undefined,
    tx,
  );
}

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let resultCell: Cell<unknown> | undefined;

  return (tx: IExtendedStorageTransaction) => {
    if (!resultCell) {
      resultCell = runtime.getCell(
        parentCell.space,
        { wish: cause },
        undefined,
        tx,
      );
      resultCell.setSourceCell(parentCell);
      sendResult(tx, resultCell);
    }

    const resultWithLog = resultCell.withTx(tx);
    const [targetCandidate, defaultValue] = inputsCell.withTx(tx).get() ??
      [];
    const wishTarget = typeof targetCandidate === "string"
      ? targetCandidate.trim()
      : "";

    if (wishTarget === "") {
      if (defaultValue === undefined) resultWithLog.set(undefined);
      else resultWithLog.set(defaultValue);
      return;
    }

    const resolvedCell = resolveWishTarget(
      wishTarget,
      runtime,
      parentCell.space,
      tx,
    );

    if (!resolvedCell) {
      console.error(`Wish target "${wishTarget}" is not recognized.`);
      if (defaultValue === undefined) resultWithLog.set(undefined);
      else resultWithLog.set(defaultValue);
      return;
    }

    const resolvedLink = resolvedCell.withTx(tx).getAsWriteRedirectLink();
    resultWithLog.setRaw(resolvedLink);
  };
}
