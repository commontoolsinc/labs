import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFMarkdown } from "./index.ts";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";

describe("cf-markdown", () => {
  it("should be defined", () => {
    expect(CFMarkdown).toBeDefined();
  });

  it("should create element instance", () => {
    const element = new CFMarkdown();
    expect(element).toBeInstanceOf(CFMarkdown);
  });

  it("should have default empty content", () => {
    const element = new CFMarkdown();
    expect(element.content).toBe("");
  });

  it("should have default variant", () => {
    const element = new CFMarkdown();
    expect(element.variant).toBe("default");
  });

  it("should have streaming disabled by default", () => {
    const element = new CFMarkdown();
    expect(element.streaming).toBe(false);
  });

  it("should render basic markdown", () => {
    const el = new CFMarkdown();
    const markdown = "Hello **world**";

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain("<strong>world</strong>");
  });

  it("should replace LLM-friendly links with cf-cell-link", () => {
    const el = new CFMarkdown();
    const link = "/of:bafyabc123/path";
    const markdown = `Check this [Link](${link})`;

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain(
      `<cf-cell-link link="${link}" label="Link"></cf-cell-link>`,
    );
  });

  it("should wrap code blocks with copy buttons", () => {
    const el = new CFMarkdown();
    const markdown = "```js\nconsole.log('hello');\n```";

    const rendered = (el as any)._renderMarkdown(markdown);

    expect(rendered).toContain("code-block-container");
    expect(rendered).toContain("cf-copy-button");
  });

  it("should wrap tables in a horizontal scroll container", () => {
    const el = new CFMarkdown();
    const markdown = [
      "| Airport | Flights | Notes |",
      "| --- | --- | --- |",
      "| Haneda | Terminal 1 North Wing | Arrive early |",
    ].join("\n");

    const rendered = (el as any)._renderMarkdown(markdown);

    // The table is rendered...
    expect(rendered).toContain("<table");
    // ...and wrapped so it can scroll horizontally on narrow screens
    // instead of cramming its columns.
    expect(rendered).toContain('<div class="table-scroll">');
    // The wrapper opens before the table and closes after it.
    expect(rendered).toMatch(
      /<div class="table-scroll"><table[\s\S]*?<\/table><\/div>/,
    );
  });

  it("wraps multiple tables independently, not as one span", () => {
    const el = new CFMarkdown();
    // Two tables with prose between them. _wrapTablesForScroll uses a
    // non-greedy match so each table gets its own .table-scroll; a greedy
    // match would swallow the first table, the prose, AND the second table
    // into a single wrapper.
    const markdown = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Prose between the tables.",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");

    const rendered = (el as any)._renderMarkdown(markdown);

    // Exactly two independent wrappers, each closing right after its table.
    // (A greedy match would produce a single wrapper and a single
    // </table></div>.)
    expect((rendered.match(/<div class="table-scroll">/g) ?? []).length).toBe(
      2,
    );
    expect((rendered.match(/<\/table><\/div>/g) ?? []).length).toBe(2);
    // The prose between the tables is not swallowed into a wrapper.
    expect(rendered).toContain("Prose between the tables.");
  });

  // marked generated these ids itself until version 5, under a `headerIds`
  // option that defaulted to on, and dropped them in a later major. The
  // expected ids below are the ones marked 4 produced, because fragment links
  // written against the old output point at them.
  describe("heading ids", () => {
    const idsOf = (markdown: string): string[] => {
      const el = new CFMarkdown();
      const rendered = (el as any)._renderMarkdown(markdown);
      return [...rendered.matchAll(/<h\d id="([^"]*)"/g)].map((m: string[]) =>
        m[1]
      );
    };

    it("gives a heading an id", () => {
      expect(idsOf("# Section")).toEqual(["section"]);
    });

    it("suffixes repeated headings so each id stays unique", () => {
      expect(idsOf("# Section\n\n# Section\n\n# Section")).toEqual([
        "section",
        "section-1",
        "section-2",
      ]);
    });

    it("counts headings that differ only by case as repeats", () => {
      expect(idsOf("# Section\n\n# section\n\n# SECTION")).toEqual([
        "section",
        "section-1",
        "section-2",
      ]);
    });

    it("skips a suffix that a later heading already claims", () => {
      // "Section 1" slugs to "section-1", which the second "Section" took, so
      // the suffix search moves past it rather than emitting a duplicate id.
      expect(idsOf("# Section\n\n# Section\n\n# Section 1")).toEqual([
        "section",
        "section-1",
        "section-1-1",
      ]);
    });

    it("restarts the suffixes on each render", () => {
      // The slugger is per-parse, so re-rendering the same content gives the
      // same ids instead of continuing to count up.
      const markdown = "# Section\n\n# Section";
      expect(idsOf(markdown)).toEqual(["section", "section-1"]);
      expect(idsOf(markdown)).toEqual(["section", "section-1"]);
    });

    it("drops punctuation", () => {
      expect(idsOf("# What's New? (v2.0)")).toEqual(["whats-new-v20"]);
    });

    it("keeps non-ASCII letters", () => {
      expect(idsOf("# Café Münster")).toEqual(["café-münster"]);
      expect(idsOf("# 中文标题")).toEqual(["中文标题"]);
      expect(idsOf("# 🚀 Quick Start")).toEqual(["🚀-quick-start"]);
    });

    it("drops an ampersand and any entity around it", () => {
      expect(idsOf("# Q&A")).toEqual(["qa"]);
      expect(idsOf("# AT&T Integration")).toEqual(["att-integration"]);
      // An escaped ampersand slugs the same way a bare one does.
      expect(idsOf("# Tips &amp; Tricks")).toEqual(["tips--tricks"]);
    });

    it("drops an ampersand nested inside inline markup", () => {
      // The slug is built from the heading's tokens, so the text inside
      // emphasis, strikethrough, a link or an image has to be walked into and
      // escaped exactly as the text around it is. Reading a container token's
      // own text instead leaves the ampersand unescaped, and unescaping it
      // then eats the letter after it: `att-integration` becomes
      // `at-integration`.
      expect(idsOf("# **AT&T** Integration")).toEqual(["att-integration"]);
      expect(idsOf("# **Q&A**")).toEqual(["qa"]);
      expect(idsOf("# *Tips & Tricks*")).toEqual(["tips--tricks"]);
      expect(idsOf("# ~~R&D~~")).toEqual(["rd"]);
      expect(idsOf("# [Q&A](/faq)")).toEqual(["qa"]);
      expect(idsOf("# ![Q&A](/i.png)")).toEqual(["qa"]);
      expect(idsOf("# `a & b`")).toEqual(["a--b"]);
    });

    it("resolves a numeric entity but leaves an over-long one alone", () => {
      expect(idsOf("# &#65; letter")).toEqual(["a-letter"]);
      // Past marked's limits (7 decimal digits, 6 hex) the run is not an
      // entity, so the `&` and `;` are dropped and the digits stay.
      expect(idsOf("# &#12345678; tail")).toEqual(["12345678-tail"]);
      expect(idsOf("# &#x1234567; tail")).toEqual(["x1234567-tail"]);
    });

    it("slugs the heading's text, not its markup", () => {
      const rendered = (new CFMarkdown() as any)._renderMarkdown(
        "# Using **bold** and `code`",
      );
      expect(rendered).toContain('id="using-bold-and-code"');
      expect(rendered).toContain("<strong>bold</strong>");
    });

    it("gives every heading level an id", () => {
      expect(idsOf("## Sub Section\n\n### Deep Section")).toEqual([
        "sub-section",
        "deep-section",
      ]);
    });

    it("gives a fragment link a heading to land on", () => {
      // The regression this guards: the link rendered but the id did not, so
      // the anchor pointed at nothing.
      const rendered = (new CFMarkdown() as any)._renderMarkdown(
        "# Section One\n\n[Jump](#section-one)",
      );
      const id = rendered.match(/<h1 id="([^"]*)"/)?.[1];
      const href = rendered.match(/<a href="#([^"]*)"/)?.[1];
      expect(id).toBe("section-one");
      expect(href).toBe(id);
    });
  });

  it("should get content value from string", () => {
    const el = new CFMarkdown();
    el.content = "test content";

    const value = (el as any)._getContentValue();

    expect(value).toBe("test content");
  });

  it("should handle null/undefined content gracefully", () => {
    const el = new CFMarkdown();
    el.content = null as any;

    const value = (el as any)._getContentValue();

    expect(value).toBe("");
  });

  describe("Cell integration", () => {
    // Note: Full Cell integration testing requires real CellImpl instances
    // which are complex to mock. These tests verify the component's
    // subscription management logic with manual _unsubscribe manipulation.

    it("should have null _unsubscribe by default", () => {
      const el = new CFMarkdown();
      expect((el as any)._unsubscribe).toBeNull();
    });

    it("should cleanup subscription on disconnect", () => {
      const el = new CFMarkdown();

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
      const el = new CFMarkdown();

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

    it("syncs uncached cell content on first bind", async () => {
      const el = new CFMarkdown();
      const cell = createMockCellHandle<string>(undefined as any);
      let syncCalls = 0;
      let requestUpdates = 0;

      (cell as any).sync = () => {
        syncCalls++;
        pushUpdate(cell, "loaded from sync");
        return Promise.resolve("loaded from sync");
      };
      el.requestUpdate = (() => {
        requestUpdates++;
      }) as typeof el.requestUpdate;

      el.content = cell;
      (el as any).willUpdate(new Map([["content", "old content"]]));
      await Promise.resolve();

      expect(syncCalls).toBe(1);
      expect((el as any)._getContentValue()).toBe("loaded from sync");
      expect(requestUpdates).toBeGreaterThan(0);
    });
  });

  describe("variant", () => {
    it("should accept inverse variant", () => {
      const el = new CFMarkdown();
      el.variant = "inverse";
      expect(el.variant).toBe("inverse");
    });
  });

  describe("streaming", () => {
    it("should accept streaming prop", () => {
      const el = new CFMarkdown();
      el.streaming = true;
      expect(el.streaming).toBe(true);
    });
  });

  describe("entity decoding", () => {
    it("should decode basic HTML entities", () => {
      const el = new CFMarkdown();

      const decoded = (el as any)._decodeHtmlEntities("&lt;div&gt;&amp;&quot;");

      expect(decoded).toBe('<div>&"');
    });

    it("should decode numeric entities in fallback mode", () => {
      const el = new CFMarkdown();

      // Force fallback mode (test environment has no document)
      const decoded = (el as any)._decodeHtmlEntities("&#60;&#62;");

      expect(decoded).toBe("<>");
    });

    it("should decode hex entities in fallback mode", () => {
      const el = new CFMarkdown();

      const decoded = (el as any)._decodeHtmlEntities("&#x3C;&#x3E;");

      expect(decoded).toBe("<>");
    });
  });
});
