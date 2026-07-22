import { assertEquals } from "@std/assert";
import type { ProbeApi } from "@commonfabric/integration";
import { buttonDisabledIs, markForClick } from "./cfc-browser-helpers.ts";

type FakeElement = {
  isConnected: boolean;
  shadowRoot?: { querySelector(selector: string): FakeElement | null };
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

function fakeElement(attributes: string[] = []): FakeElement {
  const values = new Map(attributes.map((name) => [name, ""]));
  return {
    isConnected: true,
    hasAttribute: (name) => values.has(name),
    getAttribute: (name) => values.get(name) ?? null,
    setAttribute: (name, value) => values.set(name, value),
  };
}

Deno.test("markForClick skips a stale disabled match", () => {
  const staleButton = fakeElement(["disabled"]);
  const activeButton = fakeElement();
  const staleHost = fakeElement();
  const activeHost = fakeElement();
  staleHost.shadowRoot = { querySelector: () => staleButton };
  activeHost.shadowRoot = { querySelector: () => activeButton };

  const probe = {
    collect: () => [staleHost, activeHost],
    isRendered: () => true,
  } as unknown as ProbeApi;

  assertEquals(
    markForClick(probe, "cf-button", "current", "data-target"),
    true,
  );

  assertEquals(staleButton.getAttribute("data-target"), null);
  assertEquals(activeButton.getAttribute("data-target"), "current");
});

Deno.test("buttonDisabledIs skips a hidden stale match", () => {
  const previousButtonClass = globalThis.HTMLButtonElement;
  class FakeButton {
    constructor(readonly disabled: boolean) {}
  }
  (globalThis as unknown as { HTMLButtonElement: typeof FakeButton })
    .HTMLButtonElement = FakeButton;

  try {
    const staleButton = new FakeButton(true);
    const activeButton = new FakeButton(false);
    const staleHost = {
      shadowRoot: { querySelector: () => staleButton },
    };
    const activeHost = {
      shadowRoot: { querySelector: () => activeButton },
    };
    const probe = {
      collect: () => [staleHost, activeHost],
      isRendered: (element: unknown) =>
        element !== staleHost && element !== staleButton,
      isVisible: (element: unknown) =>
        element !== staleHost && element !== staleButton,
    } as unknown as ProbeApi;

    assertEquals(buttonDisabledIs(probe, "cf-button", false), true);
  } finally {
    globalThis.HTMLButtonElement = previousButtonClass;
  }
});

Deno.test("buttonDisabledIs skips a visible match with stale state", () => {
  const previousButtonClass = globalThis.HTMLButtonElement;
  class FakeButton {
    constructor(readonly disabled: boolean) {}
  }
  (globalThis as unknown as { HTMLButtonElement: typeof FakeButton })
    .HTMLButtonElement = FakeButton;

  try {
    const staleButton = new FakeButton(false);
    const currentButton = new FakeButton(true);
    const probe = {
      collect: () => [
        { shadowRoot: { querySelector: () => staleButton } },
        { shadowRoot: { querySelector: () => currentButton } },
      ],
      isRendered: () => true,
      isVisible: () => true,
    } as unknown as ProbeApi;

    assertEquals(buttonDisabledIs(probe, "cf-button", true), true);
  } finally {
    globalThis.HTMLButtonElement = previousButtonClass;
  }
});

Deno.test("buttonDisabledIs accepts a rendered control outside the viewport", () => {
  const previousButtonClass = globalThis.HTMLButtonElement;
  class FakeButton {
    constructor(readonly disabled: boolean) {}
  }
  (globalThis as unknown as { HTMLButtonElement: typeof FakeButton })
    .HTMLButtonElement = FakeButton;

  try {
    const button = new FakeButton(true);
    const host = { shadowRoot: { querySelector: () => button } };
    const probe = {
      collect: () => [host],
      isRendered: () => true,
      isVisible: () => false,
    } as unknown as ProbeApi;

    assertEquals(buttonDisabledIs(probe, "cf-button", true), true);
  } finally {
    globalThis.HTMLButtonElement = previousButtonClass;
  }
});
