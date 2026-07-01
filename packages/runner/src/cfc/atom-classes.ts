import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { isRecord } from "@commonfabric/utils/types";

/**
 * Integrity-atom propagation classes (spec §15 registry, §3.1.6.1):
 *
 * - `hereditary`: survives combination via the class-aware meet — an output
 *   carries it only when EVERY input carried it (weakest-link, the
 *   `PolicyCertified` family).
 * - `value-bound`: bound to a specific value identity; any transformation
 *   invalidates the binding, so it never propagates through the default
 *   transition.
 * - `provenance`: records how/where a value came to be (builtins, links,
 *   gestures, prompt slots); meaningful only for the value it was minted
 *   on, never propagated.
 *
 * Unknown atom types default to `value-bound` (SC-10): dropping on
 * combination under-claims integrity, which is the fail-safe direction.
 */
export type PropagationClass = "hereditary" | "value-bound" | "provenance";

const CLASS_BY_TYPE = new Map<string, PropagationClass>([
  [CFC_ATOM_TYPE.PolicyCertified, "hereditary"],
  [CFC_ATOM_TYPE.InjectionSafe, "value-bound"],
  [CFC_ATOM_TYPE.LinkReference, "value-bound"],
  [CFC_ATOM_TYPE.PromptSlotBound, "value-bound"],
  [CFC_ATOM_TYPE.Caveat, "value-bound"],
  [CFC_ATOM_TYPE.Resource, "value-bound"],
  [CFC_ATOM_TYPE.Builtin, "provenance"],
  [CFC_ATOM_TYPE.ExternalIngest, "provenance"],
  [CFC_ATOM_TYPE.Origin, "provenance"],
  [CFC_ATOM_TYPE.PromptSlotInfluence, "provenance"],
  [CFC_ATOM_TYPE.TransformedBy, "provenance"],
  [CFC_ATOM_TYPE.UserSurfaceInput, "provenance"],
]);

export const atomPropagationClass = (atom: unknown): PropagationClass => {
  if (isRecord(atom) && typeof atom.type === "string") {
    return CLASS_BY_TYPE.get(atom.type) ?? "value-bound";
  }
  // String atoms and kind-shaped records (authored-by /
  // represents-principal) have no registered class — fail-safe.
  return "value-bound";
};
