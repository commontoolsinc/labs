/**
 * Identity markers for framework-owned builder implementations the ROG
 * front-end recognizes natively (D-V2-ROG-SIDETABLE: recognition by LIVE
 * function identity at construction time, never by serialized-shape
 * heuristics).
 *
 * This module deliberately imports NOTHING — it sits below both the builder
 * (which marks at module init) and the ROG front-end (which checks), so it
 * can never participate in the builder-land import cycles.
 */

const strInterpolationImpls = new WeakSet<object>();

/** Called once by the builder (built-in.ts) for the hoisted, framework-owned
 * `str` interpolation body. */
export function markStrInterpolation(fn: object): void {
  strInterpolationImpls.add(fn);
}

/** Is `fn` the framework `str` interpolation body? (Pure framework code with
 * one static template shape — safe to lower to a native `interpolate` op.) */
export function isStrInterpolation(fn: unknown): boolean {
  return (typeof fn === "function" || typeof fn === "object") && fn !== null &&
    strInterpolationImpls.has(fn as object);
}
