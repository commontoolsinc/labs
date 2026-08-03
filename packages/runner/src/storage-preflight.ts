import { noteDerivedCopy } from "./builder/pattern-metadata.ts";
import { replaceArtifacts } from "./encodable-form.ts";

/**
 * Replaces every builder artifact reachable from `value` with its encodable
 * form, on the way into the data model.
 *
 * The walk itself is `replaceArtifacts`; this names the one thing a storage
 * boundary adds to it -- carrying trust and the content-addressed entry ref
 * onto each copy, which the bytes do not carry.
 */
export function flattenBuilderArtifacts<T>(value: T): T {
  return replaceArtifacts(value, noteDerivedCopy);
}
