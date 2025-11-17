/// <cts-enable />
import { recipe } from "commontools";

interface MyInput {
  value: number;
}

export default recipe("MyRecipe", (input: MyInput) => {
  return {
    result: input.value * 2,
  };
});
