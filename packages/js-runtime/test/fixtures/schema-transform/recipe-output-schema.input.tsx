/// <cts-enable />
import { recipe, Cell, UI, NAME, h, derive, toSchema } from "commontools";

// Simple types to test recipe output schema transformation
interface RecipeInput {
  name: string;
  count: number;
}

interface RecipeOutput {
  name: string;
  doubled: number;
  message: string;
}

// Recipe with explicit input/output types
export const myRecipe = recipe<RecipeInput>("Doubler", toSchema<RecipeOutput>(), ({ name, count }) => {
  const doubled = derive(count, n => n * 2);
  const message = derive(name, n => `Hello, ${n}!`);
  
  return {
    [NAME]: message,
    [UI]: (
      <div>
        <h2>{message}</h2>
        <p>Original: {count}</p>
        <p>Doubled: {doubled}</p>
      </div>
    ),
    name,
    doubled,
    message
  };
});