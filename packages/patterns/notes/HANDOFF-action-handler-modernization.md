# Handoff: action() vs handler() Modernization

## Summary

This document captures the guidance updates and refactoring work needed to properly distinguish between `action()` and `handler()` in CommonTools patterns.

## Core Principle

**Prefer `action()` by default. Use `handler()` only when you need to bind different data to different handler instantiations.**

### When to use `action()`
- The handler is specific to this pattern
- It closes over pattern-scope variables (inputs, Writables, computeds, wish results)
- All instantiations use the same closed-over data
- Examples: button clicks, form submissions, modal open/close, state toggles

### When to use `handler()`
- You need different data bound per instantiation
- Common scenarios:
  - `.map()` loops where each item needs its own binding
  - Reusable handlers shared across multiple patterns
  - Cases where the same handler definition is called with different bindings in different places
- Examples: list item clicks, per-row actions in tables, delete buttons per item

## Part 1: Skill Guidance Updates

### Files to Update

1. **`.claude/skills/pattern-dev/SKILL.md`**
   - Add section on action vs handler choice
   - Emphasize action() as the default

2. **`.claude/skills/pattern-critic/SKILL.md`** (PRIORITY)
   - Add violation category for handler() misuse
   - Check for handlers that should be actions

### Proposed Additions to pattern-critic

Add new category "13. Action vs Handler Choice":

```markdown
### 13. Action vs Handler Choice

| Violation | Fix |
|-----------|-----|
| `handler()` at module scope not used in `.map()` or multi-binding scenario | Convert to `action()` inside pattern body |
| `handler()` when all instantiations use same data | Convert to `action()` |
| `action()` inside `.map()` creating new action per item | Use `handler()` at module scope with binding |

**Key Question:** Does this handler need different data bound to different instantiations?
- YES → Use `handler()` at module scope, bind with item-specific data
- NO → Use `action()` inside pattern body, close over what you need
```

### Proposed Additions to pattern-dev

Add to "Development Approach" section:

```markdown
## action() vs handler()

**Default to `action()`** - define inside pattern body, close over variables:
```typescript
const Note = pattern<Input, Output>(({ title, content }) => {
  const menuOpen = Writable.of(false);

  // Action closes over menuOpen - no binding needed
  const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));

  // Action closes over content - no binding needed
  const clearContent = action(() => content.set(""));

  return { /* ... */ };
});
```

**Use `handler()` only for per-item binding** (e.g., in `.map()`):
```typescript
// Module scope - will be bound with different items
const deleteItem = handler<void, { item: Writable<Item>; items: Writable<Item[]> }>(
  (_, { item, items }) => {
    const list = items.get();
    items.set(list.filter(i => i !== item));
  }
);

const List = pattern<Input, Output>(({ items }) => {
  return {
    [UI]: (
      <ul>
        {items.map((item) => (
          <li>
            {item.name}
            {/* Each item gets its own binding */}
            <button onClick={deleteItem({ item, items })}>Delete</button>
          </li>
        ))}
      </ul>
    ),
    items,
  };
});
```
```

## Part 2: notes-import-export.tsx Refactoring

### Current State
- 39 handlers defined at module scope
- ~6 handlers legitimately need per-item binding (used in `.map()`)
- ~33 handlers could be converted to actions

### Handlers That Should Remain as `handler()` (used in `.map()` or multi-binding)

| Handler | Reason |
|---------|--------|
| `toggleNoteCheckbox` | Per-row checkbox in notes table |
| `toggleNotebookCheckbox` | Per-row checkbox in notebooks table |
| `goToNote` | Per-row navigation in notes table |
| `goToNotebook` | Per-row navigation (used in multiple places) |
| `toggleNoteVisibility` | Per-row visibility toggle |
| `toggleNotebookVisibility` | Per-row visibility toggle |

### Handlers to Convert to `action()` (33 total)

These handlers don't need per-item binding and should be actions:

**Selection handlers:**
- `selectAllNotes`
- `deselectAllNotes`
- `selectAllNotebooks`
- `deselectAllNotebooks`

**Visibility bulk handlers:**
- `toggleAllNotesVisibility`
- `toggleAllNotebooksVisibility`

**CRUD operations:**
- `createNote`
- `_duplicateSelectedNotes`
- `deleteSelectedNotes`
- `cloneSelectedNotebooks`
- `duplicateSelectedNotebooks`

**Notebook operations:**
- `addToNotebook`
- `moveToNotebook`
- `confirmDeleteNotebooks`
- `deleteNotebooksOnly`
- `deleteNotebooksAndNotes`
- `cancelDeleteNotebooks`

**Standalone notebook modal:**
- `showStandaloneNotebookModal`
- `createStandaloneNotebookAndOpen`
- `createStandaloneNotebookAndContinue`
- `cancelStandaloneNotebookPrompt`

**New notebook prompt:**
- `createNotebookFromPrompt`
- `cancelNewNotebookPrompt`

**Export operations:**
- `openExportAllModal`
- `closeExportAllModal`
- `exportSelectedNotebooks`
- `closeExportNotebooksModal`

**Import operations:**
- `openImportModal`
- `closeImportModal`
- `_hidePasteSection`
- `analyzeImport`
- `handleImportFileUpload`
- `importSkipDuplicates`
- `importAllAsCopies`
- `cancelImport`

### Refactoring Approach

1. **Move handler definitions inside pattern body**
2. **Convert `handler<EventType, BindingsType>((event, bindings) => ...)` to `action((event?) => ...)`**
3. **Remove explicit bindings - close over pattern variables instead**
4. **Update call sites from `handlerName({ ...bindings })` to just `handlerName`**

### Example Conversion

**Before (handler at module scope):**
```typescript
const selectAllNotes = handler<
  void,
  { notes: Writable<NotePiece[]>; selectedNoteIndices: Writable<number[]> }
>((_, { notes, selectedNoteIndices }) => {
  selectedNoteIndices.set(notes.get().map((_, i) => i));
});

// In pattern body:
const bound = selectAllNotes({ notes, selectedNoteIndices });
// In JSX:
<ct-button onClick={bound}>Select All</ct-button>
```

**After (action in pattern body):**
```typescript
// In pattern body:
const selectAllNotes = action(() => {
  selectedNoteIndices.set(notes.get().map((_, i) => i));
});
// In JSX:
<ct-button onClick={selectAllNotes}>Select All</ct-button>
```

### Verification Steps

After refactoring:
1. `deno check notes/notes-import-export.tsx` - type check passes
2. Deploy locally and test:
   - Selection (select all, deselect all for notes and notebooks)
   - Visibility toggles (individual and bulk)
   - CRUD operations (create, duplicate, delete)
   - Import/export workflows
   - All modals open/close correctly

## Files Modified in This Session

- `packages/patterns/notes/note-md.tsx` - Converted goToEdit and handleCheckboxToggle to actions, kept handleBacklinkClick as handler (used in .map())

## Files to Modify (Future Work)

- `.claude/skills/pattern-dev/SKILL.md` - Add action vs handler guidance
- `.claude/skills/pattern-critic/SKILL.md` - Add violation category for handler misuse
- `packages/patterns/notes/notes-import-export.tsx` - Convert 33 handlers to actions

## Related Commits

- `e260e2486` - refactor(patterns): use void instead of Record<string, never> for handler event types
- `593403dd9` - refactor(patterns): modernize note-md.tsx with actions and better types
