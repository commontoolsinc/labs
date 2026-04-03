/// <cts-enable />
import { handler, lift } from "commonfabric";

// FIXTURE: generic-builder-type-parameters-unknown
// Verifies: generic definition-site builder wrappers degrade builder schemas to unknown
//   lift<T, U>(fn) → lift({ type: "unknown" }, { type: "unknown" }, fn)
//   handler<E, S>(fn) → handler({ type: "unknown" }, { type: "unknown" }, fn)
export function buildLift<T, U>() {
  return lift<T, U>((_value) => {
    throw new Error("not executed");
  });
}

export function buildHandler<E, S>() {
  return handler<E, S>((event, state) => {
    void event;
    void state;
  });
}
