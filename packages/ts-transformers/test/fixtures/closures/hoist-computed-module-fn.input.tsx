/// <cts-enable />
import { computed, pattern } from "commontools";

function helper(x: number) {
  return x * 2;
}

export default pattern<{ value: number }>(({ value }) => {
  const result = computed(() => helper(value));
  return { result };
});
