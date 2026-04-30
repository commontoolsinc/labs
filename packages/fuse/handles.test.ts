import { assertEquals } from "@std/assert";
import {
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
  MAX_VIRTUAL_FILE_SIZE,
  validateVirtualFileRange,
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

Deno.test("HandleMap truncates every open handle for an inode", () => {
  const handles = new HandleMap();
  const first = handles.open(1n, O_RDWR, encoder.encode("first"));
  const second = handles.open(1n, O_RDWR, encoder.encode("second"));
  const other = handles.open(2n, O_RDWR, encoder.encode("other"));

  handles.write(first, encoder.encode("stale"), 0);

  assertEquals(handles.truncateByIno(1n, 0), true);

  for (const fh of [first, second]) {
    const handle = handles.get(fh);
    assertEquals(handle?.buffer.length, 0);
    assertEquals(handle?.dirty, false);
    assertEquals(handle?.truncatePending, true);
  }
  assertEquals(new TextDecoder().decode(handles.get(other)?.buffer), "other");

  handles.write(first, encoder.encode("fresh"), 0);
  const firstHandle = handles.get(first);
  assertEquals(new TextDecoder().decode(firstHandle?.buffer), "fresh");
  assertEquals(firstHandle?.dirty, true);
  assertEquals(firstHandle?.truncatePending, false);
});

Deno.test("HandleMap only marks the truncating handle pending when provided", () => {
  const handles = new HandleMap();
  const stale = handles.open(1n, O_RDWR, encoder.encode("stale"));
  const truncating = handles.open(1n, O_RDWR, encoder.encode("current"));

  handles.write(stale, encoder.encode("dirty"), 0);

  assertEquals(handles.truncateByIno(1n, 0, { pendingFh: truncating }), true);

  const staleHandle = handles.get(stale);
  assertEquals(staleHandle?.buffer.length, 0);
  assertEquals(staleHandle?.dirty, false);
  assertEquals(staleHandle?.truncatePending, false);

  const truncatingHandle = handles.get(truncating);
  assertEquals(truncatingHandle?.buffer.length, 0);
  assertEquals(truncatingHandle?.dirty, false);
  assertEquals(truncatingHandle?.truncatePending, true);
});

Deno.test("HandleMap rejects invalid and oversized write allocations", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, new Uint8Array(0));

  assertEquals(handles.write(fh, encoder.encode("x"), -1), false);
  assertEquals(
    handles.write(fh, encoder.encode("x"), MAX_VIRTUAL_FILE_SIZE),
    false,
  );

  const handle = handles.get(fh);
  assertEquals(handle?.buffer.length, 0);
  assertEquals(handle?.dirty, false);
});

Deno.test("HandleMap rejects oversized truncates without resizing buffers", () => {
  const handles = new HandleMap();
  const fh = handles.open(1n, O_RDWR, encoder.encode("hello"));

  assertEquals(handles.truncate(fh, MAX_VIRTUAL_FILE_SIZE + 1), false);
  assertEquals(handles.truncate(fh, -1), false);
  assertEquals(new TextDecoder().decode(handles.get(fh)?.buffer), "hello");
});

Deno.test("validateVirtualFileRange classifies invalid and too-large ranges", () => {
  assertEquals(validateVirtualFileRange(-1, 1), {
    ok: false,
    reason: "invalid",
  });
  assertEquals(validateVirtualFileRange(0, -1), {
    ok: false,
    reason: "invalid",
  });
  assertEquals(validateVirtualFileRange(MAX_VIRTUAL_FILE_SIZE, 1), {
    ok: false,
    reason: "too-large",
  });
  assertEquals(validateVirtualFileRange(MAX_VIRTUAL_FILE_SIZE - 1, 1), {
    ok: true,
  });
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

Deno.test("HandleMap tracks CFC truncate and write authorization separately", () => {
  const handles = new HandleMap();
  const fh = handles.open(
    1n,
    O_RDWR,
    encoder.encode("hello"),
    { cfcAuthorizedOperations: ["truncate"] },
  );

  assertEquals(handles.hasCfcAuthorization(fh, "truncate"), true);
  assertEquals(handles.hasCfcAuthorization(fh, "write"), false);

  handles.authorizeCfcOperation(fh, "write");

  assertEquals(handles.hasCfcAuthorization(fh, "truncate"), true);
  assertEquals(handles.hasCfcAuthorization(fh, "write"), true);
});
