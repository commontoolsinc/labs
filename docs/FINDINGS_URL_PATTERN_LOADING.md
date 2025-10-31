# URL-Based Pattern Loading: Findings and Recommendations

**Date**: October 30, 2025
**Context**: Investigation into enabling cross-repository pattern references via URL-based loading

## Executive Summary

URL-based pattern loading is **partially functional today** with the existing machinery. Simple patterns without dependencies can be loaded from arbitrary URLs (including raw GitHub URLs). However, **relative imports are a critical blocker** for most real-world patterns.

### Test Results
- ✅ **4/5 integration tests passing**
- ✅ Basic URL loading works
- ✅ Error handling works correctly
- ✅ Cross-repo loading succeeds for simple patterns
- ❌ Patterns with relative imports fail to compile

## Current State

### Existing Machinery

The system **already has** URL-based pattern fetching infrastructure:

#### 1. `addGithubRecipe()` Function
**Location**: `packages/charm/src/commands.ts:119-135`

```typescript
export async function addGithubRecipe(
  charmManager: CharmManager,
  filename: string,
  spec: string,
  runOptions: unknown,
): Promise<Cell<unknown>> {
  const response = await fetch(
    `https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/recipes/${filename}?${Date.now()}`,
  );
  const src = await response.text();
  return await compileAndRunRecipe(charmManager, src, spec, runOptions);
}
```

**Limitations**:
- Hardcoded to specific repo: `commontoolsinc/labs`
- Hardcoded to specific branch: `main`
- Hardcoded to specific path: `/recipes/`
- Not exposed in webapp UI
- Not documented for users

### New Implementation

#### 2. `addRecipeFromUrl()` Function (NEW)
**Location**: `packages/charm/src/commands.ts:167-196`

```typescript
export async function addRecipeFromUrl(
  charmManager: CharmManager,
  url: string,
  spec: string,
  runOptions: unknown,
  parents?: string[],
  cacheBust = true,
): Promise<Cell<unknown>>
```

**Features**:
- Accepts **arbitrary URLs**
- Supports cache busting
- Tracks parent charm lineage
- Better error handling

**Status**: ✅ Implemented and tested

## Architecture

### Pattern Loading Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                  URL-Based Loading Flow                     │
└─────────────────────────────────────────────────────────────┘

USER/PATTERN PROVIDES URL
        ↓
    fetch(url)
        ↓
    Source Code String
        ↓
    compileAndRunRecipe()
        ↓
    RecipeManager.compileRecipe()
        ↓
    Engine.process() (TypeScript compilation)
        ↓
    ❌ FAILS HERE: Cannot resolve relative imports
        ↓
    Recipe Object (if successful)
        ↓
    CharmManager.runPersistent()
        ↓
    Charm Instance Created
```

### The Core Problem: Relative Imports

**Example**: `packages/patterns/counter.tsx`
```typescript
/// <cts-enable />
import { Default, NAME, recipe, str, Stream, UI } from "commontools";
import { decrement, increment, nth, previous } from "./counter-handlers.ts";
//                                                    ^^^^^^^^^^^^^^^^^^^^^^^^
//                                                    THIS FAILS!
```

When loading from a URL:
1. Pattern source is fetched as a string
2. TypeScript compiler tries to resolve `"./counter-handlers.ts"`
3. No file system context exists for the URL
4. Compilation fails: `Error: Could not resolve "/ba4jcbuzi7bkvz4zm2soe4hcer77f7ox7osod6obq3emrbpykw2rt2vrf/counter-handlers.ts"`

### What Works Today

✅ **Single-file patterns without dependencies**

Example: `aside.tsx`, `cheeseboard.tsx`, `ct-checkbox-cell.tsx`
```typescript
/// <cts-enable />
import { NAME, recipe, UI } from "commontools"; // ✅ Works - runtime module

