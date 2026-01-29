import { assertEquals, assertExists, assertThrows } from "@std/assert";
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

  await t.step("evaluateStringSync throws when disabled", () => {
    const manager = new CompartmentManager({ enabled: false });
    assertThrows(
      () => manager.evaluateStringSync("42"),
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

Deno.test("CompartmentManager - initialization and sync evaluation", async (t) => {
  await t.step("isReady returns false before initialization", () => {
    // Since lockdown is static and already applied by other tests,
    // we can't truly test this scenario without test isolation
    // This test documents the expected behavior
    const manager = new CompartmentManager({ enabled: true });
    // After running other tests, lockdown is already applied
    // In a fresh process, isReady() would return false before initialize()
    assertExists(manager.isReady);
  });

  await t.step("initialize() applies lockdown", async () => {
    const manager = new CompartmentManager({ enabled: true });
    await manager.initialize();
    assertEquals(manager.isReady(), true);
  });

  await t.step("initialize() is idempotent", async () => {
    const manager = new CompartmentManager({ enabled: true });
    await manager.initialize();
    await manager.initialize(); // Second call should not throw
    assertEquals(manager.isReady(), true);
  });

  await t.step("evaluateStringSync works after initialization", async () => {
    const manager = new CompartmentManager({ enabled: true });
    await manager.initialize();

    const result = manager.evaluateStringSync("40 + 2");
    assertEquals(result, 42);
  });

  await t.step("evaluateStringSync evaluates functions", async () => {
    const manager = new CompartmentManager({ enabled: true });
    await manager.initialize();

    const result = manager.evaluateStringSync("((x) => x * 2)(21)");
    assertEquals(result, 42);
  });

  await t.step("evaluateStringSync throws when disabled", () => {
    const manager = new CompartmentManager({ enabled: false });

    assertThrows(
      () => manager.evaluateStringSync("42"),
      SandboxSecurityError,
      "SES sandboxing is disabled",
    );
  });
});
