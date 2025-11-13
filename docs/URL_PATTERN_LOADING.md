# URL-Based Pattern Loading

This feature enables patterns to be loaded directly from URLs, eliminating the need for brittle symlinks or file copying between repositories.

## Overview

Patterns can now be instantiated from any accessible URL, including:
- GitHub raw URLs
- Any HTTP/HTTPS endpoint serving TypeScript/TSX files
- Patterns with relative imports (dependencies)

## Key Features

### 1. Direct URL Loading

```typescript
import { addRecipeFromUrl } from "@commontools/charm";

const charm = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/aside.tsx",
  "My Aside Pattern",
  {} // initial inputs
);
```

### 2. Automatic Dependency Resolution

Patterns that use relative imports work seamlessly:

```typescript
// counter.tsx
import { increment, decrement } from "./counter-handlers.ts";
```

When loaded from a URL, the relative import is resolved automatically:
- Base: `https://raw.githubusercontent.com/.../counter.tsx`
- Import: `./counter-handlers.ts`
- Resolved: `https://raw.githubusercontent.com/.../counter-handlers.ts`

### 3. Cross-Repository References

Patterns in the recipes repo can now reference patterns in the labs repo:

```typescript
// In recipes repo
const labsPattern = await addRecipeFromUrl(
  manager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx",
  "Counter from Labs",
  { value: 0 }
);
```

### 4. Cache Busting

URLs support cache busting via query parameters:

```typescript
const url = "https://example.com/pattern.tsx";
const charm = await addRecipeFromUrl(
  manager,
  url,
  "Pattern",
  {},
  undefined,
  true  // Enable cache busting (adds ?timestamp to URL)
);
```

## Implementation Details

### Architecture

The implementation spans multiple layers:

1. **HTTP Program Resolver** (`packages/js-runtime/program.ts`)
   - Fetches source files from URLs
   - Handles cache busting with query strings
   - Caches fetched modules

2. **Module Resolution** (`packages/js-runtime/typescript/resolver.ts`)
   - Uses JavaScript's `URL` class for relative resolution
   - Resolves `./file.ts` relative to base URL

3. **TypeScript Compilation** (`packages/js-runtime/typescript/compiler.ts`)
   - URL-aware module resolution
   - Prevents path corruption (e.g., `https://` → `https:/`)
   - Filters "module not found" errors for URL modules

4. **AMD Bundling** (`packages/js-runtime/typescript/bundler/bundle.ts`)
   - Preserves full URLs in AMD define statements
   - Fixes shortened module names (e.g., `"aside"` → `"https://.../aside.tsx"`)
   - Maintains URL module names with extensions

5. **Pretransform** (`packages/runner/src/harness/pretransform.ts`)
   - Skips hash prefixing for URL-based programs
   - URLs are already globally unique identifiers

### Key Challenges Solved

1. **Path Normalization**: Standard path operations (e.g., `path.normalize()`) corrupt URLs by converting `https://` to `https:/`. Solution: Detect URLs and skip normalization.

2. **AMD Module Names**: TypeScript strips paths and extensions from module IDs (e.g., `"https://.../aside.tsx"` becomes `"aside"`). Solution: Post-process AMD output to restore full URLs.

3. **Relative Imports**: Path-based relative resolution doesn't work for URLs. Solution: Use `URL` class for proper relative URL resolution.

4. **TypeScript Type Checking**: TypeScript reports "module not found" for URL imports. Solution: Filter these specific diagnostics for URL modules.

## Testing

### Unit Tests

```bash
deno test packages/charm/test/url-loading.test.ts --allow-net --allow-read --allow-write --allow-env --allow-ffi --unstable-ffi --no-check
```

Tests cover:
- Loading simple patterns from URLs
- Loading patterns with dependencies
- Error handling for invalid URLs
- Cross-repository references

### Integration Test

```bash
deno run --allow-all --no-check test-url-integration.ts
```

Demonstrates:
- End-to-end URL loading
- Relative import resolution
- Pattern instantiation with dependencies

## Usage Examples

### Example 1: Simple Pattern

```typescript
const asidePattern = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/aside.tsx",
  "Aside Layout",
  {}
);
```

### Example 2: Pattern with Dependencies

```typescript
const counterPattern = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/counter.tsx",
  "Counter",
  { value: 42 }
);

// Counter.tsx internally imports ./counter-handlers.ts
// This is resolved automatically via URL resolution
```

### Example 3: Cross-Repo Reference

```typescript
// From recipes repo, reference a pattern in labs repo
const labsCounter = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx",
  "Labs Counter",
  { value: 0 }
);
```

## Benefits

1. **No Symlinks**: Eliminates brittle symlink management between repos
2. **No Copying**: No need to duplicate pattern files
3. **Version Control**: Use specific commits/branches in URLs
4. **Distribution**: Patterns can be shared via simple URLs
5. **Cross-Repository**: Seamless references between different repos

## Limitations

1. **Network Required**: Patterns must be fetched over the network
2. **GitHub Rate Limits**: May hit API rate limits with frequent fetches
3. **Cache Duration**: HTTP caching depends on server headers

## Future Enhancements

Potential improvements:
- Local caching layer for offline development
- Support for npm package URLs
- Pattern versioning and semver resolution
- CDN integration for faster loading
