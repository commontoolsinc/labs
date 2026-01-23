# Bug Report: Computed List Not Re-rendering When Writable Changes

## Observed Behavior

In a Task pattern with tab-based filtering:

1. Add a task to "Inbox" via `ct-message-input`
2. Task count updates correctly (shows "Inbox (1)")
3. **But the list does not render the task** - shows empty state

**CRITICAL OBSERVATION from screenshot:**

- The Inbox tab is visually selected (blue background)
- But the empty state message says "No tasks in **Next**. Add tasks below."
- This means the list render computed is showing **stale data** from when "Next"
  tab was previously viewed

This proves:

1. Tab button style computeds ARE re-running (Inbox shows as selected)
2. Tab count computeds ARE re-running (shows "(1)")
3. List render computed is NOT re-running when `currentView` changes

## Environment

- Pattern: `packages/patterns/building-blocks/task.tsx`
- Deployed to: 22janBlocksV9
- Using: `Writable.of<string>("inbox")` for tab state, `computed()` for filtered
  list

## What We Tried

### Attempt 1: Changed array mutation from push to set

**Hypothesis:** Maybe `tasks.push(newTask)` wasn't triggering reactivity

**Change:**

```tsx
// Before (original)
tasks.push(newTask);

// After
tasks.set([...tasks.get(), newTask]);
```

**Result:** No improvement. Count still updates, list still doesn't render.

---

### Attempt 2: Pre-computed filteredTasks outside render

**Hypothesis:** Maybe filtering inline inside the render computed wasn't
tracking dependencies properly

**Change:**

```tsx
// Created filteredTasks computed at top level (line 180-184)
const filteredTasks = computed(() => {
  const view = currentView.get();
  const allTasks = tasks.get();
  return allTasks.filter((t) => (t.status || "inbox") === view);
});

// Then in render (line 437):
const tasksToShow = filteredTasks;
```

**Result:** No improvement. Same behavior.

---

### Attempt 3: Removed `.get()` on computed

**Hypothesis:** Compiler error said computed values don't need `.get()`

**Change:**

```tsx
// Before
const tasksToShow = filteredTasks.get();

// After
const tasksToShow = filteredTasks;
```

**Result:** Code compiles and deploys, but list still doesn't render items.

---

## Current Code Structure

### Tab state (Writable)

```tsx
const currentView = Writable.of<string>("inbox");
```

### Filtered tasks (computed)

```tsx
const filteredTasks = computed(() => {
  const view = currentView.get();
  const allTasks = tasks.get();
  return allTasks.filter((t) => (t.status || "inbox") === view);
});
```

### Task count (computed) - THIS WORKS

```tsx
const taskCount = computed(() =>
  tasks.get().filter((t) => t.status !== "done" && t.status !== "archived")
    .length
);
```

### Tab button counts - THESE WORK

```tsx
{
  computed(() =>
    tasks.get().filter((t) => (t.status || "inbox") === status).length
  );
}
```

### List render - DOES NOT WORK

```tsx
{
  computed(() => {
    const view = currentView.get();
    const tasksToShow = filteredTasks;

    if (tasksToShow.length === 0) {
      return <div>No tasks in {getStatusLabel(view)}. Add tasks below.</div>;
    }

    return tasksToShow.map((task: Task) => (
      <div onClick={() => openEditModal.send({ task })}>
        {task.title}
      </div>
    ));
  });
}
```

### Add task action

```tsx
const addTask = action(({ title, status }) => {
  const newTask: Task = {
    id: generateId(),
    title: trimmed,
    status: status || "inbox",
    createdAt: now(),
    modifiedAt: now(),
  };
  tasks.set([...tasks.get(), newTask]);
});
```

### Input handler

```tsx
<ct-message-input
  onct-send={(e) => {
    const title = e.detail?.message?.trim();
    if (title) {
      const view = currentView.get();
      const status = view === "done" ? "inbox" : view as TaskStatus;
      addTask.send({ title, status });
    }
  }}
/>;
```

