# Canonical Base Patterns Design

**Status:** Revised per Architect Feedback (v4 - Record-Level Upgrade)
**Date:** 2026-01-27
**Author:** Claude (with Alex & Berni)

---

## Executive Summary

Design a set of canonical base patterns using a **Container + Minimal Interface Types + Record-Level Upgrade** approach:

- **Minimal Interface Types**: Simple TypeScript interfaces (`TaskLike`, `PersonLike`, `EventLike`)
- **Container Patterns**: Manage items and list available patterns in "Add" menu (no forking)
- **Record-Level Upgrade**: Fork happens when viewing an individual record and needing more fields
- **compileAndRun Integration**: Use existing builtin to dynamically compile forked patterns
- **Lists of Lists**: Containers can include other containers (e.g., Contacts includes AutoImportedGoogleContacts)
- **Duplication as Edge Case**: Handle same-person-different-context with simple `sameAs`, not complex reconciliation

The core insight: **fork-on-demand happens on individual records, not from the container's add dropdown**. Container lists patterns; records offer upgrade options.

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Core Model** | Container + Minimal Interfaces + Record-Level Upgrade | Simple, emergent, addresses actual needs |
| **Container Role** | Manager + Pattern Listing | Container lists PersonLike patterns in "Add" menu (no forking) |
| **Fork Location** | Individual record "Upgrade" menu | Fork when viewing a record and needing more fields |
| **Fork Mechanism** | compileAndRun builtin | Dynamically compile forked pattern, replace record in-place |
| **Type Identity** | Minimal interface conformance | TaskLike, PersonLike, EventLike |
| **Nesting** | Lists of lists | Contacts can include AutoImportedGoogleContacts as a sub-list |
| **Duplication** | Simple `sameAs` field | Treat duplicates as edge case, not core concern |
| **Customization** | Record upgrade + fork | When you need "contractor with billing fields", upgrade the record |

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

### 2. Fork-on-Demand (Not Pre-Designed Variants)

**Principle:** Don't pre-design N variant patterns. Fork and modify when you actually need a new type.

**The old approach (too prescriptive):**
```
Pre-define: family-member.tsx, employee.tsx, contact.tsx, friend.tsx
User picks from catalog
```

**The new approach (emergent):**
```
1. User has a Contacts container
2. User needs to track a contractor with billing fields
3. User forks an existing PersonLike pattern
4. User (or LLM) adds the fields they need right then
5. New "contractor" pattern is created just-in-time
```

**Container lists available patterns (no forking here):**
```
┌─────────────────────────────────────────────────┐
│ Contacts (container)                             │
│                                                  │
│  items: [Person, Person, FamilyMember, ...]     │
│                                                  │
│  [+ Add Contact ▼]  ← just picks existing types │
│  ├─ Contact                                      │
│  ├─ FamilyMember                                 │
│  ├─ Contractor                                   │
│  └─ ...other PersonLike patterns                 │
└─────────────────────────────────────────────────┘
```

**Fork happens on individual records:**
```
┌─────────────────────────────────────────────────┐
│ John Smith (Contact)                             │
│                                                  │
│  name: "John Smith"                              │
│  email: "john@example.com"                       │
│                                                  │
│  [Upgrade ▼]                                     │
│  ├─ "Add birthday → FamilyMember"                │
│  ├─ "Add hourlyRate → Contractor"                │
│  └─ "Fork and customize..."                      │
└─────────────────────────────────────────────────┘
```

**When you need a new type:**
> While viewing John Smith: "I need to track him as a contractor with hourly rate."

The LLM forks Contact, adds the fields, uses `compileAndRun` to compile it, and replaces John's record in-place with the new Contractor type. His existing data (name, email) is preserved.

### 3. Core Schema Preservation

**Principle:** Variants can add anything, but must preserve the core schema fields.

This is the contract that enables the ecosystem:
- A forked pattern with `{ name, birthday, hourlyRate }` still satisfies `PersonLike`
- Containers aggregating `PersonLike` items work with ALL variants
- Breaking the core schema breaks interoperability

