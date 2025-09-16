/// <cts-enable />
import { Cell, handler, recipe } from "commontools";

interface State {
  value: Cell<number>;
  name?: Cell<string>;
}

const myHandler = handler((_, state: State) => {
  state.value.set(state.value.get() + 1);
});

export default recipe({ type: "object", properties: { value: { type: "number" }, name: { type: "string" } } }, (state) => {
  return {
    // Test case 1: Object literal with all properties from state
    onClick1: myHandler({ value: state.value, name: state.name }),
    
    // Test case 2: Object literal with subset of properties
    onClick2: myHandler({ value: state.value }),
    
    // Test case 3: Direct state passing (what we want to transform to)
    onClick3: myHandler(state),
  };
});
