/// <cts-enable />
import {
  computed,
  handler,
  llmDialog,
  pattern,
  patternTool,
  UI,
  wish,
  type WishState,
  Writable,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

// Handler that captures the result cell - (event, state) signature
const presentResultHandler = handler(
  (event: { cell: Writable<any> }, state: { resultCell: Writable<any> }) => {
    state.resultCell.set(event.cell);
  },
);

export default pattern<
  { situation: string; context: { [id: string]: any } },
  WishState<Writable<any>>
>(({ situation, context }) => {
  const profile = wish<string>({ query: "#profile" });

  const profileContext = computed(() => {
    const profileText = profile.result;
    return profileText ? `\n\n--- User Context ---\n${profileText}\n---` : "";
  });

  const systemPrompt = computed(() => {
    return `Find a useful pattern, run it, then call presentResult with the result cell.${profileContext}

Use the user context above to personalize your suggestions when relevant.`;
  });

  // Cell to capture the final result
  const result = Writable.of<Writable<any>>(undefined);

  // Bind the handler to our result cell
  const presentResult = presentResultHandler({ resultCell: result });

  const { pending: _pending } = llmDialog({
    system: systemPrompt,
    context,
    initialMessage: situation,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
      // Handler tool - directly writes to bound state
      presentResult: {
        handler: presentResult,
        description: "Present the final result cell",
      },
    },
    model: "anthropic:claude-haiku-4-5",
  });

  return {
    result,
    [UI]: (
      <ct-cell-context $cell={result}>
        {computed(() => result ?? "Searching...")}
      </ct-cell-context>
    ),
  };
});