```typescript
// VALID: extends core
interface Contractor extends PersonLike {
  name: string;        // ✓ core preserved
  hourlyRate: number;  // added when forked
  billingAddress: string; // added when forked
}

// INVALID: breaks core
interface BrokenFriend {
  nickname: string;    // ✗ renamed 'name' - breaks contract
}
```

### 4. Duplication as Edge Case (Simple `sameAs`)

**Principle:** Treat duplicate entities (same person in different contexts) as an edge case, not a core architectural concern.

**Scenario:**
- `contractor.tsx` (work): `{ name: "John Smith", rate: 150, company: "Acme" }`
- `friend.tsx` (personal): `{ name: "John Smith", birthday: "1985-03-15" }`

These might be the **same person** in two different contexts. But this is unusual, not common.

**Simple solution:** Add a `sameAs` field when needed:

```typescript
// When you discover two records are the same person
contractor.sameAs = friendJohn;  // Simple reference
```

**Why not complex reconciliation?**
- Most people don't have massive duplicate problems
- When duplicates occur, it's easy to link them
- Over-engineering identity management adds complexity without proportional benefit

**The 80% case:** Most contacts are distinct. Handle duplicates when they arise, not as core infrastructure.

---

### 5. Lists of Lists

**Principle:** Containers can include other containers as sub-lists, not by copying entries but by including the whole list.

**Example:** Contacts contains AutoImportedGoogleContacts

```
┌─────────────────────────────────────────────────────────┐
│ Contacts                                                 │
│                                                          │
│  items: [                                                │
│    Person("Alice"),                                      │
│    Person("Bob"),                                        │
│    FamilyMember("Mom"),                                  │
│  ]                                                       │
│                                                          │
│  sub-lists: [                                            │
│    ┌─────────────────────────────────────────────┐      │
│    │ AutoImportedGoogleContacts (sub-container)  │      │
│    │  items: [                                    │      │
│    │    GoogleContact("Carol"),                   │      │
│    │    GoogleContact("Dave"),                    │      │
│    │    GoogleContact("Eve"),                     │      │
│    │  ]                                           │      │
│    └─────────────────────────────────────────────┘      │
│  ]                                                       │
└─────────────────────────────────────────────────────────┘
```

**Why this matters:**
- Don't flatten everything into one list
- Keep provenance clear (Carol is from Google import)
- Can remove entire import source at once
- Can have multiple import sources as separate sub-lists
- Container shows combined view but maintains structure

**Implementation:**
```typescript
interface ContactsContainer {
  items: PersonLike[];           // Directly managed contacts
  subLists: ContactsContainer[]; // Nested containers (imports, groups, etc.)

  // Computed: all contacts including from sub-lists
  allItems: PersonLike[];
}
```

---

## Folksonomy Growth

The ecosystem evolves organically through usage, not top-down design.

### How It Works

```
Time 0: Base patterns exist
┌──────────┐ ┌──────────┐ ┌──────────┐
│PersonLike│ │ TaskLike │ │EventLike │
└──────────┘ └──────────┘ └──────────┘

Time 1: Users fork when they need new types
User A needs contractor → forks Contact, adds hourlyRate
User B needs family member → forks Contact, adds birthday

Time 2: Features spread through discovery
User C sees User A's contractor pattern, forks it
User D merges birthday field from User B's pattern

Time 3: De facto standards emerge
"contractor with hourlyRate" becomes common
This is now a discoverable pattern
```

### Container as Pattern Selector

The container's "Add" dropdown **lists all patterns that satisfy the interface**. No forking happens here - it's just selection.

```
┌─────────────────────────────────────────────────────────┐
│ Contacts                                                 │
│                                                          │
│  [+ Add Contact ▼]                                      │
│  ├─ Contact ─────────────────> creates new Contact      │
│  ├─ FamilyMember ────────────> creates new FamilyMember │
│  ├─ Contractor ──────────────> creates new Contractor   │
│  └─ ...other PersonLike patterns                        │
└─────────────────────────────────────────────────────────┘
```

**The container knows:**
- What patterns satisfy its interface (PersonLike)
- What variants users have created (appear in the list)

**Note:** Fork-on-demand happens at the **record level**, not here. See "Upgrading Records via Fork" below.

