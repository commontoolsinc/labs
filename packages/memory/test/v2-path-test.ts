import { assert, assertEquals } from "@std/assert";
import {
  encodePointer,
  parentPath,
  parsePointer,
  pathsOverlap,
  pathStringsOverlap,
} from "../v2/path.ts";

Deno.test("memory v2 path helpers round-trip JSON pointers", () => {
  const path = ["value", "nested/key", "tilde~value", "0"];
  const encoded = encodePointer(path);

  assertEquals(encoded, "/value/nested~1key/tilde~0value/0");
  assertEquals(parsePointer(encoded), path);
});

Deno.test("memory v2 path helpers compute parents and overlap", () => {
  assertEquals(parentPath([]), []);
  assertEquals(parentPath(["value", "items", "0"]), ["value", "items"]);
  assert(pathsOverlap(["value"], ["value", "items", "0"]));
  assert(pathsOverlap(["value", "items"], ["value", "items"]));
  assert(!pathsOverlap(["value", "items", "0"], ["value", "items", "1"]));
});

Deno.test("pathStringsOverlap: equal pointers overlap", () => {
  assert(pathStringsOverlap("", ""));
  assert(pathStringsOverlap("/foo", "/foo"));
  assert(pathStringsOverlap("/foo/bar/0", "/foo/bar/0"));
});

Deno.test("pathStringsOverlap: root overlaps with everything", () => {
  assert(pathStringsOverlap("", "/foo"));
  assert(pathStringsOverlap("/foo", ""));
  assert(pathStringsOverlap("", "/a/b/c"));
  assert(pathStringsOverlap("/a/b/c", ""));
});

Deno.test("pathStringsOverlap: ancestor / descendant pairs overlap", () => {
  assert(pathStringsOverlap("/foo", "/foo/bar"));
  assert(pathStringsOverlap("/foo/bar", "/foo"));
  assert(pathStringsOverlap("/foo", "/foo/bar/0/baz"));
  assert(pathStringsOverlap("/foo/bar/0/baz", "/foo"));
});

Deno.test("pathStringsOverlap: sibling paths do not overlap", () => {
  assert(!pathStringsOverlap("/foo", "/bar"));
  assert(!pathStringsOverlap("/foo/0", "/foo/1"));
  assert(!pathStringsOverlap("/foo/bar", "/foo/baz"));
});

Deno.test("pathStringsOverlap: prefix-but-not-segment-boundary does not overlap", () => {
  // "/foo" is a string prefix of "/foobar" but not a path-segment ancestor:
  // the boundary character is "b", not "/".
  assert(!pathStringsOverlap("/foo", "/foobar"));
  assert(!pathStringsOverlap("/foobar", "/foo"));
  assert(!pathStringsOverlap("/foo/bar", "/foo/barbaz"));
});

Deno.test("pathStringsOverlap: agrees with round-tripping via parsePointer", () => {
  const samples = [
    "",
    "/foo",
    "/foo/bar",
    "/foo/barbaz",
    "/foo/0",
    "/foo/0/baz",
    "/a/b/c",
    "/nested~1key/0",
    "/tilde~0value",
  ];
  for (const a of samples) {
    for (const b of samples) {
      const viaArrays = pathsOverlap(parsePointer(a), parsePointer(b));
      const viaStrings = pathStringsOverlap(a, b);
      assertEquals(
        viaStrings,
        viaArrays,
        `pathStringsOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)}) ` +
          `disagrees with array-based pathsOverlap`,
      );
    }
  }
});
