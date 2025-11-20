import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTChatMessage } from "./ct-chat-message.ts";

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

    expect(rendered).toContain(
      `<ct-cell-link link="${link}" label="Link"></ct-cell-link>`,
    );
  });
});
