/// <cts-enable />
import {
  type BuiltInLLMMessage,
  computed,
  type Default,
  generateObject,
  handler,
  ifElse,
  llmDialog,
  pattern,
  patternTool,
  Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  type WishState,
  Writable,
} from "commontools";
import { fetchAndRunPattern, listPatternIndex } from "./common-tools.tsx";

// --- Module-level handlers ---
const sendFollowUp = handler<
  { detail: { message: string } },
  {
    dialogMessages: Writable<BuiltInLLMMessage[]>;
    suggestionMessages: any;
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((event, { dialogMessages, suggestionMessages, addMessage }) => {
  // Seed dialog with generateObject's conversation on first follow-up
  if (dialogMessages.get().length === 0) {
    const msgs = suggestionMessages.get();
    if (msgs && msgs.length > 0) {
      dialogMessages.set([...msgs]);
    }
  }
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.message }],
  });
});

const presentResultTool = handler<
  { cell: Writable<any> },
  { activeResult: Writable<Writable<any> | undefined> }
>(({ cell }, { activeResult }) => {
  activeResult.set(cell);
});

const askUserTool = handler<
  { question: string; options?: string[] },
  { pendingQuestion: Writable<{ question: string; options?: string[] } | null> }
>(({ question, options }, { pendingQuestion }) => {
  pendingQuestion.set({ question, options: options ?? [] });
});

const answerQuestion = handler<
  { detail: { message: string } },
  {
    pendingQuestion: Writable<{ question: string; options?: string[] } | null>;
    dialogMessages: Writable<BuiltInLLMMessage[]>;
    suggestionMessages: any;
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((
  event,
  { pendingQuestion, dialogMessages, suggestionMessages, addMessage },
) => {
  if (dialogMessages.get().length === 0) {
    const msgs = suggestionMessages.get();
    if (msgs && msgs.length > 0) {
      dialogMessages.set([...msgs]);
    }
  }
  pendingQuestion.set(null);
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.message }],
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

  // --- Follow-up dialog state ---
  const activeResult = Writable.of<Writable<any> | undefined>(undefined);
  const dialogMessages = Writable.of<BuiltInLLMMessage[]>([]);
  const pendingQuestion = Writable.of<
    { question: string; options?: string[] } | null
  >(null);

  const dialogSystemPrompt = computed(() => {
    const profileCtx = profileContext;
    return `You are helping the user refine a result. You previously found and launched a pattern for them.${profileCtx}

Available tools:
- fetchAndRunPattern: Fetch a pattern from a URL and run it with arguments
- listPatternIndex: List all available patterns
- presentResult: Call this with { cell: <link> } to update the displayed result
- askUser: Ask the user a question. Pass { question, options? }. After calling this, STOP and wait. The user's answer will appear as your next message.

When the user asks to change or improve the result:
1. Use listPatternIndex if you need to find a different pattern
2. Use fetchAndRunPattern to launch a new/modified pattern
3. Call presentResult with the new cell to update what the user sees

Always call presentResult when you have a new result to show.`;
  });

  const dialog = llmDialog({
    system: dialogSystemPrompt,
    messages: dialogMessages,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
      presentResult: { handler: presentResultTool({ activeResult }) },
      askUser: { handler: askUserTool({ pendingQuestion }) },
    },
    model: "anthropic:claude-haiku-4-5",
    context,
  });

  const suggestionMessages = computed(() => suggestion.messages);

  // Base result from generateObject — keep this simple to avoid
  // CTS transform issues. activeResult override is layered on top
  // in the UI render path once we verify the base case works.
  const llmResult = computed(() => suggestion.result?.cell);

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
    <div>
      <ct-cell-context $cell={llmResult}>
        {computed(() => llmResult ?? "Searching...")}
      </ct-cell-context>
      {ifElse(
        computed(() => pendingQuestion.get() !== null),
        <div>
          <ct-card>
            <p>{computed(() => pendingQuestion.get()?.question ?? "")}</p>
            {computed(() => {
              const q = pendingQuestion.get();
              if (!q?.options?.length) return "";
              return q.options.join(" | ");
            })}
          </ct-card>
          <ct-message-input
            placeholder="Type your answer..."
            onct-send={answerQuestion({
              pendingQuestion,
              dialogMessages,
              suggestionMessages,
              addMessage: dialog.addMessage,
            })}
          />
        </div>,
        ifElse(
          computed(() =>
            !suggestion.pending && suggestion.result !== undefined
          ),
          <ct-message-input
            placeholder="Refine this result..."
            onct-send={sendFollowUp({
              dialogMessages,
              suggestionMessages,
              addMessage: dialog.addMessage,
            })}
          />,
          <span></span>,
        ),
      )}
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
