import { assertEquals, assertExists } from "@std/assert";
import { NAME, UI } from "commonfabric";
import PicoChat from "./main.tsx";

Deno.test("pico chat sends trimmed messages from a named user", () => {
  const subject = PicoChat({
    messages: [],
    name: " Alex ",
  });

  assertEquals(subject[NAME], "Pico chat");
  assertExists(subject[UI]);
  assertEquals(subject.messages.get(), []);

  subject.send.send({ detail: { message: " Hello " } });
  assertEquals(subject.messages.get(), [{ from: "Alex", body: "Hello" }]);
});

Deno.test("pico chat renders existing messages", () => {
  const subject = PicoChat({
    messages: [{ from: "Robin", body: "Already here" }],
    name: "Alex",
  });

  assertExists(subject[UI]);
  assertEquals(subject.messages.get(), [{
    from: "Robin",
    body: "Already here",
  }]);
});

Deno.test("pico chat ignores blank names and messages", () => {
  const emptyNameSubject = PicoChat({
    messages: [],
    name: " ",
  });
  const emptyBodySubject = PicoChat({
    messages: [],
    name: "Mary",
  });

  emptyNameSubject.send.send({ detail: { message: "Hello" } });
  emptyBodySubject.send.send({ detail: { message: "   " } });
  emptyBodySubject.send.send({});

  assertEquals(emptyNameSubject.messages.get(), []);
  assertEquals(emptyBodySubject.messages.get(), []);
});
