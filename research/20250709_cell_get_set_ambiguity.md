# Cell Get/Set Operations Ambiguity Analysis

**Date:** July 9, 2025  
**Research Focus:** Understanding the ambiguity around get/set operations for cells in the commontools platform

## Executive Summary

The current implementation of cell get/set operations exhibits significant ambiguity regarding which cell data is being accessed or modified. Three distinct use cases have been identified that require different handling:

1. **Direct cell access** - Reading/writing to any cell directly by ID and path
2. **Charm input manipulation** - Reading/writing to a charm's input cell (arguments)
3. **Charm result access** - Reading/writing to a charm's result cell (output)

Currently, the system defaults to result cell access for charms, but lacks clear distinction between input and result operations, and has unclear behavior for non-charm cells.

## Current Implementation Analysis

### CLI Interface (`packages/cli/commands/charm.ts`)

The CLI provides `charm get` and `charm set` commands that operate on charm cells:

```typescript
// GET operation - lines 315-333
.command("get", "Get a value from a charm at a specific path")
.action(async (options, pathString) => {
  const charmConfig = parseCharmOptions(options);
  const pathSegments = parseCellPath(pathString);
  const value = await getCellValue(charmConfig, pathSegments);
  render(value, { json: true });
})

// SET operation - lines 334-353
.command("set", "Set a value in a charm at a specific path")
.action(async (options, pathString) => {
  const charmConfig = parseCharmOptions(options);
  const pathSegments = parseCellPath(pathString);
  const value = await drainStdin();
  await setCellValue(charmConfig, pathSegments, value);
  render(`Set value at path: ${pathString}`);
})
```

### Core Implementation (`packages/charm/src/ops/cell-operations.ts`)

The core cell operations reveal the first major ambiguity:

```typescript
// GET operation - reads from charm's result cell
export async function getCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
): Promise<unknown> {
  const charmCell = await manager.get(charmId); // Gets result cell
  let currentValue = charmCell.get();
  // Navigate path in result data
  for (const segment of path) {
    currentValue = (currentValue as any)[segment];
  }
  return currentValue;
}

// SET operation - writes to charm's input cell
export async function setCellValue(
  manager: CharmManager,
  charmId: string,
  path: CellPath,
  value: unknown,
): Promise<void> {
  const charmCell = await manager.get(charmId); // Gets result cell
  const inputCell = manager.getArgument(charmCell);  // Gets input cell
  let targetCell = inputCell;
  // Navigate path in input cell
  for (const segment of path) {
    targetCell = targetCell.key(segment);
  }
  targetCell.set(value as any);
}
```

**Key Issue:** `getCellValue` reads from the result cell while `setCellValue` writes to the input cell. This asymmetry creates confusion about which data is being accessed.

### Charm Manager Implementation (`packages/charm/src/manager.ts`)

The CharmManager reveals additional complexity:

```typescript
// The manager.get() method returns the result cell
async get<T = Charm>(
  id: string | Cell<Charm>,
  runIt: boolean = true,
  asSchema?: JSONSchema,
): Promise<Cell<T> | undefined> {
  // ... returns running charm result cell
}

// The getArgument() method returns the input cell
getArgument<T = any>(charm: Cell<Charm | T>): Cell<T> {
  const source = charm.getSourceCell(processSchema);
  return source.key("argument").asSchema<T>(recipe.argumentSchema);
}
```

### Link Operations and Well-Known Cells

The linking system provides hints about the intended architecture:

```typescript
// From packages/cli/commands/charm.ts lines 283-289
// Parse source and target references - handle both charmId/path and well-known IDs
const source = parseLink(sourceRef, { allowWellKnown: true });
const target = parseLink(targetRef);

// For linking, we need paths unless source is a well-known ID
// Well-known IDs can be linked without a path (linking the entire cell)
const isWellKnownSource = !sourceRef.includes("/");
```

This suggests the system recognizes different categories of cells:
- **Charm cells** - Have both input and result components
- **Well-known cells** - System-defined cells that can be referenced directly
- **Arbitrary cells** - Generic cells that can be created and referenced

## Three Distinct Use Cases

### 1. Direct Cell Access (Well-Known and Arbitrary Cells)

**Current State:** Partially supported through `getCellFromEntityId()` but not exposed through CLI

**Expected Behavior:**
- `get cell-id path` - Read from any cell directly
- `set cell-id path value` - Write to any cell directly
- No distinction between input/result as these are simple cells

**Example:**
```bash
# Read from well-known charms list
ct get baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye 

# Write to arbitrary cell
ct set some-cell-id config/theme "dark"
```

### 2. Charm Input Manipulation

**Current State:** Only supported through `set` operations, not `get`

**Expected Behavior:**
- `get charm-id --input path` - Read from charm's input cell
- `set charm-id --input path value` - Write to charm's input cell
- Should trigger charm re-execution when input changes

