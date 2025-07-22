# CT-Outliner CellController Migration Plan

## Overview

This document outlines the comprehensive migration plan to update the `ct-outliner` component to use the same CellController pattern as `ct-list`. The migration will replace the current manual tree state management with a reactive, Cell-aware approach that uses direct Cell mutations via key paths.

## Current State Analysis

### Current ct-outliner Architecture
- **Manual State Sync**: Uses `this.value` (external) and `this.tree` (internal) properties with manual synchronization
- **Change Emission**: Calls `emitChange()` which sets `this.value = this.tree` and emits events
- **Update Prevention**: Uses `isInternalUpdate` flag to prevent circular updates in `updated()`
- **No Cell Support**: No Cell subscription management or transaction handling
- **Direct Mutations**: All tree operations mutate the tree object directly, then call `emitChange()`

### Key Current Methods
```typescript
// Current pattern in ct-outliner.ts:742-751
emitChange() {
  if (this.offline) return;
  this.isInternalUpdate = true;
  this.value = this.tree;
  this.isInternalUpdate = false;
  this.emit("ct-change", { value: this.tree });
}

// Current updated() logic in ct-outliner.ts:542-557
override updated(changedProperties) {
  if (changedProperties.has("value") && !this.editingNode) {
    if (!this.isInternalUpdate && !this.offline) {
      this.tree = this.value;
      // Reset focus logic...
    }
  }
}
```

## Target Architecture: CellController Pattern

### Reference Implementation
**Primary Reference**: `/packages/ui/src/v2/components/ct-list/ct-list.ts`
- Shows complete CellController integration with ArrayCellController
- Demonstrates Cell binding, getValue/setValue patterns
- Handles both `Cell<T[]>` and `T[]` values seamlessly

**Design Documentation**: `/packages/ui/src/v2/core/CELL_CONTROLLER_DESIGN.md`
- Comprehensive overview of CellController design principles
- Usage patterns and configuration options
- Migration guide from manual Cell handling

**Core Implementation**: `/packages/ui/src/v2/core/cell-controller.ts`
- Base CellController class with configuration options
- Factory functions for specialized controllers

## Migration Plan

### Phase 1: CellController Integration

#### 1.1 Add Core CellController Infrastructure
**File**: `packages/ui/src/v2/components/ct-outliner/ct-outliner.ts`

```typescript
import {
  type CellController,
  createCellController,
} from "../../core/cell-controller.ts";

export class CTOutliner extends BaseElement {
  @property()
  value: Tree | Cell<Tree> = TreeOperations.createEmptyTree();

  // Remove these manual state management properties:
  // declare tree: Tree;
  // private isInternalUpdate = false;

  // Add CellController
  private cellController: CellController<Tree>;

  constructor() {
    super();
    this.cellController = createCellController<Tree>(this, {
      timing: { strategy: "immediate" }, // Like ct-list for immediate updates
      onChange: (newTree, oldTree) => {
        this.emit("ct-change", { value: newTree });
        // Handle focus restoration after tree changes
        this.focusedNode = FocusUtils.findValidFocus(newTree, this.focusedNode);
      },
    });
  }
}
```

#### 1.2 Update Lifecycle Methods
Replace manual subscription logic with CellController binding:

```typescript
override updated(changedProperties: Map<string, any>) {
  super.updated(changedProperties);

  // Replace complex manual sync with simple binding
  if (changedProperties.has("value")) {
    this.cellController.bind(this.value);
  }
}

// Remove manual emitChange() method entirely
// Remove isInternalUpdate logic
```

#### 1.3 Update Value Access Patterns
Replace direct tree property access:

```typescript
// OLD: Direct property access
private someMethod() {
  const nodes = this.tree.root.children;
  // ... operate on tree
  this.emitChange();
}

// NEW: Controller-mediated access
private someMethod() {
  const tree = this.cellController.getValue();
  const nodes = tree.root.children;
  // ... operate via Cell mutations (see Phase 2)
}
```

### Phase 2: Direct Cell Mutations via Key Paths

#### 2.1 Understand Cell Key Path System
**Key Concept**: Instead of mutating the tree object and calling `emitChange()`, we'll:
1. Get the root Cell: `this.cellController.getCell()`
2. Navigate to specific subcells: `.key("root").key("children").key(0).key("body")`
3. Perform direct `.set()` operations on the target subcells
4. Let CellController handle propagation automatically

