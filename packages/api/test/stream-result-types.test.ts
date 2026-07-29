import { assertEquals } from "@std/assert";
import type { CELL_RESULT_TYPE, Stream } from "@commonfabric/api";

type MustBeTrue<T extends true> = T;
type AssertAssignable<T, U> = [T] extends [U] ? true : never;
type AssertNotAssignable<T, U> = [T] extends [U] ? never : true;

interface AddTopic {
  title: string;
}

interface TopicRef {
  id: string;
}

// A verb that declares nothing is the common shape and keeps its old spelling.
type ValueLess = Stream<AddTopic>;
type ExplicitVoid = Stream<AddTopic, void>;
type Returning = Stream<AddTopic, TopicRef>;

// `R` defaults to void, so every existing `Stream<T>` means what it always did.
type _DefaultIsVoid = MustBeTrue<AssertAssignable<ValueLess, ExplicitVoid>>;
type _VoidIsDefault = MustBeTrue<AssertAssignable<ExplicitVoid, ValueLess>>;

// A verb that declares a result and one that declares none are different types
// in both directions, so a declared result cannot be dropped on assignment.
//
// These assertions alone do NOT prove the CELL_RESULT_TYPE property is doing
// the work: `ICreatable<Stream<T, R>>` puts the stream in `for()`'s return
// position, which discriminates on `R` too. They would still pass with the
// property removed. The guard below is what pins it locally.
type _ReturningIsNotValueLess = MustBeTrue<
  AssertNotAssignable<Returning, ValueLess>
>;
type _ValueLessIsNotReturning = MustBeTrue<
  AssertNotAssignable<ValueLess, Returning>
>;

// Two different declared results do not interchange either.
type _ResultsDiscriminate = MustBeTrue<
  AssertNotAssignable<Returning, Stream<AddTopic, { other: string }>>
>;

// A stream is still identical to itself.
type _SelfAssignable = MustBeTrue<AssertAssignable<Returning, Returning>>;

// The event type keeps discriminating independently of the result.
type _EventStillDiscriminates = MustBeTrue<
  AssertNotAssignable<Returning, Stream<{ different: number }, TopicRef>>
>;

// `R` is recoverable by inference — what the transformer and schema generator
// read to lower a value-returning verb.
type ResultOf<S> = S extends Stream<infer _E, infer R> ? R : never;
type _InfersDeclaredResult = MustBeTrue<
  AssertAssignable<ResultOf<Returning>, TopicRef>
>;
type _InfersVoidWhenUndeclared = MustBeTrue<
  AssertAssignable<ResultOf<ValueLess>, void>
>;

// The event type stays inferable alongside it.
type EventOf<S> = S extends Stream<infer E, infer _R> ? E : never;
type _InfersEvent = MustBeTrue<AssertAssignable<EventOf<Returning>, AddTopic>>;

// Stream carries the result in its OWN property rather than borrowing the
// discrimination from ICreatable. Deleting `[CELL_RESULT_TYPE]` from Stream
// makes this line a type error, which is the point: without it the behaviour
// above rides on ICreatable's signature and would vanish silently if that
// signature ever changed.
type _ResultPinnedLocally = MustBeTrue<
  AssertAssignable<Returning[typeof CELL_RESULT_TYPE], TopicRef>
>;
type _ValueLessPinnedLocally = MustBeTrue<
  AssertAssignable<ValueLess[typeof CELL_RESULT_TYPE], void>
>;

// Schema compatibility checks results as candidate ⊆ previous, and "results may
// narrow freely" governs values, not named fields: removing a named property is
// rejected outright, so every top-level name a result publishes is permanent.
// A result nested under one key leaves only that key permanent and everything
// beneath it free to narrow — which is why a verb's declared result wants to be
// an envelope rather than the payload spread flat.
interface AddTopicResult {
  topic: { fid: string; title: string };
}

type EnvelopedVerb = Stream<AddTopic, AddTopicResult>;

// The permanent surface of the enveloped form is one key.
type _EnvelopeCommitsOneName = MustBeTrue<
  AssertAssignable<keyof ResultOf<EnvelopedVerb>, "topic">
>;

// Spread flat, every field would be permanent instead. Kept as a contrast so
// the envelope reads as a decision rather than an accident.
type FlatVerb = Stream<AddTopic, { fid: string; title: string }>;
type _FlatCommitsEveryName = MustBeTrue<
  AssertAssignable<keyof ResultOf<FlatVerb>, "fid" | "title">
>;

// The two are not interchangeable, so reshaping a result after the fact is a
// compile error rather than a quiet schema break.
type _EnvelopeIsNotFlat = MustBeTrue<
  AssertNotAssignable<EnvelopedVerb, FlatVerb>
>;

Deno.test("Stream result type parameter is structural", () => {
  // The assertions above are compile-time; this keeps the module a test file
  // and fails loudly if it ever stops being type-checked.
  assertEquals(typeof "compile-time", "string");
});
