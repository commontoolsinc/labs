import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  determineTriggeredActions,
  sortAndCompactPaths,
  type SortedAndCompactPaths,
  type TriggerPaths,
} from "../src/reactive-dependencies.ts";
import type { Action } from "../src/scheduler.ts";
import type { JSONValue } from "../src/builder/types.ts";

describe("sortAndCompactPaths", () => {
  it("returns empty array for empty input", () => {
    const result = sortAndCompactPaths([]);
    expect(result).toEqual([]);
  });

  it("returns single path unchanged", () => {
    const paths: TriggerPaths = [["a", "b", "c"]];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([["a", "b", "c"]]);
  });

  it("sorts paths lexicographically", () => {
    const paths: TriggerPaths = [
      ["b", "c"],
      ["a", "z"],
      ["a", "b"],
      ["c"],
    ];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([
      ["a", "b"],
      ["a", "z"],
      ["b", "c"],
      ["c"],
    ]);
  });

  it("removes paths that are prefixes of other paths", () => {
    const paths: TriggerPaths = [
      ["a", "b", "c", "d"],
      ["a", "b"],
      ["a", "b", "c"],
      ["x", "y"],
    ];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });

  it("handles complex compactification", () => {
    const paths: TriggerPaths = [
      ["users", "123", "name"],
      ["users", "123"],
      ["users", "456", "email"],
      ["users", "456"],
      ["posts", "abc", "title"],
      ["posts"],
    ];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([
      ["posts"],
      ["users", "123"],
      ["users", "456"],
    ]);
  });

  it("preserves paths with common prefixes but different suffixes", () => {
    const paths: TriggerPaths = [
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "e"],
    ];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "e"],
    ]);
  });

  it("handles paths with numeric strings correctly", () => {
    const paths: TriggerPaths = [
      ["2", "b"],
      ["10", "a"],
      ["1", "c"],
    ];
    const result = sortAndCompactPaths(paths);
    expect(result).toEqual([
      ["1", "c"],
      ["10", "a"],
      ["2", "b"],
    ]);
  });
});

