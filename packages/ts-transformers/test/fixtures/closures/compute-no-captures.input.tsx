/// <cts-enable />
import { computed } from "commontools";

export default function TestComputeNoCaptures() {
  const result = computed(() => 42);

  return result;
}
