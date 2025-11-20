import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTChatMessage } from "./ct-chat-message.ts";
import type { IRuntime } from "@commontools/runner";

describe("ct-chat-message", () => {
  it("should be defined", () => {
    expect(CTChatMessage).toBeDefined();
  });

  it("should replace LLM-friendly links with ct-cell-link in _renderMarkdown", () => {
    const el = new CTChatMessage();
    const link = "/of:bafyabc123/path";
    const markdown = `Check this [Link](${link})`;

    // Access private method
    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain(`<ct-cell-link link="${link}"></ct-cell-link>`);
  });

  it("should hydrate ct-cell-link with runtime in updated", () => {
    const el = new CTChatMessage();
    const mockRuntime = {
      getCellFromLink: () => ({}),
      navigateCallback: () => {},
    } as unknown as IRuntime;

    el.runtime = mockRuntime;

    // Mock shadowRoot and querySelectorAll
    const mockLink = { runtime: undefined };
    const mockShadowRoot = {
      querySelectorAll: (selector: string) => {
        if (selector === "ct-cell-link") {
          return [mockLink];
        }
        return [];
      },
    };

    Object.defineProperty(el, "shadowRoot", {
      value: mockShadowRoot,
      writable: true,
    });

    // Call updated manually
    el.updated(new Map([["runtime", undefined]]));

    expect(mockLink.runtime).toBe(mockRuntime);
  });
});
