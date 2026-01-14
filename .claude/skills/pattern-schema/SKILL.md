---
name: pattern-schema
description: Design schemas.tsx with Input/Output types for patterns
user-invocable: false
---

# Schema Design Phase

## Goal
Create `schemas.tsx` with all data types and Input/Output types BEFORE any pattern code.

## Read First
- `docs/common/concepts/types-and-schemas/default.md`
- `docs/common/concepts/types-and-schemas/writable.md`
- `docs/common/concepts/pattern.md` (Input/Output section)

## Rules
1. Every editable field needs `Writable<>` for write access
2. Fields that could be undefined initially: use `Default<T, value>`
3. Combine when needed: `Writable<Default<T, value>>`
4. Every pattern needs explicit `Input` AND `Output` interface types
5. Actions in Output type: `Stream<void>`

## Template

```tsx
import { Default, Stream, Writable } from "commontools";

// ============ DATA TYPES ============
export interface Item {
  name: Writable<Default<string, "">>;
  done: Writable<Default<boolean, false>>;
}

// ============ PATTERN INPUT/OUTPUT ============
export interface ItemInput {
  item: Item;
}

export interface ItemOutput {
  item: Item;
  toggle: Stream<void>;  // Actions must be Stream<void>
}
```

## Done When
- All data types defined with correct Writable/Default wrapping
- All Input/Output types defined for each sub-pattern
- No TypeScript errors: `deno task ct dev schemas.tsx --no-run`
