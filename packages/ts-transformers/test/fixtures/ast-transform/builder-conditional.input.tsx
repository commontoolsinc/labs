/// <cts-enable />
import { Default, h, NAME, recipe, UI } from "commontools";

interface RecipeState {
  count: Default<number, 0>;
  label: Default<string, "">;
}

export default recipe<RecipeState>("ConditionalRecipe", (state) => {
  return {
    [NAME]: state.label,
    [UI]: (
      <section>
        {state && state.count > 0
          ? <p>Positive</p>
          : <p>Non-positive</p>}
      </section>
    ),
  };
});
