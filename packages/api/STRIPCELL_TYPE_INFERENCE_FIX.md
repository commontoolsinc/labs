# StripCell Type Inference Fix

This document explains why `pattern()` (zero type parameters) was producing
`unknown` for nested properties, and what changes were made to fix it.

## The Problem

When using `pattern()` without explicit type parameters, TypeScript was failing
to infer output types correctly:

```typescript
// Before the fix:
const myPattern = pattern((input: OpaqueRef<Required<{ items: string[] }>>) => {
  return { items: input.items, count: 5 };
});

// Expected output type: { items: string[]; count: number }
// Actual output type:   { items: unknown; count: number }  ❌
```

The `items` property was being inferred as `unknown` instead of `string[]`.

## Root Causes

There were **two separate issues** combining to break inference:

### Issue 1: Phantom Type Parameter in AnyBrandedCell

`AnyBrandedCell<T>` was defined with `T` as a **phantom type parameter** - a
type parameter that doesn't appear in the structure:

```typescript
// Old definition
export type AnyBrandedCell<T, Kind extends string = string> = {
  [CELL_BRAND]: Kind;
  // T is NOT used anywhere in the structure!
};
```

TypeScript's `infer` keyword can only extract types from **structural
positions**. When `StripCell` tried to do:

```typescript
T extends AnyBrandedCell<infer U> ? StripCell<U> : ...
```

TypeScript would check "does T have `[CELL_BRAND]`?" - yes! But then it tried to
infer `U` from... nothing. `U` wasn't in the structure. Result: `U = unknown`.

**Simple demonstration:**

```typescript
// Phantom type - T not in structure
type PhantomBox<T> = { id: string };

// Structural type - T IS in structure
type RealBox<T> = { id: string; value: T };

// Inference from phantom type FAILS
type Test1 = PhantomBox<number> extends PhantomBox<infer T> ? T : never;
// Result: unknown ❌

// Inference from structural type WORKS
type Test2 = RealBox<number> extends RealBox<infer T> ? T : never;
// Result: number ✅
```

### Issue 2: Distributive Conditional Types

TypeScript's conditional types have a special behavior: when the checked type is
a **naked type parameter**, the conditional "distributes" over union types. This
also affects how intersection types are evaluated.

**What OpaqueRef produces:**

When you access `input.items` on an `OpaqueRef<{ items: string[] }>`, the type
is:

```typescript
OpaqueCell<string[]> & (OpaqueCell<string> & string)[]
```

This is an **intersection** of a cell type AND an array type.

**The problem with distributive conditionals:**

```typescript
// Old StripCell (distributive)
type StripCell<T> =
  T extends AnyBrandedCell<infer U> ? StripCell<U>
  : T extends Array<infer U> ? StripCell<U>[]
  : ...
```

For the intersection type above, TypeScript would check multiple branches:

