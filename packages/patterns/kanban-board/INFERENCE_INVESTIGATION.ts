/**
 * =============================================================================
 * TYPE INFERENCE INVESTIGATION: Why pattern<T>() doesn't infer Stream<> types
 * =============================================================================
 *
 * Run with: deno check packages/patterns/kanban-board/INFERENCE_INVESTIGATION.ts
 *
 * SUMMARY OF FINDINGS:
 * ====================
 *
 * The problem is NOT Opaque<R> - that works fine for inference!
 *
 * The actual problem is StripCell<R> in the return type position:
 *
 *   RecipeFactory<StripCell<T>, StripCell<R>>
 *                               ^^^^^^^^^^^
 *                               THIS breaks inference
 *
 * StripCell combines two things that together break TypeScript inference:
 *   1. Conditional type with `infer`: T extends AnyBrandedCell<infer U> ? ...
 *   2. Recursive mapped type: { [K in keyof T]: StripCell<T[K]> }
 *
 * When TypeScript tries to infer R and the return type involves this
 * combination, it gives up and produces `unknown` for nested properties.
 *
 * WORKAROUND:
 * ===========
 * Use pattern<InputType, OutputType>() with both type parameters explicit.
 * This bypasses inference entirely and provides the correct types.
 *
 * =============================================================================
 */

import type {
  AnyBrandedCell,
  Opaque,
  OpaqueRef,
  StripCell,
} from "@commontools/api";

type Factory<In, Out> = { __in: In; __out: Out };

interface TestInput {
  items: string[];
}

// =============================================================================
// PROOF 1: Opaque<R> does NOT break inference
// =============================================================================
// When StripCell is removed from the return type, inference works perfectly.

type PatternWithoutStripCell = {
  <T, R>(fn: (input: OpaqueRef<Required<T>>) => Opaque<R>): Factory<T, R>;
};

declare const withoutStripCell: PatternWithoutStripCell;

const proof1 = withoutStripCell((input: OpaqueRef<Required<TestInput>>) => {
  return { items: input.items, count: 5 };
});

// Result: Factory<TestInput, { items: OpaqueCell<string[]> & ...; count: number }>
// items is properly inferred! ✅
// @ts-expect-error - This is a type investigation file; error is expected
const _proof1: "PROOF1" = proof1;

// =============================================================================
// PROOF 2: StripCell<R> on output DOES break inference
// =============================================================================

type PatternWithStripCell = {
  <T, R>(
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): Factory<T, StripCell<R>>;
};

declare const withStripCell: PatternWithStripCell;

const proof2 = withStripCell((input: OpaqueRef<Required<TestInput>>) => {
  return { items: input.items, count: 5 };
});

// Result: Factory<TestInput, { items: unknown; count: number }>
// items becomes `unknown`! ❌
// @ts-expect-error - This is a type investigation file; error is expected
const _proof2: "PROOF2" = proof2;

// =============================================================================
// PROOF 3: The breaking combination is conditional+infer+recursive-mapped
// =============================================================================

// This WORKS (conditional with infer, no recursive mapping):
type SimpleUnwrap<T> = T extends AnyBrandedCell<infer U> ? U : T;

type PatternSimpleUnwrap = {
  <T, R>(
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): Factory<T, SimpleUnwrap<R>>;
};

declare const simpleUnwrap: PatternSimpleUnwrap;

const proof3a = simpleUnwrap((input: OpaqueRef<Required<TestInput>>) => {
  return { items: input.items, count: 5 };
});

// Result: items is OpaqueCell<string[]> ✅
// @ts-expect-error - This is a type investigation file; error is expected
const _proof3a: "PROOF3A" = proof3a;

// This BREAKS (conditional with infer + recursive mapping):
type ConditionalRecursive<T> = T extends AnyBrandedCell<infer U>
  ? ConditionalRecursive<U>
  : T extends object ? { [K in keyof T]: ConditionalRecursive<T[K]> }
  : T;

type PatternConditionalRecursive = {
  <T, R>(
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): Factory<T, ConditionalRecursive<R>>;
};

declare const conditionalRecursive: PatternConditionalRecursive;

const proof3b = conditionalRecursive(
  (input: OpaqueRef<Required<TestInput>>) => {
    return { items: input.items, count: 5 };
  },
);

// Result: items is `unknown` ❌
// @ts-expect-error - This is a type investigation file; error is expected
const _proof3b: "PROOF3B" = proof3b;

// =============================================================================
// PROOF 4: Both pattern() and pattern<T>() break (different reasons)
// =============================================================================
// Testing with the actual PatternFunction overloads

import type {
  JSONSchema,
  RecipeFactory,
  Schema,
  SchemaWithoutCell,
} from "@commontools/api";

type PatternFunction = {
  // Overload 1: Both T and R inferred
  <T, R>(
    fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;

  // Overload 2: T explicit, R uses `any` (falls back here when 1 type param given)
  <T>(
    fn: (input: OpaqueRef<Required<T>>) => any,
  ): RecipeFactory<StripCell<T>, StripCell<ReturnType<typeof fn>>>;

  // Overload 3: Schema-based
  <IS extends JSONSchema = JSONSchema, OS extends JSONSchema = JSONSchema>(
    fn: (input: OpaqueRef<Required<Schema<IS>>>) => Opaque<Schema<OS>>,
    argumentSchema: IS,
    resultSchema: OS,
  ): RecipeFactory<SchemaWithoutCell<IS>, SchemaWithoutCell<OS>>;
};

declare const pattern: PatternFunction;

// pattern() - no type params: matches overload 1, StripCell breaks inference
const proof4a = pattern((input: OpaqueRef<Required<TestInput>>) => {
  return { items: input.items, count: 5 };
});
// Result: { items: unknown; count: number } ❌
// @ts-expect-error - This is a type investigation file; error is expected
const _proof4a: "PROOF4A" = proof4a;

// pattern<T>() - one type param: matches overload 2, `any` return gives `any`
const proof4b = pattern<TestInput>((input) => {
  return { items: input.items, count: 5 };
});
// Result: any ❌
// @ts-expect-error - This is a type investigation file; error is expected
const _proof4b: "PROOF4B" = proof4b;

// pattern<T, R>() - both type params: explicit types, works
const proof4c = pattern<TestInput, { items: string[]; count: number }>(
  (input) => {
    return { items: input.items, count: 5 };
  },
);
// Result: { items: string[]; count: number } ✅
// @ts-expect-error - This is a type investigation file; error is expected
const _proof4c: "PROOF4C" = proof4c;

// =============================================================================
// PROOF 5: CTS transformation does NOT wrap return values
// =============================================================================
// Verified by running: deno task ct dev [file] --show-transformed
//
// CTS transforms:
//   pattern<State, Output>(({ items }) => { return { items, addItem }; })
//
// Into:
//   pattern(({ items }) => { return { items, addItem }; }, inputSchema, outputSchema)
//
// The function body and return statement are UNCHANGED.
// CTS only injects schemas as additional arguments.
//
// At runtime:
//   1. pattern() creates an OpaqueRef for the INPUT parameter
//   2. Your function is called with that OpaqueRef
//   3. Your return value is used DIRECTLY (not wrapped)
//
// So the input IS an OpaqueRef (reactive proxy), but your return object
// is a plain object containing references to those OpaqueRefs.

// =============================================================================
// EXPORT
// =============================================================================
export {};
