# Bug Report: JSX Types Breaking Custom Elements

## Summary
Commit a0c21d90e ("feat: Use our own native DOM types in JSX #1981") broke existing patterns that use custom web components not explicitly defined in the new JSX type definitions.

## Impact
- **Broken Component:** `<common-google-oauth>`
- **Affected Patterns:**
  - `gmail-auth.tsx` (canonical version in `labs/recipes/`)
  - Any pattern using `<common-google-oauth>`
- **Error:** `CompilerError: [ERROR] Property 'common-google-oauth' does not exist on type 'JSX.IntrinsicElements'`

## Root Cause

### Before (working):
```typescript
// packages/static/assets/types/jsx.d.ts
interface IntrinsicElements {
  [elemName: string]: any;  // <-- Allowed ANY custom element
  "ct-outliner": { ... },
  "ct-list": { ... },
  // ...
}
```

### After (broken):
```typescript
// packages/static/assets/types/jsx.d.ts
interface IntrinsicElements extends DOMIntrinsicElements {
  //[elemName: string]: any;  // <-- COMMENTED OUT!
  "ct-outliner": { ... },
  "ct-list": { ... },
  "common-iframe": { ... },
  "common-fragment": { ... },
  "common-input": { ... },
  // ... but NO common-google-oauth!
}
```

## The Problem
The index signature `[elemName: string]: any;` was commented out (line ~1488 in the new jsx.d.ts), which means:
1. Only explicitly defined custom elements are now allowed in JSX
2. `common-google-oauth` was not added to the explicit definitions
3. Any other custom web components not in the list will also fail

## Evidence
- **Canonical pattern fails:** `/Users/alex/Code/labs/recipes/gmail-auth.tsx` deployed to toolshed now throws compilation error
- **Component exists:** `common-google-oauth` is defined in `/Users/alex/Code/labs/packages/ui/src/v1/components/common-google-oauth.ts`
- **Component is registered:** `globalThis.customElements.define("common-google-oauth", CommonGoogleOauthElement)`
- **Component is exported:** Exported in `/Users/alex/Code/labs/packages/ui/src/v1/components/index.ts`

## Reproduction Steps
1. Deploy canonical gmail-auth pattern from labs/recipes:
   ```bash
   ct charm new --space <space> /Users/alex/Code/labs/recipes/gmail-auth.tsx
   ```
2. Navigate to the charm in browser
3. Observe compilation error in console:
   ```
   CompilerError: [ERROR] Property 'common-google-oauth' does not exist on type 'JSX.IntrinsicElements'
   ```

## Proposed Solutions

### Option 1: Add missing custom elements (Recommended)
Add explicit type definitions for all UI components:
- `common-google-oauth`
- `common-plaid-link` (probably also missing)
- Any other custom elements from `/packages/ui/src/v1/components/`

### Option 2: Restore index signature
Uncomment the `[elemName: string]: any;` line to allow arbitrary custom elements (reverts to old behavior)

### Option 3: Make index signature more permissive
```typescript
interface IntrinsicElements extends DOMIntrinsicElements {
  [elemName: `common-${string}`]: any;  // Allow common-* elements
  [elemName: `ct-${string}`]: any;      // Allow ct-* elements
  // ... explicit definitions for better typing
}
```

## Files Changed in Broken Commit
- `packages/api/index.ts`
- `packages/static/assets/types/commontools.d.ts`
- `packages/static/assets/types/jsx.d.ts` (2409 lines added, 147 removed)

## Commit Details
- **Hash:** a0c21d90e85b6f460bd89f3fecfc2c0dfda3522e
- **Author:** Jordan Santell
- **Date:** Fri Oct 31 09:11:28 2025 -0700
- **PR:** #1981

## Testing Notes
The issue was discovered when trying to implement a gmail-charm-creator pattern that uses the canonical gmail-auth component. The pattern worked in toolshed as recently as yesterday (Oct 30) but broke after this morning's type changes.

## CC
@jsantell
