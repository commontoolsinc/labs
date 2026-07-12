import {
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import type { Cell } from "../cell.ts";
import { isPattern, type Pattern } from "../builder/types.ts";
import type { AddCancel } from "../cancel.ts";
import { cfcLabelViewForCell } from "../cfc/label-view.ts";
import {
  FactoryArtifactUnavailableError,
  materializeFactory,
  prepareFactory,
} from "../factory-materialization.ts";
import { resolveLink } from "../link-resolution.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import { RetryWhenReady } from "../scheduler/retry-when-ready.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
} from "../storage/interface.ts";

function requirePattern(value: unknown, builtinName: string): Pattern {
  if (!isPattern(value)) {
    throw new Error(
      `${builtinName}: canonical op must be a pattern factory`,
    );
  }
  return value;
}

type ListBuiltinName = "map" | "filter" | "flatMap";

type CanonicalSelection = {
  canonical: unknown;
  cfcLabel: unknown;
};

type CurrentSelection = CanonicalSelection & {
  raw: unknown;
  sourceLink: NormalizedFullLink;
};

export type MaterializedListPatternSelection = {
  pattern: Pattern;
  generation: number;
  factorySelectionLink: NormalizedFullLink;
};

function canonicalSelection(value: unknown): unknown {
  return isAdmittedFabricFactory(value) ? sealFactoryState(value) : value;
}

function sameSelection(
  left: CanonicalSelection,
  right: CanonicalSelection,
): boolean {
  return deepEqual(left.canonical, right.canonical) &&
    deepEqual(left.cfcLabel, right.cfcLabel);
}

function readSelection(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  bindingLink: NormalizedFullLink,
): CurrentSelection {
  const resolvedOp = resolveLink(
    runtime,
    tx,
    bindingLink,
    "value",
  );
  const sourceCell = runtime.getCellFromLink(resolvedOp, undefined, tx);
  const raw = sourceCell.getRaw();
  return {
    raw,
    canonical: canonicalSelection(raw),
    cfcLabel: cfcLabelViewForCell(sourceCell),
    sourceLink: resolvedOp,
  };
}

/**
 * Materialize one canonical list-op factory at its resolved source location.
 *
 * A cold artifact parks only the current coordinator action. The scheduler
 * preserves its op/list read set, aborts its writes, and generation-fences the
 * readiness continuation. Once loading settles the action runs again and
 * rereads the current op and list; an intervening selection or owner stop
 * therefore supersedes this attempt without invoking an old child.
 */
function materializeSelection(
  runtime: Runtime,
  selection: CurrentSelection,
  builtinName: ListBuiltinName,
): Pattern {
  const context = {
    runtime,
    artifactSpace: selection.sourceLink.space,
  } as const;

  try {
    return requirePattern(
      materializeFactory(selection.raw, context),
      builtinName,
    );
  } catch (error) {
    if (!(error instanceof FactoryArtifactUnavailableError)) throw error;
    const readiness = prepareFactory(selection.raw, context).then((factory) => {
      requirePattern(factory, builtinName);
    });
    throw new RetryWhenReady(
      readiness,
      `${builtinName}: list pattern factory is waiting for artifact readiness`,
    );
  }
}

/**
 * Supervise the canonical factory selected by one list builtin instance.
 *
 * The normal action is the only execution-authorizing path. The storage
 * listener is deliberately a cancellation-only fast lane: it can invalidate
 * and stop the active row generation while an authored promise occupies the
 * scheduler, but it never materializes code or starts a replacement.
 */
export function createListPatternFactorySupervisor(
  runtime: Runtime,
  addCancel: AddCancel,
  preemptRows: () => void,
): {
  materialize(
    tx: IExtendedStorageTransaction,
    opBindingCell: Cell<unknown>,
    builtinName: ListBuiltinName,
  ): MaterializedListPatternSelection;
} {
  let active = true;
  let bindingLink: NormalizedFullLink | undefined;
  let selectionSourceLink: NormalizedFullLink | undefined;
  let activeSelection: CanonicalSelection | undefined;
  let preempted = false;
  let generation = 0;
  let fastSelectionQueued = false;
  let fastSubscription: IStorageSubscription | undefined;

  const preempt = (): void => {
    if (preempted) return;
    preempted = true;
    generation++;
    preemptRows();
  };

  const installFastSubscription = (): void => {
    if (fastSubscription !== undefined) return;
    fastSubscription = {
      next: (notification) => {
        if (!active) return { done: true };
        const touches = (link: NormalizedFullLink | undefined): boolean => {
          if (link === undefined || notification.space !== link.space) {
            return false;
          }
          if (notification.type === "reset") return true;
          return [...notification.changes].some((change) =>
            change.address.id === link.id &&
            (change.address.scope ?? "space") === (link.scope ?? "space")
          );
        };
        if (!touches(bindingLink) && !touches(selectionSourceLink)) {
          return { done: false };
        }
        if (!fastSelectionQueued) {
          fastSelectionQueued = true;
          queueMicrotask(() => {
            fastSelectionQueued = false;
            if (!active || bindingLink === undefined) return;
            try {
              const current = readSelection(
                runtime,
                runtime.readTx(),
                bindingLink,
              );
              selectionSourceLink = current.sourceLink;
              if (
                activeSelection !== undefined &&
                !sameSelection(current, activeSelection)
              ) {
                preempt();
              }
            } catch (error) {
              runtime.scheduler.reportError(error, {
                name: "list-factory-fast-selection",
              });
            }
          });
        }
        return { done: false };
      },
    };
    runtime.storageManager.subscribe(fastSubscription);
  };

  addCancel(() => {
    active = false;
    if (fastSubscription !== undefined) {
      runtime.storageManager.unsubscribe?.(fastSubscription);
      fastSubscription = undefined;
    }
  });

  return {
    materialize(tx, opBindingCell, builtinName) {
      bindingLink = opBindingCell.getAsNormalizedFullLink();
      const current = readSelection(runtime, tx, bindingLink);
      selectionSourceLink = current.sourceLink;
      installFastSubscription();

      if (
        activeSelection !== undefined &&
        !sameSelection(current, activeSelection)
      ) {
        preempt();
      }

      // Materialization can throw RetryWhenReady or a terminal validation
      // error. In either case the old rows stay canceled and activeSelection
      // deliberately remains the last successfully activated state.
      const pattern = materializeSelection(runtime, current, builtinName);
      if (generation === 0) generation = 1;
      activeSelection = current;
      preempted = false;
      return {
        pattern,
        generation,
        factorySelectionLink: bindingLink,
      };
    },
  };
}