---

## Key Observations

1. **Count computeds work:** `taskCount` and inline tab counts all update
   correctly
2. **List computed doesn't work:** The render computed that uses `filteredTasks`
   doesn't re-render
3. **Same pattern works elsewhere:** The Person, Place, Thing, Role, Project
   patterns all use similar list rendering and work correctly
4. **Difference:** Task pattern has tabs/filtering based on a `Writable` state
   variable

---

## Root Cause Analysis (from screenshot evidence)

The screenshot proves that `currentView.get()` works correctly in SOME computed
contexts but not in the list render computed:

| Location                           | Uses `currentView.get()` | Updates? |
| ---------------------------------- | ------------------------ | -------- |
| Tab button `backgroundColor` style | Yes                      | ✅ YES   |
| Tab button `color` style           | Yes                      | ✅ YES   |
| Tab button `borderColor` style     | Yes                      | ✅ YES   |
| List render computed (line 435)    | Yes                      | ❌ NO    |
| Input placeholder                  | Yes                      | ?        |

The difference is that the **working** computeds are inline style computeds
inside JSX attributes, while the **broken** computed wraps a larger block of JSX
that maps over an array.

---

## Hypotheses for Framework Team

### Hypothesis A: Nested computed dependency tracking

The list is inside a `computed(() => { ... })` that references another
`computed` (`filteredTasks`). Maybe nested computed dependencies aren't being
tracked correctly?

### Hypothesis B: Writable + computed interaction

The `filteredTasks` computed depends on both:

- `currentView.get()` (a Writable)
- `tasks.get()` (Input Writable)

Maybe when `tasks` changes, the computed doesn't re-run because `currentView`
hasn't changed?

### Hypothesis C: Array reference comparison

When we do `tasks.set([...tasks.get(), newTask])`, we're creating a new array.
But maybe the computed is doing reference equality and sees `filteredTasks` as
unchanged?

### Hypothesis D: JSX re-render timing

The render computed returns JSX. Maybe there's a timing issue where the JSX is
created before the inner computed has a chance to update?

---

## Questions for Framework Team

1. Is there a correct pattern for "filtered list based on local UI state"?
2. Should `Writable.of()` be used differently for UI state that affects computed
   values?
3. Is there a way to force a computed to re-evaluate?
4. Are there known issues with computed values that depend on both Input
   Writables and local Writables?

---

## Comparison: Working vs Not Working

### Working: Person pattern (no tabs, simple list)

```tsx
const activePersons = computed(() =>
  persons.get().filter((p) => p.isActive !== false)
);

// In render:
{
  computed(() => {
    const personsToShow = showArchived.get() ? persons.get() : activePersons;
    return personsToShow.map((person) => <div>{person.name}</div>);
  });
}
```

### Not Working: Task pattern (tabs with filtering)

```tsx
const currentView = Writable.of<string>("inbox");
const filteredTasks = computed(() => {
  const view = currentView.get();
  return tasks.get().filter((t) => (t.status || "inbox") === view);
});

// In render:
{
  computed(() => {
    const tasksToShow = filteredTasks;
    return tasksToShow.map((task) => <div>{task.title}</div>);
  });
}
```

The key difference is that Person filters on a boolean toggle (`showArchived`)
while Task filters on a string enum (`currentView`). But both use
`Writable.of()`.

---

## Potential Workarounds to Try

1. **Don't wrap entire list in computed?** - Maybe render the list directly
   without computed wrapper
2. **Use a different state mechanism?** - Maybe `Writable.of()` has issues in
   this context
3. **Force dependency tracking?** - Is there a way to explicitly declare
   dependencies for a computed?
4. **Use lift() instead of computed()?** - Would `lift()` behave differently?

---

## Full File Reference

See: `packages/patterns/building-blocks/task.tsx` (543 lines)
