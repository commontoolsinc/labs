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
    update: action((e: MyEvent) => value.set(e.data)),
  };
});
