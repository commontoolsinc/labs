# Cell Passing POC - Architecture Diagrams

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Test Harness (cell-passing-poc-simple.test.ts)             │
│                                                             │
│  ├─ Setup Runtime & Storage                                │
│  ├─ Compile Parent Pattern                                 │
│  ├─ Run Parent with Child Source                           │
│  ├─ Wait for Child to Compile                              │
│  └─ Execute Tests & Assertions                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Parent Pattern (compiled at runtime)                        │
│                                                             │
│  ┌───────────────────────────────┐                         │
│  │ const sharedItems =           │                         │
│  │   cell<string[]>([])          │                         │
│  └───────────────────────────────┘                         │
│                │                                            │
│                ▼                                            │
│  ┌───────────────────────────────────────────────┐         │
│  │ compileAndRun({                               │         │
│  │   files: [{ name, contents: CHILD_SOURCE }],  │         │
│  │   main: "/child.tsx",                         │         │
│  │   input: {                                    │         │
│  │     items: sharedItems  ◄────────────┐        │         │
│  │   }                                  │        │         │
│  │ })                                   │        │         │
│  └───────────────────────────────────────────────┘         │
│                │                        │                   │
│                ▼                        │                   │
│  ┌───────────────────────────────────────────────┐         │
│  │ Compiled Child Pattern Result                 │         │
│  │   - Has .key("addItem") handler               │         │
│  │   - Receives items Cell                       │         │
│  └───────────────────────────────────────────────┘         │
│                                         │                   │
└─────────────────────────────────────────│───────────────────┘
                                          │
                      Cell Reference      │
                      Passed Here ────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Child Pattern (compiled from source string)                 │
│                                                             │
│  interface Input {                                          │
│    items: Cell<string[]>  ◄─── Same Cell instance!         │
│  }                                                          │
│                                                             │
│  const addItem = handler<Event, { items: Cell<...> }>(     │
│    (event, { items }) => {                                 │
│      items.set([...items.get(), newValue])  ◄─┐            │
│    }                                           │            │
│  )                                             │            │
│                                                │            │
│  return {                                      │            │
│    items,      ◄───────────────────────────────┤            │
│    addItem: addItem({ items })                 │            │
│  }                                             │            │
│                                                │            │
└────────────────────────────────────────────────│────────────┘
                                                 │
                                                 │
                     Modifications flow back ────┘
                     (same reference, reactive updates)
```

## Data Flow: Adding an Item

```
Step 1: Test triggers parent handler
┌──────────────────┐
│ Test             │
│  triggerStream   │──┐
│   .send({...})   │  │
└──────────────────┘  │
                      │
Step 2: Parent forwards to child
                      ▼
┌────────────────────────────────┐
│ Parent Pattern                 │
│  handler receives event        │
│  forwards to childAddStream    │──┐
└────────────────────────────────┘  │
                                    │
Step 3: Child handler executes
                                    ▼
┌────────────────────────────────────────┐
│ Child Pattern                          │
│  addItem handler receives event        │
│  reads: items.get() → ['existing']     │
│  writes: items.set(['existing', 'new'])│──┐
└────────────────────────────────────────┘  │
                                            │
Step 4: Cell updated (shared reference)
                                            ▼
┌─────────────────────────────────────────────┐
│ Cell<string[]>                              │
│  Value: ['existing', 'new']                 │
│  Notifies all reactive dependencies         │
└─────────────────────────────────────────────┘
                    │
                    ├─────────────────────┐
                    ▼                     ▼
         ┌──────────────────┐  ┌──────────────────┐
         │ Parent sees:     │  │ Child sees:      │
         │ ['existing',     │  │ ['existing',     │
         │  'new']          │  │  'new']          │
         └──────────────────┘  └──────────────────┘
```

## Type Flow

```
Pattern Definition (TypeScript):
┌────────────────────────────────────────┐
│ interface Input {                      │
│   items: Cell<string[]>                │
│ }                                      │
│                                        │
│ pattern<Input>(({ items }) => {        │
│   // items has full Cell<string[]> API │
│   items.get() → string[]               │
│   items.set([...]) → void              │
│ })                                     │
└────────────────────────────────────────┘
                │
                ▼ CTS Transform
