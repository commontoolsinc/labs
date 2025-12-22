# Kanban Board Roadmap

## Current State (v0.1)

A functional kanban board with:
- Columns with nested cards
- Add/remove cards and columns
- Move cards between columns (← → buttons)
- Reactive computed stats (totalCards, cardCounts)
- CLI-compatible handlers for cross-charm integration

**Known Limitations:**
- No inline editing (must delete and recreate cards)
- No drag-and-drop (button-based movement only)
- No visual differentiation between cards
- No persistence of card order within columns (new cards append to end)

---

## Development Phases

### Phase 1: Card Editing (High Priority)

**Goal:** Make cards actually editable without delete/recreate workflow.

**Features:**
1. **Inline title editing** - Click to edit card title in place
   - Use `$value` binding on a `ct-input` that appears on click
   - Or always-visible `ct-textarea` with subtle styling

2. **Expandable card detail view** - Click card to see/edit full details
   - Description field (multiline)
   - Created date (auto-set)
   - Could be a modal or inline expansion

3. **Column title editing** - Rename columns inline

**Technical Approach:**
- Add `editing` state per card (or track single `editingCardId`)
- Use `ifElse()` to switch between display and edit modes
- Consider: should edits be immediate (bidirectional binding) or require save?

**Schema Changes:**
```typescript
interface Card {
  id: string;
  title: string;
  description: Default<string, "">;
  createdAt: Default<number, 0>;  // timestamp
}
```

---

### Phase 2: Visual Organization (High Priority)

**Goal:** Let users visually distinguish and categorize cards.

**Features:**
1. **Labels/Tags**
   - Predefined colors (red, orange, yellow, green, blue, purple)
   - Optional text labels
   - Multiple labels per card
   - Visual: colored pills/badges on card

2. **Priority Indicators**
   - High / Medium / Low (or 1-5 scale)
   - Visual: colored left border, icon, or background tint

3. **Due Dates**
   - Date picker for setting due date
   - Visual states: overdue (red), due soon (yellow), upcoming (normal)
   - Computed `isOverdue`, `isDueSoon` for styling

**Schema Changes:**
```typescript
type Priority = "high" | "medium" | "low";

interface Label {
  id: string;
  name: string;
  color: string;  // hex or named color
}

interface Card {
  id: string;
  title: string;
  description: Default<string, "">;
  priority: Default<Priority, "medium">;
  dueDate: Default<string | null, null>;  // ISO date string
  labels: Default<Label[], []>;
  createdAt: Default<number, 0>;
}

// Board-level label definitions
interface State {
  columns: Cell<Column[]>;
  availableLabels: Cell<Default<Label[], [
    { id: "bug", name: "Bug", color: "#ef4444" },
    { id: "feature", name: "Feature", color: "#3b82f6" },
    { id: "urgent", name: "Urgent", color: "#f97316" },
  ]>>;
}
```

**Computed Derivations:**
```typescript
const overdueCards = computed(() =>
  allCards.filter(c => c.dueDate && new Date(c.dueDate) < today)
);

const cardsByPriority = computed(() => ({
  high: allCards.filter(c => c.priority === "high"),
  medium: allCards.filter(c => c.priority === "medium"),
  low: allCards.filter(c => c.priority === "low"),
}));
```

---

### Phase 3: Drag and Drop (Very High UX Impact)

**Goal:** Enable the intuitive drag-and-drop interaction users expect from kanban.

**Challenges:**
- CommonTools doesn't have native DnD primitives
- Need to manage drag state across reactive boundaries
- Touch support for mobile

**Approach Options:**

**Option A: HTML5 Drag and Drop**
- Use native `draggable`, `ondragstart`, `ondragover`, `ondrop`
- Manage `draggingCardId` and `dropTargetColumnId` in cells
- Pros: No external dependencies
- Cons: Finicky API, limited mobile support

**Option B: Pointer-based Custom Implementation**
- Track `onpointerdown`, `onpointermove`, `onpointerup`
- Create visual drag preview element
- Calculate drop zones based on pointer position
- Pros: Full control, works on touch
- Cons: More complex implementation

**Option C: Simplified "Pick and Place"**
- Click card to "pick it up" (highlight it)
- Click column or position to "place" it
- Pros: Simple, accessible, touch-friendly
- Cons: Less intuitive than true DnD

**Recommended:** Start with Option C (pick-and-place) as an intermediate step, then implement Option A or B for true DnD.

