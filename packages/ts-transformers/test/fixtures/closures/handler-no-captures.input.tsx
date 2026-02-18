/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

export default pattern<State>((_state) => {
  return {
    [UI]: (
      <button type="button" onClick={() => console.log("hi")}>
        Log
      </button>
    ),
  };
});
