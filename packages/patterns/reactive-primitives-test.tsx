/// <cts-enable />
/**
 * Reactive Primitives Test Pattern
 *
 * Comprehensive test pattern for Cell.reduce() and Cell.map(fn, { key }) APIs.
 * This pattern exercises various edge cases and usage patterns to verify the
 * ts-transformer correctly handles these reactive primitives.
 *
 * Test Coverage:
 * 1. Basic reduce() - sum, count
 * 2. Complex reduce() - object accumulation
 * 3. Reduce to collect unique values
 * 4. Reduce string concatenation
 * 5. Keyed map() with string key path
 * 6. Keyed map() with key function
 * 7. Chained operations - map followed by reduce
 * 8. Multiple reduces on same array
 */

import {
  Cell,
  cell,
  computed,
  handler,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

// ============================================================================
// Types
// ============================================================================

interface Task {
  id: string;
  title: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  tags: string[];
}

interface TaskStats {
  total: number;
  completed: number;
  byPriority: { low: number; medium: number; high: number };
}

// ============================================================================
// Test Pattern
// ============================================================================

export default recipe<{}, {}>("Reactive Primitives Test", () => {
  // Initialize with sample data
  const tasks = cell<Task[]>([
    {
      id: "task-1",
      title: "Write documentation",
      completed: true,
      priority: "high",
      tags: ["docs", "important"],
    },
    {
      id: "task-2",
      title: "Fix bug in reducer",
      completed: false,
      priority: "high",
      tags: ["bug", "urgent"],
    },
    {
      id: "task-3",
      title: "Add unit tests",
      completed: false,
      priority: "medium",
      tags: ["testing"],
    },
    {
      id: "task-4",
      title: "Refactor code",
      completed: true,
      priority: "low",
      tags: ["cleanup"],
    },
  ]);

  // ========================================================================
  // TEST 1: Basic reduce() - Count total tasks
  // ========================================================================
  const totalTasks = tasks.reduce(0, (acc: number, _task: Task) => acc + 1);

  // ========================================================================
  // TEST 2: Basic reduce() - Count completed tasks
  // ========================================================================
  const completedTasks = tasks.reduce(
    0,
    (acc: number, task: Task) => acc + (task.completed ? 1 : 0)
  );

  // ========================================================================
  // TEST 3: Complex reduce() - Build statistics object
  // ========================================================================
  const taskStats = tasks.reduce(
    { total: 0, completed: 0, byPriority: { low: 0, medium: 0, high: 0 } },
    (acc: TaskStats, task: Task) => ({
      total: acc.total + 1,
      completed: acc.completed + (task.completed ? 1 : 0),
      byPriority: {
        low: acc.byPriority.low + (task.priority === "low" ? 1 : 0),
        medium: acc.byPriority.medium + (task.priority === "medium" ? 1 : 0),
        high: acc.byPriority.high + (task.priority === "high" ? 1 : 0),
      },
    })
  );

  // ========================================================================
  // TEST 4: Reduce to collect unique values (tags)
  // ========================================================================
  const allTags = tasks.reduce([] as string[], (acc: string[], task: Task) => {
    const newTags = task.tags.filter((t) => !acc.includes(t));
    return [...acc, ...newTags];
  });

  // ========================================================================
  // TEST 5: Reduce to concatenate strings
  // ========================================================================
  const taskTitles = tasks.reduce("", (acc: string, task: Task, index: number) =>
    acc + (index > 0 ? ", " : "") + task.title
  );

  // ========================================================================
  // TEST 6: Keyed map() with string key path
  // ========================================================================
  const taskCards = tasks.map(
    (task: Task) => ({
      id: task.id,
      display: `[${task.completed ? "✓" : " "}] ${task.title} (${task.priority})`,
      tagCount: task.tags.length,
    }),
    { key: "id" }
  );

  // ========================================================================
  // TEST 7: Keyed map() with key function
  // ========================================================================
  const taskSummaries = tasks.map(
    (task: Task) => ({
      title: task.title,
      status: task.completed ? "Done" : "Pending",
    }),
    { key: (task: Task) => task.id }
  );

  // ========================================================================
  // TEST 8: Chained operations - map then reduce
  // ========================================================================
  const mappedPriorities = tasks.map(
    (task: Task) => ({
      id: task.id,
      priorityScore: task.priority === "high" ? 3 : task.priority === "medium" ? 2 : 1,
    }),
    { key: "id" }
  );

  const totalPriorityScore = mappedPriorities.reduce(
    0,
    (acc: number, item: { id: string; priorityScore: number }) => acc + item.priorityScore
  );

  // ========================================================================
  // TEST 9: Multiple reduces on same source
  // ========================================================================
  const highPriorityCount = tasks.reduce(
    0,
    (acc: number, task: Task) => acc + (task.priority === "high" ? 1 : 0)
  );

  const mediumPriorityCount = tasks.reduce(
    0,
    (acc: number, task: Task) => acc + (task.priority === "medium" ? 1 : 0)
  );

  const lowPriorityCount = tasks.reduce(
    0,
    (acc: number, task: Task) => acc + (task.priority === "low" ? 1 : 0)
  );

  // ========================================================================
  // Handlers for modifying tasks
  // ========================================================================

  const addTask = handler<void, { tasks: Cell<Task[]> }>((_, { tasks }) => {
    const id = `task-${Date.now()}`;
    tasks.push({
      id,
      title: `New Task ${id.slice(-4)}`,
      completed: false,
      priority: ["low", "medium", "high"][Math.floor(Math.random() * 3)] as
        | "low"
        | "medium"
        | "high",
      tags: ["new"],
    });
  });

  const toggleFirst = handler<void, { tasks: Cell<Task[]> }>((_, { tasks }) => {
    const current = tasks.get();
    if (current.length > 0) {
      const first = current[0];
      tasks.set([{ ...first, completed: !first.completed }, ...current.slice(1)]);
    }
  });

  const removeFirst = handler<void, { tasks: Cell<Task[]> }>((_, { tasks }) => {
    const current = tasks.get();
    if (current.length > 0) {
      tasks.set(current.slice(1));
    }
  });

  const clearAll = handler<void, { tasks: Cell<Task[]> }>((_, { tasks }) => {
    tasks.set([]);
  });

  const resetTasks = handler<void, { tasks: Cell<Task[]> }>((_, { tasks }) => {
    tasks.set([
      {
        id: "task-1",
        title: "Write documentation",
        completed: true,
        priority: "high",
        tags: ["docs", "important"],
      },
      {
        id: "task-2",
        title: "Fix bug in reducer",
        completed: false,
        priority: "high",
        tags: ["bug", "urgent"],
      },
      {
        id: "task-3",
        title: "Add unit tests",
        completed: false,
        priority: "medium",
        tags: ["testing"],
      },
      {
        id: "task-4",
        title: "Refactor code",
        completed: true,
        priority: "low",
        tags: ["cleanup"],
      },
    ]);
  });

  // ========================================================================
  // UI - Using plain HTML elements to avoid component type issues
  // ========================================================================

  return {
    [NAME]: str`Reactive Primitives Test (${totalTasks} tasks)`,
    [UI]: (
      <div style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ margin: "0 0 0.5rem 0" }}>Reactive Primitives Test</h1>
        <p style={{ color: "#666", margin: "0 0 1rem 0" }}>
          Tests for Cell.reduce() and Cell.map(fn, {"{"} key {"}"})
        </p>

        {/* Actions */}
        <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button onClick={addTask({ tasks })}>Add Task</button>
          <button onClick={toggleFirst({ tasks })}>Toggle First</button>
          <button onClick={removeFirst({ tasks })}>Remove First</button>
          <button onClick={clearAll({ tasks })}>Clear All</button>
          <button onClick={resetTasks({ tasks })}>Reset</button>
        </div>

        {/* TEST 1-2: Basic reduce() */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 1-2: Basic reduce()</h3>
          <div style={{ display: "flex", gap: "2rem" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>Total Tasks</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{totalTasks}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>Completed</div>
              <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{completedTasks}</div>
            </div>
          </div>
        </div>

        {/* TEST 3: Complex reduce() */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 3: Complex reduce() - Object Accumulation</h3>
          <div>
            Stats: total={computed(() => taskStats.total)},
            completed={computed(() => taskStats.completed)},
            high={computed(() => taskStats.byPriority.high)},
            medium={computed(() => taskStats.byPriority.medium)},
            low={computed(() => taskStats.byPriority.low)}
          </div>
        </div>

        {/* TEST 4: Unique Collection */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 4: Reduce to collect unique tags</h3>
          <div>Tags: {computed(() => allTags.join(", ") || "(empty)")}</div>
          <div style={{ fontSize: "0.8rem", color: "#666" }}>
            Count: {computed(() => allTags.length)}
          </div>
        </div>

        {/* TEST 5: String Concatenation */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 5: Reduce string concatenation</h3>
          <div>{taskTitles || "(empty)"}</div>
        </div>

        {/* TEST 6: Keyed map() with string key */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 6: Keyed map() with string key</h3>
          <div style={{ fontFamily: "monospace", fontSize: "0.9rem" }}>
            {taskCards.map((card) => (
              <div key={card.id}>{card.display} - {card.tagCount} tags</div>
            ))}
          </div>
        </div>

        {/* TEST 7: Keyed map() with key function */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 7: Keyed map() with key function</h3>
          <div>
            {taskSummaries.map((summary) => (
              <div>{summary.title}: {summary.status}</div>
            ))}
          </div>
        </div>

        {/* TEST 8: Chained operations */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 8: Chained map + reduce</h3>
          <div>Total priority score: {totalPriorityScore}</div>
          <div style={{ fontSize: "0.8rem", color: "#666" }}>(high=3, medium=2, low=1)</div>
        </div>

        {/* TEST 9: Multiple reduces */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>TEST 9: Multiple reduces on same source</h3>
          <div style={{ display: "flex", gap: "2rem" }}>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>High</div>
              <div style={{ fontWeight: "bold" }}>{highPriorityCount}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>Medium</div>
              <div style={{ fontWeight: "bold" }}>{mediumPriorityCount}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>Low</div>
              <div style={{ fontWeight: "bold" }}>{lowPriorityCount}</div>
            </div>
          </div>
        </div>

        {/* Raw Data */}
        <div style={{ background: "#f0f4f8", padding: "1rem", borderRadius: "8px" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>Raw Data</h3>
          <pre style={{ background: "#fff", padding: "0.5rem", borderRadius: "4px", overflow: "auto", maxHeight: "200px", fontSize: "0.8rem" }}>
            {computed(() => JSON.stringify(tasks.get(), null, 2))}
          </pre>
        </div>
      </div>
    ),

    // Export all values for testing
    tasks,
    totalTasks,
    completedTasks,
    taskStats,
    allTags,
    taskTitles,
    taskCards,
    taskSummaries,
    mappedPriorities,
    totalPriorityScore,
    highPriorityCount,
    mediumPriorityCount,
    lowPriorityCount,
  };
});
