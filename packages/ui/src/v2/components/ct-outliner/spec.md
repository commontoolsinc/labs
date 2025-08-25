# CT Outliner Component Specification

## Overview

The `ct-outliner` is a hierarchical tree-based outliner component built with Lit
that provides keyboard-driven navigation and editing capabilities. It uses a
Cell-based reactive data structure with proper link resolution support.

## Data Structure

### Node Interface

```typescript
interface Node {
  body: string; // Text content of the node
  children: Node[]; // Child nodes
  attachments: Attachment[]; // File/charm attachments
  [ID]: string; // Required for Cell array operations
}
```

### Tree Interface

```typescript
interface Tree {
  root: Node; // Root node (typically has empty body)
}
```

**Key Design Decision**: The component uses CommonTools' Cell reactive data
structure. All nodes must have `[ID]` properties to work correctly with Cell
array operations. The component properly uses `.getAsQueryResult()` for reading
data to ensure link resolution works correctly.

## Component Properties

- `value: Cell<Tree>` - The reactive tree data structure
- `readonly: boolean` - Whether editing is disabled
- `mentionable: MentionableItem[]` - Items available for @ mentions
- `tree: Tree` (getter) - Current tree value from Cell
- `focusedNodePath: number[] | null` - Path to currently focused node
- `collapsedNodePaths: Set<string>` - Paths to collapsed nodes

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

All tree operations use path-based APIs and return TreeOperationResult with
diffs describing what changed. Operations properly use Cell's transactional
updates and `.getAsQueryResult()` for link resolution.

### Node Creation

- `createNodeAfterPath(path)`: Insert sibling after specified path
- `createChildNodeAtPath(path)`: Insert as first child at specified path

### Node Manipulation

- `deleteNodeByPath(path)`: Remove node, promote children to parent level
- `indentNodeByPath(path)`: Make node a child of previous sibling
- `outdentNodeByPath(path)`: Move node up to parent's level
- `moveNodeUpByPath(path)`: Move node up among siblings
- `moveNodeDownByPath(path)`: Move node down among siblings

### Tree Integrity Rules

- Cannot delete root node
- Cannot indent first child (no previous sibling)
- Cannot outdent nodes already at root level
- Deleting a node with children promotes them to the parent level

## UI State Management

### Focus Management

- `focusedNodePath`: Path to currently selected node (has visual focus ring)
- Focus persists through tree operations using path-based tracking
- Focus is automatically moved when deleting focused node

### Collapse/Expand

- `collapsedNodePaths`: Set of node paths that are visually collapsed
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
  detail: { href: string, text: string, charm: Charm }
  ```

### Internal Event Flow

1. **Keyboard events**: Routed through different handlers based on mode
   - Read mode: `handleKeyDown()` → `executePathBasedKeyboardCommand()`
   - Edit mode: `handleEditorKeyDown()` → `handleNormalEditorKeyDown()`
2. **Tree mutations**: Operations use Cell transactions, automatic reactivity
   triggers updates without manual `emitChange()` calls

## Testing Architecture

### Test Coverage

- **92 test cases** across 6 test files ensure comprehensive coverage
- **component-integration.test.ts**: End-to-end component behavior
- **ct-outliner-logic.test.ts**: Tree operations and business logic
- **keyboard-commands.test.ts**: Keyboard command execution
- **ct-outliner-indent.test.ts**: Indentation operations
- **ct-outliner-path.test.ts**: Path-based node navigation
- **link-resolution.test.ts**: Cell link resolution behavior

### Test Patterns

- Cell-based operations tested with real Runtime instances
- Mock DOM environment for textarea and focus management
- Keyboard events are simulated with mock event objects
- Link resolution tested with scenarios involving Cell references

## Implementation Notes

### Cell-based Reactive Design

The component uses CommonTools' Cell reactive data structure for automatic
change propagation and link resolution:

- All nodes must have `[ID]` properties for Cell array operations
- Uses `.getAsQueryResult()` for reading data to resolve links
- Uses `mutateCell()` for safe mutations within transactions
- Path-based operations avoid node reference issues

### Performance Considerations

- Tree operations use Cell transactions for consistency
- Path-based tracking avoids stale node references
- Incremental DOM updates via Lit's change detection
- Automatic reactivity through Cell subscriptions

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

This component underwent major refactoring to:

1. **Fix Cell API usage**: Properly use `.getAsQueryResult()` for link
   resolution
2. **Add [ID] properties**: All nodes now have required IDs for Cell operations
3. **Path-based operations**: Moved from node references to path-based tracking
4. **Comprehensive testing**: Added link resolution tests and improved coverage

Recent fixes (December 2024):

- Fixed all `.get()` calls to use `.getAsQueryResult()` for proper link
  resolution
- Added type casting for Charm[] in attachment rendering
- Removed unused debug files and utilities
- Updated to follow Cell API best practices
