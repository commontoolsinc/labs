import { assertEquals } from "@std/assert";
import { chunkEvents, encodedJsonBytes } from "../src/chunking.ts";

Deno.test("chunkEvents keeps provider events whole and deterministic", () => {
  const events = [
    { id: "a", text: "12345678" },
    { id: "b", text: "abcdefgh" },
    { id: "c", text: "oversized-event-is-still-whole" },
  ];
  const targetBytes = encodedJsonBytes([events[0]]);
  const chunks = chunkEvents(events, targetBytes);

  assertEquals(chunks.map((chunk) => chunk.events.map((event) => event.id)), [
    ["a"],
    ["b"],
    ["c"],
  ]);
  assertEquals(chunks.map((chunk) => chunk.part), [0, 1, 2]);
  assertEquals(chunkEvents(events, targetBytes), chunks);
});

Deno.test("chunkEvents returns one empty chunk for an empty complete snapshot", () => {
  assertEquals(chunkEvents([], 512), [{ part: 0, events: [], byteLength: 2 }]);
});

Deno.test("chunkEvents serializes each provider event once", () => {
  let serializations = 0;
  const events = [
    {
      id: "a",
      toJSON() {
        serializations++;
        return { id: "a", text: "é" };
      },
    },
    {
      id: "b",
      toJSON() {
        serializations++;
        return { id: "b", text: "世界" };
      },
    },
  ];

  const chunks = chunkEvents(events, 1);

  assertEquals(serializations, 2);
  assertEquals(chunks.map((chunk) => chunk.events[0].id), ["a", "b"]);
  assertEquals(chunks.map((chunk) => chunk.byteLength), [
    encodedJsonBytes([{ id: "a", text: "é" }]),
    encodedJsonBytes([{ id: "b", text: "世界" }]),
  ]);
});
