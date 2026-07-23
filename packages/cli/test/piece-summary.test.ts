import { expect } from "@std/expect";
import { decode } from "@commonfabric/utils/encoding";
import { renderPieceSummaries } from "../commands/piece.ts";

function captureStdout(fn: () => void): string {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

Deno.test("piece summaries render human and JSON output", () => {
  const identity = "R".repeat(43);
  const patternRef = {
    identity,
    symbol: "default",
    source: {
      ref: `cf:pattern:${identity}`,
      repository: "https://github.com/commontoolsinc/labs",
      entry: "/packages/patterns/notes.tsx",
    },
  };

  const json = captureStdout(() =>
    renderPieceSummaries([
      { id: "of:notes", name: "Notes", patternRef },
      { id: "of:unnamed" },
    ], true)
  );
  expect(JSON.parse(json)).toEqual([
    { id: "of:notes", name: "Notes", patternRef },
    { id: "of:unnamed", name: null, patternRef: null },
  ]);

  const table = captureStdout(() =>
    renderPieceSummaries([
      { id: "of:notes", name: "Notes", patternRef },
      { id: "of:unreadable", error: "stored data is unavailable" },
      { id: "of:unnamed" },
    ], false)
  );
  expect(table).toContain("ID");
  expect(table).toContain("of:notes");
  expect(table).toContain("Notes");
  expect(table).toContain(
    "https://github.com/commontoolsinc/labs#/packages/patterns/notes.tsx",
  );
  expect(table).toContain("<error: stored data is unavailable>");
  expect(table).toContain("<unnamed>");
  expect(table).toContain("<unknown>");

  expect(captureStdout(() => renderPieceSummaries([], false))).toBe("");
});
