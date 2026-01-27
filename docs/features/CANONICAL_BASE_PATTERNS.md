# Canonical Base Patterns Design

**Status:** Revised per Architect Feedback
**Date:** 2026-01-27
**Author:** Claude (with Alex & Berni)

---

## Executive Summary

Design a set of canonical base patterns using a **Container + Minimal Interface Types** approach:

- **Minimal Interface Types**: Simple TypeScript interfaces (`TaskLike`, `PersonLike`, `EventLike`)
- **N Variant Patterns**: Coherent, complete patterns that implement these interfaces (`family-member.tsx`, `potluck.tsx`)
- **Container Patterns**: Aggregate items matching a minimal interface, expose `addItem` handler
- **Collection Projections**: Add/remove entire collections to containers (e.g., "notebooks projected to tasks")

This is simpler than the annotation-based approach and directly addresses Tony's actual needs.

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Core Model** | Container + Minimal Interfaces | Simple, addresses actual needs |
| **Pattern Variants** | N coherent variants per type | "family-member", "employee" not "person + annotations" |
| **Type Identity** | Minimal interface conformance | TaskLike, PersonLike, EventLike |
| **Collections** | Projection-based | Add entire projections to containers, not individual items |
| **Annotations** | Demoted to edge case | Optional linked records if needed, not the primary model |

---

## Architecture Overview

### Core Concept: Container + Minimal Interface Types

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CONTAINER PATTERN                               │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ Minimal Interface Type: TaskLike { title: string, done: boolean }│
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  items: [                                                            │
│    ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│    │ TodoItem        │  │ ShoppingItem    │  │ ProjectTask     │   │
│    │ title: "..."    │  │ title: "..."    │  │ title: "..."    │   │
│    │ done: false     │  │ done: true      │  │ done: false     │   │
│    │ + priority      │  │ + quantity      │  │ + assignee      │   │
│    │ + notes         │  │ + aisle         │  │ + dueDate       │   │
│    └─────────────────┘  └─────────────────┘  └─────────────────┘   │
│  ]                                                                   │
│                                                                      │
│  addItem: Stream<{ item: TaskLike }>                                │
│  mentionable: [non-archived items...]                               │
└─────────────────────────────────────────────────────────────────────┘
```

Key properties:
- **Containers aggregate items matching a minimal interface**
- **Each variant is a coherent, complete UX** that can evolve independently
- **Containers expose `addItem` handler** for adding new items
- **Mentionable items** can be @-mentioned from container

---

## Minimal Interface Types

Define simple TypeScript interfaces that many patterns can implement:

```typescript
// packages/api/types/interfaces.ts

/** Minimal interface for task-like items */
export interface TaskLike {
  title: string;
  done: boolean;
}

/** Minimal interface for person-like items */
export interface PersonLike {
  name: string;
}

/** Minimal interface for event-like items */
export interface EventLike {
  title: string;
  date: string;    // ISO date
  time?: string;   // Optional time
}

/** Minimal interface for calendar-renderable items */
export interface CalendarItem {
  title: string;
  date: string;
  time?: string;
  duration?: number;  // minutes
}
```

---

## N Variant Patterns

Instead of one "person" pattern with annotations, create N coherent variants:

### Person Variants

| Pattern | Extra Fields | Use Case |
|---------|--------------|----------|
| `family-member.tsx` | birthday, dietary, gift preferences | Personal contacts |
| `employee.tsx` | department, role, start date, manager | Work contacts |
| `contact.tsx` | phone, email, address | Lightweight CRM |
| `friend.tsx` | interests, how we met, relationship notes | Social |

### Event Variants

| Pattern | Extra Fields | Use Case |
|---------|--------------|----------|
| `staff-meeting.tsx` | agenda, attendees, action items | Work |
| `potluck.tsx` | dishes, dietary needs, who's bringing what | Social |
| `kids-birthday.tsx` | theme, guest list, gifts, activities | Family |
| `appointment.tsx` | location, provider, confirmation | Personal |

### Task Variants

| Pattern | Extra Fields | Use Case |
|---------|--------------|----------|
| `todo-item.tsx` | priority, notes | General |
| `shopping-item.tsx` | quantity, aisle, store | Shopping |
| `project-task.tsx` | assignee, dueDate, project | Work |

Each variant:
1. **Is a complete, coherent UX** - not fragmented pieces
2. **Exports `NAME` and `[UI]`** - can be rendered standalone
3. **Implements relevant minimal interfaces** - can be used in containers
4. **Can evolve independently** - add features without affecting others

---

## Container Pattern Protocol

Containers aggregate items that match a minimal interface:

```typescript
// packages/patterns/container-protocol.ts