#### 2.2 Migration Pattern Examples

**Node Body Updates**:
```typescript
// OLD: Direct mutation + emitChange
editNode(node: Node, newBody: string) {
  node.body = newBody;
  this.emitChange();
}

// NEW: Cell path mutation
editNode(node: Node, newBody: string) {
  const tree = this.cellController.getValue();
  const nodePath = this.getNodePath(node); // [0, 2, 1] for root.children[0].children[2].children[1]

  const rootCell = this.cellController.getCell();
  if (rootCell && nodePath) {
    let targetCell = rootCell.key("root").key("children");

    // Navigate down the path
    for (const index of nodePath.slice(0, -1)) {
      targetCell = targetCell.key(index).key("children");
    }

    // Get the final node's body cell
    const nodeBodyCell = targetCell.key(nodePath[nodePath.length - 1]).key("body");

    // Direct mutation
    const tx = rootCell.runtime.edit();
    nodeBodyCell.withTx(tx).set(newBody);
    tx.commit();
  }
}
```

**Array Operations** (add/remove nodes):
```typescript
// OLD: Direct array mutation + emitChange
addChildNode(parentNode: Node, newNode: Node) {
  parentNode.children.push(newNode);
  this.emitChange();
}

// NEW: Cell array mutation
addChildNode(parentNode: Node, newNode: Node) {
  const rootCell = this.cellController.getCell();
  if (rootCell) {
    const parentPath = this.getNodePath(parentNode);
    let targetCell = rootCell.key("root").key("children");

    // Navigate to parent's children array
    for (const index of parentPath) {
      targetCell = targetCell.key(index).key("children");
    }

    // Get current children and append
    const currentChildren = targetCell.get() || [];
    const tx = rootCell.runtime.edit();
    targetCell.withTx(tx).set([...currentChildren, newNode]);
    tx.commit();
  }
}
```

#### 2.3 Update TreeOperations Module
**File**: `packages/ui/src/v2/components/ct-outliner/tree-operations.ts`

Convert all static tree operation methods to accept and operate on Cells:

```typescript
export class TreeOperations {
  // OLD: Operate on Tree objects
  static indentNode(tree: Tree, node: Node): TreeUpdateResult { /* ... */ }

  // NEW: Operate on Tree Cells
  static indentNode(treeCell: Cell<Tree>, node: Node): void {
    // Use Cell key paths for targeted mutations
    // No return value needed - Cell handles propagation
  }

  // Update all methods:
  // - outdentNode, deleteNode, createNodeAfter, createChildNode
  // - moveNode, duplicateNode, etc.
  // - Convert to use Cell.key() paths and .set() operations
}
```

#### 2.4 Path Management Utilities
Add utility methods for Cell path navigation:

```typescript
// In ct-outliner.ts
private getNodeCellPath(node: Node): string[] | null {
  const nodePath = this.getNodePath(node); // existing method returns number[]
  if (!nodePath) return null;

  // Convert [0, 2, 1] to ["root", "children", "0", "children", "2", "children", "1"]
  const cellPath = ["root", "children"];
  for (let i = 0; i < nodePath.length; i++) {
    cellPath.push(String(nodePath[i]));
    if (i < nodePath.length - 1) {
      cellPath.push("children");
    }
  }
  return cellPath;
}

private getNodeBodyCell(node: Node): Cell<string> | null {
  const rootCell = this.cellController.getCell();
  const cellPath = this.getNodeCellPath(node);

  if (!rootCell || !cellPath) return null;

  let targetCell = rootCell;
  for (const key of cellPath) {
    targetCell = targetCell.key(key);
  }

  return targetCell.key("body");
}
```

### Phase 3: Update All Tree Operations

#### 3.1 Core Editing Operations
**Files to update**:
- `ct-outliner.ts` - Main component methods
- `keyboard-commands.ts` - Keyboard command handlers
- `tree-operations.ts` - Core tree manipulation logic

