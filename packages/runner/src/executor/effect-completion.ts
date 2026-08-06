// The effect-completion marker (server-execution v2 stage G,
// serving-loop.md §4): the writeback transactions of the effectful
// builtins — `fetch*`, `generate*`, `sqlite*` result/claim/error writes
// — are the COMPLETION side of a served effect. Under the serving
// posture they must NOT seal into a wave (§4: the completion commit
// "never passes through §3d's sealing — the run is long over when the
// response arrives"); they commit as their OWN derived-class commit,
// with identity annotations sourced from the outbox carriage captured
// at the ORIGINAL run's seal, and their result-cell dirtiness injected
// in-process post-commit.
//
// The builtins mark each writeback transaction with the effect's id
// (`${kind}:${inputHash}` — the memo/outbox-dedupe key). The marker is
// code-authored only (builtin implementations), carried on a WeakMap —
// exactly the stampWaveRunContext pattern one module over:
//
// - OFF arm, and ON-arm client speculation: no seal destination is
//   installed, the marker is never read, and the writeback commits to
//   the store exactly as today — byte-identical behavior, one WeakMap
//   write of overhead.
// - ON-arm serving: the SpaceServer's seal dispatcher routes a marked
//   transaction to the effect-completion committer instead of the wave
//   (space-server.ts). An UNMARKED builtin writeback keeps stage F's
//   posture — refused at the seal as unstamped (§3d's ruling), loudly —
//   so a missed marking surfaces as an error, never as silent
//   mis-classification.

import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const effectCompletionKeys = new WeakMap<object, string>();

/**
 * Mark a writeback transaction as the completion of the served effect
 * `effectKey` (the builtin's memo/outbox id, e.g. `fetchJson:<hash>`).
 * Call it FIRST inside the writeback's transaction callback, before any
 * writes — the marker must be present when the transaction closes.
 */
export function markEffectCompletion(
  tx: IExtendedStorageTransaction,
  effectKey: string,
): void {
  effectCompletionKeys.set(tx, effectKey);
}

export function effectCompletionKeyOf(
  tx: IExtendedStorageTransaction,
): string | undefined {
  return effectCompletionKeys.get(tx);
}
