/// <cts-enable />
import { Cell, computed, pattern, UI } from "commontools";
import { fetchAndRunPattern } from "./system/common-tools.tsx";

/**
 * Even more minimal test - directly call fetchAndRunPattern
 * without using generateObject
 */
export default pattern<{ url: string }>(({ url }) => {
  // Directly call fetchAndRunPattern with a counter pattern URL
  const result = fetchAndRunPattern({
    url: url ?? "https://common.tools/api/patterns/counter.tsx",
    args: Cell.of({}),
  });

  const cell = computed(() => result?.cell);

  return {
    result: cell,
    [UI]: (
      <div>
        <h1>Minimal Cycle Test 2</h1>
        <p>Testing fetchAndRunPattern directly</p>
        <ct-cell-context $cell={cell} label="Result">
          {computed(() => cell ?? "Waiting for result...")}
        </ct-cell-context>
      </div>
    ),
  };
});
