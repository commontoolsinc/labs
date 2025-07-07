# CT Outliner Component Specification

## Overview

The `ct-outliner` is a hierarchical tree-based outliner component built with Lit
that provides keyboard-driven navigation and editing capabilities. It uses a
mutable tree data structure for live manipulation while maintaining node
reference equality.

## Data Structure

### Node Interface

```typescript
interface Node {
  body: string; // Text content of the node
  children: Node[]; // Child nodes (mutable array)
  attachments: Attachment[]; // File/charm attachments
}
```

### Tree Interface

```typescript
interface Tree {
  root: Node; // Root node (typically has empty body)
}
```

**Key Design Decision**: The tree structure is intentionally mutable to preserve
object references for focus management and UI consistency. This differs from
typical immutable patterns in the codebase.

## Component Properties

- `value: Tree` - The tree data structure
- `readonly: boolean` - Whether editing is disabled
- `mentionable: MentionableItem[]` - Items available for @ mentions
- `tree: Tree` (internal state) - Working copy of the tree
- `focusedNode: Node | null` - Currently focused node
- `collapsedNodes: Set<Node>` - Nodes that are collapsed in the UI

## Keyboard Commands

### Navigation Commands

| Key     | Action                                            |
| ------- | ------------------------------------------------- |
| `↑`     | Move focus to previous node                       |
| `↓`     | Move focus to next node                           |
| `←`     | Collapse node (if expanded) or move to parent     |
| `→`     | Expand node (if collapsed) or move to first child |
| `Alt+↑` | Move node up among siblings                       |
| `Alt+↓` | Move node down among siblings                     |

### Edit Mode Commands

| Key              | Modifier   | Context   | Action                                     |
| ---------------- | ---------- | --------- | ------------------------------------------ |
| `Space`          | -          | Read mode | Start editing (preserves existing content) |
| `cmd/ctrl+Enter` | -          | Any       | Toggle edit mode on/off                    |
| `Enter`          | -          | Read mode | Create new sibling node                    |
| `Enter`          | `Shift`    | Read mode | Create new child node                      |
| `Enter`          | -          | Edit mode | Exit edit mode                             |
| `Enter`          | `cmd/ctrl` | Edit mode | Exit edit mode                             |
| `Escape`         | -          | Edit mode | Cancel editing (revert changes)            |

### Tree Structure Commands

| Key         | Modifier   | Context   | Action                                          |
| ----------- | ---------- | --------- | ----------------------------------------------- |
| `Tab`       | -          | Read mode | Indent node (make child of previous sibling)    |
| `Tab`       | `Shift`    | Read mode | Outdent node (move to parent level)             |
| `]`         | `cmd/ctrl` | Any mode  | Indent node (works in both read and edit mode)  |
| `[`         | `cmd/ctrl` | Any mode  | Outdent node (works in both read and edit mode) |
| `Delete`    | -          | Read mode | Delete focused node                             |
| `Backspace` | `cmd/ctrl` | Any mode  | Delete focused node (works in readonly mode)    |

### Typing Behavior

- **Any letter/number/punctuation**: Enter edit mode and replace entire node
  content with typed character
- **Modifier keys** (`cmd+a`, `ctrl+c`, etc.): Execute command, don't enter edit
  mode

### Clipboard Commands

| Key | Modifier   | Action                |
| --- | ---------- | --------------------- |
| `c` | `cmd/ctrl` | Copy node as markdown |

### Universal Commands (Work in Both Read and Edit Mode)

| Key         | Modifier   | Action           |
| ----------- | ---------- | ---------------- |
| `]`         | `cmd/ctrl` | Indent node      |
| `[`         | `cmd/ctrl` | Outdent node     |
| `Backspace` | `cmd/ctrl` | Delete node      |
| `Enter`     | `cmd/ctrl` | Toggle edit mode |

## Edit Mode Behavior

### Entering Edit Mode

1. **Space key**: Preserves existing content, places cursor at end
2. **Typing character**: Replaces entire content with typed character
3. **cmd/ctrl+Enter**: Toggles into edit mode, selects all text

### Exiting Edit Mode

