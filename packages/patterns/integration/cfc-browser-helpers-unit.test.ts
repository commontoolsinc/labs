import { assertEquals } from "@std/assert";
import type { ProbeApi } from "@commonfabric/integration";
import { buttonDisabledIs, markForClick } from "./cfc-browser-helpers.ts";

type FakeElement = {
  shadowRoot?: { querySelector(selector: string): FakeElement | null };
  scrollIntoView(): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

function fakeElement(attributes: string[] = []): FakeElement {
  const values = new Map(attributes.map((name) => [name, ""]));
  return {
    scrollIntoView() {},
    hasAttribute: (name) => values.has(name),
    getAttribute: (name) => values.get(name) ?? null,
    setAttribute: (name, value) => values.set(name, value),
  };
}

Deno.test("markForClick skips a stale disabled match", async () => {
  const staleButton = fakeElement(["disabled"]);
  const activeButton = fakeElement();
  const staleHost = fakeElement();
  const activeHost = fakeElement();
  staleHost.shadowRoot = { querySelector: () => staleButton };
  activeHost.shadowRoot = { querySelector: () => activeButton };

  const probe = {
    collect: () => [staleHost, activeHost],
    isVisible: () => true,
  } as unknown as ProbeApi;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 1;
  };

  try {
    assertEquals(
      await markForClick(probe, "cf-button", "current", "data-target"),
      true,
    );
  } finally {
    globalThis.requestAnimationFrame = previousAnimationFrame;
  }

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
      isVisible: (element: unknown) =>
        element !== staleHost && element !== staleButton,
    } as unknown as ProbeApi;

    assertEquals(buttonDisabledIs(probe, "cf-button", false), true);
  } finally {
    globalThis.HTMLButtonElement = previousButtonClass;
  }
});