describe("determineTriggeredActions", () => {
  // Helper to create mock actions
  const createAction = (id: string): Action => ({
    schedule: () => {},
    name: id,
  } as unknown as Action);

  describe("basic functionality", () => {
    it("returns empty array when no dependencies", () => {
      const dependencies = new Map<Action, SortedAndCompactPaths>();
      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toEqual([]);
    });

    it("triggers action when simple path value changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger action when value remains the same", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 1 },
      );
      expect(result).toEqual([]);
    });

    it("triggers multiple actions for same path", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
        [action2, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: 2 },
      );
      expect(result).toContain(action1);
      expect(result).toContain(action2);
      expect(result).toHaveLength(2);
    });
  });

  describe("nested paths", () => {
    it("triggers on nested path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice", age: 30 } },
        { user: { name: "Bob", age: 30 } },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers on deeply nested path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b", "c", "d"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: { b: { c: { d: 1 } } } },
        { a: { b: { c: { d: 2 } } } },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger when nested value unchanged", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice", age: 30 } },
        { user: { name: "Alice", age: 31 } },
      );
      expect(result).toEqual([]);
    });

    it("triggers parent path when child changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { name: "Alice" } },
        { user: { name: "Bob" } },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("multiple paths per action", () => {
    it("triggers when any watched path changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"], ["b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1, b: 2 },
        { a: 1, b: 3 },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers only once even if multiple paths change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"], ["b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1, b: 2 },
        { a: 2, b: 3 },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("undefined and null handling", () => {
    it("triggers when value becomes undefined", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: 1 },
        { a: undefined } as unknown as JSONValue,
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when undefined becomes value", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        undefined,
        { a: 1 },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when path doesn't exist in before", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { x: 1 },
        { a: { b: 2 } },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers when path doesn't exist in after", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: { b: 2 } },
        { x: 1 },
      );
      expect(result).toEqual([action1]);
    });

    it("handles null values correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: null },
        { a: null },
      );
      expect(result).toEqual([]);
    });

    it("triggers when null changes to value", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { a: null },
        { a: 1 },
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("array handling", () => {
    it("triggers on array element change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "0"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b", "c"] },
        { items: ["x", "b", "c"] },
      );
      expect(result).toEqual([action1]);
    });

    it("triggers on array length change", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b"] },
        { items: ["a", "b", "c"] },
      );
      expect(result).toEqual([action1]);
    });

    it("handles array index paths correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "1", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: [{ name: "a" }, { name: "b" }] },
        { items: [{ name: "a" }, { name: "c" }] },
      );
      expect(result).toEqual([action1]);
    });

    it("does not trigger on non-existent array index", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["items", "5"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { items: ["a", "b"] },
        { items: ["x", "y"] },
      );
      expect(result).toEqual([]);
    });
  });

  describe("startPath parameter", () => {
    it("filters dependencies based on startPath", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
        [action2, [["post", "title"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { name: "Alice" },
        { name: "Bob" },
        ["user"],
      );
      expect(result).toEqual([action1]);
    });

    it("handles nested startPath correctly", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b", "c"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { c: 1 },
        { c: 2 },
        ["a", "b"],
      );
      expect(result).toEqual([action1]);
    });

    it("returns empty when startPath doesn't match any dependencies", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user", "name"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { title: "Old" },
        { title: "New" },
        ["post"],
      );
      expect(result).toEqual([]);
    });

    it("handles multiple levels with startPath", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["users", "123", "profile", "name"]]],
        [action2, [["users", "123", "settings"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { profile: { name: "Alice" }, settings: { theme: "dark" } },
        { profile: { name: "Bob" }, settings: { theme: "dark" } },
        ["users", "123"],
      );
      expect(result).toEqual([action1]);
    });

    it("works with undefined data and startPath", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a", "b"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        undefined,
        { b: 1 },
        ["a"],
      );
      expect(result).toEqual([action1]);
    });
  });

  describe("edge cases", () => {
    it("handles empty object to empty object", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["a"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        {},
        {},
      );
      expect(result).toEqual([]);
    });

    it("handles complex object equality", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const obj = { x: { y: { z: [1, 2, 3] } } };
      const result = determineTriggeredActions(
        dependencies,
        { data: obj },
        { data: obj },
      );
      expect(result).toEqual([]);
    });

    it("detects deep object changes", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: { x: { y: { z: [1, 2, 3] } } } },
        { data: { x: { y: { z: [1, 2, 4] } } } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles mixed primitive types", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["value"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { value: "123" },
        { value: 123 },
      );
      expect(result).toEqual([action1]);
    });

    it("handles boolean values", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["flag"]]],
      ]);

      const result1 = determineTriggeredActions(
        dependencies,
        { flag: true },
        { flag: false },
      );
      expect(result1).toEqual([action1]);

      const result2 = determineTriggeredActions(
        dependencies,
        { flag: true },
        { flag: true },
      );
      expect(result2).toEqual([]);
    });
  });

  describe("performance and stress tests", () => {
    it("handles many dependencies efficiently", () => {
      const actions: Action[] = [];
      const dependencies = new Map<Action, SortedAndCompactPaths>();

      // Create 1000 actions with different paths
      for (let i = 0; i < 1000; i++) {
        const action = createAction(`action${i}`);
        actions.push(action);
        dependencies.set(action, [[`item${i}`]]);
      }

      const before: JSONValue = {};
      const after: JSONValue = {};
      for (let i = 0; i < 1000; i++) {
        (before as any)[`item${i}`] = i;
        (after as any)[`item${i}`] = i;
      }
      // Change one value
      (after as any).item500 = "changed";

      const startTime = performance.now();
      const result = determineTriggeredActions(dependencies, before, after);
      const endTime = performance.now();

      expect(result).toEqual([actions[500]]);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast
    });

    it("handles deeply nested paths efficiently", () => {
      const action1 = createAction("action1");
      const deepPath = Array.from({ length: 20 }, (_, i) => `level${i}`);
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [deepPath]],
      ]);

      // Create deeply nested objects
      const before: any = {};
      const after: any = {};
      let currentBefore = before;
      let currentAfter = after;
      for (let i = 0; i < deepPath.length - 1; i++) {
        currentBefore[deepPath[i]] = {};
        currentAfter[deepPath[i]] = {};
        currentBefore = currentBefore[deepPath[i]];
        currentAfter = currentAfter[deepPath[i]];
      }
      currentBefore[deepPath[deepPath.length - 1]] = "before";
      currentAfter[deepPath[deepPath.length - 1]] = "after";

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([action1]);
    });

    it("handles many paths per action", () => {
      const action1 = createAction("action1");
      const paths: SortedAndCompactPaths = Array.from(
        { length: 100 },
        (_, i) => [`field${i}`],
      );
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, paths],
      ]);

      const before: any = {};
      const after: any = {};
      for (let i = 0; i < 100; i++) {
        before[`field${i}`] = i;
        after[`field${i}`] = i;
      }
      after.field50 = "changed";

      const result = determineTriggeredActions(dependencies, before, after);
      expect(result).toEqual([action1]);
    });
  });

  describe("complex scenarios", () => {
    it("handles multiple actions with different nested dependencies", () => {
      const action1 = createAction("action1");
      const action2 = createAction("action2");
      const action3 = createAction("action3");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["user"]]], // Watches entire user object
        [action2, [["user", "profile", "name"]]], // Watches specific nested field
        [action3, [["user", "settings"]]], // Watches different branch
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { user: { profile: { name: "Alice", age: 30 }, settings: {} } },
        { user: { profile: { name: "Bob", age: 30 }, settings: {} } },
      );

      expect(result).toContain(action1); // Should trigger because user.profile changed
      expect(result).toContain(action2); // Should trigger because user.profile.name changed
      expect(result).not.toContain(action3); // Should not trigger because user.settings didn't change
    });

    it("handles type changes in nested structures", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data", "value"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: { value: { nested: true } } },
        { data: { value: "string" } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles array to object conversion", () => {
      const action1 = createAction("action1");
      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [action1, [["data"]]],
      ]);

      const result = determineTriggeredActions(
        dependencies,
        { data: [1, 2, 3] },
        { data: { "0": 1, "1": 2, "2": 3 } },
      );
      expect(result).toEqual([action1]);
    });

    it("handles complex real-world scenario", () => {
      const userPrefsAction = createAction("userPrefsAction");
      const userNameAction = createAction("userNameAction");
      const featuredPostsAction = createAction("featuredPostsAction");
      const recentPostsAction = createAction("recentPostsAction");
      const unreadCountAction = createAction("unreadCountAction");
      const notificationItemsAction = createAction("notificationItemsAction");
      const settingsAction = createAction("settingsAction");
      const analyticsAction = createAction("analyticsAction");

      const dependencies = new Map<Action, SortedAndCompactPaths>([
        [userPrefsAction, [["currentUser", "preferences"]]],
        [userNameAction, [["currentUser", "name"]]],
        [featuredPostsAction, [["posts", "featured"]]],
        [recentPostsAction, [["posts", "recent"]]],
        [unreadCountAction, [["notifications", "unread"]]],
        [notificationItemsAction, [["notifications", "items"]]],
        [settingsAction, [["settings"]]],
        [analyticsAction, [["analytics", "pageViews"], ["analytics", "sessions"]]],
      ]);

      const before = {
        currentUser: {
          id: "123",
          name: "Alice",
          preferences: { theme: "light", language: "en" },
          lastLogin: "2024-01-01",
        },
        posts: {
          featured: ["post1", "post2"],
          recent: ["post3", "post4"],
          drafts: [],
        },
        notifications: {
          unread: 5,
          items: [],
          settings: { email: true, push: false },
        },
        settings: {
          privacy: "public",
          autoSave: true,
        },
        analytics: {
          pageViews: 1000,
          sessions: 50,
          bounceRate: 0.3,
        },
      };

      const after = {
        currentUser: {
          id: "123",
          name: "Alice",  // Same name
          preferences: { theme: "dark", language: "en" },  // Theme changed
          lastLogin: "2024-01-02",  // Changed but not watched
        },
        posts: {
          featured: ["post1", "post2"],  // Same featured posts
          recent: ["post3", "post4", "post5"],  // Added a new recent post
          drafts: ["draft1"],  // Changed but not watched
        },
        notifications: {
          unread: 6,  // Incremented
          items: [{ id: "n1" }],  // Added new item
          settings: { email: false, push: false },  // Changed but not watched
        },
        settings: {
          privacy: "public",  // Same
          autoSave: true,  // Same
        },
        analytics: {
          pageViews: 1250,  // Changed
          sessions: 50,  // Same
          bounceRate: 0.25,  // Changed but not watched
        },
      };

      const result = determineTriggeredActions(
        dependencies,
        before as JSONValue,
        after as JSONValue,
      );

      // Should trigger
      expect(result).toContain(userPrefsAction); // preferences.theme changed
      expect(result).toContain(recentPostsAction); // posts.recent changed
      expect(result).toContain(unreadCountAction); // notifications.unread changed
      expect(result).toContain(notificationItemsAction); // notifications.items changed
      expect(result).toContain(analyticsAction); // analytics.pageViews changed

      // Should NOT trigger
      expect(result).not.toContain(userNameAction); // name didn't change
      expect(result).not.toContain(featuredPostsAction); // featured posts didn't change
      expect(result).not.toContain(settingsAction); // settings didn't change
    });
  });
});

