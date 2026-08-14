import { noteDerivedCopy } from "./builder/pattern-metadata.ts";
import { replaceArtifacts, type WalkHooks } from "./encodable-form.ts";

/**
 * Replaces every builder artifact reachable from `value` with its encodable
 * form, on the way into the data model. The hooks are the walk's own; see
 * `WalkHooks` in `encodable-form.ts`.
 *
 * The walk itself is `replaceArtifacts`; this names the one thing a storage
 * boundary adds to it -- carrying trust and the content-addressed entry ref
 * onto each copy, which the bytes do not carry.
 *
 * That carrying is DELIBERATE and it does widen something, so it is worth
 * being explicit. `noteDerivedCopy` documents itself as for runner-owned copy
 * sites, and this is one -- but its INPUTS are arbitrary caller values, since
 * `Runtime.getImmutableCell` reaches here. The effect is that the serialized
 * form of a trusted pattern is now itself trusted, where before it was a dead
 * end. Nothing is laundered by that: trust propagates from the ORIGINAL's
 * derivation root, so a copy of an untrusted value gains nothing, and a
 * forged pattern-shaped object never arrives here paired with a trusted
 * original. A copy of a trusted artifact being trusted is the property the
 * side tables exist to preserve; not carrying it was the bug.
 */
export function flattenBuilderArtifacts<T>(value: T, hooks?: WalkHooks): T {
  return replaceArtifacts(value, noteDerivedCopy, hooks);
}
