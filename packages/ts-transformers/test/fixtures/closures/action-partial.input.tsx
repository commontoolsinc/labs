/// <cts-enable />
import { Cell, pattern, action } from "commontools";

interface BaseState {
  a: Cell<string>;
  b: Cell<number>;
}

// Partial<BaseState> should make both 'a' and 'b' optional in the schema
type PartState = Partial<BaseState>;

export default pattern<PartState>(({ a, b }) => {
  return {
    readA: action(() => console.log(a)),
    readB: action(() => console.log(b)),
  };
});