import type { Stream, Writable, VNode } from "commontools";

/**
 * What containers expect from their items
 */
export interface ContainerItem<T> {
  item: T;           // The actual item (matches minimal interface)
  name: string;      // Display name
  ui?: VNode;        // Optional inline UI
}

/**
 * What containers expose
 */
export interface ContainerProtocol<T> {
  items: Writable<ContainerItem<T>[]>;
  addItem: Stream<{ item: T }>;
  removeItem: Stream<{ item: T }>;
  mentionable: unknown[];  // Items that can be @-mentioned
}
```

---

## Example: Task Container

```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, action, computed } from "commontools";
import type { TaskLike, ContainerItem } from "commontools";

interface Input {
  title?: string;
  items?: Writable<ContainerItem<TaskLike>[]>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: ContainerItem<TaskLike>[];
  addItem: Stream<{ item: TaskLike }>;
  mentionable: unknown[];
}

export default pattern<Input, Output>(({ title, items }) => {
  const data = items ?? Writable.of<ContainerItem<TaskLike>[]>([]);

  const addItem = action(({ item }: { item: TaskLike }) => {
    data.push({
      item,
      name: item.title,
    });
  });

  return {
    [NAME]: computed(() => title ?? "Tasks"),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="sm">
          {data.map(entry => (
            <ct-card>
              <ct-hstack gap="sm" align="center">
                <ct-checkbox $checked={entry.item.done} />
                <span>{entry.name}</span>
              </ct-hstack>
            </ct-card>
          ))}
        </ct-vstack>
      </ct-screen>
    ),
    items: data,
    addItem,
    mentionable: computed(() =>
      data.get().filter(e => !e.item.done).map(e => e.item)
    ),
  };
});
```

---

## Example: Family Member Variant

A complete, coherent person variant:

```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, Default, computed } from "commontools";
import type { PersonLike } from "commontools";

export interface FamilyMember extends PersonLike {
  name: string;
  relationship: string;           // "spouse", "child", "parent", etc.
  birthday?: string;              // ISO date
  dietaryRestrictions?: string[];
  giftPreferences?: string[];
  notes?: string;
}

interface Input {
  member?: Writable<FamilyMember>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  member: FamilyMember;
}

export default pattern<Input, Output>(({ member }) => {
  const data = member ?? Writable.of<FamilyMember>({
    name: "",
    relationship: "",
  });

  return {
    [NAME]: computed(() => `👨‍👩‍👧 ${data.name || "Family Member"}`),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="md">
          <ct-input $value={data.key("name")} placeholder="Name" />
          <ct-picker
            $value={data.key("relationship")}
            options={["spouse", "child", "parent", "sibling", "grandparent"]}
          />
          <ct-input $value={data.key("birthday")} type="date" placeholder="Birthday" />
          <ct-tags tags={data.key("dietaryRestrictions")} placeholder="Dietary restrictions" />
          <ct-tags tags={data.key("giftPreferences")} placeholder="Gift ideas" />
          <ct-textarea $value={data.key("notes")} placeholder="Notes..." />
        </ct-vstack>
      </ct-screen>
    ),
    member: data,
  };
});
```

---

## Collection Projections

For "show me all X in space" queries, create **collection projections**:

```typescript
/// <cts-enable />
import { pattern, computed } from "commontools";
import type { TaskLike } from "commontools";

interface Notebook {
  title: string;
  items: Array<{ title: string; completed?: boolean }>;
}

interface Input {
  notebooks: Notebook[];
}

interface Output {
  tasks: TaskLike[];  // Notebooks projected as tasks
}