### Upgrading Records via Fork

The key UX insight: **fork-on-demand happens when viewing an individual record**, not from the container's add menu.

When you're viewing a record (e.g., a Contact named "John Smith"), the system can suggest upgrades to more specific types:

```
┌─────────────────────────────────────────────────────────┐
│ John Smith (Contact)                                     │
│                                                          │
│  name: "John Smith"                                     │
│  email: "john@example.com"                              │
│  phone: "555-1234"                                      │
│                                                          │
│  [Upgrade ▼]                                            │
│  ├─ "Add birthday → FamilyMember"                       │
│  ├─ "Add hourlyRate → Contractor"                       │
│  ├─ "Add company → Employee"                            │
│  └─ "Fork and customize..." ────> LLM adds fields,      │
│                                   compileAndRun creates │
│                                   new pattern, record   │
│                                   is replaced in-place  │
└─────────────────────────────────────────────────────────┘
```

**How upgrades work:**

1. **Known type upgrades**: The system knows FamilyMember extends Contact with `birthday`. If user adds birthday, offer to upgrade the record to FamilyMember type.

2. **Custom fork**: User says "I need to track this person's billing address and hourly rate." The LLM:
   - Forks the Contact pattern
   - Adds the requested fields
   - Uses `compileAndRun` to compile the new pattern
   - Replaces the record in-place with the new type (preserving existing data)

**The `compileAndRun` builtin enables this:**

```typescript
// packages/runner/src/builtins/compile-and-run.ts
// Takes: { files: [{name, contents}], main, input }
// Returns: { result, error, errors, pending }

// 1. LLM generates forked pattern source
const forkedPattern = {
  files: [{ name: "contractor.tsx", contents: generatedSource }],
  main: "contractor.tsx",
  input: existingRecordData  // Preserves John's name, email, phone
};

// 2. compileAndRun compiles and instantiates it
// 3. The result replaces the original record in the container
```

**Upgrade discovery logic:**
- Find patterns that extend the current type
- Show which fields would need to be added
- Offer to add those fields and upgrade the record type
- All existing data is preserved during upgrade

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
- Browse existing patterns that satisfy the interface
- See popular fields across variants
- Fork and modify rather than starting from scratch
- LLM suggests: "This looks like a contractor. Want to use the Contractor pattern?"

---

## Architecture Overview

### Core Concept: Container + Record-Level Upgrade

