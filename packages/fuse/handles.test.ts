import { assertEquals } from "@std/assert";
import {
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
} from "./handles.ts";
import { O_RDWR } from "./platform.ts";

const encoder = new TextEncoder();

Deno.test("HandleMap marks empty truncates as pending without treating them as buffered writes", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  assertEquals(handleHasPendingChanges(handles.get(fh)), false);

  handles.markTruncated(fh);

  const handle = handles.get(fh);
  assertEquals(handle?.buffer.length, 0);
  assertEquals(handle?.dirty, false);
  assertEquals(handle?.truncatePending, true);
  assertEquals(handleHasPendingChanges(handle), true);
  assertEquals(handleHasBufferedContent(handle), true);
});

Deno.test("HandleMap clears pending truncates when content arrives", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  handles.markTruncated(fh);
  handles.write(fh, encoder.encode("world"), 0);

  const handle = handles.get(fh);
  assertEquals(new TextDecoder().decode(handle?.buffer), "world");
  assertEquals(handle?.dirty, true);
  assertEquals(handle?.truncatePending, false);
  assertEquals(handleHasPendingChanges(handle), true);
});

Deno.test("HandleMap stores stable write targets on open handles", () => {
  const handles = new HandleMap();
  const writeTarget = { kind: "value", target: { jsonPath: ["title"] } };
  const fh = handles.open(
    1n,
    O_RDWR,
    encoder.encode("hello"),
    { writeTarget },
  );

  assertEquals(handles.get(fh)?.writeTarget, writeTarget);
});
