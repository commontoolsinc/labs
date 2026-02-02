import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import type { ActionTaintContext } from "./action-context.ts";
import type { Label } from "./labels.ts";
import {
  emptyLabel,
  joinLabel,
  labelFromSchemaIfc,
  labelFromStoredLabels,
  toLabelStorage,
} from "./labels.ts";
import {
  accumulateTaint,
  CFCViolationError,
  checkWrite,
} from "./action-context.ts";
import type { ExchangeRule } from "./exchange-rules.ts";
import { formatLabel } from "./violations.ts";
import { getLogger } from "@commontools/utils/logger";
import type { RuntimeTelemetry } from "../telemetry.ts";
import type { JSONSchema } from "../builder/types.ts";

const logger = getLogger("cfc");

/**
 * Associates ActionTaintContext with transactions, along with debug/dryRun flags and telemetry.
 * This avoids modifying the IExtendedStorageTransaction interface.
 */
type TaintEntry = {
  ctx: ActionTaintContext;
  debug: boolean;
  dryRun: boolean;
  telemetry?: RuntimeTelemetry;
};

const taintEntries = new WeakMap<IExtendedStorageTransaction, TaintEntry>();

/** Attach a taint context to a transaction. Called at action start. */
export function attachTaintContext(
  tx: IExtendedStorageTransaction,
  ctx: ActionTaintContext,
  options?: { debug?: boolean; dryRun?: boolean; telemetry?: RuntimeTelemetry },
): void {
  taintEntries.set(tx, {
    ctx,
    debug: options?.debug ?? false,
    dryRun: options?.dryRun ?? false,
    telemetry: options?.telemetry,
  });
}

/** Get the taint context for a transaction, if any. */
export function getTaintContext(
  tx: IExtendedStorageTransaction,
): ActionTaintContext | undefined {
  return taintEntries.get(tx)?.ctx;
}

/**
 * Record a read with its label on the transaction's taint context.
 * No-op if no taint context is attached (backwards compatible).
 */
export function recordTaintedRead(
  tx: IExtendedStorageTransaction,
  label: Label,
): void {
  const entry = taintEntries.get(tx);
  if (entry) {
    if (entry.debug) {
      logger.info("cfc-read", () => [
        `Taint accumulated:`,
        formatLabel(label),
      ]);
    }
    accumulateTaint(entry.ctx, label);
  }
}

/**
 * Check whether a write is allowed given accumulated taint.
 * No-op if no taint context is attached (backwards compatible).
 * Throws CFCViolationError on violation.
 */
export function checkTaintedWrite(
  tx: IExtendedStorageTransaction,
  writeTargetLabel: Label,
  exchangeRules?: ExchangeRule[],
): void {
  const entry = taintEntries.get(tx);
  if (entry) {
    try {
      checkWrite(
        entry.ctx,
        writeTargetLabel,
        exchangeRules ?? entry.ctx.policy.exchangeRules,
      );
    } catch (e) {
      if (e instanceof CFCViolationError) {
        const violation = {
          kind: e.kind,
          accumulatedTaint: formatLabel(e.accumulatedTaint),
          writeTargetLabel: formatLabel(e.writeTargetLabel),
          summary: e.message,
          isDryRun: entry.dryRun,
        };

        // Emit telemetry event for CFC violation
        if (entry.telemetry) {
          entry.telemetry.submit({
            type: "cfc.violation",
            ...violation,
          });
        }

        // Log the violation
        logger.warn("cfc-violation", () => [
          `${entry.dryRun ? "[DRY RUN] " : ""}${e.message}`,
        ]);

        // In dry-run mode, don't throw; in normal mode, rethrow
        if (!entry.dryRun) {
          throw e;
        }
      } else {
        // Re-throw if it's not a CFCViolationError
        throw e;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers — reduce duplication across cell.ts, data-updating.ts,
// schema.ts, and traverse.ts.
// ---------------------------------------------------------------------------

/** Compute a CFC label from a JSON schema's `ifc` field, or empty. */
export function labelFromSchema(
  schema: JSONSchema | undefined,
): Label {
  if (schema && typeof schema === "object" && schema.ifc) {
    return labelFromSchemaIfc(schema.ifc);
  }
  return emptyLabel();
}

/**
 * Record a read from a schema-annotated cell. Merges schema ifc with stored
 * labels (when CFC is active). No-op when tx has no taint context.
 */
export function recordSchemaRead(
  tx: IExtendedStorageTransaction,
  schema: JSONSchema | undefined,
  address?: IMemorySpaceAddress,
): void {
  const entry = taintEntries.get(tx);
  if (!entry) return;

  const schemaLabel = (schema && typeof schema === "object" && schema.ifc)
    ? labelFromSchemaIfc(schema.ifc)
    : undefined;

  const storedLabels = (schemaLabel || entry) && address
    ? tx.readLabelOrUndefined(address)
    : undefined;
  const storedLabel = storedLabels
    ? labelFromStoredLabels(storedLabels)
    : undefined;

  if (schemaLabel || storedLabel) {
    const effectiveLabel = schemaLabel && storedLabel
      ? joinLabel(schemaLabel, storedLabel)
      : (schemaLabel ?? storedLabel)!;
    recordTaintedRead(tx, effectiveLabel);
  }
}

/**
 * Check write is allowed, then persist the effective label (schema ⊔ taint)
 * to the label/ path. No-op when tx has no taint context and schema has no ifc.
 */
export function checkWriteAndPersistLabel(
  tx: IExtendedStorageTransaction,
  schema: JSONSchema | undefined,
  address: IMemorySpaceAddress,
): void {
  const writeLabel = labelFromSchema(schema);
  checkTaintedWrite(tx, writeLabel);

  const taintCtx = getTaintContext(tx);
  const effectiveLabel = taintCtx
    ? joinLabel(writeLabel, taintCtx.accumulatedTaint)
    : writeLabel;
  const storage = toLabelStorage(effectiveLabel);
  if (Object.keys(storage).length > 0) {
    tx.writeLabelOrThrow(address, storage);
  }
}

/** Remove taint context from transaction (cleanup). */
export function detachTaintContext(
  tx: IExtendedStorageTransaction,
): void {
  taintEntries.delete(tx);
}