**State for DnD:**
```typescript
const dragState = Cell.of<{
  cardId: string | null;
  fromColumnId: string | null;
} | null>(null);
```

**Also Enable:**
- Card reordering WITHIN columns (not just between)
- Column reordering (drag columns left/right)

---

### Phase 4: Productivity Features (Medium Priority)

**Goal:** Add features that make the board useful for real work.

**Features:**

1. **Search/Filter**
   - Text search across card titles and descriptions
   - Filter by label, priority, due date status
   - Computed `filteredColumns` based on active filters

2. **WIP Limits (Work In Progress)**
   - Set max cards per column
   - Visual warning when limit exceeded
   - Core kanban methodology feature

3. **Checklists/Subtasks**
   - Cards can have a list of checkable items
   - Progress indicator on card (e.g., "3/5 done")

4. **Archive**
   - Move completed cards to archive instead of delete
   - View archived cards separately
   - Restore from archive

**Schema Additions:**
```typescript
interface ChecklistItem {
  id: string;
  text: string;
  done: Default<boolean, false>;
}

interface Card {
  // ... existing fields
  checklist: Default<ChecklistItem[], []>;
  archived: Default<boolean, false>;
}

interface Column {
  // ... existing fields
  wipLimit: Default<number | null, null>;  // null = no limit
}
```

---

### Phase 5: Polish & Power Features (Lower Priority)

**Goal:** Refine the experience for power users.

**Features:**

1. **Keyboard Shortcuts**
   - `n` - New card in focused column
   - `e` - Edit focused card
   - `←` `→` - Move focused card
   - `Delete` - Delete focused card
   - `/` - Focus search

2. **Column Collapse**
   - Minimize columns to just header
   - Useful for focusing on specific workflow stages

3. **Card Quick Actions**
   - Hover menu for common actions
   - Right-click context menu

4. **Board Templates**
   - "Basic Kanban" (To Do, Doing, Done)
   - "Sprint Board" (Backlog, Sprint, In Progress, Review, Done)
   - "Bug Triage" (New, Confirmed, In Progress, Fixed, Closed)

5. **Multiple Views**
   - Board view (current)
   - List view (all cards in filterable table)
   - Calendar view (cards by due date)

---

## Technical Considerations

### Pattern Composition Strategy

As complexity grows, consider splitting into sub-patterns:
```
kanban-board/
├── main.tsx           # Composes sub-patterns, owns main state
├── schemas.tsx        # Shared types
├── column.tsx         # Single column component
├── card.tsx           # Single card component
├── card-detail.tsx    # Expanded card edit view
├── filters.tsx        # Search/filter controls
└── ROADMAP.md
```

### State Management

For complex features like DnD and multi-select:
- Keep UI state (dragging, editing, selected) in local `Cell.of()`
- Keep data state (cards, columns) in pattern inputs
- Use handlers for data mutations, inline handlers for UI state

### Performance

For boards with many cards (100+):
- Consider virtualization for long column card lists
- Memoize expensive computed derivations
- Lazy-load card details

---

## Suggested Implementation Order

1. **Card inline editing** - Immediate usability win
2. **Labels with colors** - Visual differentiation
3. **Due dates** - Time-based organization
4. **Pick-and-place movement** - Better UX than buttons
5. **Search** - Find cards quickly
6. **True drag-and-drop** - Polish the interaction
7. **WIP limits** - Kanban methodology
8. **Checklists** - Subtask tracking

---

## Questions to Resolve

1. **Modal vs inline for card details?**
   - Modal: cleaner, focused editing experience
   - Inline: faster, no context switch

2. **Where to store label definitions?**
   - Board-level (current cards reference by ID)
   - Card-level (each card has full label objects)
   - Trade-off: consistency vs. simplicity

3. **How to handle card ordering within columns?**
   - Current: array position (implicit)
   - Alternative: explicit `order` field (enables non-sequential inserts)

4. **Multi-board support?**
   - Current scope: single board
   - Future: board selector, multiple boards in one charm

---

## Session Notes

**Bugs Fixed (2024-12-19):**
- `Cell.equals(c, column)` doesn't work for comparing OpaqueRef to plain objects
- Fix: Use `c.id === column.id` for lookups in inline handlers
- Local `Cell.of()` state can get corrupted with `setsrc` iterations; fresh deploys are cleaner

**Patterns Learned:**
- Define handlers with `handler()` for CLI compatibility
- Use string ID comparison in inline handlers, not `Cell.equals()` across contexts
- `computed()` requires `.get()` when iterating over `Cell<T[]>`
