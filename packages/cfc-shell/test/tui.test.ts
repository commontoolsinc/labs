import { assertEquals } from "@std/assert";
import {
  boxEnd,
  boxLine,
  boxStart,
  getTermWidth,
  wordWrap,
} from "../src/agent/tui.ts";

Deno.test("wordWrap breaks long lines at word boundaries", () => {
  const input = "the quick brown fox jumps over the lazy dog";
  const result = wordWrap(input, 20);
  for (const line of result.split("\n")) {
    assertEquals(line.length <= 20, true, `line too long: "${line}"`);
  }
  // All words preserved
  assertEquals(result.replace(/\n/g, " "), input);
});

Deno.test("wordWrap preserves short lines", () => {
  assertEquals(wordWrap("hello", 80), "hello");
  assertEquals(wordWrap("short\nlines", 80), "short\nlines");
});

Deno.test("wordWrap preserves existing newlines", () => {
  const input = "line one\nline two";
  const result = wordWrap(input, 80);
  assertEquals(result, "line one\nline two");
});

Deno.test("boxLine wraps content accounting for prefix width", () => {
  const long = "a ".repeat(40).trim();
  const result = boxLine(long, 40);
  // Each rendered line should have the │ prefix
  for (const line of result.split("\n")) {
    assertEquals(line.includes("│"), true);
  }
});

Deno.test("boxStart produces opening border", () => {
  const result = boxStart("sub-agent (sub policy)");
  assertEquals(result.includes("┌"), true);
  assertEquals(result.includes("sub-agent"), true);
});

Deno.test("boxEnd produces closing border with summary", () => {
  const result = boxEnd('"hello" [integrity: InjectionFree]');
  assertEquals(result.includes("└"), true);
  assertEquals(result.includes("→"), true);
  assertEquals(result.includes("hello"), true);
});

Deno.test("getTermWidth returns a number", () => {
  const width = getTermWidth();
  assertEquals(typeof width, "number");
  assertEquals(width > 0, true);
});
