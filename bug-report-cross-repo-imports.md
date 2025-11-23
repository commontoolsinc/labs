# Bug Report: ct tool does not support relative imports to adjacent repositories

## Summary

The `ct` tool's module resolver cannot resolve relative imports that traverse up to a parent directory and then into an adjacent repository. This prevents patterns in one repository from importing patterns from another repository in the same workspace.

## Expected Behavior

Given this directory structure:
```
/Users/alex/Code/
├── labs/
│   └── packages/
│       └── patterns/
│           ├── counter.tsx
│           └── counter-handlers.ts
└── recipes/
    └── recipes/
        └── alex/
            └── WIP/
                └── charm-creator.tsx
```

The following import in `charm-creator.tsx` should work:
```typescript
import Counter from "../../../../labs/packages/patterns/counter.tsx";
```

This path correctly traverses:
- Up from `WIP/` to `alex/` (../)
- Up from `alex/` to `recipes/` (../../)
- Up from `recipes/` to `recipes/` (../../../)
- Up from `recipes/` to `Code/` (../../../../)
- Into `labs/packages/patterns/counter.tsx` (../../../../labs/packages/patterns/counter.tsx)

## Actual Behavior

The `ct` tool's module resolver incorrectly resolves the path, looking for:
```
/Users/alex/Code/recipes/recipes/alex/WIP/labs/packages/patterns/counter.tsx
```

Instead of:
```
/Users/alex/Code/labs/packages/patterns/counter.tsx
```

### Error Message
```
NotFound: No such file or directory (os error 2): readfile '/Users/alex/Code/recipes/recipes/alex/WIP/labs/packages/patterns/counter.tsx'
    at Object.readTextFileSync (ext:deno_fs/30_fs.js:770:10)
    at FileSystemProgramResolver.#readFile (file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/js-runtime/program.ts:65:17)
    at FileSystemProgramResolver.resolveSource (file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/js-runtime/program.ts:55:31)
```

The error occurs at `packages/js-runtime/program.ts:55` in the `FileSystemProgramResolver.resolveSource` method.

## What This Would Enable

### 1. Code Reuse Across Repositories
- Patterns in the `recipes` repository could import and compose patterns from the `labs` repository
- Users could create custom pattern libraries in separate repositories and reference them
- Teams could maintain shared pattern libraries that multiple recipe repositories reference

### 2. Better Code Organization
- Separate concerns: core patterns in `labs`, specific use cases in `recipes`
- Avoid monorepo constraints while maintaining modularity
- Enable cleaner separation between stable patterns and experimental recipes

### 3. Avoid Code Duplication
Currently, to work around this issue, users must:
- Copy pattern files and their dependencies into the recipe repository
- Manually sync updates between repositories
- Maintain duplicate code that can drift out of sync

### Example Use Case
The `charm-creator.tsx` pattern provides a UI for creating different types of charms. It should be able to import various pattern templates (like `counter.tsx`, `note.tsx`, etc.) from the core patterns library and instantiate them with `navigateTo()`. Without cross-repository imports, each pattern must be duplicated into the recipe repository.

## Alternatives Considered

### 1. Copy Files (Current Workaround)
**Pros:**
- Works with current ct tool
- Self-contained recipe repository

**Cons:**
- Code duplication
- Manual synchronization required
- Files can drift out of sync
- Violates DRY principle
- Increases maintenance burden

### 2. Absolute Paths
Attempted using absolute paths:
```typescript
import Counter from "/Users/alex/Code/labs/packages/patterns/counter.tsx";
```

**Result:** Same error - the tool still tries to resolve relative to the current file's directory

### 3. Monorepo
Move all recipes into the labs repository.

**Cons:**
- Couples recipe development to core pattern development
- Forces same version control for all code
- Not suitable for user-generated recipes
- Doesn't scale for multiple recipe repositories

### 4. Symbolic Links
Create symlinks from recipes to labs patterns.

**Cons:**
- Brittle across systems
- Complicates repository setup
- Version control complexity
- Not portable

### 5. Package/Module System
Publish patterns as npm packages or similar.

**Cons:**
- Heavy-weight for local development
- Requires build/publish step for every change
- Overkill for workspace-local references
- Adds deployment complexity

## Technical Details

The issue appears to be in `FileSystemProgramResolver` at `packages/js-runtime/program.ts`. The resolver likely:
1. Takes the importing file's directory as base: `/Users/alex/Code/recipes/recipes/alex/WIP/`
2. Appends the import path without properly resolving `..` segments: `../../../../labs/packages/patterns/counter.tsx`
3. Results in malformed path: `/Users/alex/Code/recipes/recipes/alex/WIP/labs/packages/patterns/counter.tsx`

The resolver should instead:
1. Normalize the path by resolving `..` segments
2. Handle paths that traverse above the importing file's repository root
3. Support standard relative path resolution as used by Node.js, Deno, and TypeScript

## Reproduction Steps

1. Create file at `/Users/alex/Code/recipes/recipes/alex/WIP/charm-creator.tsx`
2. Add import: `import Counter from "../../../../labs/packages/patterns/counter.tsx";`
3. Ensure target file exists at `/Users/alex/Code/labs/packages/patterns/counter.tsx`
4. Run: `ct charm new --space <space-name> /Users/alex/Code/recipes/recipes/alex/WIP/charm-creator.tsx`
5. Observe error about file not found at incorrect path

## Environment

- OS: macOS (Darwin 24.6.0)
- ct tool: Version 0.0.1 (compiled binary)
- Working directory: `/Users/alex/Code/labs`
- Import from: `/Users/alex/Code/recipes/recipes/alex/WIP/charm-creator.tsx`
- Import to: `/Users/alex/Code/labs/packages/patterns/counter.tsx`

## Suggested Fix

Update `FileSystemProgramResolver.resolveSource()` to:
1. Use proper path normalization (e.g., Node's `path.resolve()` or Deno's equivalent)
2. Resolve relative imports correctly, handling `..` segments that traverse above the current file's directory
3. Support standard ECMAScript module resolution semantics

This would align the ct tool's behavior with standard JavaScript/TypeScript module resolution and enable the common workspace pattern of adjacent repositories referencing each other.
