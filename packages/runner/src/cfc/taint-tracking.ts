import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { ActionTaintContext } from "./action-context.ts";
import type { Label } from "./labels.ts";
import { accumulateTaint, checkWrite } from "./action-context.ts";
import type { ExchangeRule } from "./exchange-rules.ts";
import { formatLabel } from "./violations.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("cfc");

/**
 * Associates ActionTaintContext with transactions, along with debug/dryRun flags.
 * This avoids modifying the IExtendedStorageTransaction interface.
 */
type TaintEntry = {
  ctx: ActionTaintContext;
  debug: boolean;
  dryRun: boolean;
};

const taintEntries = new WeakMap<IExtendedStorageTransaction, TaintEntry>();

/** Attach a taint context to a transaction. Called at action start. */
export function attachTaintContext(
  tx: IExtendedStorageTransaction,
  ctx: ActionTaintContext,
  options?: { debug?: boolean; dryRun?: boolean },
): void {
  taintEntries.set(tx, {
    ctx,
    debug: options?.debug ?? false,
    dryRun: options?.dryRun ?? false,
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
        `Taint accumulated:`, formatLabel(label),
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
      checkWrite(entry.ctx, writeTargetLabel, exchangeRules ?? entry.ctx.policy.exchangeRules);
    } catch (e) {
      if (entry.dryRun) {
        logger.warn("cfc-violation", () => [
          `[DRY RUN] ${(e as Error).message}`,
        ]);
        return;
      }
      throw e;
    }
  }
}

/** Remove taint context from transaction (cleanup). */
export function detachTaintContext(
  tx: IExtendedStorageTransaction,
): void {
  taintEntries.delete(tx);
}