┌────────────────────────────────────────┐
│ Runtime Recipe Structure:              │
│                                        │
│ Input Schema: {                        │
│   type: "object",                      │
│   properties: {                        │
│     items: {                           │
│       type: "array",                   │
│       items: { type: "string" },       │
│       asCell: true  ◄─── Key marker    │
│     }                                  │
│   }                                    │
│ }                                      │
└────────────────────────────────────────┘
                │
                ▼ compileAndRun
┌────────────────────────────────────────┐
│ Child receives input object:           │
│                                        │
│ {                                      │
│   items: Cell<string[]>  ◄─ Instance   │
│ }                                      │
│                                        │
│ Type preserved, methods available      │
└────────────────────────────────────────┘
```

## Reactivity Graph

```
┌─────────────────────────────────────────────────────────┐
│ Runtime Reactive Dependency Graph                       │
│                                                         │
│  Cell<string[]> ("sharedItems")                         │
│         │                                               │
│         ├──────────────┬──────────────┐                 │
│         ▼              ▼              ▼                 │
│  Parent           Parent          Child                │
│  computed()       handler()       handler()            │
│  (itemCount)      (triggerAdd)    (addItem)            │
│         │              │              │                 │
│         ▼              │              │                 │
│  Parent UI ◄───────────┘              │                 │
│  updates when                         │                 │
│  Cell changes                         │                 │
│                                       │                 │
│  Child sees same Cell ◄───────────────┘                 │
│  modifications work                                     │
│  because it's the                                       │
│  SAME Cell instance                                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Compilation Timeline

```
Time ──────────────────────────────────────────────────────►

T0: Test starts
    │
    ▼
T1: Runtime & Storage initialized
    │
    ▼
T2: Parent pattern compiled
    │
    ▼
T3: Parent pattern running
    ├─ Creates Cell<string[]>
    └─ Calls compileAndRun(params)
        │
        ▼
T4: Child compilation starts
    │ (compileAndRun is async)
    │
    ▼
T5: Parent continues executing
    │ (compiled.pending = true)
    │
    ▼
T6: Child compilation completes
    ├─ compiled.result set
    ├─ compiled.pending = false
    └─ Child pattern starts running
        │
        ▼
T7: Test detects child ready
    │
    ▼
T8: Test calls handler
    ├─ Parent forwards to child
    └─ Child modifies Cell
        │
        ▼
T9: Parent reads Cell
    └─ Sees modified value ✓

```

## File Structure Map

```
/Users/alex/Code/labs-2/
│
├── CELL_PASSING_POC_SUMMARY.md ◄── Start here (overview)
│
└── packages/runner/integration/
    │
    ├── QUICK_START.md ◄────────────── Quick commands
    ├── README_CELL_PASSING_POC.md ◄── File descriptions
    ├── ARCHITECTURE_DIAGRAM.md ◄───── This file
    ├── CELL_PASSING_POC.md ◄────────── Detailed docs
    │
    ├── cell-passing-poc-simple.test.ts ◄── Run this first
    │   ├─ Inline parent pattern
    │   ├─ Inline child pattern
    │   └─ Self-contained test logic
    │
    ├── cell-passing-poc.test.ts ◄────── Full test
    │   ├─ Test harness
    │   ├─ Uses parent file ──┐
    │   └─ Inline child       │
    │                         ▼
    └── cell-passing-poc-parent.test.tsx
        ├─ Parent pattern source
        └─ Uses compileAndRun
```

## Component Interaction

