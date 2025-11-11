/// <cts-enable />
import { compute } from "commontools";

export default function TestComputeNoCaptures() {
  const result = compute(() => 42);

  return result;
}
