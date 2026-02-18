/// <cts-enable />
import {
  type BuiltInLLMMessage,
  computed,
  type Default,
  handler,
  ifElse,
  llmDialog,
  pattern,
  patternTool,
  type Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  type WishState,
  Writable,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

const triggerGeneration = handler<
  unknown,
  { addMessage: Stream<BuiltInLLMMessage>; situation: string }
>((_, { addMessage, situation }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: situation }],
  });
});

const sendMessage = handler<
  { detail: { text: string; attachments?: Array<any> } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.text }],
  });
});

export default pattern<
  {
    situation: string;
    context: { [id: string]: any };
    initialResults: Default<Writable<unknown>[], []>;
  },
  WishState<Writable<any>> & { [UI]: VNode }
>(({ situation, context, initialResults }) => {
  // --- Picker state (used when initialResults is non-empty) ---
  const selectedIndex = Writable.of(0);
  const userConfirmedIndex = Writable.of<number | null>(null);

  const confirmedIndex = computed(() => {
    if (initialResults.length === 1) return 0;
    return userConfirmedIndex.get();
  });

  const pickerResult = computed(() => {
    if (initialResults.length === 0) return undefined;
    const idx = confirmedIndex; // Auto-unwraps to number | null
    if (idx === null) return undefined; // Wait for user confirmation
    return initialResults[Math.min(idx, initialResults.length - 1)];
  });

  // --- LLM state (freeform query path) ---
  const profile = wish<string>({ query: "#profile" });

  const profileContext = computed(() => {
    const profileText = profile.result;
    return profileText ? `\n\n--- User Context ---\n${profileText}\n---` : "";
  });

  const systemPrompt = computed(() => {
    const profileCtx = profileContext;
    return `Find a useful pattern, run it, then call presentResult with the cell link.${profileCtx}

Use the user context above to personalize your suggestions when relevant.`;
  });

  const messages = Writable.of<BuiltInLLMMessage[]>([]);

  const { addMessage, pending, result: suggestionResult } = llmDialog({
    system: systemPrompt,
    messages,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
    },
    model: "anthropic:claude-haiku-4-5",
    context,
    resultSchema: toSchema<{ cell: Writable<any> }>(),
  });

  const llmResult = computed(() => suggestionResult?.cell);

  // Reactively select between picker and LLM result. This must be a named
  // computed variable — the CTS transformer leaves named Cells as-is in the
  // return object, which lets wish.ts read the result via .get().
  const result = computed(() => {
    if (initialResults.length > 0) return pickerResult;
    return llmResult;
  });

  // Pre-create VNodes outside the computed so they're stable across
  // re-evaluations (creating VNodes inside a computed causes the
  // reconciler to re-mount the DOM, losing inner subscriptions).
  const freeformUI = (
    <div style="display:contents">
      <ct-cell-context $cell={llmResult}>
        {ifElse(
          computed(() => !!llmResult),
          computed(() => llmResult),
          ifElse(
            computed(() => !!pending),
            <span>Searching...</span>,
            <ct-button
              variant="primary"
              onClick={triggerGeneration({ addMessage, situation })}
            >
              Generate Suggestion
            </ct-button>,
          ),
        )}
      </ct-cell-context>
      <ct-prompt-input
        placeholder="Refine suggestion..."
        pending={pending}
        onct-send={sendMessage({ addMessage })}
      />
    </div>
  );

  const pickerUI = (
    <ct-card>
      <h2>Choose Result ({initialResults.length})</h2>
      <ct-picker $items={initialResults} $selectedIndex={selectedIndex} />
      <ct-button
        variant="primary"
        onClick={() => userConfirmedIndex.set(selectedIndex.get())}
      >
        Confirm Selection
      </ct-button>
    </ct-card>
  );

  return {
    result,
    candidates: initialResults,
    // [UI] must be a static VNode — the reconciler breaks if it's a computed.
    // Use ifElse as a child to switch between modes at the reactive level.
    [UI]: (
      <div style="display:contents">
        {ifElse(
          computed(() => initialResults.length > 0),
          pickerUI,
          freeformUI,
        )}
      </div>
    ),
  };
});