**Example:**
```bash
# Read current input
ct charm get --input bafycharm1 config/apiKey

# Update input
ct charm set --input bafycharm1 config/apiKey "new-key"
```

### 3. Charm Result Access

**Current State:** Default behavior for `get` operations, not supported for `set`

**Expected Behavior:**
- `get charm-id path` - Read from charm's result cell (current default)
- `set charm-id --result path value` - Write directly to result cell (bypass recipe)
- Writing to result should be rare and potentially dangerous

**Example:**
```bash
# Read result (current default)
ct charm get bafycharm1 data/users

# Direct result manipulation (dangerous)
ct charm set --result bafycharm1 $UI "<override>"
```

## Problems with Current Implementation

### 1. Asymmetric Operations
- `get` reads from result cell
- `set` writes to input cell
- No way to read input or write result

### 2. Limited Cell Type Support
- CLI only supports charm operations
- No direct access to well-known cells
- No support for arbitrary cells

### 3. Unclear Semantics
- Users expect `get` and `set` to be symmetric
- No clear indication of which cell type is being accessed
- Mixing of input/result operations is confusing

### 4. Missing Functionality
- Cannot read current input values
- Cannot write directly to result (for debugging/testing)
- Cannot operate on non-charm cells through CLI

## Test Coverage Analysis

### Existing Tests

**Cell Operations Tests** (`packages/charm/test/cell-operations.test.ts`):
- Tests basic `getCellValue` and `setCellValue` functionality
- Uses mock implementations
- Focuses on path navigation, not cell type distinction
- **Missing:** Tests for input vs result cell access

**CLI Tests** (`packages/cli/test/charm-cell-operations.test.ts`):
- Tests path parsing only
- **Missing:** Integration tests for actual get/set operations
- **Missing:** Tests for different cell types

### Test Gaps

1. **Integration tests** for actual charm get/set operations
2. **Cell type distinction** tests (input vs result)
3. **Well-known cell access** tests
4. **Arbitrary cell access** tests
5. **Asymmetric operation behavior** tests

## Proposed API Design Improvements

### Option 1: Explicit Cell Type Flags

Add flags to clarify which cell is being accessed:

```bash
# Default behavior (result cell)
ct charm get bafycharm1 data/users

# Explicit input access
ct charm get --input bafycharm1 config/apiKey
ct charm set --input bafycharm1 config/apiKey "new-key"

# Explicit result access
ct charm get --result bafycharm1 data/users
ct charm set --result bafycharm1 $UI "<override>"  # dangerous

# Direct cell access (non-charm)
ct cell get cell-id path
ct cell set cell-id path value
```

### Option 2: Different Commands for Different Cell Types

Separate commands for different operations:

```bash
# Charm operations (default to result)
ct charm get bafycharm1 data/users
ct charm set-input bafycharm1 config/apiKey "new-key"
ct charm get-input bafycharm1 config/apiKey

# Direct cell operations
ct cell get cell-id path
ct cell set cell-id path value
```

### Option 3: URI-style Addressing

Use URI-style paths to specify cell type:

```bash
# Result cell (default)
ct get bafycharm1/result/data/users
ct get bafycharm1/data/users  # shorthand

# Input cell
ct get bafycharm1/input/config/apiKey
ct set bafycharm1/input/config/apiKey "new-key"

# Direct cell access
ct get cell-id/path
ct set cell-id/path value
```

## Recommendations

### Immediate Actions

1. **Fix asymmetric operations** - Make `getCellValue` and `setCellValue` operate on the same cell type by default
2. **Add comprehensive tests** - Cover all three use cases with integration tests
3. **Document current behavior** - Clear documentation about which cell type each operation affects

### Medium-term Improvements

1. **Implement Option 1** - Add explicit flags for cell type specification
2. **Add cell command** - Support direct operations on arbitrary cells
3. **Improve error messages** - Make it clear when operations fail due to cell type mismatches

### Long-term Considerations

1. **Consistent addressing scheme** - Develop a unified way to address different cell types
2. **Type safety** - Add runtime validation for cell type operations
3. **Performance optimization** - Cache cell type determination to avoid repeated lookups

## Conclusion

The current cell get/set implementation suffers from significant ambiguity that affects usability and correctness. The asymmetric behavior where `get` reads from result cells while `set` writes to input cells is particularly problematic. 

The three identified use cases (direct cell access, charm input manipulation, and charm result access) each require different handling, and the current implementation inadequately addresses this distinction.

Implementing explicit cell type flags (Option 1) appears to be the most backward-compatible solution that would resolve the ambiguity while maintaining the current API structure. This would allow users to explicitly specify which cell type they want to operate on, making the operations predictable and symmetric.

The lack of comprehensive integration tests also makes it difficult to verify correct behavior and catch regressions. Adding thorough test coverage should be a priority alongside any API improvements.