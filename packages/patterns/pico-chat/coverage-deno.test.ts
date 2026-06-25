import { assertEquals, assertExists } from "@std/assert";
import { NAME, UI } from "commonfabric";
import PicoChat, { groupMessages } from "./main.tsx";

Deno.test("pico chat sends trimmed messages from a named user", () => {
  const subject = PicoChat({
    messages: [],
    name: " Alex ",
  });

  assertEquals(subject[NAME], "Pico chat");
  assertExists(subject[UI]);
  assertEquals(subject.messages.get(), []);

  subject.send.send({ detail: { message: " Hello " } });
  assertEquals(
    subject.messages.get().map(({ from, body, reactions }) => ({
      from,
      body,
      reactions,
    })),
    [{ from: "Alex", body: "Hello", reactions: [] }],
  );
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

Deno.test("pico chat groups sequential messages from the same user", () => {
  const subject = PicoChat({
    messages: [],
    name: "Alex",
  });

  subject.send.send({ detail: { message: "First" } });
  subject.send.send({ detail: { message: "Second" } });

  const groups = groupMessages(subject.messages.get());
  assertEquals(groups.length, 1);
  assertEquals(
    groups[0].messages.map((message) => message.body),
    ["First", "Second"],
  );
});

Deno.test("pico chat starts a new group when the sender changes", () => {
  const alex = PicoChat({
    messages: [],
    name: "Alex",
  });
  alex.send.send({ detail: { message: "Hello" } });

  const mary = PicoChat({
    messages: alex.messages,
    name: "Mary",
  });
  mary.send.send({ detail: { message: "Hi" } });

  assertEquals(groupMessages(alex.messages.get()).map((group) => group.from), [
    "Alex",
    "Mary",
  ]);
});

Deno.test("pico chat groups legacy same-name messages without cell links", () => {
  const groups = groupMessages([
    { from: "Robin", body: "First" },
    { from: "Robin", body: "Second" },
  ]);

  assertEquals(groups.length, 1);
  assertEquals(groups[0].messages.map((message) => message.body), [
    "First",
    "Second",
  ]);
});

Deno.test("pico chat lets another named user toggle emoji reactions", () => {
  const author = PicoChat({
    messages: [],
    name: "Tony",
  });
  author.send.send({ detail: { message: "Reactable" } });

  const reactor = PicoChat({
    messages: author.messages,
    name: "Alex",
  });

  reactor.react.send({ messageIndex: 0, emoji: "👍" });
  assertEquals(
    author.messages.get()[0].reactions?.map(({ emoji, byName }) => ({
      emoji,
      byName,
    })),
    [{ emoji: "👍", byName: "Alex" }],
  );

  reactor.react.send({ messageIndex: 0, emoji: "👍" });
  assertEquals(author.messages.get()[0].reactions, []);
});

Deno.test("pico chat ignores invalid reaction attempts", () => {
  const subject = PicoChat({
    messages: [],
    name: "Alex",
  });
  subject.send.send({ detail: { message: "Valid" } });

  subject.react.send({ messageIndex: 0, emoji: "   " });
  subject.react.send({ messageIndex: -1, emoji: "👍" });
  subject.react.send({ messageIndex: 99, emoji: "👍" });
  subject.react.send({ messageIndex: 0.5, emoji: "👍" });

  const emptyNameSubject = PicoChat({
    messages: subject.messages,
    name: " ",
  });
  emptyNameSubject.react.send({ messageIndex: 0, emoji: "👍" });

  assertEquals(subject.messages.get()[0].reactions, []);
});

Deno.test("pico chat prevents reactions to own display-name messages", () => {
  const firstAlex = PicoChat({
    messages: [],
    name: "Alex",
  });
  firstAlex.send.send({ detail: { message: "Same names" } });
  const [message] = firstAlex.messages.get();

  const secondAlex = PicoChat({
    messages: firstAlex.messages,
    name: "Alex",
  });

  firstAlex.react.send({ messageIndex: 0, emoji: "❤️" });
  secondAlex.react.send({ messageIndex: 0, emoji: "❤️" });

  assertEquals(message.reactions, []);
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
