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
| **Customization** | Fork-and-pull model | Users fork patterns, LLM helps merge features |
| **Identity** | Reconciliation over annotation | Same entity in different contexts = linking problem |

---

## Governing Principles

These principles guide how the pattern ecosystem evolves and how users customize their experience.

### 1. Schelling Points for Interoperability

A **schelling point** is something people converge on naturally without explicit agreement.

**Principle:** The ecosystem needs common reference points that everyone uses, enabling patterns to interoperate without central coordination.

```typescript
// The schelling point - minimal, stable, universal
export interface PersonLike {
  name: string;  // Just this. Everyone can agree on this.
}

// Everything else is optional variance
interface FamilyMember extends PersonLike {
  name: string;              // core preserved
  relationship: string;      // added
  birthday?: string;         // added
  dietaryRestrictions?: string[];  // added
}
```

**Key insight:** The schelling point must be **minimal enough that everyone can adopt it** but **meaningful enough to enable interoperability**. A single field (`name`) is often sufficient.

### 2. Fork-and-Pull for Customization

**Principle:** Users customize by forking patterns, not by annotating a single canonical pattern.

**The tension:**
- Super-organizer wants: comprehensive `friend.tsx` with dietary preferences, alma mater, gift ideas
- Anti-organizer wants: minimal `friend.tsx` with just name
- Both are valid - no single pattern serves both

**The solution:** Users fork the base pattern to create their own variants:

```
┌────────────┐
│ base/      │  Schelling point (minimal, stable)
│ person.tsx │
└────────────┘
      │
 ┌────┴────┬────────────┬────────────┐
 ▼         ▼            ▼            ▼
┌──────┐ ┌──────┐  ┌──────────┐  ┌──────────┐
│alice/│ │bob/  │  │claire/   │  │diane/    │
│friend│ │friend│  │colleague │  │contact   │
│(rich)│ │(min) │  │(work)    │  │(basic)   │
└──────┘ └──────┘  └──────────┘  └──────────┘
```

**Feature adoption via LLM:**
> "I like how Claire's colleague pattern has the 'project history' field. Add that to my friend pattern."

The LLM analyzes both patterns, extracts the feature, and merges it while preserving core schema.

### 3. Core Schema Preservation

**Principle:** Variants can add anything, but must preserve the core schema fields.

This is the contract that enables the ecosystem:
- A `friend.tsx` with `{ name, birthday, dietary }` still satisfies `PersonLike`
- Containers aggregating `PersonLike` items work with ALL variants
- Breaking the core schema breaks interoperability

```typescript
// VALID: extends core
interface DetailedFriend extends PersonLike {
  name: string;        // ✓ core preserved
  birthday: string;    // added
  interests: string[]; // added
}

// INVALID: breaks core
interface BrokenFriend {
  nickname: string;    // ✗ renamed 'name' - breaks contract
}
```

### 4. Reconciliation Over Annotation

**Principle:** When the same entity exists in multiple contexts, the problem is **reconciliation** (identity linking), not annotation.

**Scenario:**
- `contractor.tsx` (work): `{ name: "John Smith", rate: 150, company: "Acme" }`
- `friend.tsx` (personal): `{ name: "John Smith", birthday: "1985-03-15" }`

These are the **same person** in two different views. The challenge is linking them.

**Reframe:** From this angle, annotations are actually **identity pointers**:
- `SSNPerson.tsx` = name + SSN + **pointer to the entity it identifies**
- It's not about extensibility, it's about identity linking
- Multiple records with complementary data, linked by identity

---

## The Reconciliation Problem

### Why It Matters

Without reconciliation:
- Calendar shows "meeting with John Smith" but doesn't know his birthday is tomorrow
- Contact search returns two "John Smith" entries
- Gift preferences live in one place, work availability in another

With reconciliation:
- System knows these are the same entity
- Can combine information across contexts
- Can present unified view when needed

### Identity Linking Mechanism

```typescript
// Identity link - connects two entities as "the same thing"
interface IdentityLink {
  entity1: CellRef;
  entity2: CellRef;

  // How we know they're the same
  evidence: {
    type: 'user-asserted' | 'email-match' | 'phone-match' | 'llm-inferred';
    confidence: number;  // 0-1
    details?: string;
  };
}
```

**Example:**
```typescript
// User explicitly links contractor and friend records
createIdentityLink({
  entity1: contractorJohn,
  entity2: friendJohn,
  evidence: {
    type: 'user-asserted',
    confidence: 1.0,
    details: "Same person - John from Acme is also my friend John"
  }
});
```

### Open Questions

1. **Storage**: Where do identity links live? Separate entities? Fields on both?
2. **Merged views**: How do we present a unified view of linked entities?
3. **Conflicts**: What if `contractor.phone !== friend.phone`?
4. **Transitivity**: If A=B and B=C, does A=C automatically?

---

## Folksonomy Growth

The ecosystem evolves organically through usage, not top-down design.

### How It Works

```
Time 0: Base patterns exist
┌──────────┐ ┌──────────┐ ┌──────────┐
│PersonLike│ │ TaskLike │ │EventLike │
└──────────┘ └──────────┘ └──────────┘

Time 1: Early adopters fork
┌──────────┐ ┌──────────┐ ┌──────────┐
│friend    │ │colleague │ │shopping  │
│(5 users) │ │(3 users) │ │(8 users) │
└──────────┘ └──────────┘ └──────────┘

Time 2: Features spread through adoption
friend gains "birthday" from 40% of forks
shopping gains "aisle" from 60% of forks

Time 3: De facto standards emerge
"friend with birthday" becomes common expectation
This is now a new schelling point
```

### Emergent Schelling Points

Initial: `PersonLike { name: string }`

