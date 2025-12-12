/// <cts-enable />
import { Cell, pattern, action } from "commontools";

interface MyEvent {
  data: string;
}

interface State {
  value: Cell<string>;
}

export default pattern<State>(({ value }) => {
  return {
    // Test action<MyEvent>((e) => ...) variant (type parameter instead of inline annotation)
    update: action<MyEvent>((e) => value.set(e.data)),
  };
});
