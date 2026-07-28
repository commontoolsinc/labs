import { hashStringOf } from "@commonfabric/data-model/value-hash";
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
 * callers that already own a durable delivery id pass it through
 * {@link scopeCallerEventId} instead.
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

/**
 * Binds a caller-supplied delivery id to the stream it was sent to.
 *
 * Every minted id above ends in `eventLink.id`, and that is load-bearing: the
 * handling's receipt derives from the handler's input bindings plus the event
 * id (`runner.ts`, `cause.$event`), and the bindings alone do not identify the
 * verb — two handlers on one piece that close over the same state have
 * byte-identical bindings. The stream component is what keeps their receipts
 * apart. A raw caller id carries no such component, so without this an agent
 * reusing one invocation id across two verbs would have its second call
 * collide on the first's receipt and be reported as an already-settled
 * success it never made.
 *
 * Scoping keeps the property the protocol actually wants: the same id sent to
 * the same stream is the same invocation (retries deduplicate), while the same
 * id sent elsewhere is a different one.
 *
 * The binding is a content hash of a structured value rather than delimited
 * concatenation, because the caller's half is opaque: with `a:b` joined by
 * `:`, the pair (`x`, `y:z`) and the pair (`x:y`, `z`) render identically, and
 * a caller choosing its own id chooses which side of that ambiguity to sit on.
 * Hashing also lets the whole link identify the stream — id, path, and space —
 * so this does not quietly depend on stream links always being whole documents
 * at the empty path, which is true today and is not a stated invariant.
 * `hashOf` is type-tagged and length-prefixed, so no component can impersonate
 * another, and it is deterministic across processes: a retry from a fresh CLI
 * invocation derives the same id.
 *
 * The result deliberately does not carry the caller's id in the clear. That
 * costs some greppability — an operator correlating a CLI invocation id with a
 * scheduler log line has to re-derive it — but the id is caller-controlled
 * text that would otherwise reach logs and telemetry verbatim. Do not append
 * the raw id back for convenience.
 */
export function scopeCallerEventId(
  callerEventId: string,
  eventLink: NormalizedFullLink,
): string {
  return `evt:caller:${
    hashStringOf({
      caller: callerEventId,
      id: eventLink.id,
      path: [...eventLink.path],
      space: eventLink.space,
    })
  }`;
}
