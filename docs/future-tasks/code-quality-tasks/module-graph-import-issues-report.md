# Module Graph and Import Issues Report

Based on the analysis of the codebase against AGENTS.md guidelines, the
following module graph and import issues were found:

## 1. Default Exports Instead of Named Exports

The following files violate the "prefer named exports over default exports"
guideline:

### Component Files

- `packages/charm/src/iframe/recipe.ts`
- `packages/charm/src/commands.ts`
- `packages/html/src/render.ts`
- `packages/html/src/path.ts`
- `packages/memory/clock.ts` - `export default new Clock();`

### Plugin Files

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

## 2. Missing or Incorrect Import Grouping

The following files don't follow the import grouping convention (standard
library → external → internal):

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

- External imports (`@scure/bip39`) mixed with internal imports without proper
  grouping

## 3. Module-Specific Dependencies (Good Practices Found)

The codebase correctly follows the guideline for module-specific dependencies:

### Good Examples

- `packages/llm/deno.json` - Correctly declares `json5` dependency
- `packages/ui/deno.json` - Correctly declares `@shoelace-style/shoelace`
  dependency
- Most packages don't have unnecessary dependencies in their `deno.json`

**This is a positive finding** - the codebase correctly avoids adding
package-specific dependencies to the workspace `deno.json`.

## Recommendations

### 1. Convert Default to Named Exports

```typescript
// For all identified files:
// Change: export default Clock
// To:     export { Clock }

// Change: export default new Clock()
// To:     export const clock = new Clock()
//         or export function createClock(): Clock
```

### 2. Enforce Import Grouping

Add ESLint rule or formatter configuration to enforce:

1. Standard library imports
2. External package imports
3. Internal package imports
4. Relative imports

## Impact Summary

- **Circular dependencies**: Critical issue affecting maintainability and
  testability
- **Default exports**: Medium impact - affects consistency and tree-shaking
- **Import grouping**: Low impact - affects readability
- **Heavy utilities**: Medium impact - affects bundle size and modularity
