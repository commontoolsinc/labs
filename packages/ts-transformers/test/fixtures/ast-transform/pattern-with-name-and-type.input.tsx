/// <cts-enable />
import { pattern } from "commontools";

interface MyInput {
  value: number;
}

export default pattern((input: MyInput) => {
  return {
    result: input.value * 2,
  };
});
