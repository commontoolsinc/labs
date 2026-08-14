import { cell, handler, pattern, Stream } from "commonfabric";

interface Ping {
  word: string;
}

interface PingResult {
  echoed: string;
}

interface Verbs {
  ping: Stream<Ping, PingResult>;
  poke: Stream<Ping>;
}

// The schema-first authored form: the author supplies the event and state
// schemas, so the transformer must not prepend generated ones — that would
// displace the callback out of the positions the runtime dispatch and the
// sandbox verifier accept (argument 0 or 2). With a declared result, the
// options object still lowers onto the trailing slot.
const ping = handler<Ping, { count: number }, PingResult>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  (event, _state) => {
    return { echoed: event.word };
  },
);

// The same form without a declared result: passed through untouched — no
// generated schemas, no options object.
const poke = handler<Ping, { count: number }>(
  {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  {
    type: "object",
    properties: { count: { type: "number", asCell: ["cell"] } },
  },
  (_event, _state) => {},
);

export default pattern<Record<string, never>, Verbs>(() => {
  const count = cell(0);
  return { ping: ping({ count }), poke: poke({ count }) };
});

// FIXTURE: schema-first-declared-result
// Verifies: the schema-first authored form handler<E, T[, R]>(eventSchema,
//   stateSchema, callback) keeps its authored schemas and callback positions
//   — nothing is prepended — while a declared result still lowers into the
//   trailing options as `{ resultSchema: … }`. Without a declared result the
//   call passes through byte-identical.
// Context: before this recognition, the injection unconditionally prepended
//   two generated schemas, producing a call whose callback sat at argument 4
//   — a shape the runtime never reads and the sandbox verifier refuses.