// Benchmarks
Deno.bench("sortAndCompactPaths - small dataset", () => {
  const paths: TriggerPaths = [
    ["user", "name"],
    ["user"],
    ["posts", "0", "title"],
    ["posts"],
    ["settings", "theme"],
  ];
  sortAndCompactPaths(paths);
});

Deno.bench("sortAndCompactPaths - large dataset", () => {
  const paths: TriggerPaths = [];
  for (let i = 0; i < 1000; i++) {
    paths.push([`field${i}`]);
    if (i % 10 === 0) {
      paths.push([`field${i}`, "nested"]);
      paths.push([`field${i}`, "nested", "deep"]);
    }
  }
  sortAndCompactPaths(paths);
});

Deno.bench("sortAndCompactPaths - deeply nested paths", () => {
  const paths: TriggerPaths = [];
  for (let i = 0; i < 100; i++) {
    const depth = Math.floor(Math.random() * 10) + 1;
    const path = Array.from({ length: depth }, (_, j) => `level${j}`);
    paths.push(path);
  }
  sortAndCompactPaths(paths);
});

Deno.bench("determineTriggeredActions - simple change", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [["user", "name"]]],
  ]);
  
  determineTriggeredActions(
    dependencies,
    { user: { name: "Alice", age: 30 } },
    { user: { name: "Bob", age: 30 } },
  );
});

