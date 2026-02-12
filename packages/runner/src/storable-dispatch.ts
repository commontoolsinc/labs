import type { StorableValue, StorableValueLayer } from "@commontools/memory/interface";
import { toStorableValue, toDeepStorableValue } from "@commontools/memory/storable-value";
import type { ExperimentalOptions } from "./runtime.ts";

/** Dispatch to the appropriate storable value converter. */
export function dispatchToStorableValue(
  value: unknown,
  experimental?: ExperimentalOptions,
): StorableValueLayer {
  if (experimental?.richStorableValues) {
    throw new Error("richStorableValues not yet implemented");
  }
  return toStorableValue(value);
}

/** Dispatch to the appropriate deep storable value converter. */
export function dispatchToDeepStorableValue(
  value: unknown,
  experimental?: ExperimentalOptions,
): StorableValue {
  if (experimental?.richStorableValues) {
    throw new Error("richStorableValues not yet implemented");
  }
  return toDeepStorableValue(value);
}
