/// <cts-enable />
import { Default, h, NAME, recipe, str, UI } from "commontools";
import { getValue, roll } from "./dice-handlers.ts";

interface RecipeState {
  value: Default<number, 1>;
}

export default recipe<RecipeState>("Dice", (state) => {
  return {
    [NAME]: `Dice Roller`,
    [UI]: (
      <div>
        <ct-button onClick={roll(state)}>
          Roll D6
        </ct-button>
        <ct-button onClick={roll(state)}>
          getValue(state), Roll D20
        </ct-button>
        <span id="dice-result">
          Current value: {state.value}
        </span>
        <ct-button onClick={getValue(state)}>
          Check value
        </ct-button>
      </div>
    ),
    value: state.value,
    roll: roll(state),
  };
});
