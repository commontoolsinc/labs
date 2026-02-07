# Reactive Proxy `.length` Bug

## Summary

When accessing `.length` on reactive proxy values (strings or arrays) returned from pattern outputs, it returns `undefined` instead of the actual length.

## Reproduction

In pattern tests, when accessing properties from an instantiated pattern:

```typescript
const instance = NotesImportExport({ allPieces, importMarkdown });

// These work:
instance.exportedMarkdown !== ""        // ✓ returns true/false correctly
typeof instance.exportedMarkdown === "string"  // ✓ returns true

// This fails:
instance.exportedMarkdown.length > 0    // ✗ returns undefined (not a boolean)

// Same issue with arrays:
instance.detectedDuplicates.length === 0  // ✗ returns undefined
```

## Workarounds

**For strings:** Use direct comparison instead of `.length`
```typescript
// Instead of: str.length > 0
str !== ""
```

**For arrays:** Spread first to get a plain JS array
```typescript
// Instead of: arr.length === 0
[...arr].length === 0
```

## Context

- Discovered while writing tests for `packages/patterns/notes/notes-import-export.tsx`
- The pattern returns `exportedMarkdown` (a Writable<string>) and `detectedDuplicates` (a computed array)
- Direct value comparison works, but `.length` property access does not
- This has apparently been fixed before and may be a regression

## Files to Investigate

- `packages/runner/src/query-result-proxy.ts` - likely where proxy property access is handled
- Pattern test harness code that wraps pattern outputs

## Related Test Files

- `packages/patterns/notes/notes-import-export.test.tsx` - has workarounds applied
- `packages/patterns/notes/notes-import-export-simple.test.tsx` - minimal repro (can be deleted after fix)
