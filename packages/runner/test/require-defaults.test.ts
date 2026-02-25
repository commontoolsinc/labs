/**
 * Type-level tests for RequireDefaults<T> and related utilities.
 *
 * These tests verify compile-time behavior of RequireDefaults<T>,
 * StripDefaultBrand<T>, and the Default<T,V> brand detection logic.
 * If any type assertion is wrong, this file will fail to compile.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  RequireDefaults,
  StripDefaultBrand,
} from "../src/builder/types.ts";
import type { Default } from "@commontools/api";
import type { Cell } from "@commontools/runner";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Asserts T and U are mutually assignable (structurally equal).
 * Produces `never` on mismatch → compile error at call site.
 */
type AssertEqual<T, U> = [T] extends [U] ? [U] extends [T] ? true : never
  : never;

type MustBeTrue<T extends true> = T;

/**
 * Flattens an intersection type to a plain object type so that
 * AssertEqual works correctly with RequireDefaults<T> (which is an
 * intersection of two mapped types).
 */
type Simplify<T> = { [K in keyof T]: T[K] };

// ============================================================================
// StripDefaultBrand<T> — non-Default types are unchanged
// ============================================================================

const _stripPlainString: MustBeTrue<
  AssertEqual<StripDefaultBrand<string>, string>
> = true;

const _stripPlainNumber: MustBeTrue<
  AssertEqual<StripDefaultBrand<number>, number>
> = true;

const _stripPlainObject: MustBeTrue<
  AssertEqual<StripDefaultBrand<{ a: string }>, { a: string }>
> = true;

// ============================================================================
// StripDefaultBrand<T> — Default<T,V> strips to plain T
// ============================================================================

const _stripDefaultString: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<string, "hello">>, string>
> = true;

const _stripDefaultNumber: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<number, 0>>, number>
> = true;

const _stripDefaultBoolean: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<boolean, true>>, boolean>
> = true;

// Default<T|undefined, V> strips to T|undefined (brand removed, undefined kept)
const _stripDefaultWithUndefined: MustBeTrue<
  AssertEqual<
    StripDefaultBrand<Default<string | undefined, "x">>,
    string | undefined
  >
> = true;

// ============================================================================
// RequireDefaults<T> — plain optional fields are unchanged
// ============================================================================

const _plainOptionalPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ name?: string }>>,
    { name?: string | undefined }
  >
> = true;

const _plainRequiredPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ name: string }>>,
    { name: string }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — Default<> fields become required with brand stripped
// ============================================================================

const _stringDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ title?: Default<string, "Untitled"> }>>,
    { title: string }
  >
> = true;

const _numberDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ count?: Default<number, 0> }>>,
    { count: number }
  >
> = true;

const _booleanDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ enabled?: Default<boolean, false> }>>,
    { enabled: boolean }
  >
> = true;

const _objectDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ options?: Default<{ x: number }, { x: 0 }> }>>,
    { options: { x: number } }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — mixed: Default fields required, plain fields preserved
// ============================================================================

type Mixed = {
  title?: Default<string, "Untitled">;
  count?: Default<number, 0>;
  name?: string;
  id: number;
};

const _mixed: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<Mixed>>,
    { title: string; count: number; name?: string | undefined; id: number }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — Default<T|undefined, V>
// The implementation strips `| undefined` via Exclude when making the key
// required, so the value type becomes just T (not T|undefined).
// ============================================================================

const _undefinableDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ tag?: Default<string | undefined, ""> }>>,
    { tag: string }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — Cell-wrapped Default fields
// ============================================================================

const _cellDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: Default<Cell<string[]>, never> }>>,
    { items: Cell<string[]> }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — Default field in a union with a plain type
// The presence of a Default-branded member in the union makes the field required.
// ============================================================================

const _unionDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: Default<string, "x"> | number }>>,
    { value: string | number }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — plain union (no Default) stays optional
// ============================================================================

const _plainUnionPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: string | number }>>,
    { value?: string | number | undefined }
  >
> = true;

// ============================================================================
// RequireDefaults<T> — is only one level deep (inner Default fields are not
// processed, preserving the Default brand on nested types)
// ============================================================================

type Nested = {
  outer?: Default<string, "">;
  inner: { a?: Default<number, 0> };
};

const _shallowOnly: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<Nested>>,
    // `outer` is made required; `inner` is untouched (Default brand preserved inside)
    { outer: string; inner: { a?: Default<number, 0> } }
  >
> = true;

// ============================================================================
// Runtime stub — the type assertions above are the real tests
// ============================================================================

describe("RequireDefaults type-level tests", () => {
  it("all type assertions compile correctly", () => {
    // If this file compiled without errors, all static type assertions passed.
    expect(true).toBe(true);
  });
});
