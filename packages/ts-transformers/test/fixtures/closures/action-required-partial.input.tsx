/// <cts-enable />
import { Cell, pattern, action } from "commontools";

interface BaseState {
  a?: Cell<string>;
  b: Cell<number>;
}

// Required<BaseState> should make 'a' required in the schema
type ReqState = Required<BaseState>;

export default pattern<ReqState>(({ a, b }) => {
  return {
    setA: action(() => a.set("hello")),
    setB: action(() => b.set(42)),
  };
});