**Methods to migrate**:
```typescript
// All these need Cell-based implementations:
- startEditing() → Use getNodeBodyCell() for editing content
- finishEditing() → Direct Cell.set() on node body
- deleteNode() → Cell array manipulation
- indentNode() → Cell tree restructuring
- outdentNode() → Cell tree restructuring
- createNewNodeAfter() → Cell array insertion
- createChildNode() → Cell array insertion
- duplicateNode() → Cell array + object creation
- moveNode() → Cell array manipulation
```

#### 3.2 Keyboard Command Updates
**File**: `packages/ui/src/v2/components/ct-outliner/keyboard-commands.ts`

Update all keyboard commands to use new Cell-based operations:

```typescript
// OLD: Direct tree mutation
case "Enter":
  if (ctx.focusedNode) {
    TreeOperations.createNodeAfter(ctx.component.tree, ctx.focusedNode);
    ctx.component.emitChange();
  }

// NEW: Cell-based mutation
case "Enter":
  if (ctx.focusedNode) {
    const treeCell = ctx.component.cellController.getCell();
    if (treeCell) {
      TreeOperations.createNodeAfter(treeCell, ctx.focusedNode);
      // No emitChange needed - Cell handles it
    }
  }
```

### Phase 4: Special Considerations

#### 4.1 Offline Mode Integration
The offline mode needs special handling with CellController:

```typescript
// Configure CellController for offline mode
private configureCellController() {
  const options = {
    timing: { strategy: "immediate" },
    onChange: (newTree, oldTree) => {
      if (!this.offline) {
        this.emit("ct-change", { value: newTree });
      }
      this.focusedNode = FocusUtils.findValidFocus(newTree, this.focusedNode);
    },
    // Custom setValue for offline mode
    setValue: (value, newValue, oldValue) => {
      if (this.offline) {
        // In offline mode, don't propagate to external Cell
        return;
      }
      // Normal Cell handling for online mode
      if (isCell(value)) {
        const tx = value.runtime.edit();
        value.withTx(tx).set(newValue);
        tx.commit();
      }
    }
  };

  this.cellController = createCellController<Tree>(this, options);
}
```

#### 4.2 Focus Management
Focus management needs to work with the new Cell-based tree:

```typescript
// Update focus utilities to work with Cell trees
private updateFocusAfterTreeChange() {
  const currentTree = this.cellController.getValue();
  this.focusedNode = FocusUtils.findValidFocus(currentTree, this.focusedNode);
  this.requestUpdate();
}
```

#### 4.3 Debugging and Testing
Update the debug panel and test utilities:

```typescript
// Debug panel needs to work with CellController
private handleReset() {
  const emptyTree = TreeOperations.createEmptyTree();
  this.cellController.setValue(emptyTree);
  this.focusedNode = null;
  this.collapsedNodes.clear();
}

// Test API updates
get testAPI() {
  return {
    cellController: this.cellController,
    getValue: () => this.cellController.getValue(),
    setValue: (tree: Tree) => this.cellController.setValue(tree),
    // ... other test methods
  };
}
```

### Phase 5: Type Updates and Interface Changes

#### 5.1 Update Type Definitions
**File**: `packages/ui/src/v2/components/ct-outliner/types.ts`

```typescript
// Update OutlinerOperations interface
export interface OutlinerOperations {
  readonly tree: Tree; // Remove - use cellController.getValue()
  cellController: CellController<Tree>; // Add

  // Update method signatures to remove Tree return values
  deleteNode(node: Node): void; // was: TreeUpdateResult
  indentNode(node: Node): void; // was: TreeUpdateResult
  // ... etc

  // Remove emitChange - handled by CellController
  // emitChange(): void;
}
```

#### 5.2 Component Interface Updates
```typescript
// Update the main component interface
export class CTOutliner extends BaseElement {
  @property()
  value: Tree | Cell<Tree> = TreeOperations.createEmptyTree();

  // Remove internal tree state
  // declare tree: Tree;

  // Add Cell controller
  private cellController: CellController<Tree>;

  // Update getter for backward compatibility
  get tree(): Tree {
    return this.cellController.getValue();
  }
}
```

### Phase 6: Testing Migration

#### 6.1 Update Test Files
**Files to update**:
- `component-integration.test.ts`
- `ct-outliner-logic.test.ts`
- `keyboard-commands.test.ts`
- `offline-mode.test.ts`