export default recipe("Aside", () => {
  return {
    [NAME]: "Aside",
    [UI]: (<div>...</div>),
  };
});
```

### What Doesn't Work

❌ **Multi-file patterns with relative imports**

Example: `counter.tsx` + `counter-handlers.ts`
- 10+ patterns in `packages/patterns/` use this structure
- All realistic patterns need handler files
- Current architecture can't resolve these dependencies

## Proposed Solutions

### Option 1: Multi-File URL Loading (RECOMMENDED)

**Concept**: Support loading patterns with their dependencies as a bundle.

```typescript
// New function signature
export async function addRecipeFromUrlWithDeps(
  charmManager: CharmManager,
  mainUrl: string,
  dependencyUrls: Record<string, string>, // Map relative paths to absolute URLs
  spec: string,
  runOptions: unknown,
): Promise<Cell<unknown>>
```

**Example usage**:
```typescript
await addRecipeFromUrlWithDeps(
  manager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx",
  {
    "./counter-handlers.ts": "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter-handlers.ts"
  },
  "Counter",
  { value: 0 }
);
```

**Implementation approach**:
1. Fetch all files in parallel
2. Create a `RuntimeProgram` with multiple files:
   ```typescript
   {
     main: "/counter.tsx",
     files: [
       { name: "/counter.tsx", contents: mainSource },
       { name: "/counter-handlers.ts", contents: handlersSource }
     ]
   }
   ```
3. TypeScript resolver can now resolve relative imports within the program

**Pros**:
- Leverages existing `RuntimeProgram` multi-file support
- No changes to compilation pipeline
- Full pattern compatibility

**Cons**:
- User must specify all dependencies
- Verbose API
- No automatic dependency discovery

### Option 2: Smart URL Resolution

**Concept**: Enhance TypeScript resolver to fetch dependencies automatically.

**Implementation**:
1. Modify `packages/js-runtime/typescript/resolver.ts`
2. When encountering a relative import:
   - Resolve it relative to the source URL
   - Fetch the dependency automatically
   - Add to program files
3. Recursively resolve nested dependencies

**Pros**:
- Clean API (just provide main URL)
- Automatic dependency resolution
- Natural developer experience

**Cons**:
- Complex implementation
- Potential security concerns (arbitrary fetches)
- Needs caching strategy
- May break on non-public repositories

### Option 3: Bundle-Based Distribution

**Concept**: Pre-bundle patterns with dependencies before deployment.

**Implementation**:
1. Add build step: `deno bundle pattern.tsx pattern.bundle.js`
2. Deploy bundled version to URL
3. Load bundled JavaScript directly

**Pros**:
- No resolver changes needed
- Optimized loading
- Compatible with CDNs

**Cons**:
- Requires build step
- Loses source-level debugging
- Not transparent to users

### Option 4: Pattern Registry/CDN

**Concept**: Central registry that serves patterns with resolved dependencies.

**Implementation**:
1. Pattern registry API: `https://patterns.commontools.dev/api/pattern/{owner}/{repo}/{path}`
2. Registry fetches, resolves, and caches patterns
3. Returns complete program structure

**Pros**:
- Clean separation of concerns
- Caching and optimization
- Version management possible

**Cons**:
- Infrastructure dependency
- Central point of failure
- Doesn't work for private patterns

## Recommended Path Forward

### Phase 1: Enable Simple Patterns (DONE ✅)
- ✅ Implement `addRecipeFromUrl()`
- ✅ Write integration tests
- ✅ Export from charm package
- ⚠️  Document limitations (no dependencies)

### Phase 2: Multi-File Support (NEXT)
1. Implement `addRecipeFromUrlWithDeps()`
2. Add helper to scan pattern for relative imports
3. Create CLI command: `ct charm new-from-url <url> --deps <dep1> <dep2>`
4. Test with counter.tsx and other multi-file patterns

### Phase 3: Smart Resolution (FUTURE)
1. Implement automatic dependency fetching
2. Add caching layer
3. Handle edge cases (circular deps, missing files)
4. Security review

### Phase 4: Integration (FUTURE)
1. Expose in webapp UI
2. Create pattern discovery interface
3. Add to built-in modules for pattern-to-pattern loading
4. Documentation and examples

