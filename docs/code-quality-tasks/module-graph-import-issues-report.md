# Module Graph and Import Issues Report

Based on the analysis of the codebase against AGENTS.md guidelines, the following module graph and import issues were found:

## 1. Circular Dependencies Between Modules

### Critical Circular Dependency: `@commontools/builder` ↔ `@commontools/runner`

**Builder → Runner imports:**
- `packages/builder/src/built-in.ts` imports from `@commontools/runner`
- `packages/builder/src/schema-to-ts.ts` imports from `@commontools/runner`
- `packages/builder/src/utils.ts` imports from `@commontools/runner`

**Runner → Builder imports:**
- `packages/runner/src/cfc.ts` imports from `@commontools/builder`
- `packages/runner/src/recipe-manager.ts` imports from `@commontools/builder`
- `packages/runner/src/runner.ts` imports from `@commontools/builder`
- `packages/runner/src/env.ts` imports from `@commontools/builder`
- `packages/runner/src/doc-map.ts` imports from `@commontools/builder`
- `packages/runner/src/cell.ts` imports from `@commontools/builder`

**Impact**: This circular dependency makes it impossible to:
- Test these modules in isolation
- Understand the module hierarchy
- Reuse either module independently
- Avoid loading unnecessary code

**Recommendation**: Extract shared types and interfaces to a separate package like `@commontools/core-types` or `@commontools/shared`.

## 2. Default Exports Instead of Named Exports

The following files violate the "prefer named exports over default exports" guideline:

### Component Files
- `packages/charm/src/iframe/recipe.ts`
- `packages/charm/src/commands.ts`
- `packages/html/src/render.ts`
- `packages/html/src/path.ts`
- `packages/memory/clock.ts` - `export default new Clock();`

### Plugin Files
- `packages/deno-vite-plugin/src/index.ts`
- `packages/deno-vite-plugin/src/resolvePlugin.ts`
- `packages/deno-vite-plugin/src/prefixPlugin.ts`

### View Components
- `packages/jumble/src/assets/ShapeLogo.tsx`
- `packages/jumble/src/views/CharmView.tsx`
- `packages/jumble/src/views/ErrorBoundaryView.tsx`
- `packages/jumble/src/views/DebugView.tsx`
- Multiple other view files in `packages/jumble/src/views/`

**Example Fix**:
```typescript
// Bad
export default class Clock { ... }

// Good
export class Clock { ... }

// Bad
export default new Clock();

// Good
export const clock = new Clock();
// Or better: export a factory function
export function createClock(): Clock { ... }
```

## 3. Missing or Incorrect Import Grouping

The following files don't follow the import grouping convention (standard library → external → internal):

### `packages/jumble/src/components/CharmRunner.tsx`
```typescript
// Current (mixed imports)
import { html } from "lit";
import { Recipe } from "@commontools/common-runner";
import { SpellRunner } from "./SpellRunner.js";

// Should be:
// Standard library
import { html } from "lit";

// External
// (none in this case)

// Internal
import { Recipe } from "@commontools/common-runner";
import { SpellRunner } from "./SpellRunner.js";
```

### `packages/builder/src/utils.ts`
```typescript
// Current (internal packages mixed without grouping)
import { JSONSchema7 } from "json-schema";
import { isOpaqueRef, OpaqueRef } from "./spell.js";
import { diffAndUpdate, maybeGetCellLink } from "@commontools/runner";

// Should be:
// Standard library
// (none)

// External
import { JSONSchema7 } from "json-schema";

// Internal
import { diffAndUpdate, maybeGetCellLink } from "@commontools/runner";
import { isOpaqueRef, OpaqueRef } from "./spell.js";
```

### `packages/identity/src/ed25519/index.ts`
- External imports (`@scure/bip39`) mixed with internal imports without proper grouping

## 4. Heavy Dependencies in Utility Modules

### `packages/builder/src/utils.ts`
**Issue**: This utility module imports from `@commontools/runner`, making it a heavyweight utility rather than a lightweight one.

**Impact**: 
- Any code that needs simple utilities from `builder` must also load the entire `runner` package
- Creates the circular dependency issue mentioned above
- Violates the principle that utility modules should have minimal dependencies

**Recommendation**: 
- Move utilities that depend on `runner` to a separate module like `builder-runner-utils.ts`
- Keep pure utilities without external dependencies in `utils.ts`

## 5. Module-Specific Dependencies (Good Practices Found)

The codebase correctly follows the guideline for module-specific dependencies:

### Good Examples:
- `packages/llm/deno.json` - Correctly declares `json5` dependency
- `packages/ui/deno.json` - Correctly declares `@shoelace-style/shoelace` dependency
- Most packages don't have unnecessary dependencies in their `deno.json`

**This is a positive finding** - the codebase correctly avoids adding package-specific dependencies to the workspace `deno.json`.

## 6. Non-standard JS Usage

**Positive Finding**: The codebase is clean of non-portable JavaScript patterns:
- No direct use of environment variables in module scope
- No Vite-specific APIs (`import.meta.hot`, `import.meta.glob`) outside of Vite plugin code
- Clean separation between build-time and runtime code

## Recommendations

### 1. Break Circular Dependencies
Create a new package structure:
```
@commontools/core-types    // Shared interfaces and types
@commontools/builder      // Depends on core-types
@commontools/runner       // Depends on core-types and builder
```

### 2. Convert Default to Named Exports
```typescript
// For all identified files:
// Change: export default Clock
// To:     export { Clock }

// Change: export default new Clock()
// To:     export const clock = new Clock()
//         or export function createClock(): Clock
```

### 3. Enforce Import Grouping
Add ESLint rule or formatter configuration to enforce:
1. Standard library imports
2. External package imports
3. Internal package imports
4. Relative imports

### 4. Refactor Heavy Utilities
Split `packages/builder/src/utils.ts`:
- `utils.ts` - Pure utilities with no external dependencies
- `runner-utils.ts` - Utilities that need runner functionality

### 5. Document Module Dependencies
Create a module dependency graph documentation to help developers understand:
- Which packages can be used independently
- Which packages have peer dependencies
- The intended hierarchy of packages

## Impact Summary

- **Circular dependencies**: Critical issue affecting maintainability and testability
- **Default exports**: Medium impact - affects consistency and tree-shaking
- **Import grouping**: Low impact - affects readability
- **Heavy utilities**: Medium impact - affects bundle size and modularity