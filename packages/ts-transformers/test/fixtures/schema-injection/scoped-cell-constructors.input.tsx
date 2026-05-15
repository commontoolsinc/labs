import {
  Cell,
  Stream,
  type PerUser,
  type Writable,
  Writable as WritableConstructor,
} from "commonfabric";

interface Event {
  message: string;
}

// FIXTURE: scoped-cell-constructors
// Verifies: scoped cell constructor helpers inject top-level schema scopes.
export default function TestScopedCellConstructors() {
  const name = WritableConstructor.perUser.of("Ada");
  const draft = Cell.perSession.for<string>("draft");
  const events = Stream.perSpace.of<Event>({ message: "ready" });
  const contextual: PerUser<Writable<string>> = WritableConstructor.of("");
  const inherited = WritableConstructor.of("");

  return {
    name,
    draft,
    events,
    contextual,
    inherited,
  };
}
