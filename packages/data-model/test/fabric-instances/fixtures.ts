/**
 * Shared doubles for the fabric-instance tests: a reconstruction context that
 * refuses to resolve a cell, and the two recursion callbacks for driving the
 * freeze protocols by hand.
 *
 * The callbacks let a test invoke a protocol member on an instance directly,
 * rather than reaching it through the generic entry point that would otherwise
 * do the walking.
 */

import { BaseReconstructionContext } from "@/codec-interface/BaseReconstructionContext.ts";
import type { FabricValue } from "@/interface.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";

/** Dummy reconstruction context for tests. */
export class DummyReconstructionContext extends BaseReconstructionContext {
  override getCell(): never {
    throw new Error("getCell not implemented in test");
  }
}

export const dummyContext = new DummyReconstructionContext(true);

/**
 * Recursion-callback helpers for exercising the `[DEEP_FREEZE]` /
 * `[IS_DEEP_FROZEN]` protocol members directly (invoking them on an instance
 * with a recursion callback). They use `deepFreeze` / `isDeepFrozen` only as
 * recursion helpers on the nested (plain) sub-values -- never as the entry
 * point for the instance itself.
 */
export const subFreeze = (v: FabricValue): FabricValue => deepFreeze(v);
export const subIsDeepFrozen = (v: FabricValue): boolean => isDeepFrozen(v);
