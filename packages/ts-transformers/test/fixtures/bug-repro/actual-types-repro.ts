/**
 * NULL ELIMINATION REPRODUCTION - Using Actual CommonTools Types
 * ===============================================================
 *
 * This uses the real OpaqueRef from commontools to verify the bug.
 *
 * RUN: deno run -A test/fixtures/bug-repro/verify-actual.ts
 */

import type { OpaqueRef, OpaqueCell } from "commontools";

// ============================================================================
// TEST CASES
// ============================================================================

// Direct nullable type
type Direct = OpaqueRef<string | null>;
type DirectInner = Direct extends OpaqueCell<infer T> ? T : never;
type DirectGet = Direct extends { get(): infer R } ? R : never;

// Via object property
interface State {
  value: string | null;
  defaultValue: string;
}

type StateRef = OpaqueRef<State>;
type ValueProp = StateRef["value"];
type ValueInner = ValueProp extends OpaqueCell<infer T> ? T : never;
type ValueGet = ValueProp extends { get(): infer R } ? R : never;

// With Required<>
type RequiredStateRef = OpaqueRef<Required<State>>;
type RequiredValueProp = RequiredStateRef["value"];
type RequiredValueInner = RequiredValueProp extends OpaqueCell<infer T> ? T : never;

// ============================================================================
// EXPORTS
// ============================================================================
export type {
  Direct, DirectInner, DirectGet,
  StateRef, ValueProp, ValueInner, ValueGet,
  RequiredStateRef, RequiredValueProp, RequiredValueInner,
};
