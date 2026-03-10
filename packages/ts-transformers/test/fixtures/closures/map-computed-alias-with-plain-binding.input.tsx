/// <cts-enable />
import { pattern, UI } from "commontools";

function dynamicKey(): "value" {
  return "value";
}

interface Item {
  foo: number;
  value: number;
}

interface State {
  items: Item[];
}

// FIXTURE: map-computed-alias-with-plain-binding
// Verifies: computed property key mixed with a plain destructured binding in the same pattern
//   { foo, [dynamicKey()]: val } → plain destructure for foo, derive() for val
//   foo + val expression → derive() combining both bindings
// Context: Mixes static destructuring ({foo}) with dynamic computed key ([dynamicKey()]: val)
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ foo, [dynamicKey()]: val }) => (
          <span>{foo + val}</span>
        ))}
      </div>
    ),
  };
});
