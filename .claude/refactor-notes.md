# Recipe→Pattern Refactor: Current State

## Branch: refactor/recipe-to-pattern

## What's Done
- All package-by-package identifier renames complete (tasks 1-8)
- `PatternBuilder` type alias (`typeof pattern`) exported from pattern.ts
- `BuilderFunctionsAndConstants.pattern` now typed as `PatternBuilder` instead of `PatternFunction`
- `compileOrGetRecipe` → `compileOrGetPattern` in pattern-manager.ts
- `recipeMeta` → `patternMeta` fix in pattern-manager.ts
- Duplicate `let pattern` / destructured `pattern` removed from patterns.test.ts
- Added `<T>(fn)` overload to `function pattern` (single type param, fn-only)

## 9 Remaining Type Errors (all in tests)

### Root cause: old `const pattern: PatternFunction` vs new `function pattern`
Old code had TWO exports from recipe.ts:
- `const pattern: PatternFunction` — takes `(fn, schema?, schema?)` (fn FIRST)
- `function recipe(...)` — takes `(schema, fn)` or `(schema, schema, fn)` (schema FIRST)

Tests that used `pattern(fn, schema, schema)` now break because the only `pattern` is the overloaded function which expects schema first.

### Files to fix:

1. **patterns.test.ts** lines 1540, 1557, 1890, 1952 — calls like `pattern(fn, schema, schema)` need arg reorder to `pattern(schema, schema, fn)` or `pattern(schema, fn)`

2. **patterns.test.ts** lines 1929, 1931 — property access errors (`hasSelf`, `children`) caused by schema inference failing due to wrong arg order

3. **generate-object-tools.test.ts** line 991 — `pattern<Record<string, never>>(() => ...)` — single type param with fn-only. The added `<T>(fn)` overload should fix this. Re-check.

## After fixing those errors
- Run full `deno check` via `./tasks/check.sh`
- Fix any remaining errors across other packages
- Commit
