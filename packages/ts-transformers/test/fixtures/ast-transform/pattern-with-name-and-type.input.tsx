/// <cts-enable />
import { computed, pattern } from "commontools";

interface MyInput {
  value: number;
}

export default pattern((input: MyInput) => {
  return {
    result: computed(() => input.value * 2),
  };
});
