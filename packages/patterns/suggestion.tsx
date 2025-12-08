/// <cts-enable />
import {
  Cell,
  computed,
  derive,
  generateObject,
  pattern,
  patternTool,
  toSchema,
  UI,
  type WishState,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

export default pattern<
  { situation: string; context: { [id: string]: any } },
  WishState<Cell<any>>
>(({ situation, context }) => {
  const suggestion = generateObject({
    system: "Find a useful pattern, run it, pass link to final result",
    prompt: situation,
    context,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
    },
    model: "anthropic:claude-haiku-4-5",
    schema: toSchema<{ cell: Cell<any> }>(),
  });

  const result = computed(() => suggestion.result?.cell);

  return {
    result,
    [UI]: (
      <ct-cell-context $cell={result}>
        {derive(result, (r) => r ?? "Searching...")}
      </ct-cell-context>
    ),
  };
});
