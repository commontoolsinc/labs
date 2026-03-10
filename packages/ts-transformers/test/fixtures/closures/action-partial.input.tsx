/// <cts-enable />
import { Cell, pattern, action } from "commontools";

interface BaseState {
  a: Cell<string>;
  b: Cell<number>;
}

// Partial<BaseState> should make both 'a' and 'b' optional in the schema
type PartState = Partial<BaseState>;

// FIXTURE: action-partial
// Verifies: Partial<BaseState> produces optional (anyOf undefined|type) capture schemas in handlers
//   action(() => console.log(a)) → handler(false, { a: { anyOf: [undefined, string] } }, ...)({ a })
// Context: Partial<> makes properties optional; capture schemas reflect this with anyOf union
export default pattern<PartState>(({ a, b }) => {
  return {
    readA: action(() => console.log(a)),
    readB: action(() => console.log(b)),
  };
});
