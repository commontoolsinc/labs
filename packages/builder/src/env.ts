import { isDeno } from "../../utils/src/env.ts";

// Environment configuration provided to recipes. Could
// eventually be e.g. `import.meta` exposed to recipes.
//
// /!\ These should not be globals (outside of recipe execution context).
// /!\ Execution needs to be sandboxed to prevent recipes setting these values.

// Environment configuration available to recipes.
export interface RecipeEnvironment {
  readonly apiUrl: URL;
}

let globalEnv = {
  apiUrl: isDeno()
    ? new URL("http://localhost:8000")
    : new URL(new URL(globalThis.location.href).origin),
};

// Sets the `RecipeEnvironment` for all recipes executed
// within this JavaScript context.
export function setRecipeEnvironment(env: RecipeEnvironment) {
  globalEnv = env;
}

// Gets the `RecipeEnvironment` for all recipes executed
// within this JavaScript context.
//
// User-visible.
export function getRecipeEnvironment(): RecipeEnvironment {
  return globalEnv;
}
