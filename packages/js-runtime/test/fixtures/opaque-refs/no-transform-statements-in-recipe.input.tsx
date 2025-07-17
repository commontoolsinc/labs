/// <cts-enable />
// Test to verify that OpaqueRef operations in statements are NOT transformed
// Only JSX expressions should be transformed
import { recipe, UI, handler, h, Cell } from "commontools";

interface State {
  count: number;
  visible: boolean;
  items: string[];
}

interface HandlerState {
  count: Cell<number>;
  visible: Cell<boolean>;
  items: Cell<string[]>;
}

const increment = handler((e, state: HandlerState) => {
  // In handlers, we need to use get/set methods
  if (state.count.get() > 10) {
    state.count.set(0);
  }
  state.count.set(state.count.get() + 1);
});

export default recipe<State>("NoTransformStatements", (state) => {
  // These statement-level operations should NOT be transformed
  // They will fail at runtime if they try to use OpaqueRef directly
  
  // If statements - NOT transformed
  if (state.count > 10) {
    console.log("Count is high");
  }
  
  // Variable declarations - NOT transformed
  const isHigh = state.count > 10;
  const double = state.count * 2;
  const message = "Count: " + state.count;
  
  // Loops - NOT transformed
  for (let i = 0; i < state.count; i++) {
    console.log(i);
  }
  
  while (state.count < 5) {
    break; // This would fail at runtime
  }
  
  // Switch statements - NOT transformed
  switch (state.count) {
    case 5:
      console.log("Five");
      break;
    default:
      console.log("Other");
  }
  
  // Ternary in statements - NOT transformed
  const status = state.visible ? "visible" : "hidden";
  
  // Function calls with OpaqueRef - NOT transformed
  console.log(state.count);
  console.log(state.visible);
  
  // Array operations - NOT transformed
  const doubled = state.items.map(item => item + "!");
  const filtered = state.items.filter(item => item.length > 5);
  
  return {
    [UI]: (
      <div>
        {/* These JSX expressions SHOULD be transformed */}
        <p>Count: {state.count}</p>
        <p>Double: {state.count * 2}</p>
        <p>Is High: {state.count > 10 ? "Yes" : "No"}</p>
        <p>Items: {state.items.length}</p>
        <button onClick={increment(state)}>Increment</button>
      </div>
    )
  };
});