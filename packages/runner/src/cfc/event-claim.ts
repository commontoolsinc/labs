import type { Runtime } from "../runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";

export interface CfcHandledEventClaimMarker {
  readonly id: string;
  readonly space: MemorySpace;
}

function getHandledEventClaimCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  eventId: string,
  handlerKey: string,
) {
  return runtime.getCell(
    space,
    {
      cfc: {
        handledEvent: {
          eventId,
          handlerKey,
        },
      },
    },
    undefined,
    tx,
  );
}

export function tryClaimHandledEvent(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  eventId: string,
  handlerKey: string,
): {
  readonly alreadyHandled: boolean;
  readonly marker: CfcHandledEventClaimMarker;
} {
  const cell = getHandledEventClaimCell(
    runtime,
    tx,
    space,
    eventId,
    handlerKey,
  );
  const marker = {
    id: cell.getAsNormalizedFullLink().id,
    space,
  } satisfies CfcHandledEventClaimMarker;

  if (cell.withTx(tx).get() !== undefined) {
    return {
      alreadyHandled: true,
      marker,
    };
  }

  cell.withTx(tx).set(true);
  return {
    alreadyHandled: false,
    marker,
  };
}

export function isHandledEventClaimConflict(
  error: CommitError | undefined,
  marker: CfcHandledEventClaimMarker | undefined,
): boolean {
  if (!error || error.name !== "ConflictError" || !marker) {
    return false;
  }

  return error.conflict.space === marker.space &&
    error.conflict.of === marker.id;
}
