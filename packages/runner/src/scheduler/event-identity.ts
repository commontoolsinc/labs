import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

// Per-origin-transaction state for minting causally-derived event ids:
// a stable random key for the transaction plus a send counter. Both live
// only as long as the transaction object; retries of the sending handler
// run in a NEW transaction and therefore mint fresh ids (spec §7.6: each
// attempt's launches are tied to that attempt).
const txEventKeys = new WeakMap<object, { key: string; counter: number }>();

function originStateFor(tx: object): { key: string; counter: number } {
  let state = txEventKeys.get(tx);
  if (!state) {
    state = { key: crypto.randomUUID(), counter: 0 };
    txEventKeys.set(tx, state);
  }
  return state;
}

/**
 * Mints the durable id for an event at send time (spec §7.5). Ingress
 * callers that already own a durable delivery id pass it through instead.
 */
export function mintEventId(
  eventLink: NormalizedFullLink,
  originTx?: IExtendedStorageTransaction,
): string {
  if (originTx) {
    const state = originStateFor(originTx);
    const seq = state.counter++;
    return `evt:${state.key}:${seq}:${eventLink.id}`;
  }
  return `evt:${crypto.randomUUID()}:${eventLink.id}`;
}
