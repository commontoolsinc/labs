/// <cts-enable />
import { computed, fetchData, ifElse, pattern, UI } from "commontools";

// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument

export default pattern<Record<string, never>>(() => {
  const { pending, result } = fetchData({
    url: "/api/data",
    mode: "text",
  });

  // Pattern 1: undefined as ifTrue (waiting state returns nothing)
  const output1 = ifElse(
    computed(() => pending || !result),
    undefined,
    { result }
  );

  // Pattern 2: undefined as ifFalse (error state returns nothing)
  const output2 = ifElse(
    computed(() => !!result),
    { data: result },
    undefined
  );

  return {
    [UI]: (
      <div>
        <span>{output1}</span>
        <span>{output2}</span>
      </div>
    ),
  };
});
