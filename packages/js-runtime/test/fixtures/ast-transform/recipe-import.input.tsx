/// <cts-enable />
// Test case: Recipe that imports and uses another recipe
// This tests that transformed code works when recipes are imported from other modules

import { recipe, UI, h, navigateTo, handler } from "commontools";
import Counter from "./counter-recipe.input.tsx";

const createCounter = handler<unknown, unknown>(() => {
  return navigateTo(Counter({ value: 42 }));
});

export default recipe(
  { type: "object", properties: {}, required: [] },
  () => {
    // This calls the imported Counter recipe
    // The Counter recipe contains transformed code (derive calls)
    // which reference commontools_1 that won't be in scope here
    const counterInstance = Counter({ value: 42 });
    
    return {
      [UI]: (
          <ct-button onClick={createCounter}>
            Create Counter
          </ct-button>
      )
    };
  }
);