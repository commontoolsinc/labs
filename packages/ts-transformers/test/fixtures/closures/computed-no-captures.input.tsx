/// <cts-enable />
import { computed, pattern } from "commontools";

export default pattern(() => {
  const result = computed(() => 42);

  return result;
});
