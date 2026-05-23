import type { FabricValue } from "../interface.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";
import type { JsonWireValue } from "./json-wire-types.ts";

// ---------------------------------------------------------------------------
// Utility: `ProblematicValue` factory
// ---------------------------------------------------------------------------

/**
 * Creates a `ProblematicValue` for a deserialization failure. The type tag
 * is preserved for round-tripping; the message provides human-readable
 * diagnostics.
 */
export function makeProblematic(
  tag: string,
  state: JsonWireValue,
  message: string,
): ProblematicValue {
  return new ProblematicValue(tag, state as FabricValue, message);
}