1. **Enter**: Save changes and exit
2. **cmd/ctrl+Enter**: Save changes and exit
3. **Escape**: Cancel changes and revert content
4. **Arrow keys at text boundaries**: Save and move focus

### In-Edit Navigation

- `↑` at first line: Exit edit mode and move to previous node
- `↓` at last line: Exit edit mode and move to next node
- `←` at beginning: Exit edit mode
- `→` at end: Exit edit mode

## Tree Operations

All tree operations maintain object references where possible and only create
new objects when necessary.

### Node Creation

- `createNewNodeAfter(node)`: Insert sibling after specified node
- `createChildNode(node)`: Insert as first child of specified node

### Node Manipulation

- `deleteNode(node)`: Remove node, promote children to parent level
- `indentNode(node)`: Make node a child of previous sibling
- `outdentNode(node)`: Move node up to parent's level

### Tree Integrity Rules

- Cannot delete root node
- Cannot indent first child (no previous sibling)
- Cannot outdent nodes already at root level
- Deleting a node with children promotes them to the parent level

## UI State Management

### Focus Management

- `focusedNode`: Currently selected node (has visual focus ring)
- Focus persists through tree operations
- Focus is automatically moved when deleting focused node

### Collapse/Expand

- `collapsedNodes`: Set of nodes that are visually collapsed
- Collapsed nodes hide their children in the UI
- Arrow keys can expand/collapse nodes

### Visual Indicators

- **Focus ring**: Shows currently focused node
- **Bullet points**: Indicate hierarchy level
- **Collapse icons**: Show expand/collapse state for nodes with children

## Event Handling

### Custom Events

- `ct-change`: Fired when tree content changes
  ```typescript
  detail: {
    value: Tree;
  }
  ```
- `charm-link-click`: Fired when clicking charm references
  ```typescript
  detail: { href: string, text: string, charm: CharmReference }
  ```

### Internal Event Flow

1. **Keyboard events**: Routed through different handlers based on mode
   - Read mode: `handleKeyDown()` → `executeKeyboardCommand()`
   - Edit mode: `handleEditorKeyDown()` → `handleNormalEditorKeyDown()`
2. **Tree mutations**: Operations modify tree in place, then `emitChange()` and
   `requestUpdate()`

## Testing Architecture

### Test Coverage

- **82 test cases** across 3 test files ensure comprehensive coverage
- **component-integration.test.ts**: End-to-end component behavior
- **ct-outliner-logic.test.ts**: Tree operations and business logic
- **keyboard-commands.test.ts**: Keyboard command execution

### Test Patterns

- Mutable tree operations are tested by checking direct node references
- Mock DOM environment for textarea and focus management
- Keyboard events are simulated with mock event objects

## Implementation Notes

### Mutable vs Immutable Design

Unlike most of the codebase, this component uses mutable tree operations for
performance and reference equality. This design choice enables:

- Consistent focus management (focused node references remain valid)
- Efficient tree operations (no object copying overhead)
- Simplified component logic (no tree reassignments needed)

### Performance Considerations

- Tree operations mutate in place - O(1) for most operations
- Node index caching using WeakMap for editor IDs
- Incremental DOM updates via Lit's change detection

### Browser Compatibility

- Uses modern JavaScript features (WeakMap, Set)
- Keyboard event handling works across platforms
- Focus management compatible with screen readers

## Future Enhancements

### Potential Features

- Drag and drop reordering
- Multi-node selection
- Undo/redo functionality
- Rich text formatting
- Import/export formats beyond markdown

### Extension Points

- `MentionableItem` interface for @ completion
- `Attachment` interface for file/charm references
- Custom keyboard command registration
- Theme/styling customization

## Migration Notes

This component underwent a major refactoring to:

1. **Simplify data structure**: Removed Node/Block separation, eliminated ID
   management
2. **Adopt mutable operations**: Changed from immutable tree transformations
3. **Fix keyboard regressions**: Restored all expected keyboard behaviors
4. **Improve test coverage**: Added comprehensive test suite to prevent future
   regressions

The refactoring maintains the same public API while improving internal
consistency and performance.
