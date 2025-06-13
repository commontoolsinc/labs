// Expose `getRecipeEnvironment` even if unused so that (dynamic) recipes
// can still import from the host context.
export {
  getRecipeEnvironment,
  setRecipeEnvironment,
} from "./builder/env.ts";