The container lists available patterns; fork-on-demand happens on individual records.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CONTAINER PATTERN                               │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ Minimal Interface Type: PersonLike { name: string }              │
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  items: [                                                            │
│    ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│    │ Contact         │  │ FamilyMember    │  │ Contractor      │   │
│    │ name: "Alice"   │  │ name: "Mom"     │  │ name: "John"    │   │
│    │ + email         │  │ + birthday      │  │ + hourlyRate    │   │
│    │ + phone         │  │ + relationship  │  │ + company       │   │
│    └────────┬────────┘  └─────────────────┘  └─────────────────┘   │
│             │                                                        │
│             ▼ click to view individual record                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Alice (Contact)                                                │  │
│  │  name: "Alice"   email: "alice@..."   phone: "555-..."       │  │
│  │                                                                │  │
│  │  [Upgrade ▼]  ← fork-on-demand happens HERE on records       │  │
│  │  ├─ "Add birthday → FamilyMember"                             │  │
│  │  ├─ "Add hourlyRate → Contractor"                             │  │
│  │  └─ "Fork and customize..."                                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  subLists: [AutoImportedGoogleContacts, WorkContacts, ...]          │
│                                                                      │
│  [+ Add Contact ▼]  ← just lists existing patterns, no forking     │
│  ├─ Contact                                                          │
│  ├─ FamilyMember                                                     │
│  └─ Contractor                                                       │
│                                                                      │
│  addItem: Stream<{ item: PersonLike }>                              │
│  mentionable: [all items from items + subLists]                     │
└─────────────────────────────────────────────────────────────────────┘
```

Key properties:
- **Container "Add" menu lists existing patterns** - just picks a type, no forking
- **Fork-on-demand happens on records** - upgrade Alice from Contact to Contractor
- **compileAndRun enables dynamic fork** - LLM generates pattern, compile it, replace record
- **Data preserved during upgrade** - existing fields carry over to new type
- **Lists of lists**: Containers can include other containers (subLists)
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

## Pattern Variants: Fork-on-Demand, Not Pre-Designed Catalogs

**Key insight:** Don't pre-design a catalog of variants. Start with minimal base patterns and fork when needed.

### Base Patterns (Ship These)

We provide minimal base patterns that users fork:

| Base Pattern | Interface | Fields |
|--------------|-----------|--------|
| `contact.tsx` | PersonLike | name, email?, phone? |
| `task.tsx` | TaskLike | title, done |
| `event.tsx` | EventLike | title, date, time? |

### Example Variants (Emerge from Usage)

These are examples of what users might create by forking, not patterns we pre-build:

| Forked From | User's Variant | Added Fields | Why They Forked |
|-------------|----------------|--------------|-----------------|
| contact.tsx | contractor.tsx | hourlyRate, company, billingAddress | Needed to track freelancers |
| contact.tsx | family-member.tsx | birthday, relationship, dietary | Planning family events |
| task.tsx | shopping-item.tsx | quantity, aisle, store | Grocery shopping workflow |
| event.tsx | potluck.tsx | dishes[], attendees[], whoBringsWhat | Organizing potlucks |

### How Forking Works (Record-Level Upgrade)

Forking happens when viewing an individual record, not from the container's add menu.

```
User (viewing "John Smith" as Contact): "I need to track him as a contractor"

System:
1. LLM forks contact.tsx as the base
2. LLM adds: hourlyRate, company, billingAddress fields
3. compileAndRun compiles the new "contractor.tsx" pattern
4. John's record is replaced in-place with Contractor type
5. Existing data (name, email, phone) is preserved
6. Contractor now appears in container's add menu for future contacts
```

**Using `compileAndRun` for dynamic pattern compilation:**

```typescript
// The LLM generates the forked pattern source
const forkedSource = `
  /// <cts-enable />
  export interface Contractor extends PersonLike {
    name: string;
    hourlyRate: number;
    company: string;
  }
  // ... pattern implementation
`;

// compileAndRun compiles and instantiates it
const result = compileAndRun({
  files: [{ name: "contractor.tsx", contents: forkedSource }],
  main: "contractor.tsx",
  input: { name: "John Smith", email: "john@example.com" }  // existing data
});

// result.result is the running piece - replaces the original record
```

### Each Forked Pattern:
1. **Is a complete, coherent UX** - not fragmented pieces
2. **Exports `NAME` and `[UI]`** - can be rendered standalone
3. **Satisfies the base interface** - can be used in containers
4. **Lives in user's space** - they own it, can modify it

---

## Container Pattern Protocol

Containers manage items, discover patterns, and support nested lists:

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
  sameAs?: T;        // Optional: link to same entity in another context
}

/**
 * What containers expose
 */
export interface ContainerProtocol<T> {
  // Direct items managed by this container
  items: Writable<ContainerItem<T>[]>;

  // Nested containers (lists of lists)
  subLists: Writable<ContainerProtocol<T>[]>;

  // All items including from subLists (computed)
  allItems: ContainerItem<T>[];

  // Handlers
  addItem: Stream<{ item: T }>;
  removeItem: Stream<{ item: T }>;
  addSubList: Stream<{ list: ContainerProtocol<T> }>;
  removeSubList: Stream<{ list: ContainerProtocol<T> }>;

  // For @-mentions
  mentionable: unknown[];

  // Pattern discovery: find patterns that satisfy interface T
  // (used for the "Add" dropdown - just lists existing patterns, no forking)
  availablePatterns: PatternRef[];
}

/**
 * Reference to a pattern that can be instantiated
 */
export interface PatternRef {
  name: string;
  schema: unknown;  // The pattern's type
  create: () => ContainerItem<unknown>;
}

/**
 * Record upgrade protocol - for individual records, not containers
 * This is how fork-on-demand works at the record level.
 */
export interface RecordUpgradeProtocol<T> {
  // Current record data
  currentData: T;
  currentType: PatternRef;

  // Available upgrades (patterns that extend current type)
  availableUpgrades: UpgradeOption[];

  // Upgrade the record to a new type (uses compileAndRun internally)
  upgradeRecord: Stream<{ newType: PatternRef | string }>;  // string = custom fork request
}

export interface UpgradeOption {
  targetType: PatternRef;
  requiredFields: string[];  // Fields that need to be added
  description: string;       // e.g., "Add birthday to make this a FamilyMember"
}
```

---

## Example: Contacts Container (with Lists of Lists)

```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, action, computed } from "commontools";
import type { PersonLike, ContainerItem, ContainerProtocol } from "commontools";

interface Input {
  title?: string;
  items?: Writable<ContainerItem<PersonLike>[]>;
  subLists?: Writable<ContainerProtocol<PersonLike>[]>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  items: ContainerItem<PersonLike>[];
  subLists: ContainerProtocol<PersonLike>[];
  allItems: ContainerItem<PersonLike>[];  // items + all subList items
  addItem: Stream<{ item: PersonLike }>;
  addSubList: Stream<{ list: ContainerProtocol<PersonLike> }>;
  mentionable: unknown[];
}

export default pattern<Input, Output>(({ title, items, subLists }) => {
  const data = items ?? Writable.of<ContainerItem<PersonLike>[]>([]);
  const lists = subLists ?? Writable.of<ContainerProtocol<PersonLike>[]>([]);

  const addItem = action(({ item }: { item: PersonLike }) => {
    data.push({ item, name: item.name });
  });

  const addSubList = action(({ list }: { list: ContainerProtocol<PersonLike> }) => {
    lists.push(list);
  });

  // Combine direct items + items from all sub-lists
  const allItems = computed(() => {
    const direct = data.get();
    const fromSubLists = lists.get().flatMap(sub => sub.allItems);
    return [...direct, ...fromSubLists];
  });

  return {
    [NAME]: computed(() => title ?? "Contacts"),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="sm">
          {/* Direct items */}
          {data.map(entry => (
            <ct-card>
              <span>{entry.name}</span>
            </ct-card>
          ))}

          {/* Sub-lists (e.g., AutoImportedGoogleContacts) */}
          {lists.map(subList => (
            <ct-card>
              <ct-vstack gap="xs">
                <strong>{subList[NAME]}</strong>
                {subList.allItems.map(entry => (
                  <span style="margin-left: 1em">{entry.name}</span>
                ))}
              </ct-vstack>
            </ct-card>
          ))}
        </ct-vstack>
      </ct-screen>
    ),
    items: data,
    subLists: lists,
    allItems,
    addItem,
    addSubList,
    mentionable: allItems,
  };
});
```

---

## Example: Forking Contact to Create FamilyMember

This shows how a user might fork the base Contact pattern to create a FamilyMember variant.

### Base: contact.tsx (provided)
```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, Default, computed } from "commontools";
import type { PersonLike } from "commontools";

export interface Contact extends PersonLike {
  name: string;
  email?: string;
  phone?: string;
}

export default pattern<{ contact: Writable<Default<Contact, { name: "" }>> }, { contact: Contact }>(({ contact }) => {
  return {
    [NAME]: computed(() => contact.name || "Contact"),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="md">
          <ct-input $value={contact.key("name")} placeholder="Name" />
          <ct-input $value={contact.key("email")} placeholder="Email" />
          <ct-input $value={contact.key("phone")} placeholder="Phone" />
        </ct-vstack>
      </ct-screen>
    ),
    contact,
  };
});
```

### Forked: family-member.tsx (user creates when needed)

User says: "I need to track family members with birthdays and dietary restrictions."
LLM forks contact.tsx and adds the requested fields:

```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, Default, computed } from "commontools";
import type { PersonLike } from "commontools";

// Forked from Contact, added: relationship, birthday, dietary, gifts
export interface FamilyMember extends PersonLike {
  name: string;
  relationship: string;           // Added: "spouse", "child", "parent", etc.
  birthday?: string;              // Added: ISO date
  dietaryRestrictions?: string[]; // Added: for meal planning
  giftPreferences?: string[];     // Added: for gift giving
}

export default pattern<{ member: Writable<Default<FamilyMember, { name: "", relationship: "" }>> }, { member: FamilyMember }>(({ member }) => {
  return {
    [NAME]: computed(() => member.name || "Family Member"),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="md">
          <ct-input $value={member.key("name")} placeholder="Name" />
          <ct-picker
            $value={member.key("relationship")}
            options={["spouse", "child", "parent", "sibling", "grandparent"]}
          />
          <ct-input $value={member.key("birthday")} type="date" placeholder="Birthday" />
          <ct-tags tags={member.key("dietaryRestrictions")} placeholder="Dietary restrictions" />
          <ct-tags tags={member.key("giftPreferences")} placeholder="Gift ideas" />
        </ct-vstack>
      </ct-screen>
    ),
    member,
  };
});
```

**Key point:** FamilyMember wasn't pre-designed. It was created just-in-time when the user needed it.

---

## Lists of Lists in Practice

### Example: Contacts with Google Import Sub-List

```typescript
/// <cts-enable />
import { pattern, NAME, UI, Writable, computed } from "commontools";
import type { PersonLike, ContainerProtocol } from "commontools";

// A sub-list that imports from Google Contacts
interface GoogleContactsImport extends ContainerProtocol<PersonLike> {
  syncStatus: 'synced' | 'syncing' | 'error';
  lastSync: string;
}

// Main Contacts container can include this as a sub-list
const contacts = ContactsContainer({
  items: [
    { item: { name: "Alice" }, name: "Alice" },
    { item: { name: "Bob" }, name: "Bob" },
  ],
  subLists: [
    googleContactsImport,  // Includes all Google contacts as a sub-list
    workContactsImport,    // Could have multiple sub-lists
  ],
});

// contacts.allItems now includes Alice, Bob, AND all items from sub-lists
```

### Why Lists of Lists?

1. **Keep provenance**: You know Carol came from Google import, not manually added
2. **Bulk operations**: Remove entire import source at once
3. **Avoid duplication**: Don't copy 500 Google contacts into main list
4. **Structure preservation**: Main list + organized sub-groups
5. **Easy cleanup**: If Google sync breaks, just remove that sub-list

### When to Use Sub-Lists vs Projection

| Use Sub-Lists | Use Projections |
|---------------|-----------------|
| Same interface type | Different interface types |
| Imported contacts → Contacts | Notebook checkboxes → Tasks |
| Work contacts → Contacts | Birthdays → Calendar events |
| Structure matters | Shape transformation needed |

---

## Tony's Needs - Addressed

The architect clarified Tony's actual pattern needs:

| Need | Solution |
|------|----------|
| Task list with tasks | Container pattern for `TaskLike` with subLists |
| Calendar with events | Container pattern for `EventLike`/`CalendarItem` |
| Tasks/events can be different shapes | Fork base patterns when needed, add fields |
| Create new items | `addItem` handler on container |
| Create new types | Container helps discover/fork patterns |
| Import contacts from Google | Add GoogleContacts as subList, don't flatten |
| Mentionable items | `mentionable` = all items from items + subLists |

**Implementation recipe:**
1. Define TypeScript type for minimal interface: `{ done: boolean, title: string }`
2. Provide base patterns: `task.tsx`, `contact.tsx`, `event.tsx`
3. Container helps users fork base patterns to create new types
4. Container supports subLists for imports and grouping
5. Simple `sameAs` for occasional duplicates

---

## Handling Duplicates: Simple `sameAs`

### The Scenario

You have:
- `contractor`: `{ name: "John Smith", hourlyRate: 150, company: "Acme" }`
- `friend`: `{ name: "John Smith", birthday: "1985-03-15" }`

These might be the same person. What do you do?

### Simple Solution: `sameAs` Field

```typescript
// When you realize they're the same person, just link them
contractor.sameAs = friend;

// Or bidirectional
contractor.sameAs = friend;
friend.sameAs = contractor;
```

That's it. No complex reconciliation infrastructure.

### Why This Is Enough

1. **Duplicates are rare**: Most people in your contacts are distinct
2. **When they happen, they're obvious**: User notices "wait, I have two John Smiths"
3. **Simple fix**: Link them with sameAs, move on
4. **No merged views needed**: Just navigate from one to the other

### What NOT to Build

Don't build:
- Complex identity resolution algorithms
- Confidence scoring on matches
- Automatic deduplication systems
- Merged view generation
- Conflict resolution UX

These are over-engineering for an edge case. If someone really needs sophisticated deduplication, they can build a specialized tool for it.

### When Duplicates Arise

| Situation | Solution |
|-----------|----------|
| Imported contacts overlap with manual | User links them with sameAs |
| Same person in work and personal lists | Lives in both, linked with sameAs |
| Typo creates duplicate | Delete the duplicate |
| Actually two different people | Leave them separate (no sameAs) |

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
- [ ] Revise container-protocol.ts with subLists support

### Phase 2: Base Patterns + First Container
- [ ] `contact.tsx` - Base PersonLike pattern (minimal: name, email?, phone?)
- [ ] `task.tsx` - Base TaskLike pattern (minimal: title, done)
- [ ] `event.tsx` - Base EventLike pattern (minimal: title, date)
- [ ] `contacts-container.tsx` - Container with subLists support

### Phase 3: Record-Level Upgrade Infrastructure
- [ ] Pattern discovery: find patterns satisfying an interface (for container "Add" menu)
- [ ] Upgrade discovery: find patterns that extend current record's type
- [ ] `RecordUpgradeProtocol` implementation for individual records
- [ ] LLM-assisted fork: generate new pattern source with requested fields
- [ ] Integration with `compileAndRun`: compile forked pattern dynamically
- [ ] Record replacement: replace record in-place with upgraded type (preserve data)
- [ ] Schema validation: verify fork still satisfies base interface

### Phase 4: Lists of Lists
- [ ] `addSubList` handler on containers
- [ ] Combined `allItems` computed property
- [ ] Example: GoogleContactsImport as sub-list of Contacts

### Phase 5: Simple Duplication Handling
- [ ] Add optional `sameAs` field to ContainerItem
- [ ] UI to link two items as same entity
- [ ] Navigation between linked items

### Phase 6: UX for Container + Record Upgrade
- [ ] Container "Add" menu shows available patterns (just selection, no forking)
- [ ] Record view shows "Upgrade" menu with available type upgrades
- [ ] "Fork and customize..." option in record upgrade menu triggers LLM flow
- [ ] compileAndRun integration for dynamic pattern compilation
- [ ] Record replacement UI (preserves data, changes type)
- [ ] Browse patterns others have created (optional)

---

## Verification Plan

### Container Protocol
1. **Test addItem**: Add contact to container, verify it appears
2. **Test addSubList**: Add GoogleContacts import, verify items appear in allItems
3. **Test mentionable**: Verify all items (direct + from subLists) appear in mentionable

### Record-Level Upgrade
4. **Test pattern discovery**: Container finds patterns satisfying PersonLike for "Add" menu
5. **Test upgrade discovery**: Record shows available type upgrades (Contact → FamilyMember)
6. **Test fork + compileAndRun**: Fork contact.tsx, add birthday field, compile dynamically
7. **Test record replacement**: Upgrade Alice from Contact to FamilyMember, verify data preserved
8. **Test schema validation**: Upgraded pattern still satisfies PersonLike interface

### Lists of Lists
9. **Test nested structure**: Contacts with 2 subLists, verify allItems combines correctly
10. **Test provenance**: Items from subLists show their source
11. **Test bulk removal**: Remove subList, verify its items disappear from allItems

### Simple Duplicates
12. **Test sameAs**: Link two contacts, verify navigation between them works

### Integration
13. **Manual test**: Create Contacts, add direct contacts, add GoogleContacts subList
14. **Manual test**: View Alice (Contact), use Upgrade menu to make her a Contractor
15. **Verify**: After upgrade, Alice appears as Contractor in container, original data preserved

---

## Questions for Architect (Berni)

### Addressed by This Revision (v3)

1. ~~Over-engineering reconciliation~~ → Simple `sameAs` field
2. ~~Pre-designed variant catalogs~~ → Fork-on-demand
3. ~~Complex identity infrastructure~~ → Treat duplicates as edge case
4. ~~Flat container model~~ → Lists of lists (subLists)

### Still Open

1. **Interface location**: Should minimal interfaces live in `packages/api/types/` or elsewhere?

2. **Pattern discovery mechanism**: How does a container find all patterns that satisfy its interface?
   - Query by interface type?
   - Registry of patterns with their interfaces?
   - Static analysis of pattern schemas?

3. **Record upgrade discovery**: How does a record know what types it can upgrade to?
   - Find patterns where current type is a subset of target type?
   - Registry of "extends" relationships between patterns?
   - LLM analysis of schema compatibility?

4. **compileAndRun integration for upgrades**: How exactly does the upgrade flow work?
   - LLM generates forked pattern source
   - `compileAndRun` compiles it dynamically
   - How is the record "replaced in-place" in the container?
   - Does the new pattern get saved to user's space for reuse?

5. **SubList identity**: How do we track where a sub-list came from?
   - Reference to original container?
   - Import source metadata?
   - Live sync vs snapshot?

6. **Schema validation**: How do we verify a fork still satisfies the base interface?
   - TypeScript compiler check?
   - Runtime validation?
   - Warning vs error on violation?

---

## Appendix: What Changed

### v1 → v2 (Annotation → Reconciliation)

| v1 Design | v2 Design | Rationale |
|-----------|-----------|-----------|
| `[ANNOTATIONS]` array | Identity linking | Not extensibility, it's reconciliation |
| Annotation system | Records + reconciliation | Simpler mental model |
| Single "person" + annotations | N variant patterns | Coherent UX per variant |

### v2 → v3 (Pre-Designed → Fork-on-Demand)

| v2 Design | v3 Design | Rationale |
|-----------|-----------|-----------|
| Pre-designed N variants | Fork-on-demand | Create types when you need them |
| Complex reconciliation | Simple `sameAs` field | Duplicates are edge case |
| Flat container items | Lists of lists (subLists) | Contacts includes GoogleContacts |
| Catalog of variants | Container discovers patterns | Container is the entry point |
| Identity linking infrastructure | Simple field reference | Don't over-engineer edge cases |

### v3 → v4 (Container Fork → Record-Level Upgrade)

| v3 Design | v4 Design | Rationale |
|-----------|-----------|-----------|
| Fork from container "Add" menu | Fork from individual record "Upgrade" menu | Fork happens on records, not containers |
| Container has forkPattern handler | Container just lists patterns | Simpler container responsibility |
| Unclear when fork happens | Fork when viewing a record and needing more fields | Clearer mental model |
| No record replacement model | Record upgraded in-place, data preserved | Upgrade = replace with richer type |
| N/A | compileAndRun enables dynamic compilation | Leverage existing builtin for fork flow |

### Key Insight (v4)

> "Fork-on-demand happens on **individual records**, not from the container's add dropdown. When viewing John Smith (Contact), you can upgrade him to a Contractor by adding hourlyRate. The LLM forks the pattern, compileAndRun compiles it, and the record is replaced in-place."

**Container responsibility:** List available patterns in "Add" menu (no forking)
**Record responsibility:** Show upgrade options, enable fork-and-upgrade via compileAndRun

---

## Appendix: Research Sources

- **Architect feedback (v1)**: Discord messages (2026-01-27, morning)
- **Architect feedback (v2)**: Live conversation (2026-01-27, afternoon) - fork-and-pull, reconciliation
- **Architect feedback (v4)**: Clarification that fork happens on records, not container add menu
- **Container protocol**: `packages/patterns/container-protocol.ts`
- **Existing patterns**: `packages/patterns/contacts/`, `packages/patterns/todo-list/`
- **Template registry**: `packages/patterns/record/template-registry.ts` - existing fork model
- **Module registry**: `packages/patterns/record/registry.ts` - composable modules
- **compileAndRun builtin**: `packages/runner/src/builtins/compile-and-run.ts` - dynamic pattern compilation
