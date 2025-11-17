/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

interface State {
  counter: Cell<number>;
}

export default recipe<State>("LogButton", (_state) => {
  return {
    [UI]: (
      <button type="button" onClick={() => console.log("hi")}>
        Log
      </button>
    ),
  };
});
