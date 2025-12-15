/// <cts-enable />
import { Default, NAME, recipe, Stream, UI } from "commontools";
import { getValue, roll } from "./dice-handlers.ts";

interface RecipeState {
  value: Default<number, 1>;
}

interface RecipeOutput {
  value: number;
  something: {
    nested: string;
  };
  roll: Stream<{ sides?: number }>;
}

export default recipe<RecipeState, RecipeOutput>((state) => {
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
    something: {
      nested: "a secret surprise!",
    },
  };
});