```
┌──────────────────────────────────────────────────────────┐
│ Storage Layer (Memory)                                   │
│  - Stores charm state                                    │
│  - Syncs changes across runtime                          │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Runtime                                                  │
│  - Manages execution                                     │
│  - Tracks reactive dependencies                          │
│  - Handles Cell lifecycle                                │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ CharmManager                                             │
│  - Compiles patterns                                     │
│  - Runs charms persistently                              │
│  - Provides charm interface                              │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────┐
│ Parent Charm                                             │
│  ┌────────────────────────────────────────────────┐     │
│  │ compileAndRun Built-in                         │     │
│  │  - Compiles child source                       │     │
│  │  - Passes input (with Cell) to child          │     │
│  │  - Returns compiled result                     │     │
│  └────────────────┬───────────────────────────────┘     │
│                   │                                      │
│                   ▼                                      │
│  ┌────────────────────────────────────────────────┐     │
│  │ Child Charm (dynamically compiled)             │     │
│  │  - Receives Cell from parent                   │     │
│  │  - Exposes handlers that modify Cell           │     │
│  │  - Same runtime instance                       │     │
│  └────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

## Success Validation Flow

```
                    Start Test
                        │
                        ▼
             ┌──────────────────────┐
             │ Compile Parent?      │
             │ Yes ─► Continue      │
             │ No ──► Fail          │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Parent Running?      │
             │ Yes ─► Continue      │
             │ No ──► Fail          │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Cell Created?        │
             │ Yes ─► Continue      │
             │ No ──► Fail          │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Child Compiling?     │
             │ Yes ─► Wait          │
             │ Error ─► Fail        │
             └──────────────────────┘
                        │
                   (wait loop)
                        │
                        ▼
             ┌──────────────────────┐
             │ Child Ready?         │
             │ Yes ─► Continue      │
             │ Timeout ─► Fail      │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Add Item 1           │
             │ Success ─► Continue  │
             │ Error ──► Fail       │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Item in Array?       │
             │ Yes ─► Continue      │
             │ No ──► Fail          │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Add Item 2           │
             │ Success ─► Continue  │
             │ Error ──► Fail       │
             └──────────────────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ 2 Items in Order?    │
             │ Yes ─► Success! ✓    │
             │ No ──► Fail          │
             └──────────────────────┘
```

## Key Technical Points

### 1. Cell is a Reference Type

```typescript
// Cell is NOT:
Cell<string[]> = ['a', 'b', 'c']  // ✗ Plain array

// Cell IS:
Cell<string[]> = {
  get(): string[]
  set(value: string[]): void
  // ... other methods
  // ... internal state
  // ... reactive tracking
}
```

### 2. compileAndRun Passes References

```typescript
// When you do:
compileAndRun({
  input: { items: myCell }
})

// The child receives:
{ items: <same Cell instance as parent> }

// NOT a copy or serialized value
```

### 3. Reactivity is Runtime-Global

```typescript
// Both parent and child share:
- Same Runtime instance
- Same reactive dependency tracker
- Same Cell registry
- Same update notification system

// Therefore:
Cell modified anywhere → All dependents notified
```

## Common Pitfalls (Avoided)

### ❌ Wrong: Passing Plain Value

```typescript
// This would NOT work:
const myArray = ['a', 'b'];
compileAndRun({
  input: { items: myArray }  // Just an array
})

// Child gets a copy, not a reference
// Changes wouldn't be shared
```

### ✓ Correct: Passing Cell

```typescript
// This DOES work:
const myCell = cell(['a', 'b']);
compileAndRun({
  input: { items: myCell }  // Cell object
})

// Child gets the Cell reference
// Changes are shared
```

### ❌ Wrong: Accessing Cell Value Directly

```typescript
// In pattern:
pattern<Input>(({ items }) => {
  const count = items.length;  // ✗ Error! Cell doesn't have .length
})
```

### ✓ Correct: Using Cell Methods

```typescript
// In pattern:
pattern<Input>(({ items }) => {
  const count = computed(() => items.get().length);  // ✓ Correct
})
```

## What This Proves

1. **Reference Preservation**
   - Cells passed through compileAndRun maintain identity
   - No serialization/copy occurs
   - Same object in both contexts

2. **Reactive Coupling**
   - Changes in child trigger parent updates
   - Changes in parent trigger child updates
   - Dependency graph spans compilation boundary

3. **Type Safety**
   - TypeScript types preserved
   - Cell methods available in both contexts
   - Compile-time checks work

4. **Architecture Validity**
   - Proposed solution is sound
   - No runtime modifications needed
   - Leverages existing infrastructure