## Technical Details

### Modified Files

1. **`packages/charm/src/commands.ts`** - Added `addRecipeFromUrl()` function
2. **`packages/charm/src/index.ts`** - Exported new function
3. **`packages/charm/test/url-loading.test.ts`** - Integration tests (NEW)
4. **`packages/patterns/url-loader-demo.tsx`** - Demo pattern (NEW)

### TypeScript Resolution Context

**Current resolver**: `packages/js-runtime/typescript/resolver.ts:40`

```typescript
export async function resolveProgram(
  program: Program,
  system: ResolverSystem = Deno,
): Promise<ResolvedProgram> {
  // When loading from URL, there's no file system context!
  // Relative imports have no base path to resolve from
}
```

The resolver needs:
- Base URL/path for resolving relative imports
- Access to dependency files (either local or fetched)

### Compilation Flow

```typescript
// packages/runner/src/recipe-manager.ts:227-240
async compileRecipe(input: string | RuntimeProgram): Promise<Recipe> {
  let program: RuntimeProgram | undefined;
  if (typeof input === "string") {
    program = {
      main: "/main.tsx",           // ✅ Single file works
      files: [{
        name: "/main.tsx",
        contents: input
      }],
    };
  } else {
    program = input;               // ✅ Multi-file support exists!
  }
  const recipe = await this.runtime.harness.run(program);
  recipe.program = program;
  return recipe;
}
```

**Key insight**: The system **already supports multi-file programs**. We just need to fetch the files and provide them in the right format!

## Security Considerations

1. **URL Validation**
   - Whitelist allowed domains?
   - HTTPS-only enforcement
   - Rate limiting

2. **Code Execution**
   - Patterns execute in sandbox
   - But can access runtime APIs
   - Need review for malicious patterns

3. **Dependency Chain**
   - Prevent infinite recursion
   - Limit dependency depth
   - Validate all fetched code

## Performance Considerations

1. **Network Latency**
   - Multiple HTTP requests for dependencies
   - Consider bundling or parallel fetching
   - Cache fetched patterns

2. **Compilation Cache**
   - Cache by content hash (already done)
   - Invalidation strategy needed
   - Storage considerations

## Use Cases

### 1. Cross-Repo Development
**Current**: Copy patterns between repos, brittle symlinks
**Future**: Direct URL references
```typescript
// In recipes repo, reference labs pattern
const counterUrl = "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx";
```

### 2. Pattern Composition
**Future**: Patterns can dynamically load other patterns
```typescript
// Inside a pattern
const subPattern = await loadFromUrl("https://...");
```

### 3. Pattern Distribution
**Future**: Share patterns via URLs
```
ct charm new https://gist.github.com/user/pattern.tsx
```

## Testing

### Test Coverage
- ✅ Basic URL loading
- ✅ Error handling (404, network errors)
- ✅ Cross-repo loading
- ✅ Cache busting
- ❌ Multi-file patterns (blocked by relative imports)
- ⚠️  Transaction handling in rapid succession

### Test Patterns Used
- **aside.tsx** - Simple, no dependencies (✅ works)
- **counter.tsx** - With dependencies (❌ fails as expected)
- **cheeseboard.tsx** - fetchData usage (✅ works)

## Conclusion

URL-based pattern loading is **feasible and partially working**. The core infrastructure exists and functions correctly for simple patterns. The main technical challenge is **resolving relative imports** when loading from URLs.

**Recommended next step**: Implement Option 1 (Multi-File URL Loading) as it:
1. Works with existing infrastructure
2. Requires minimal changes
3. Provides immediate value
4. Can be enhanced later with automatic resolution

The implementation difficulty is **LOW to MEDIUM**:
- Easy: Multi-file loading API (1-2 days)
- Medium: Automatic dependency scanning (2-3 days)
- Hard: Smart automatic resolution (1-2 weeks)

**Bottom line**: This feature is **ready to use today** for simple patterns, and can be extended to support complex patterns with a straightforward implementation of multi-file loading.