**Key changes**:
- Mock Cell values in addition to plain Tree values
- Update test assertions to work with CellController
- Test both Cell and non-Cell scenarios
- Verify offline mode still works correctly

#### 6.2 Test Cell Integration
```typescript
// Add tests for Cell functionality
describe("Cell Integration", () => {
  it("should handle Cell<Tree> values", () => {
    const mockRuntime = createMockRuntime();
    const treeCell = mockRuntime.getCell<Tree>({ type: "tree" });

    const outliner = new CTOutliner();
    outliner.value = treeCell;

    // Test that operations work with Cell
    // Test that changes propagate correctly
  });

  it("should handle plain Tree values", () => {
    const outliner = new CTOutliner();
    outliner.value = TreeOperations.createEmptyTree();

    // Test that operations work with plain objects
  });
});
```

## Implementation Order

### Priority 1: Core Infrastructure (STAGES 1-2)
1. Add CellController integration to main component
2. Update lifecycle methods and property handling
3. Create basic Cell path navigation utilities
4. Update value access patterns

### Priority 2: Tree Operations Migration (STAGES 3-4)
1. Migrate TreeOperations module to Cell-based approach
2. Update core editing operations (start/finish editing)
3. Migrate keyboard commands to use new operations
4. Test basic functionality

### Priority 3: Advanced Features (STAGES 5-6)
1. Implement offline mode with CellController
2. Update focus management for Cell trees
3. Migrate debug panel and test utilities
4. Handle edge cases and error scenarios

### Priority 4: Testing and Polish (STAGES 7-8)
1. Update all test files for new architecture
2. Add comprehensive Cell integration tests
3. Performance testing and optimization
4. Documentation updates

## Key Files Reference

### Implementation Files
- **Main Component**: `/packages/ui/src/v2/components/ct-outliner/ct-outliner.ts`
- **Tree Operations**: `/packages/ui/src/v2/components/ct-outliner/tree-operations.ts`
- **Keyboard Commands**: `/packages/ui/src/v2/components/ct-outliner/keyboard-commands.ts`
- **Type Definitions**: `/packages/ui/src/v2/components/ct-outliner/types.ts`

### Reference Files
- **CellController Pattern**: `/packages/ui/src/v2/components/ct-list/ct-list.ts`
- **Design Documentation**: `/packages/ui/src/v2/core/CELL_CONTROLLER_DESIGN.md`
- **Core Implementation**: `/packages/ui/src/v2/core/cell-controller.ts`

### Test Files
- `/packages/ui/src/v2/components/ct-outliner/component-integration.test.ts`
- `/packages/ui/src/v2/components/ct-outliner/ct-outliner-logic.test.ts`
- `/packages/ui/src/v2/components/ct-outliner/keyboard-commands.test.ts`
- `/packages/ui/src/v2/components/ct-outliner/offline-mode.test.ts`

## Success Criteria

### Functional Requirements
✅ Component accepts both `Cell<Tree>` and `Tree` values
✅ All existing functionality preserved (editing, keyboard nav, etc.)
✅ Offline mode continues to work correctly
✅ Focus management works with Cell-based trees
✅ Debug panel integrates with CellController

### Technical Requirements
✅ No manual `emitChange()` or `isInternalUpdate` logic
✅ All tree mutations use Cell key paths and `.set()` operations
✅ CellController handles all subscription and update logic
✅ TreeOperations module uses Cell-based operations
✅ Consistent with ct-list CellController pattern

### Quality Requirements
✅ All existing tests pass with new implementation
✅ Performance is equal or better than current implementation
✅ Code complexity reduced through CellController abstraction
✅ Type safety maintained throughout

## Risk Mitigation

### Complexity Risks
- **Risk**: Cell key path navigation is complex for deep trees
- **Mitigation**: Create utility functions for common path operations

### Performance Risks
- **Risk**: Cell operations might be slower than direct mutations
- **Mitigation**: Profile and optimize Cell usage patterns

### Compatibility Risks
- **Risk**: Breaking changes to component interface
- **Mitigation**: Maintain backward compatibility with Tree values

### Testing Risks
- **Risk**: Complex test migration for Cell integration
- **Mitigation**: Implement in phases with incremental testing

This migration will bring ct-outliner in line with the established CellController pattern while maintaining all existing functionality and improving the reactive data flow architecture.
