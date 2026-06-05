import { BaseReconstructionContext } from "../../src/wire-common/BaseReconstructionContext.ts";
import type { FabricValue } from "../../src/interface.ts";
import { deepFreeze, isDeepFrozen } from "../../src/deep-freeze.ts";

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
