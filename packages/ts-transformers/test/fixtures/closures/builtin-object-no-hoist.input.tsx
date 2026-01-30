/// <cts-enable />
import { computed, pattern } from "commontools";

export default pattern<{ data: Record<string, number> }>(({ data }) => {
  const keys = computed(() => Object.keys(data));
  return { keys };
});