Emergent (from usage):
```typescript
// Most friend patterns have birthday - it becomes expected
interface FriendLike extends PersonLike {
  name: string;
  birthday?: string;  // emerged from usage
}
```

The system doesn't mandate this - it emerges from what people actually do.

### Discovery & Adoption

For folksonomy to work, users need to discover what others have done:
- Browse popular forks
- See common fields across variants
- LLM suggests: "80% of friend patterns have birthday, want to add it?"

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

## Annotations Reframed: Just More Records

The original annotation design makes sense when viewed from a different angle: **it's the same schema, just approached differently.**

### The Key Insight

`SSNPerson.tsx` isn't "an annotation that attaches TO a person." It IS a person record:

| Old Framing | New Framing |
|-------------|-------------|
| SSNPerson is an annotation | SSNPerson is a PersonLike record |
| It attaches TO the "real" person | It IS a person, just minimal |
| Special annotation system needed | Just records + reconciliation |

Both `FamilyMember` and `SSNPerson` satisfy `PersonLike { name }`:

```
┌─────────────────────┐         ┌─────────────────────┐
│ FamilyMember        │         │ SSNPerson           │
│ (PersonLike)        │         │ (PersonLike)        │
│                     │         │                     │
│ name: "John Smith"  │   ←─→   │ name: "John Smith"  │
│ birthday: "1985-03" │ reconcile│ ssn: "123-45-6789" │
│ dietary: ["vegan"]  │         │                     │
│ gifts: ["books"]    │         │ (that's it - just   │
│ notes: "..."        │         │  name and SSN)      │
└─────────────────────┘         └─────────────────────┘

Both are just PersonLike records with different fields.
They get RECONCILED as the same entity, not annotated.
```

### Why This Matters

**No special annotation system needed.** Everything is just:
1. Records that satisfy a minimal interface
2. Some records have many fields, some have few
3. Records about the same entity get linked via reconciliation

The SSNPerson pattern exists because:
- Maybe SSN data lives in a separate security context
- Maybe it was imported from a different system
- Maybe someone created it before you had the full person record

It's not subordinate to a "real" person - it IS a person record, just a sparse one.

### When You'd Have Sparse Records

```typescript
// SSNPerson - a minimal person record with just identity info
interface SSNPerson extends PersonLike {
  name: string;       // satisfies PersonLike
  ssn: string;        // the only extra field
}

// ImportedContact - from an email import, sparse data
interface ImportedContact extends PersonLike {
  name: string;       // satisfies PersonLike
  email: string;      // all we got from the import
  importSource: string;
}

// These reconcile with your rich FamilyMember record
// No annotation system - just records + identity linking
```

**Use cases for sparse records:**
- Sensitive data separation (SSN in its own record)
- Import reconciliation (imported contact with minimal data)
- Cross-context linking (work contractor, personal friend)
- Incremental data collection (start sparse, add fields over time)

### Not the Primary Model

For most cases, prefer:
1. **Forking a variant pattern** - add the fields you need upfront
2. **Using collection projections** - transform data as needed
3. **Rich records** - include fields in the original pattern

Sparse records + reconciliation are for:
- Same entity appearing in different contexts
- Data from different sources/imports
- Security separation of sensitive fields

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

### Phase 6: Fork-and-Pull Infrastructure
- [ ] Pattern forking capability
- [ ] Schema comparison (does fork satisfy base?)
- [ ] LLM-assisted feature merging between forks

### Phase 7: Identity & Reconciliation
- [ ] Identity link pattern
- [ ] Reconciliation UI (link two entities as same)
- [ ] Unified view generation for linked entities
- [ ] Conflict detection and resolution

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
2. ~~Annotation complexity~~ → Reframed as identity linking
3. ~~Tony's needs~~ → Directly addressed with container protocol
4. ~~Customization tension~~ → Fork-and-pull model

### Still Open

1. **Interface location**: Should minimal interfaces live in `packages/api/types/` or elsewhere?

2. **Container registration**: How do containers discover available variant patterns?

3. **Projection mechanics**: Pull vs push? Who creates projections? Should they point back to original?

4. **Identity link storage**: Where do identity links live? Separate entities? Bidirectional fields?

5. **Fork mechanics**: How do users actually fork a pattern? UI? CLI? LLM-generated?

6. **Schema validation**: How do we verify a fork still satisfies the base interface?

7. **Conflict resolution**: When linked entities have conflicting values, what's the UX?

---

## Appendix: What Changed from v1

| Original Design | Revised Design | Rationale |
|----------------|----------------|-----------|
| `[ANNOTATIONS]` array | Reframed as identity pointers | Not extensibility, it's reconciliation |
| `[ANNOTATES]` back-reference | Identity links | Clearer mental model |
| `[ANNOTATION_SOURCE]` provenance | Removed | Over-engineering |
| Computed annotation adapters | Removed | Collection projections are simpler |
| Three-class annotation model | Removed | Too complex |
| Single "person" + annotations | N variant patterns via fork | Coherent UX per variant |
| Central pattern definition | Fork-and-pull model | Organic ecosystem growth |
| — | Schelling points | Interoperability without coordination |
| — | Reconciliation problem | Same entity, different contexts |
| — | Folksonomy growth | Features spread through adoption |

---

## Appendix: Research Sources

- **Architect feedback (v1)**: Discord messages (2026-01-27, morning)
- **Architect feedback (v2)**: Live conversation (2026-01-27, afternoon) - fork-and-pull, reconciliation
- **Container protocol**: `packages/patterns/container-protocol.ts`
- **Existing patterns**: `packages/patterns/contacts/`, `packages/patterns/todo-list/`
- **Template registry**: `packages/patterns/record/template-registry.ts` - existing fork model
- **Module registry**: `packages/patterns/record/registry.ts` - composable modules
