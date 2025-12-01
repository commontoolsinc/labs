import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTMarkdown } from "./ct-markdown.ts";

describe("ct-markdown", () => {
  it("should be defined", () => {
    expect(CTMarkdown).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CTMarkdown();
    expect(element).toBeInstanceOf(CTMarkdown);
  });

  it("should have default empty content", () => {
    const element = new CTMarkdown();
    expect(element.content).toBe("");
  });

  it("should have default variant", () => {
    const element = new CTMarkdown();
    expect(element.variant).toBe("default");
  });

  it("should have streaming disabled by default", () => {
    const element = new CTMarkdown();
    expect(element.streaming).toBe(false);
  });

  it("should render basic markdown", () => {
    const el = new CTMarkdown();
    const markdown = "Hello **world**";

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain("<strong>world</strong>");
  });

  it("should replace LLM-friendly links with ct-cell-link", () => {
    const el = new CTMarkdown();
    const link = "/of:bafyabc123/path";
    const markdown = `Check this [Link](${link})`;

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain(
      `<ct-cell-link link="${link}" label="Link"></ct-cell-link>`,
    );
  });

  it("should wrap code blocks with copy buttons", () => {
    const el = new CTMarkdown();
    const markdown = "```js\nconsole.log('hello');\n```";

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain("code-block-container");
    expect(rendered).toContain("ct-copy-button");
  });

  it("should get content value from string", () => {
    const el = new CTMarkdown();
    el.content = "test content";

    const value = (el as any)._getContentValue();

    expect(value).toBe("test content");
  });

  it("should handle null/undefined content gracefully", () => {
    const el = new CTMarkdown();
    el.content = null as any;

    const value = (el as any)._getContentValue();

    expect(value).toBe("");
  });
});
