/**
 * Durable reference schemas must enforce every scope cap retained by their
 * live acquisition. The link format carries schemas, but no inherited cap
 * positions, so a write refuses a projection that would lose that restriction.
 */

import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { ScopeCapAtDepth } from "../link-types.ts";
import { narrowerScopeCap } from "../scope.ts";

/** Refuses a durable link whose schema cannot retain its acquired scope caps. */
export function assertSerializableReferenceScope(
  schema: JSONSchema | undefined,
  scopeCaps: readonly ScopeCapAtDepth[] | undefined,
): void {
  const schemaCap = narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(schema),
    ContextualFlowControl.getAsCellFollowScopeCap(schema),
  );
  if (
    scopeCaps?.some(({ scope }) =>
      narrowerScopeCap(scope, schemaCap) !== schemaCap
    )
  ) {
    throw new Error(
      "Reference acquisition scope cap cannot be widened for storage",
    );
  }
}
