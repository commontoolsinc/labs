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

  describe("Cell integration", () => {
    // Note: Full Cell integration testing requires real CellImpl instances
    // which are complex to mock. These tests verify the component's
    // subscription management logic with manual _unsubscribe manipulation.

    it("should have null _unsubscribe by default", () => {
      const el = new CTMarkdown();
      expect((el as any)._unsubscribe).toBeNull();
    });

    it("should cleanup subscription on disconnect", () => {
      const el = new CTMarkdown();

      // Simulate having a subscription
      let cleaned = false;
      (el as any)._unsubscribe = () => {
        cleaned = true;
      };

      // Trigger disconnect
      el.disconnectedCallback();

      expect(cleaned).toBe(true);
      expect((el as any)._unsubscribe).toBeNull();
    });

    it("should cleanup old subscription when willUpdate is called with changed content", () => {
      const el = new CTMarkdown();

      // Simulate having an old subscription
      let oldCleaned = false;
      (el as any)._unsubscribe = () => {
        oldCleaned = true;
      };

      // Trigger willUpdate with content change (string content, not Cell)
      el.content = "new content";
      (el as any).willUpdate(new Map([["content", "old content"]]));

      // Old subscription should have been cleaned up
      expect(oldCleaned).toBe(true);
      // No new subscription for string content
      expect((el as any)._unsubscribe).toBeNull();
    });
  });

  describe("variant", () => {
    it("should accept inverse variant", () => {
      const el = new CTMarkdown();
      el.variant = "inverse";
      expect(el.variant).toBe("inverse");
    });
  });

  describe("streaming", () => {
    it("should accept streaming prop", () => {
      const el = new CTMarkdown();
      el.streaming = true;
      expect(el.streaming).toBe(true);
    });
  });

  describe("entity decoding", () => {
    it("should decode basic HTML entities", () => {
      const el = new CTMarkdown();

      const decoded = (el as any)._decodeHtmlEntities("&lt;div&gt;&amp;&quot;");

      expect(decoded).toBe('<div>&"');
    });

    it("should decode numeric entities in fallback mode", () => {
      const el = new CTMarkdown();

      // Force fallback mode (test environment has no document)
      const decoded = (el as any)._decodeHtmlEntities("&#60;&#62;");

      expect(decoded).toBe("<>");
    });

    it("should decode hex entities in fallback mode", () => {
      const el = new CTMarkdown();

      const decoded = (el as any)._decodeHtmlEntities("&#x3C;&#x3E;");

      expect(decoded).toBe("<>");
    });
  });
});
