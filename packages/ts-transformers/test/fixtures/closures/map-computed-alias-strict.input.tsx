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

export default recipe<State>("MapComputedAliasStrict", (state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [dynamicKey]: val }) => {
          "use strict";
          return <span key={val}>{val * 2}</span>;
        })}
      </div>
    ),
  };
});
