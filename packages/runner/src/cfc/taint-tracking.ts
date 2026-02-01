import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { ActionTaintContext } from "./action-context.ts";
import type { Label } from "./labels.ts";
import { accumulateTaint, checkWrite } from "./action-context.ts";
import type { ExchangeRule } from "./exchange-rules.ts";

/**
 * Associates ActionTaintContext with transactions.
 * This avoids modifying the IExtendedStorageTransaction interface.
 */
const taintContexts = new WeakMap<IExtendedStorageTransaction, ActionTaintContext>();

/** Attach a taint context to a transaction. Called at action start. */
export function attachTaintContext(
  tx: IExtendedStorageTransaction,
  ctx: ActionTaintContext,
): void {
  taintContexts.set(tx, ctx);
}

/** Get the taint context for a transaction, if any. */
export function getTaintContext(
  tx: IExtendedStorageTransaction,
): ActionTaintContext | undefined {
  return taintContexts.get(tx);
}

/**
 * Record a read with its label on the transaction's taint context.
 * No-op if no taint context is attached (backwards compatible).
 */
export function recordTaintedRead(
  tx: IExtendedStorageTransaction,
  label: Label,
): void {
  const ctx = taintContexts.get(tx);
  if (ctx) {
    accumulateTaint(ctx, label);
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
  const ctx = taintContexts.get(tx);
  if (ctx) {
    checkWrite(ctx, writeTargetLabel, exchangeRules ?? ctx.policy.exchangeRules);
  }
}

/** Remove taint context from transaction (cleanup). */
export function detachTaintContext(
  tx: IExtendedStorageTransaction,
): void {
  taintContexts.delete(tx);
}
