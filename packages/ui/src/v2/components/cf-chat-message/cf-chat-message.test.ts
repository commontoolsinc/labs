import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFChatMessage } from "./cf-chat-message.ts";

describe("cf-chat-message", () => {
  it("should be defined", () => {
    expect(CFChatMessage).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CFChatMessage();
    expect(element).toBeInstanceOf(CFChatMessage);
  });

  it("should have default role of user", () => {
    const element = new CFChatMessage();
    expect(element.role).toBe("user");
  });

  it("should have streaming disabled by default", () => {
    const element = new CFChatMessage();
    expect(element.streaming).toBe(false);
  });

  it("should extract text content from string", () => {
    const el = new CFChatMessage();
    el.content = "Hello world";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should extract text content from array with text parts", () => {
    const el = new CFChatMessage();
    el.content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ] as any;

    const text = (el as any)._extractTextContent();

    expect(text).toBe("Hello world");
  });

  it("should return empty string for empty content", () => {
    const el = new CFChatMessage();
    el.content = "";

    const text = (el as any)._extractTextContent();

    expect(text).toBe("");
  });

  // Note: Markdown rendering is now tested in cf-markdown.test.ts
  // cf-chat-message delegates to cf-markdown component
});
