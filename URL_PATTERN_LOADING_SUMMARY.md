# URL Pattern Loading - Implementation Summary

## ✅ Feature Complete and Tested

This document summarizes the implementation of URL-based pattern loading for CommonTools.

## Problem Solved

**Original Issue**: Patterns in the `recipes` repo needed to reference patterns in the `labs` repo, but this required brittle symlinks or copying files between repositories.

**Solution**: Patterns can now be loaded directly from any accessible URL, including GitHub raw URLs, with automatic resolution of relative imports.

## Implementation Status

### ✅ Core Functionality
- [x] Load patterns from HTTP/HTTPS URLs
- [x] Automatic relative import resolution (e.g., `./handlers.ts`)
- [x] TypeScript compilation of URL-based modules
- [x] AMD module bundling with URL preservation
- [x] Cross-repository pattern references
- [x] Cache busting support

### ✅ Testing
- [x] Unit tests (5/5 passing) - `packages/charm/test/url-loading.test.ts`
- [x] Integration tests - `test-url-integration.ts`
- [x] Real-world patterns tested (aside.tsx, counter.tsx with dependencies)
- [x] Documentation and examples

### Modified Files (7 core files)

1. **`packages/js-runtime/program.ts`**
   - Enhanced `HttpProgramResolver` to handle URLs and cache busting
   - Strip query strings from filenames for TypeScript compatibility

2. **`packages/js-runtime/typescript/resolver.ts`**
   - Added URL-based relative import resolution using JavaScript's `URL` class

3. **`packages/js-runtime/typescript/compiler.ts`**
   - URL-aware module resolution in `resolveModuleNameLiterals()`
   - Prevent path corruption with URL-safe source collection

4. **`packages/js-runtime/typescript/diagnostics/checker.ts`**
   - Filter "module not found" errors for URL-based modules
   - Handle both error codes 2307 and 2792

5. **`packages/js-runtime/typescript/bundler/bundle.ts`**
   - Post-process AMD output to preserve full URLs in defines/requires
   - Prevent TypeScript from stripping URLs to short names

6. **`packages/runner/src/harness/pretransform.ts`**
   - Skip hash prefixing for URL-based programs (already globally unique)

7. **`packages/charm/src/commands.ts`**
   - New `addRecipeFromUrl()` function for loading patterns from URLs

## Key Technical Achievements

### 1. URL Resolution
Standard path operations corrupt URLs (`https://` → `https:/`). Solution: Detect URLs and use URL-specific resolution.

### 2. Relative Imports
Patterns like `counter.tsx` can import `./counter-handlers.ts`, and these are resolved relative to the base URL:
- Base: `https://raw.githubusercontent.com/.../counter.tsx`
- Import: `./counter-handlers.ts`
- Result: `https://raw.githubusercontent.com/.../counter-handlers.ts`

### 3. AMD Module Names
TypeScript strips URLs to short names (`aside` instead of `https://.../aside.tsx`). Solution: Post-process the AMD output to restore full URLs.

### 4. TypeScript Compatibility
TypeScript doesn't understand URL imports natively. Solution: Filter specific diagnostic codes for URL modules.

## Test Results

### Unit Tests (packages/charm/test/url-loading.test.ts)
```
✓ should load a pattern from a GitHub raw URL
✓ should handle invalid URLs gracefully
✓ should compile and instantiate pattern without dependencies
✓ should load pattern WITH dependencies via URL resolution
✓ demonstrates loading from labs repo
```

### Integration Test (test-url-integration.ts)
```
✓ Simple pattern loaded successfully
✓ Pattern with dependencies loaded successfully
✓ Relative import resolution works
✓ Cross-repository references enabled
```

## Usage Examples

### Basic URL Loading
```typescript
import { addRecipeFromUrl } from "@commontools/charm";

const charm = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/aside.tsx",
  "Aside Pattern",
  {}
);
```

### Pattern with Dependencies
```typescript
// counter.tsx imports ./counter-handlers.ts - works automatically!
const counter = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx",
  "Counter",
  { value: 42 }
);
```

### Cross-Repo Reference
```typescript
// From recipes repo, reference labs repo pattern
const labsPattern = await addRecipeFromUrl(
  charmManager,
  "https://raw.githubusercontent.com/commontoolsinc/labs/main/packages/patterns/counter.tsx",
  "Labs Counter",
  { value: 0 }
);
```

## Benefits

1. **No Symlinks**: Eliminates brittle symlink management
2. **No File Copying**: No need to duplicate patterns
3. **Version Control**: Pin to specific commits/branches via URL
4. **Easy Sharing**: Distribute patterns via simple URLs
5. **Cross-Repository**: Seamless references between repos

## Documentation

- **Feature Documentation**: `docs/URL_PATTERN_LOADING.md`
- **Test Suite**: `packages/charm/test/url-loading.test.ts`
- **Integration Demo**: `test-url-integration.ts`
- **This Summary**: `URL_PATTERN_LOADING_SUMMARY.md`

## Next Steps (Optional Future Enhancements)

1. **Local Caching**: Add persistent cache for offline development
2. **npm Support**: Load patterns from npm packages
3. **Versioning**: Semver support for pattern dependencies
4. **CDN Integration**: Use CDNs for faster pattern delivery

## Verification

To verify the implementation:

```bash
# Run unit tests
deno test packages/charm/test/url-loading.test.ts --allow-net --allow-read --allow-write --allow-env --allow-ffi --unstable-ffi --no-check

# Run integration test
deno run --allow-all --no-check test-url-integration.ts
```

Both should pass successfully, demonstrating:
- URL-based pattern loading works
- Relative imports are resolved correctly
- Patterns with dependencies load successfully
- Cross-repository references are enabled

---

**Status**: ✅ **COMPLETE AND TESTED**

The feature is fully functional, tested, and ready for use. Patterns can now be loaded from any accessible URL, with automatic dependency resolution.
