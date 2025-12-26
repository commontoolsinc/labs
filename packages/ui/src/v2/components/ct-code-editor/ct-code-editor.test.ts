import { describe, it, beforeEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTCodeEditor, MimeType } from "./ct-code-editor.ts";

// deno-lint-ignore no-explicit-any
type AnyEditor = any;

describe("CTCodeEditor", () => {
  it("should be defined", () => {
    expect(CTCodeEditor).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTCodeEditor.name).toBe("CTCodeEditor");
  });

  it("should create element instance", () => {
    const element = new CTCodeEditor();
    expect(element).toBeInstanceOf(CTCodeEditor);
  });

  it("should have default properties", () => {
    const element = new CTCodeEditor();
    expect(element.value).toBe("");
    expect(element.language).toBe(MimeType.markdown);
    expect(element.disabled).toBe(false);
    expect(element.readonly).toBe(false);
    expect(element.placeholder).toBe("");
    expect(element.timingStrategy).toBe("debounce");
    expect(element.timingDelay).toBe(500);
  });

  it("should have MimeType constants", () => {
    expect(MimeType.javascript).toBe("text/javascript");
    expect(MimeType.typescript).toBe("text/x.typescript");
    expect(MimeType.markdown).toBe("text/markdown");
    expect(MimeType.json).toBe("application/json");
    expect(MimeType.css).toBe("text/css");
    expect(MimeType.html).toBe("text/html");
    expect(MimeType.jsx).toBe("text/x.jsx");
  });

  it("should allow setting properties", () => {
    const element = new CTCodeEditor();
    element.value = "const x = 42;";
    element.language = MimeType.javascript;
    element.readonly = true;
    element.timingStrategy = "immediate";
    element.timingDelay = 100;

    expect(element.value).toBe("const x = 42;");
    expect(element.language).toBe(MimeType.javascript);
    expect(element.readonly).toBe(true);
    expect(element.timingStrategy).toBe("immediate");
    expect(element.timingDelay).toBe(100);
  });
});

describe("CTCodeEditor._hashContent", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should return consistent hash for same input", () => {
    const hash1 = element._hashContent("hello world");
    const hash2 = element._hashContent("hello world");
    expect(hash1).toBe(hash2);
  });

  it("should return different hash for different inputs", () => {
    const hash1 = element._hashContent("hello");
    const hash2 = element._hashContent("world");
    expect(hash1).not.toBe(hash2);
  });

  it("should return 0 for empty string", () => {
    const hash = element._hashContent("");
    expect(hash).toBe(0);
  });

  it("should handle unicode characters", () => {
    const hash1 = element._hashContent("hello 世界 🌍");
    const hash2 = element._hashContent("hello 世界 🌍");
    expect(hash1).toBe(hash2);

    const hash3 = element._hashContent("hello 世界 🌎");
    expect(hash1).not.toBe(hash3);
  });

  it("should return 32-bit signed integer", () => {
    // Test with a long string to trigger potential overflow
    const longString = "a".repeat(10000);
    const hash = element._hashContent(longString);

    // Verify it's a 32-bit signed integer (-2147483648 to 2147483647)
    expect(hash).toBeGreaterThanOrEqual(-2147483648);
    expect(hash).toBeLessThanOrEqual(2147483647);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it("should produce different hashes for similar strings", () => {
    const hash1 = element._hashContent("abc");
    const hash2 = element._hashContent("abd");
    const hash3 = element._hashContent("bbc");
    expect(hash1).not.toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash2).not.toBe(hash3);
  });

  it("should handle whitespace-only strings", () => {
    const hash1 = element._hashContent("   ");
    const hash2 = element._hashContent("\t\t\t");
    const hash3 = element._hashContent("\n\n\n");
    expect(hash1).not.toBe(hash2);
    expect(hash2).not.toBe(hash3);
    expect(hash1).not.toBe(0);
  });

  it("should handle newlines correctly", () => {
    const hash1 = element._hashContent("line1\nline2");
    const hash2 = element._hashContent("line1\nline2");
    const hash3 = element._hashContent("line1\r\nline2");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3); // Different line endings should differ
  });
});

describe("CTCodeEditor hash lifecycle", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should start with null hash", () => {
    expect(element._lastEditorContentHash).toBeNull();
  });
});

describe("CTCodeEditor._hashContent performance", () => {
  let element: AnyEditor;

  beforeEach(() => {
    element = new CTCodeEditor();
  });

  it("should hash short strings quickly (< 1ms for 100 ops)", () => {
    const shortString = "Hello world";
    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      element._hashContent(shortString);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10); // Should complete in < 10ms for 100 ops
  });

  it("should hash medium strings quickly (< 10ms for 100 ops)", () => {
    const mediumString = "a".repeat(1000);
    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      element._hashContent(mediumString);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50); // Should complete in < 50ms for 100 ops
  });

  it("should hash large strings in reasonable time (< 100ms for 10 ops)", () => {
    const largeString = "a".repeat(100000);
    const iterations = 10;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      element._hashContent(largeString);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100); // Should complete in < 100ms for 10 ops
  });

  it("should hash typical note content efficiently", () => {
    // Simulate typical note content with markdown, code, and text
    const typicalContent = `# My Notes

## Introduction
This is a typical note with some **bold** and *italic* text.

\`\`\`javascript
function example() {
  return "Hello world";
}
\`\`\`

- List item 1
- List item 2
- List item 3

Some more paragraph text to make this realistic.
`.repeat(10); // ~2KB content

    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      element._hashContent(typicalContent);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50); // Should be fast for typical content
  });
});
