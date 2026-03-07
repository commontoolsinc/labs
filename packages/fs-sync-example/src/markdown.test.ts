import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { parseMarkdown, serializeMarkdown } from "./markdown.ts";
import type { MarkdownState } from "./markdown.ts";

describe("parseMarkdown", () => {
  it("parses a standard todo file", () => {
    const text = `---
nextId: 3
---
- [ ] T-01 Buy groceries
- [x] T-02 Write docs
`;
    const result = parseMarkdown(text);
    assertEquals(result.nextId, 3);
    assertEquals(result.todos, [
      { id: "T-01", description: "Buy groceries", done: false },
      { id: "T-02", description: "Write docs", done: true },
    ]);
  });

  it("handles empty file", () => {
    const result = parseMarkdown("");
    assertEquals(result.nextId, 1);
    assertEquals(result.todos, []);
  });

  it("handles file with only frontmatter and no todos", () => {
    const text = `---
nextId: 5
---
`;
    const result = parseMarkdown(text);
    assertEquals(result.nextId, 5);
    assertEquals(result.todos, []);
  });

  it("ignores blank lines and non-matching lines", () => {
    const text = `---
nextId: 2
---

Some random text
- [ ] T-01 Valid todo

Another line
`;
    const result = parseMarkdown(text);
    assertEquals(result.todos.length, 1);
    assertEquals(result.todos[0].id, "T-01");
  });

  it("handles file without frontmatter", () => {
    const text = `- [ ] T-01 No frontmatter
- [x] T-02 Still works
`;
    const result = parseMarkdown(text);
    assertEquals(result.nextId, 1); // default
    assertEquals(result.todos.length, 2);
  });

  it("parses multi-digit IDs", () => {
    const text = `---
nextId: 100
---
- [ ] T-99 Almost there
- [x] T-100 One hundred
`;
    const result = parseMarkdown(text);
    assertEquals(result.nextId, 100);
    assertEquals(result.todos[0].id, "T-99");
    assertEquals(result.todos[1].id, "T-100");
  });

  it("preserves descriptions with special characters", () => {
    const text = `---
nextId: 2
---
- [ ] T-01 Buy milk & eggs (2 dozen)
`;
    const result = parseMarkdown(text);
    assertEquals(result.todos[0].description, "Buy milk & eggs (2 dozen)");
  });

  it("handles CRLF line endings", () => {
    const text =
      "---\r\nnextId: 3\r\n---\r\n- [ ] T-01 Buy groceries\r\n- [x] T-02 Write docs\r\n";
    const result = parseMarkdown(text);
    assertEquals(result.nextId, 3);
    assertEquals(result.todos.length, 2);
    assertEquals(result.todos[0], {
      id: "T-01",
      description: "Buy groceries",
      done: false,
    });
    assertEquals(result.todos[1], {
      id: "T-02",
      description: "Write docs",
      done: true,
    });
  });
});

describe("serializeMarkdown", () => {
  it("serializes a standard state", () => {
    const state: MarkdownState = {
      nextId: 3,
      todos: [
        { id: "T-01", description: "Buy groceries", done: false },
        { id: "T-02", description: "Write docs", done: true },
      ],
    };
    const result = serializeMarkdown(state);
    assertEquals(
      result,
      `---
nextId: 3
---
- [ ] T-01 Buy groceries
- [x] T-02 Write docs
`,
    );
  });

  it("serializes empty state", () => {
    const state: MarkdownState = { nextId: 1, todos: [] };
    const result = serializeMarkdown(state);
    assertEquals(result, `---\nnextId: 1\n---\n`);
  });
});

describe("roundtrip", () => {
  it("parse then serialize is identity", () => {
    const original = `---
nextId: 4
---
- [ ] T-01 First
- [x] T-02 Second
- [ ] T-03 Third
`;
    const parsed = parseMarkdown(original);
    const serialized = serializeMarkdown(parsed);
    assertEquals(serialized, original);
  });

  it("serialize then parse is identity", () => {
    const state: MarkdownState = {
      nextId: 10,
      todos: [
        { id: "T-07", description: "Lucky seven", done: false },
        { id: "T-08", description: "Eight is great", done: true },
        { id: "T-09", description: "Cloud nine", done: false },
      ],
    };
    const serialized = serializeMarkdown(state);
    const parsed = parseMarkdown(serialized);
    assertEquals(parsed, state);
  });
});
