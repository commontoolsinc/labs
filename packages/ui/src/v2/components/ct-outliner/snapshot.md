# CT-Outliner Refactor Status Report

## Current State - December 2024

### What We've Accomplished

1. **Fixed Cell Array Operations** ✅
   - Resolved the "Reflect.get called on non-object" error
   - The solution: Nodes must have `[ID]` properties when initially created
   - Fixed by ensuring all test data uses `TreeOperations.createNode()`
   - Removed the need for `createCleanNodeCopy` workaround
   - All tests now passing

2. **Discovered Critical API Misuse** 🚨
   - We're incorrectly using `.get()` instead of `.getAsQueryResult()` throughout the codebase
   - `.get()` does NOT resolve links - it returns raw Cell data
   - `.getAsQueryResult()` properly resolves links and returns the actual data
   - This is a CRITICAL issue that breaks link resolution

### Current Issue: Improper Cell API Usage

We discovered widespread misuse of the Cell API:

```typescript
// WRONG - doesn't resolve links
const children = childrenCell.get();

// CORRECT - resolves links properly
const children = childrenCell.getAsQueryResult();
```

#### Findings:

1. **Extensive `.get()` misuse**:
   - 9 instances in `tree-operations.ts`
   - 10+ instances in `ct-outliner.ts`
   - Test files also affected
   - This means links are NOT being resolved correctly anywhere

2. **Why this matters**:
   - Links are a core feature of CommonTools
   - Without proper resolution, linked data appears as Cell references instead of actual values
   - This breaks any functionality that depends on linked data

3. **Our tests don't catch this** 🚨:
   - Current tests don't include scenarios with linked data
   - Tests pass because they only use local, non-linked data
   - This is a major gap in test coverage

4. **Type safety issues**:
   - `.getAsQueryResult()` returns `unknown` and needs casting
   - `.get()` returns typed values but doesn't resolve links
   - This creates a false sense of type safety

5. **Runtime Data Corruption** 💥:
   - Creating new items and moving items creates CORRUPT DATA at runtime
   - We're inserting malformed/unresolved link data into arrays
   - This corruption is NOT caught by our tests but happens trivially in real usage
   - The corrupted data manifests as:
     - Nodes that can't be found or accessed
     - Operations that silently fail
     - Tree structures that become invalid
     - UI that doesn't update or shows broken state

## Next Steps

### 1. Fix All `.get()` Calls
- [IN PROGRESS] Replace `.get()` with `.getAsQueryResult()` in `tree-operations.ts`
- [IN PROGRESS] Replace `.get()` with `.getAsQueryResult()` in `ct-outliner.ts`
- Add proper type casting where needed
- Exception: Keep `.get()` inside `mutateCell` callbacks where we're modifying data

### 2. Add Link Resolution Tests
- Create tests that use linked data
- Verify that links are properly resolved
- Test scenarios:
  - Nodes with linked attachments
  - Trees with linked subtrees
  - Mentionable items that are links

### 3. Review All Cell Usage Patterns
- Audit all Cell access patterns
- Document proper usage:
  - Use `.getAsQueryResult()` for reading data
  - Use `.get()` only inside mutation callbacks
  - Always cast the result of `.getAsQueryResult()`

### 4. Fix Type Issues
- Import missing types (Attachment, etc.)
- Add proper type assertions for `.getAsQueryResult()` calls
- Consider creating helper functions that handle casting

## Critical Questions

1. How many other components have this same issue?
2. What functionality is currently broken due to unresolved links?
3. Should we create a linting rule to catch `.get()` misuse?
4. Do we need to educate the team on proper Cell API usage?

## Immediate Action Items

1. Finish fixing all `.get()` calls in ct-outliner
2. Run tests to ensure nothing breaks
3. Create a test that would have caught this issue
4. Document the proper Cell API usage pattern
5. Consider a codebase-wide audit for this issue

## Example of the Problem

When we do this:
```typescript
// Get children array with unresolved links
const children = parentCell.get();  
const nodeToMove = children[0];  // This might be a link reference!

// Later, insert this unresolved link into another array
const newChildren = [...siblingChildren, nodeToMove];
siblingCell.set(newChildren);
```

We're potentially inserting an unresolved link reference into the array, which corrupts the data structure. The correct approach:
```typescript
// Properly resolve all links
const children = parentCell.getAsQueryResult() as Node[];
const nodeToMove = children[0];  // Now this is the actual resolved node

// Safe to move the resolved node
const newChildren = [...siblingChildren, nodeToMove];
siblingCell.set(newChildren);
```

## Severity

This is a **CRITICAL** bug that:
- Causes data corruption in production
- Is invisible in our test suite
- Affects core functionality (creating, moving, deleting nodes)
- Could be affecting other components using similar patterns