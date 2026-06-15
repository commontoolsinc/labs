/**
 * Unit tests for cf-tabs' cf-change emission contract (CT-1746 / CT-1745).
 *
 * The product bug: cf-tabs emitted `cf-change` on EVERY change to the bound
 * cell — including programmatic / cell-driven changes — so any `oncf-change`
 * handler that wrote the bound cell formed an unbreakable feedback loop
 * ("Too many iterations"). The fix emits `cf-change` ONLY for user gestures
 * (click / keyboard), while cell-driven changes still sync the selection.
 *
 * cf-tabs extends Lit's HTMLElement, which Deno's headless `deno test` runner
 * does not provide. We install a minimal DOM shim (the same "mock only the
 * surface the code under test touches" approach used by
 * packages/html/test/main-applicator.test.ts) so we can construct the real
 * component and drive its real handlers. The cell binding uses the shared
 * createMockCellHandle util, exactly like cell-controller.test.ts.
 */

// ---------------------------------------------------------------------------
// Minimal DOM shim — installed BEFORE importing the component so that Lit's
// ReactiveElement base class has an HTMLElement to extend.
// ---------------------------------------------------------------------------

interface ShadowStub {
  querySelector(): null;
  addEventListener(): void;
}

class FakeHTMLElement {
  attributes = new Map<string, string>();
  _listeners: Record<string, Array<(e: any) => void>> = {};
  shadowRoot: ShadowStub | null = null;

  addEventListener(type: string, handler: (e: any) => void): void {
    (this._listeners[type] ||= []).push(handler);
  }
  removeEventListener(type: string, handler: (e: any) => void): void {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(event: { type: string }): boolean {
    (this._listeners[event.type] ?? []).forEach((h) => h(event));
    return true;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  querySelectorAll(): unknown[] {
    return [];
  }
  querySelector(): unknown {
    return null;
  }
  attachShadow(): ShadowStub {
    this.shadowRoot = { querySelector: () => null, addEventListener: () => {} };
    return this.shadowRoot;
  }
  getRootNode(): this {
    return this;
  }
  get isConnected(): boolean {
    return false;
  }
}

class FakeTab {
  value: string;
  disabled = false;
  selected = false;
  attributes = new Map<string, string>();
  constructor(value: string) {
    this.value = value;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeTabPanel {
  value: string;
  hidden = false;
  attributes = new Map<string, string>();
  constructor(value: string) {
    this.value = value;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

const g = globalThis as Record<string, unknown>;
g.HTMLElement = FakeHTMLElement;
g.customElements = { define: () => {}, get: () => undefined };
g.requestAnimationFrame = (_cb: () => void) => 0;
g.cancelAnimationFrame = () => {};

// ---------------------------------------------------------------------------

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stringSchema } from "@commonfabric/runner/schemas";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CFTabs } from "./cf-tabs.ts";

/**
 * Build a CFTabs instance wired to fake tabs/panels and a mock cell, with its
 * cell controller bound (as firstUpdated would do). Returns helpers to drive
 * and observe it.
 */
function makeTabs(cell: CellHandle<string>, tabValues: string[]) {
  const tabs = new CFTabs();
  const fakeTabs = tabValues.map((v) => new FakeTab(v));
  const fakePanels = tabValues.map((v) => new FakeTabPanel(v));

  // Route querySelectorAll to our fake children.
  (tabs as unknown as {
    querySelectorAll: (sel: string) => unknown[];
  }).querySelectorAll = (sel: string) => {
    if (sel === "cf-tab") return fakeTabs;
    if (sel === "cf-tab-panel") return fakePanels;
    return [];
  };

  // Bind the cell the way firstUpdated() does, and seed initial selection.
  (tabs as unknown as { value: CellHandle<string> }).value = cell;
  const ctrl = (tabs as unknown as {
    _cellController: {
      bind: (v: CellHandle<string>, s: unknown) => void;
    };
  })._cellController;
  ctrl.bind(cell, stringSchema);
  (tabs as unknown as { updateTabSelection: () => void }).updateTabSelection();

  // cf-change events are emitted via dispatchEvent (BaseElement.emit).
  const changes: Array<{ value: string; oldValue: string }> = [];
  const orig = (tabs as unknown as { dispatchEvent: (e: any) => boolean })
    .dispatchEvent.bind(tabs);
  (tabs as unknown as { dispatchEvent: (e: any) => boolean }).dispatchEvent = (
    e: any,
  ) => {
    if (e?.type === "cf-change") changes.push(e.detail);
    return orig(e);
  };

  const clickTab = (value: string) => {
    const tab = fakeTabs.find((t) => t.value === value);
    (tabs as unknown as {
      handleTabClick: (e: { detail: { tab: unknown } }) => void;
    }).handleTabClick({ detail: { tab } });
  };

  const selectedTab = () => fakeTabs.find((t) => t.selected)?.value;
  const visiblePanel = () => fakePanels.find((p) => !p.hidden)?.value;

  return {
    tabs,
    fakeTabs,
    fakePanels,
    changes,
    clickTab,
    selectedTab,
    visiblePanel,
  };
}

describe("CFTabs cf-change emission contract (CT-1746)", () => {
  it("emits exactly ONE cf-change on a user tab click", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    h.clickTab("progress");

    expect(h.changes.length).toBe(1);
    expect(h.changes[0].value).toBe("progress");
    expect(h.changes[0].oldValue).toBe("active");
    // User click writes through to the bound cell (problem-2 propagation).
    expect(cell.get()).toBe("progress");
    expect(h.selectedTab()).toBe("progress");
  });

  it("does NOT emit cf-change for a programmatic / cell-driven change, but still syncs selection", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    // Simulate a backend / programmatic update to the bound cell — the exact
    // path that previously echoed cf-change and closed the feedback loop.
    pushUpdate(cell, "pending");

    expect(h.changes.length).toBe(0);
    // Visual selection must still follow the cell.
    expect(h.selectedTab()).toBe("pending");
    expect(h.visiblePanel()).toBe("pending");
  });

  it("supports $value-only binding: a user click switches selection with NO cf-change listener", () => {
    // No cf-change consumer at all — selection must be driven purely by the
    // controller write-back to the bound cell. This is what lets consumers
    // drop the load-bearing-but-cyclic oncf-change handler.
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);

    h.clickTab("feed");

    expect(cell.get()).toBe("feed");
    expect(h.selectedTab()).toBe("feed");
    expect(h.visiblePanel()).toBe("feed");
  });

  it("does not re-emit when clicking the already-selected tab", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress"]);
    h.changes.length = 0;

    h.clickTab("active"); // same as current value

    expect(h.changes.length).toBe(0);
    expect(cell.get()).toBe("active");
  });

  it("ignores clicks on disabled tabs", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress"]);
    h.fakeTabs[1].disabled = true;
    h.changes.length = 0;

    h.clickTab("progress");

    expect(h.changes.length).toBe(0);
    expect(cell.get()).toBe("active");
  });
});
