import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTChatMessage } from "./ct-chat-message.ts";

describe("ct-chat-message", () => {
  it("should be defined", () => {
    expect(CTChatMessage).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CTChatMessage();
    expect(element).toBeInstanceOf(CTChatMessage);
  });

  it("should have default role of user", () => {
    const element = new CTChatMessage();
    expect(element.role).toBe("user");
  });

  it("should have streaming disabled by default", () => {
    const element = new CTChatMessage();
    expect(element.streaming).toBe(false);
  });

  it("should extract text content from string", () => {
    const el = new CTChatMessage();
    el.content = "Hello world";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should extract text content from array with text parts", () => {
    const el = new CTChatMessage();
    el.content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ] as any;

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should return empty string for empty content", () => {
    const el = new CTChatMessage();
    el.content = "";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("");
  });

  // Note: Markdown rendering is now tested in ct-markdown.test.ts
  // ct-chat-message delegates to ct-markdown component
});
