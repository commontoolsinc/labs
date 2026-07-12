import type { Cell } from "../cell.ts";
import { isPattern, type Pattern } from "../builder/types.ts";
import {
  FactoryArtifactUnavailableError,
  materializeFactory,
  prepareFactory,
} from "../factory-materialization.ts";
import { resolveLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import { RetryWhenReady } from "../scheduler/retry-when-ready.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

function requirePattern(value: unknown, builtinName: string): Pattern {
  if (!isPattern(value)) {
    throw new Error(
      `${builtinName}: canonical op must be a pattern factory`,
    );
  }
  return value;
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
export function materializeListPatternFactory(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  opCell: Cell<unknown>,
  builtinName: "map" | "filter" | "flatMap",
): Pattern {
  const resolvedOp = resolveLink(
    runtime,
    tx,
    opCell.getAsNormalizedFullLink(),
    "value",
  );
  const rawOp = runtime.getCellFromLink(resolvedOp, undefined, tx).getRaw();
  const context = {
    runtime,
    artifactSpace: resolvedOp.space,
  } as const;

  try {
    return requirePattern(
      materializeFactory(rawOp, context),
      builtinName,
    );
  } catch (error) {
    if (!(error instanceof FactoryArtifactUnavailableError)) throw error;
    const readiness = prepareFactory(rawOp, context).then((factory) => {
      requirePattern(factory, builtinName);
    });
    throw new RetryWhenReady(
      readiness,
      `${builtinName}: list pattern factory is waiting for artifact readiness`,
    );
  }
}
