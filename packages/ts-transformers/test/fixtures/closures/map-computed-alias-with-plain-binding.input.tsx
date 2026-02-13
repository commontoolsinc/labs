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

export default pattern<State>("MapComputedAliasWithPlainBinding", (state) => {
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
