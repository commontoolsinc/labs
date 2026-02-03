import { assertEquals } from "@std/assert";
import {
  boxEnd,
  boxStart,
  createStreamFormatter,
  fmtCommand,
  fmtOutput,
  fmtPrefixed,
  fmtStatus,
  getTermWidth,
  gutter,
  gutterWidth,
  wordWrap,
} from "../src/agent/tui.ts";

Deno.test("wordWrap breaks long lines at word boundaries", () => {
  const input = "the quick brown fox jumps over the lazy dog";
  const result = wordWrap(input, 20);
  for (const line of result.split("\n")) {
    assertEquals(line.length <= 20, true, `line too long: "${line}"`);
  }
  assertEquals(result.replace(/\n/g, " "), input);
});

Deno.test("wordWrap preserves short lines", () => {
  assertEquals(wordWrap("hello", 80), "hello");
  assertEquals(wordWrap("short\nlines", 80), "short\nlines");
});

Deno.test("wordWrap preserves existing newlines", () => {
  const input = "line one\nline two";
  assertEquals(wordWrap(input, 80), "line one\nline two");
});

Deno.test("getTermWidth returns a number", () => {
  const width = getTermWidth();
  assertEquals(typeof width, "number");
  assertEquals(width > 0, true);
});

Deno.test("gutter returns empty string for depth 0", () => {
  assertEquals(gutter(0), "");
});

Deno.test("gutterWidth returns correct column count", () => {
  assertEquals(gutterWidth(0), 0);
  assertEquals(gutterWidth(1), 2); // "│ "
  assertEquals(gutterWidth(2), 4); // "│ │ "
});

Deno.test("boxStart includes ┌ and label", () => {
  const result = boxStart("sub-agent (sub policy)", 1);
  assertEquals(result.includes("┌"), true);
  assertEquals(result.includes("sub-agent"), true);
});

Deno.test("boxStart at depth 2 includes parent gutter", () => {
  const result = boxStart("nested", 2);
  assertEquals(result.includes("│"), true);
  assertEquals(result.includes("┌"), true);
});

Deno.test("boxEnd includes └ and summary", () => {
  const result = boxEnd('"hello" [integrity: InjectionFree]', 1);
  assertEquals(result.includes("└"), true);
  assertEquals(result.includes("→"), true);
  assertEquals(result.includes("hello"), true);
});

Deno.test("fmtCommand formats with gutter and $ prefix", () => {
  const d0 = fmtCommand("ls", 0);
  assertEquals(d0, "$ ls");

  const d1 = fmtCommand("cat /file", 1);
  assertEquals(d1.includes("│"), true);
  assertEquals(d1.includes("$ cat /file"), true);
});

Deno.test("fmtPrefixed wraps long text with indented continuation", () => {
  const long = "a ".repeat(40).trim(); // 79 chars
  const result = fmtPrefixed("#", long, 0, 40);
  const lines = result.split("\n");
  assertEquals(lines[0].startsWith("# "), true);
  // Continuation lines should start with 2-space indent, not "# "
  for (let i = 1; i < lines.length; i++) {
    assertEquals(lines[i].startsWith("  "), true);
    assertEquals(lines[i].startsWith("# "), false);
  }
});

Deno.test("fmtOutput indents each line", () => {
  const result = fmtOutput("line1\nline2", 0);
  assertEquals(result, "  line1\n  line2");
});

Deno.test("fmtStatus formats status messages", () => {
  const result = fmtStatus("[exit code: 1]", 0);
  assertEquals(result, "  [exit code: 1]");
});

Deno.test("createStreamFormatter adds ⏺ on first delta", () => {
  const fmt = createStreamFormatter(() => 0);
  const out = fmt.format("Hello");
  assertEquals(out.includes("⏺"), true);
  assertEquals(out.includes("Hello"), true);
});

Deno.test("createStreamFormatter indents continuation lines", () => {
  const fmt = createStreamFormatter(() => 0);
  const out = fmt.format("line1\nline2");
  // Output is: "\n\n⏺ line1\n  line2" (depth 0 gets blank line separator)
  assertEquals(out.includes("⏺ line1"), true);
  assertEquals(out.includes("\n  line2"), true);
});

Deno.test("createStreamFormatter uses gutter at depth > 0", () => {
  const fmt = createStreamFormatter(() => 1);
  const out = fmt.format("Hello");
  assertEquals(out.includes("│"), true);
  assertEquals(out.includes("⏺"), true);
});

Deno.test("createStreamFormatter reset restarts ⏺ marker", () => {
  const fmt = createStreamFormatter(() => 0);
  fmt.format("First");
  fmt.reset();
  const out = fmt.format("Second");
  assertEquals(out.includes("⏺"), true);
  assertEquals(out.includes("Second"), true);
});

Deno.test("wordWrap hard-wraps words longer than width", () => {
  const long = "a".repeat(50);
  const result = wordWrap(long, 20);
  for (const line of result.split("\n")) {
    assertEquals(line.length <= 20, true, `line too long: "${line}"`);
  }
  // All characters preserved
  assertEquals(result.replace(/\n/g, ""), long);
});
