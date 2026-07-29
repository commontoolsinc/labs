import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { VerbError } from "@commonfabric/api";

Deno.test("VerbError carries a stable code beside its message", () => {
  const error = new VerbError("EMPTY_TITLE", "title must be non-empty");

  // The code is what an agent branches on, so it is readable without parsing
  // the message.
  assertEquals(error.code, "EMPTY_TITLE");
  assertEquals(error.message, "title must be non-empty");
});

Deno.test("VerbError is an Error, so throwing one behaves like any rejection", () => {
  const error = new VerbError("NOT_YOUR_TURN", "wait for your opponent");

  // Until the invocation surface reports codes (WS-E), a thrown VerbError has
  // to degrade to what a thrown handler error already does. That only holds if
  // it is a real Error: caught by `catch`, matched by `instanceof Error`, and
  // rendered by anything that reads `.message`.
  assertInstanceOf(error, Error);
  assertEquals(error.name, "VerbError");

  const caught = assertThrows(
    () => {
      throw error;
    },
    VerbError,
    "wait for your opponent",
  );
  assertEquals(caught.code, "NOT_YOUR_TURN");
});

Deno.test("VerbError codes distinguish rejections that need different responses", () => {
  // The point of a code rather than prose: two rejections a caller must react
  // to differently stay distinguishable when the wording changes.
  const retryable = new VerbError("NOT_YOUR_TURN", "wait for your opponent");
  const fixPayload = new VerbError("EMPTY_TITLE", "title must be non-empty");

  assertEquals(retryable.code === fixPayload.code, false);
  assertEquals(
    [retryable, fixPayload].filter((e) => e.code === "NOT_YOUR_TURN").length,
    1,
  );
});
