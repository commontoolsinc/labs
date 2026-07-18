import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { runtimeHostFlags, setupHostToggles } from "../src/lib/host-toggles.ts";

class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface Harness {
  storage: FakeStorage;
  restore: () => void;
}

function setup(): Harness {
  const storage = new FakeStorage();
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });

  const cfGlobal = globalThis as { commonfabric?: unknown };
  const originalCommonfabric = cfGlobal.commonfabric;
  cfGlobal.commonfabric = {};

  const realInfo = console.info;
  console.info = () => {};

  return {
    storage,
    restore: () => {
      console.info = realInfo;
      if (storageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", storageDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
      if (originalCommonfabric === undefined) {
        delete cfGlobal.commonfabric;
      } else {
        cfGlobal.commonfabric = originalCommonfabric;
      }
    },
  };
}

describe("setupHostToggles", () => {
  it("installs every commonfabric.* host-toggle command", () => {
    const h = setup();
    try {
      setupHostToggles();
      const cf = (globalThis as {
        commonfabric?: Record<string, unknown>;
      }).commonfabric;
      expect(typeof cf?.forwardWorkerConsole).toBe("function");
      expect(typeof cf?.cfcRenderCeiling).toBe("function");
    } finally {
      h.restore();
    }
  });
});

describe("runtimeHostFlags", () => {
  it("defaults every flag to false", () => {
    const h = setup();
    try {
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: false,
        cfcRenderCeiling: false,
        patternCoverage: false,
      });
    } finally {
      h.restore();
    }
  });

  it("reflects the persisted per-toggle state", () => {
    const h = setup();
    try {
      h.storage.map.set("forwardWorkerConsole", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: false,
        patternCoverage: false,
      });
      h.storage.map.set("cfcRenderCeiling", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: true,
        patternCoverage: false,
      });
      h.storage.map.set("patternCoverage", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: true,
        patternCoverage: true,
      });
    } finally {
      h.restore();
    }
  });
});
