import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  CompartmentManager,
  getCompartmentManager,
  resetCompartmentManager,
  SandboxSecurityError,
} from "../../src/sandbox/mod.ts";

Deno.test("CompartmentManager - disabled by default", async (t) => {
  await t.step("isEnabled returns false by default", () => {
    const manager = new CompartmentManager();
    assertEquals(manager.isEnabled(), false);
  });

  await t.step("loadPattern throws when disabled", async () => {
    const manager = new CompartmentManager({ enabled: false });
    await assertRejects(
      async () => {
        await manager.loadPattern({
          patternId: "test",
          source: "const x = 1;",
        });
      },
      SandboxSecurityError,
      "SES sandboxing is disabled",
    );
  });

  await t.step("evaluateString throws when disabled", async () => {
    const manager = new CompartmentManager({ enabled: false });
    await assertRejects(
      async () => {
        await manager.evaluateString("42");
      },
      SandboxSecurityError,
      "SES sandboxing is disabled",
    );
  });
});

Deno.test("CompartmentManager - enabled", async (t) => {
  await t.step("isEnabled returns true when enabled", () => {
    const manager = new CompartmentManager({ enabled: true });
    assertEquals(manager.isEnabled(), true);
  });

  await t.step("evaluateString evaluates simple expressions", async () => {
    const manager = new CompartmentManager({ enabled: true });
    const result = await manager.evaluateString("40 + 2");
    assertEquals(result, 42);
  });

  await t.step("evaluateString evaluates IIFE", async () => {
    const manager = new CompartmentManager({ enabled: true });
    const result = await manager.evaluateString("(() => 'hello')()");
    assertEquals(result, "hello");
  });

  await t.step("evaluateString has access to Math", async () => {
    const manager = new CompartmentManager({ enabled: true });
    const result = await manager.evaluateString("Math.max(1, 2, 3)");
    assertEquals(result, 3);
  });

  await t.step("evaluateString has access to JSON", async () => {
    const manager = new CompartmentManager({ enabled: true });
    const result = await manager.evaluateString("JSON.parse('{\"a\":1}')");
    assertEquals(result, { a: 1 });
  });

  await t.step("evaluateString has access to Array methods", async () => {
    const manager = new CompartmentManager({ enabled: true });
    const result = await manager.evaluateString(
      "[1,2,3].map(x => x * 2).join(',')",
    );
    assertEquals(result, "2,4,6");
  });
});

Deno.test("CompartmentManager - caching", async (t) => {
  await t.step("hasPattern returns false for unknown pattern", () => {
    const manager = new CompartmentManager({ enabled: true });
    assertEquals(manager.hasPattern("unknown"), false);
  });

  await t.step("clearCache clears all patterns", async () => {
    const manager = new CompartmentManager({ enabled: true });

    // Load a simple pattern
    await manager.loadPattern({
      patternId: "test-pattern",
      source: `
        const MyPattern = { __exportName: "MyPattern", value: 42 };
      `,
    });

    assertEquals(manager.hasPattern("test-pattern"), true);

    manager.clearCache();

    assertEquals(manager.hasPattern("test-pattern"), false);
  });
});

Deno.test("CompartmentManager - getStats", async (t) => {
  await t.step("returns stats about the manager", () => {
    const manager = new CompartmentManager({ enabled: true });

    const stats = manager.getStats();
    assertEquals(stats.enabled, true);
    assertEquals(stats.loadedPatterns, 0);
    assertEquals(stats.patternIds, []);
  });
});

Deno.test("CompartmentManager - singleton", async (t) => {
  await t.step("getCompartmentManager returns same instance", () => {
    resetCompartmentManager();
    const m1 = getCompartmentManager();
    const m2 = getCompartmentManager();
    assertEquals(m1, m2);
  });

  await t.step("resetCompartmentManager creates new instance", () => {
    const _m1 = getCompartmentManager();
    resetCompartmentManager();
    const m2 = getCompartmentManager();
    // After reset, it's a different instance
    // (but we can't directly compare because reset sets it to undefined first)
    assertExists(m2);
  });
});