Deno.bench("determineTriggeredActions - no changes", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [["user", "name"]]],
  ]);
  
  const data = { user: { name: "Alice", age: 30 } };
  determineTriggeredActions(dependencies, data, data);
});

Deno.bench("determineTriggeredActions - many dependencies", () => {
  const dependencies = new Map<Action, SortedAndCompactPaths>();
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  
  for (let i = 0; i < 100; i++) {
    const action = { 
      schedule: () => {}, 
      name: `action${i}` 
    } as unknown as Action;
    dependencies.set(action, [[`field${i}`]]);
    before[`field${i}`] = i;
    after[`field${i}`] = i;
  }
  // Change one field
  after.field50 = -1;
  
  determineTriggeredActions(
    dependencies,
    before as JSONValue,
    after as JSONValue,
  );
});

Deno.bench("determineTriggeredActions - deep nesting", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const deepPath = Array.from({ length: 10 }, (_, i) => `level${i}`);
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, [deepPath]],
  ]);
  
  // Create deeply nested objects
  const createNested = (value: string) => {
    let result: any = value;
    for (let i = deepPath.length - 1; i >= 0; i--) {
      result = { [deepPath[i]]: result };
    }
    return result;
  };
  
  determineTriggeredActions(
    dependencies,
    createNested("before"),
    createNested("after"),
  );
});

Deno.bench("determineTriggeredActions - multiple paths per action", () => {
  const action = { schedule: () => {}, name: "action" } as unknown as Action;
  const paths: SortedAndCompactPaths = Array.from(
    { length: 20 },
    (_, i) => [`field${i}`],
  );
  const dependencies = new Map<Action, SortedAndCompactPaths>([
    [action, paths],
  ]);
  
  const before: any = {};
  const after: any = {};
  for (let i = 0; i < 20; i++) {
    before[`field${i}`] = i;
    after[`field${i}`] = i;
  }
  after.field10 = "changed";
  
  determineTriggeredActions(dependencies, before, after);
});

Deno.bench("determineTriggeredActions - complex real-world", () => {
  const dependencies = new Map<Action, SortedAndCompactPaths>();
  
  // Simulate a real app with various watchers
  const actions = [
    { paths: [["currentUser"]], name: "userWatcher" },
    { paths: [["currentUser", "preferences"]], name: "prefsWatcher" },
    { paths: [["posts"]], name: "postsWatcher" },
    { paths: [["posts", "0"], ["posts", "1"], ["posts", "2"]], name: "topPostsWatcher" },
    { paths: [["notifications", "unread"]], name: "unreadWatcher" },
    { paths: [["ui", "theme"]], name: "themeWatcher" },
    { paths: [["ui", "sidebar", "collapsed"]], name: "sidebarWatcher" },
  ];
  
  for (const { paths, name } of actions) {
    const action = { schedule: () => {}, name } as unknown as Action;
    dependencies.set(action, paths);
  }
  
  const before = {
    currentUser: {
      id: "123",
      name: "Alice",
      preferences: { theme: "light", notifications: true },
    },
    posts: [
      { id: "p1", title: "Post 1", likes: 10 },
      { id: "p2", title: "Post 2", likes: 20 },
      { id: "p3", title: "Post 3", likes: 30 },
    ],
    notifications: { unread: 5, items: [] },
    ui: {
      theme: "light",
      sidebar: { collapsed: false, width: 250 },
    },
  };
  
  const after = {
    currentUser: {
      id: "123",
      name: "Alice",
      preferences: { theme: "dark", notifications: true },
    },
    posts: [
      { id: "p1", title: "Post 1", likes: 11 },
      { id: "p2", title: "Post 2", likes: 20 },
      { id: "p3", title: "Post 3", likes: 30 },
    ],
    notifications: { unread: 6, items: [{ id: "n1" }] },
    ui: {
      theme: "dark",
      sidebar: { collapsed: false, width: 250 },
    },
  };
  
  determineTriggeredActions(
    dependencies,
    before as JSONValue,
    after as JSONValue,
  );
});