// Project notebook items to TaskLike interface
export default pattern<Input, Output>(({ notebooks }) => {
  const tasks = computed(() => {
    return notebooks.flatMap(nb =>
      nb.items.map(item => ({
        title: `${nb.title}: ${item.title}`,
        done: item.completed ?? false,
      }))
    );
  });

  return { tasks };
});
```

**Containers can add entire projections:**

```typescript
// In a task container, add "notebooks projected as tasks"
const notebookTasks = NotebooksAsTasks({ notebooks });
taskContainer.addCollection.send({ projection: notebookTasks });
```

This enables:
- Add/remove **entire collections** to containers
- Higher quality because the process is aware of what it processes
- Works for birthdays → calendar, notebook checkboxes → tasks, etc.

---

## Tony's Needs - Addressed

The architect clarified Tony's actual pattern needs:

| Need | Solution |
|------|----------|
| Task list with tasks | Container pattern for `TaskLike` |
| Calendar with events | Container pattern for `EventLike`/`CalendarItem` |
| Tasks/events can be different shapes | N variant patterns that implement the interface |
| Create new items | `addItem` handler on container |
| Mentionable items | `mentionable` output on container |

**Implementation recipe:**
1. Define TypeScript type for minimal interface: `{ done: boolean, title: string }`
2. Define N patterns that have at least that, but expand into other shapes
3. Patterns output `NAME` and `[UI]`
4. Container pattern lists them, exposes `addItem` handler
5. Add mentionable items to container's `mentionable` output

---

## Annotations (Demoted)

The annotation system is demoted to an **optional edge case mechanism**:

**When you might need it:**
- Started with an entity one way, later decided it's also another kind
- Entity reconciliation: multiple instances that should be the same entity
- Complementary data from different sources

**If needed, use simple linked records:**

```typescript
interface LinkedRecord<T> {
  primary: CellRef;        // The main record this augments
  data: T;                 // Complementary data
  relationship: string;    // e.g., "augments", "extends"
}
```

This is NOT the primary model. Most cases are better served by:
- Creating a new variant pattern
- Using collection projections
- Designing the original pattern to include the fields

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `packages/api/types/interfaces.ts` | New: Minimal interface types |
| `packages/patterns/container-protocol.ts` | Revise for minimal interfaces |
| `packages/patterns/variants/` | New: Variant patterns directory |
| `packages/patterns/containers/` | New: Container patterns directory |

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Define minimal interface types (`TaskLike`, `PersonLike`, `EventLike`)
- [ ] Export from "commontools" entrypoint
- [ ] Revise container-protocol.ts

### Phase 2: First Container + Variants
- [ ] `task-container.tsx` - Container for TaskLike
- [ ] `todo-item.tsx` - Basic task variant
- [ ] `shopping-item.tsx` - Shopping task variant

### Phase 3: Person Variants
- [ ] `family-member.tsx` - With birthday, dietary, gifts
- [ ] `contact.tsx` - Lightweight CRM
- [ ] `employee.tsx` - Work contacts

### Phase 4: Event Variants
- [ ] `potluck.tsx` - Social event with dishes
- [ ] `staff-meeting.tsx` - Work event with agenda
- [ ] `kids-birthday.tsx` - Family event with guests

### Phase 5: Collection Projections
- [ ] `notebooks-as-tasks.tsx` - Example projection
- [ ] Container `addCollection` handler
- [ ] Calendar integration with event projections

### Phase 6 (If Needed): Linked Records
- [ ] Simple linked record mechanism for edge cases
- [ ] Entity reconciliation patterns

---

## Verification Plan

### Container Protocol
1. **Test addItem**: Add task to container, verify it appears
2. **Test variant compatibility**: Add different TaskLike variants to same container
3. **Test mentionable**: Verify non-archived items appear in mentionable

### Variant Patterns
4. **Test family-member.tsx**: Create, edit, verify all fields work
5. **Test interface conformance**: Verify variant can be added to container

### Collection Projections
6. **Test notebook → tasks**: Project notebooks, verify TaskLike output
7. **Test add projection to container**: Add entire projection, verify items appear

### Integration
8. **Manual test**: Create task container, add various task variants
9. **Manual test**: Create calendar, add event variants and projections

---

## Questions for Architect (Berni)

### Addressed by Revision

1. ~~Over-engineering~~ → Simplified to Container + Minimal Interfaces
2. ~~Annotation complexity~~ → Demoted to optional edge case
3. ~~Tony's needs~~ → Directly addressed with container protocol

### Still Open

1. **Interface location**: Should minimal interfaces live in `packages/api/types/` or elsewhere?

2. **Container registration**: How do containers discover available variant patterns?

3. **Projection mechanics**: Pull vs push? Who creates projections? Should they point back to original?

4. **Entity reconciliation**: When multiple instances should be the same entity, what's the resolution pattern?

---

## Appendix: What Changed from v1

| Original Design | Revised Design | Rationale |
|----------------|----------------|-----------|
| `[ANNOTATIONS]` array | Demoted to edge case | Over-engineering |
| `[ANNOTATES]` back-reference | Removed | Not needed |
| `[ANNOTATION_SOURCE]` provenance | Removed | Over-engineering |
| Computed annotation adapters | Removed | Collection projections are simpler |
| Three-class annotation model | Removed | Too complex |
| Single "person" + annotations | N variant patterns | Coherent UX per variant |

---

## Appendix: Research Sources

- **Architect feedback**: Discord messages (2026-01-27)
- **Container protocol**: `packages/patterns/container-protocol.ts`
- **Existing patterns**: `packages/patterns/contacts/`, `packages/patterns/todo-list/`
