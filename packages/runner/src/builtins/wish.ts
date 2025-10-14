import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { EntityId } from "../create-ref.ts";
import { ALL_CHARMS_ID } from "./well-known.ts";
import type { JSONSchema } from "../builder/types.ts";

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

const TARGET_SCHEMA = {
  type: "string",
  default: "",
} as const satisfies JSONSchema;

export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const inputsWithTx = inputsCell.withTx(tx);
    const values = inputsWithTx.get() ?? [];
    const target = inputsWithTx.key(0).asSchema(TARGET_SCHEMA).get();
    const defaultValue = values.length >= 2 ? values[1] : undefined;
    const hasDefault = defaultValue !== undefined && defaultValue !== null;
    const defaultCell = hasDefault ? inputsWithTx.key(1) : undefined;

    const wishTarget = typeof target === "string"
      ? target.trim()
      : "";

    if (wishTarget === "") {
      sendResult(tx, hasDefault ? defaultCell : undefined);
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
      sendResult(tx, hasDefault ? defaultCell : undefined);
      return;
    }

    sendResult(tx, resolvedCell.withTx(tx));
  };
}
