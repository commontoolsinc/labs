import { action, cell, pattern, Stream } from "commonfabric";

interface AddTopic {
  title: string;
}

interface AddTopicResult {
  topic: { fid: string };
}

interface Verbs {
  addTopic: Stream<AddTopic, AddTopicResult>;
  touch: Stream<AddTopic>;
}

export default pattern<Record<string, never>, Verbs>(() => {
  const count = cell(0);

  // A verb that declares what it produces (verb contract rule 3). The result
  // rides `Stream`'s second type parameter and is opt-in by naming both type
  // arguments — it is never inferred from the body.
  const addTopic = action<AddTopic, AddTopicResult>((event) => {
    count.set(count.get() + 1);
    return { topic: { fid: event.title } };
  });

  // The value-less shape, unchanged, for contrast.
  const touch = action((_event: AddTopic) => {
    count.set(count.get() + 1);
  });

  // Returned against the `Verbs` annotation on `pattern<>` above, so the
  // declared result is LOAD-BEARING here rather than decorative: fixture
  // inputs are type-checked (only `*.expected.*` is excluded from the check
  // task), so if a returning verb ever stops satisfying `Stream<E, R>` this
  // file fails to compile. An earlier revision declared `Verbs` and never
  // returned against it, which asserted nothing.
  return { addTopic, touch };
});

// FIXTURE: stream-declared-result
// Verifies: a declared result on Stream's second parameter survives the
//   transformer and still satisfies the pattern's own Output annotation.
//   `action` is the sole result-authoring surface — `handler()` produces
//   HandlerFactory<T, E, void>, so the same shape written with `handler` does
//   not compile. C2 lowers the returned value; C3 emits the result schema.
//   Until both land, a returning verb transforms exactly like a value-less
//   one, and this golden is the baseline they move.
//
// The explicit type-argument form does NOT cost the input schema: `addTopic`
// emits `{title: string}` from `action<AddTopic, …>` with an unannotated
// callback parameter, exactly as `touch` does from an annotated one. Worth
// stating because the opposite is easy to conclude from a hand-rolled
// transform — the schema comes out `true` unless the real `commonfabric`
// types are supplied, which the fixture runner does and an ad-hoc script
// does not.
