/// <cts-enable />
import {
  Cell,
  computed,
  generateObject,
  pattern,
  patternTool,
  toSchema,
  UI,
} from "commontools";
import { fetchAndRunPattern } from "./system/common-tools.tsx";

/**
 * Minimal test to reproduce link cycle issue with fetchAndRunPattern.
 * This pattern uses generateObject to call fetchAndRunPattern,
 * similar to how suggestion.tsx works.
 */
export default pattern<{ prompt: string }>(({ prompt }) => {
  const result = generateObject({
    system: "Create a counter pattern",
    prompt: prompt ?? "gimme counter plz",
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
    },
    model: "anthropic:claude-haiku-4-5",
    schema: toSchema<{ cell: Cell<any> }>(),
  });

  const cell = computed(() => result.result?.cell);

  return {
    result: cell,
    [UI]: (
      <div>
        <h1>Minimal Cycle Test</h1>
        <ct-cell-context $cell={cell} label="Result">
          {computed(() => cell ?? "Waiting for result...")}
        </ct-cell-context>
      </div>
    ),
  };
});