- Does it extend `AnyBrandedCell`? Yes (it has the cell brand)
- Does it extend `Array`? Yes (it's also an array)

When multiple branches can match, TypeScript produces union results from
evaluating both paths, leading to weird types like `string | string[]` or
collapsing to `unknown`.

## The Solution

### Fix 1: Add a Structural Phantom Property

We add a symbol-keyed property to `AnyBrandedCell` that "carries" the `T` type:

```typescript
// New symbol for the phantom property
declare const CELL_INNER_TYPE: unique symbol;

// New definition - T is now structurally present
export type AnyBrandedCell<T, Kind extends string = string> = {
  [CELL_BRAND]: Kind;
  readonly [CELL_INNER_TYPE]: T; // NEW: T is in the structure!
};
```

Now when TypeScript evaluates `Cell<string[]> extends AnyBrandedCell<infer U>`:

1. It checks: does it have `[CELL_BRAND]`? Yes
2. It checks: does it have `[CELL_INNER_TYPE]`? Yes
3. It infers `U` from `[CELL_INNER_TYPE]` → `U = string[]` ✅

**Why the property must be non-optional:**

If we used `readonly [CELL_INNER_TYPE]?: T` (optional), then **any object**
would match the constraint (optional means "might not exist"). Plain arrays like
`string[]` would incorrectly match `AnyBrandedCell`, causing the branded cell
branch to be taken for non-cell types.

**Runtime implications: None!**

This is purely a type-system change. The symbol is declared with `declare const`
(no runtime value), and cell objects don't need to actually have this property.
TypeScript just uses it for type inference during compilation.

### Fix 2: Use Non-Distributive Conditionals

We wrap the type checks in tuples to prevent distribution:

```typescript
// New StripCell (non-distributive)
export type StripCell<T> = [T] extends [Stream<any>] ? T
  : [T] extends [AnyBrandedCell<infer U>] ? StripCell<U>
  : [T] extends [ArrayBuffer | ArrayBufferView | URL | Date] ? T
  : [T] extends [Array<infer U>] ? StripCell<U>[]
  : [T] extends [object] ? { [K in keyof T]: StripCell<T[K]> }
  : T;
```

**How `[T] extends [X]` prevents distribution:**

Distribution only occurs when the type parameter appears "naked" (unwrapped). By
wrapping in a tuple, we're asking "does the tuple containing T extend the tuple
containing X?" - TypeScript treats it as a single unit rather than distributing
over union/intersection members.

```typescript
// Distributive (T is naked):
type Test1<T> = T extends string ? "yes" : "no";
type R1 = Test1<string | number>; // "yes" | "no" (distributed!)

// Non-distributive (T is wrapped):
type Test2<T> = [T] extends [string] ? "yes" : "no";
type R2 = Test2<string | number>; // "no" (not distributed)
```

## The Complete Change

### In `packages/api/index.ts`:

```typescript
// 1. Add new symbol (near CELL_BRAND)
declare const CELL_INNER_TYPE: unique symbol;

// 2. Modify AnyBrandedCell
export type AnyBrandedCell<T, Kind extends string = string> = {
  [CELL_BRAND]: Kind;
  readonly [CELL_INNER_TYPE]: T; // Added for type inference
};

// 3. Modify StripCell to use non-distributive conditionals
export type StripCell<T> = [T] extends [Stream<any>] ? T
  : [T] extends [AnyBrandedCell<infer U>] ? StripCell<U>
  : [T] extends [ArrayBuffer | ArrayBufferView | URL | Date] ? T
  : [T] extends [Array<infer U>] ? StripCell<U>[]
  : [T] extends [object] ? { [K in keyof T]: StripCell<T[K]> }
  : T;
```

## Results

### Before:

```typescript
const myPattern = pattern((input) => {
  return { items: input.items, count: 5 };
});
// Output type: { items: unknown; count: number } ❌
```

### After:

```typescript
const myPattern = pattern((input) => {
  return { items: input.items, count: 5 };
});
// Output type: { items: string[]; count: number } ✅
```

### Stream handlers are preserved:

```typescript
const myPattern = pattern((input) => {
  return {
    items: input.items,
    addItem: handler(...),  // Stream<T>
  };
});
// Output type: { items: string[]; addItem: Stream<...> } ✅
```

## Why This is Future-Proof

The fix uses `AnyBrandedCell` rather than enumerating specific cell types. This
means:

- Any new cell type (like the recently added `Writable` alias) automatically
  works
- No need to update `StripCell` when cell types are added or renamed
- The phantom property is inherited by all types that extend `AnyBrandedCell`

## Related Files

- `packages/api/index.ts` - Contains `AnyBrandedCell` and `StripCell`
  definitions
- `packages/patterns/kanban-board/STRIPCELL_EXPERIMENTS.ts` - Test file with all
  experiments
- `packages/patterns/kanban-board/INFERENCE_INVESTIGATION.ts` - Original
  investigation file
