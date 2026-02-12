/// <cts-enable />
import {
  computed,
  generateObject,
  pattern,
  patternTool,
  toSchema,
  UI,
  wish,
  type WishState,
  Writable,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

export default pattern<
  { situation: string; context: { [id: string]: any } },
  WishState<Writable<any>>
>(({ situation, context }) => {
  // Get user profile text from home pattern
  const profile = wish<string>({ query: "#profile" });

  // Build profile context string for the system prompt
  const profileContext = computed(() => {
    const profileText = profile.result;
    return profileText ? `\n\n--- User Context ---\n${profileText}\n---` : "";
  });

  // Build system prompt with profile context
  const systemPrompt = computed(() => {
    const profileCtx = profileContext;
    return `Find a useful pattern, run it, pass link to final result.${profileCtx}

Use the user context above to personalize your suggestions when relevant.`;
  });

  const suggestion = generateObject({
    system: systemPrompt,
    prompt: situation,
    context,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
    },
    model: "anthropic:claude-haiku-4-5",
    schema: toSchema<{ cell: Writable<any> }>(),
  });

  const result = computed(() => suggestion.result?.cell);

  return {
    result,
    candidates: undefined,
    error: undefined,
    [UI]: (
      <ct-cell-context $cell={result}>
        {computed(() => result ?? "Searching...")}
      </ct-cell-context>
    ),
  };
});
