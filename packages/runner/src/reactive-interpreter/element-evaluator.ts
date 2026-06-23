/**
 * W3 helper — build a per-element evaluator from a collection's element
 * Pattern, by routing through the existing extract↔interpret seam.
 *
 * A collection op (map/filter/flatMap) carries its element computation as an
 * inline `Pattern` (the `op` input, `{ argumentSchema, resultSchema, result,
 * nodes }`). The collection interpreter (W3) does NOT instantiate that as a
 * per-element child pattern; instead it evaluates the element op *as data* by
 * running `evalRog` over the element pattern's ROG, once per element, in a
 * read-isolated transaction.
 *
 * This module is the reused W1b-bridge wiring: `extractRog` normalizes the
 * element Pattern into a ROG, `resolveLeafImpls` resolves its leaf bodies from
 * the in-memory module callables, and the returned closure runs `evalRog` for a
 * given element value. The element argument convention matches the builder's
 * `mapWithPattern` element pattern: a single `{ element: <value> }` argument
 * (the `element` alias the pattern's nodes read from). The element op may be a
 * single leaf or a multi-op graph (e.g. `{ doubled: x*2 }`) — `evalRog` handles
 * the leaf / access / construct / control vocabulary uniformly.
 *
 * Boundary (same as W1b-bridge): this resolves leaves from the *in-memory* lift
 * bodies (`module.implementation` is a live callable). A *serialized* element
 * pattern would carry only `$implRef`, which needs the SES session
 * implementation index — out of scope here (reported honestly via
 * `unresolvedLeafOps`).
 */

import {
  extractRog,
  type ImplRefResolver,
  resolveLeafImpls,
} from "./extract.ts";
import { evalRog } from "./interpret.ts";
import type { OpId } from "./rog.ts";

// The in-memory element Pattern shape we read (structural subset; see
// builder/types Pattern). We only need `nodes`/`result`/schemas, which
// `extractRog` consumes.
interface ElementPatternLike {
  argumentSchema?: unknown;
  resultSchema?: unknown;
  result?: unknown;
  nodes?: unknown[];
}

export interface ElementEvaluator {
  /** Evaluate the element op for one element value (the `element` argument). */
  (elementValue: unknown): unknown;
  /** Leaf ops that could not be resolved to an in-memory callable. Empty for an
   * in-memory built pattern; non-empty signals the serialized/SES boundary. */
  readonly unresolvedLeafOps: readonly OpId[];
}

/**
 * Build a per-element evaluator from a collection's element Pattern. The
 * extraction + leaf resolution happens once (eagerly); the returned closure is
 * cheap to call per element and routes the element computation through
 * `evalRog` over the element ROG — never a hardcoded leaf.
 */
export function buildElementEvaluator(
  elementPattern: ElementPatternLike,
  /** Optional fallback for serialized element graphs (read back from a cell via
   * `getRaw()`), whose leaf bodies are no longer live callables but whose
   * `$implRef`s resolve through the harness's verified-implementation index. */
  implRefResolver?: ImplRefResolver,
): ElementEvaluator {
  const ex = extractRog(elementPattern as Parameters<typeof extractRog>[0]);
  const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
    elementPattern as Parameters<typeof resolveLeafImpls>[0],
    ex.rog,
    implRefResolver,
  );

  const evaluate = ((elementValue: unknown): unknown => {
    const { result } = evalRog(ex.rog, {
      // The element pattern reads its input via the `element` argument alias.
      argument: { element: elementValue },
      leafImpls,
      internalToOp: ex.internalToOp,
    });
    return result;
  }) as ElementEvaluator;
  Object.defineProperty(evaluate, "unresolvedLeafOps", {
    value: unresolvedLeafOps,
    enumerable: true,
  });
  return evaluate;
}
