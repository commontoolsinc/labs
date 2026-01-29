/// <cts-enable />
import { computed, pattern } from "commontools";

export default pattern<{ value: number }>(({ value }) => {
  const floored = computed(() => Math.floor(value));
  return { floored };
});
