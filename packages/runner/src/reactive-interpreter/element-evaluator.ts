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
  extractRogBaseDefer,
  type ImplRefResolver,
  type LiveLeafTrustCheck,
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
  /** Evaluate the element op for one element value (the `element` argument), and
   * its positional `index` (the `index` argument the builder's `mapWithPattern`
   * element pattern also exposes; defaults to `undefined` for callers that do not
   * track it). */
  (elementValue: unknown, index?: number): unknown;
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
  /** SECURITY trust gate for LIVE element-leaf impls — an untrusted in-memory
   * callback is reported as unresolved (→ legacy fallback) so it never runs as a
   * raw host closure inside the interpreter. Mirrors the scalar leaf path. */
  liveLeafTrustCheck?: LiveLeafTrustCheck,
  /** Resolve the element pattern's argument aliases RELATIVE to the frame the
   * builder serialized them in (their inferred base `defer`), rather than as a
   * standalone depth-0 root. TRUE for the partition collection-boundary lowering
   * + the runtime `$ri-collection-map` builtin (which interpret an authored
   * `array.map((value, index) => …)` element whose `element`/`index` aliases sit
   * at `defer === 1` under the parent map frame). FALSE (default) for the
   * single-node collection-eligibility probe, which keeps its pre-existing
   * standalone-root semantics — so a build-time nested child / launched-child map
   * whose element only resolves under a non-zero base defer DECLINES there and
   * stays a legacy boundary (it is NOT the increment's target; engaging it would
   * diverge from legacy's launched-child projection). */
  applyBaseDefer = false,
): ElementEvaluator {
  // A collection ELEMENT pattern is extracted as its OWN root here, but the
  // builder serialized its `element`/`index` argument aliases relative to the
  // PARENT map frame (so they carry `defer === 1`, not 0). When `applyBaseDefer`,
  // infer that base so the extractor's defer gate treats the element's top-frame
  // argument reads as LOCAL (otherwise every authored
  // `array.map((value, index) => …)` element — which inlines under its parent —
  // would be rejected as an unrecognized deferred alias and the per-element
  // render would never interpret). When NOT set, the element is extracted as a
  // standalone depth-0 root (the original single-node-probe contract).
  const baseDefer = applyBaseDefer
    ? extractRogBaseDefer(elementPattern as Parameters<typeof extractRog>[0])
    : 0;
  const ex = extractRog(
    elementPattern as Parameters<typeof extractRog>[0],
    baseDefer,
  );
  const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
    elementPattern as Parameters<typeof resolveLeafImpls>[0],
    ex.rog,
    implRefResolver,
    liveLeafTrustCheck,
  );

  const evaluate = ((elementValue: unknown, index?: number): unknown => {
    const { result } = evalRog(ex.rog, {
      // The element pattern reads its input via the `element` argument alias, and
      // (for `array.map((value, index) => …)` shapes) the positional `index`
      // alias — the builder's `mapWithPattern` exposes BOTH on the element
      // argument cell, so provide both (an element pattern that ignores `index`
      // simply never reads it).
      argument: { element: elementValue, index },
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
