/// <cts-enable />
import { pattern, type Writable, UI } from "commontools";

interface State {
  foo: string;
  bar: string;
}

export default pattern((input: Writable<State>) => {
  return {
    [UI]: <div>{input.key("foo").get()}</div>,
  };
});
