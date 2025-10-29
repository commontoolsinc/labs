/// <cts-enable />
import { recipe, UI } from "commontools";

const dynamicKey = "value" as const;

interface Item {
  value: number;
  other: number;
}

interface State {
  items: Item[];
}

export default recipe<State>("MapDestructuredComputedAlias", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [dynamicKey]: val }) => (
          <span>{val}</span>
        ))}
      </div>
    ),
  };
});
