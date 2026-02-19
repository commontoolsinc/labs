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
  // Seed dialog with generateObject's conversation on first follow-up.
  // Pass messages through raw — llmDialog's own tool-result messages use the
  // same format, so the server/AI SDK should accept them.
  // Note: suggestionMessages is a computed, CTS auto-unwraps it to a plain
  // value in handler state bindings — do NOT call .get() on it.
  if (dialogMessages.get().length === 0) {
    const msgs = suggestionMessages;
    if (msgs && msgs.length > 0) {
      dialogMessages.set(msgs);
    }
  }
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.message }],
  });
});

// Dialog-specific fetchAndRunPattern that auto-presents its result.
// Wraps the shared fetchAndRunPattern and writes the result cell to
// activeResult via extraParams, so the UI updates without needing the LLM
// to call a separate presentResult tool.
// finalResult handler for llmDialog — matches the generateObject builtin so
// seeded messages pass through, and auto-presents when called during dialog.
// Must be a handler (not pattern) because patterns run in a separate space
// and can't .set() on cells from the parent pattern.
const presentResult = handler<
  { cell: Writable<any> },
  { activeResult: Writable<{ active: Writable<any> | null }> }
>((event, { activeResult }) => {
  activeResult.set({ active: event.cell });
});

const askUserHandler = handler<
  { question: string; options?: string[] },
  { pendingQuestion: Writable<{ question: string; options?: string[] } | null> }
>((event, { pendingQuestion }) => {
  pendingQuestion.set({ question: event.question, options: event.options });
});

const answerQuestion = handler<
  { detail: { answer: string } },
  {
    pendingQuestion: Writable<{ question: string; options?: string[] } | null>;
    dialogMessages: Writable<BuiltInLLMMessage[]>;
    suggestionMessages: any;
    addMessage: Stream<BuiltInLLMMessage>;
  }
>(
  (
    event,
    { pendingQuestion, dialogMessages, suggestionMessages, addMessage },
  ) => {
    // Same as sendFollowUp — pass raw messages through.
    if (dialogMessages.get().length === 0) {
      const msgs = suggestionMessages;
      if (msgs && msgs.length > 0) {
        dialogMessages.set(msgs);
      }
    }
    pendingQuestion.set(null);
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text: event.detail.answer }],
    });
  },
);

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
  const activeResult = Writable.of<{ active: Writable<any> | null }>({
    active: null,
  });
  const dialogMessages = Writable.of<BuiltInLLMMessage[]>([]);
  const pendingQuestion = Writable.of<
    {
      question: string;
      options?: string[];
    } | null
  >(null);

  const dialogSystemPrompt = computed(() => {
    const profileCtx = profileContext;
    return `You are helping the user refine a result. You previously found and launched a pattern for them.${profileCtx}

Tools:
- fetchAndRunPattern({ url, args }): Fetch a pattern from a URL and run it. Returns { result: { "@link": "..." }, ... }.
- listPatternIndex(): List all available patterns with their URLs.
- finalResult({ cell }): Present a result to the user. Pass the result @link from fetchAndRunPattern's output.
- askUser({ question, options? }): Ask the user a clarifying question. STOP after calling this.

When the user asks to change or improve the result:
1. Call listPatternIndex() to find the right pattern URL
2. Call fetchAndRunPattern({ url, args: {} }) to launch it
3. The response will contain a "result" field with an @link — pass that EXACT @link as the "cell" to finalResult
   Example: fetchAndRunPattern returns { "result": { "@link": "/of:abc/..." } }
   Then call: finalResult({ "cell": { "@link": "/of:abc/..." } })`;
  });

  // NOTE: Intentionally NOT passing `context` here. The context cells contain
  // complex running patterns ($UI, $mentionable, etc.) that cause circular
  // reference errors when llmDialog tries to serialize them for the LLM.
  // builtinTools: false prevents invoke/read/schema/pin from being exposed.
  const dialogParams = {
    system: dialogSystemPrompt,
    messages: dialogMessages,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
      askUser: {
        handler: askUserHandler({ pendingQuestion }),
        description:
          "Ask the user a clarifying question. STOP after calling this.",
      },
      finalResult: {
        handler: presentResult({ activeResult }),
        description:
          "Present a result to the user. Pass the result @link from fetchAndRunPattern output as the cell parameter. " +
          'Example: if fetchAndRunPattern returns { "result": { "@link": "/of:abc/..." } }, ' +
          'call finalResult({ "cell": { "@link": "/of:abc/..." } })',
      },
    },
    model: "anthropic:claude-sonnet-4-5",
    builtinTools: false,
  };
  const dialog = llmDialog(dialogParams);

  const suggestionMessages = computed(() => suggestion.messages);

  const suggestionCell = computed(() => suggestion.result?.cell);
  const dialogCell = computed(() => activeResult.get()?.active);

  // Reactively select between picker and LLM result. This must be a named
  // computed variable — the CTS transformer leaves named Cells as-is in the
  // return object, which lets wish.ts read the result via .get().
  const result = computed(() => {
    if (initialResults.length > 0) return pickerResult;
    // Prefer dialog override, fall back to initial suggestion.
    const d = dialogCell;
    if (d !== null) return d;
    return suggestionCell;
  });

  // Pre-create VNodes outside the computed so they're stable across
  // re-evaluations (creating VNodes inside a computed causes the
  // reconciler to re-mount the DOM, losing inner subscriptions).
  const freeformUI = (
    <div>
      <ct-cell-context $cell={suggestionCell}>
        {computed(() => suggestionCell ?? "Searching...")}
      </ct-cell-context>
      {ifElse(
        computed(() => dialogCell !== null),
        <div>
          <ct-cell-context $cell={dialogCell}>
            {computed(() => dialogCell)}
          </ct-cell-context>
        </div>,
        <span></span>,
      )}
      {ifElse(
        computed(() => pendingQuestion.get() !== null),
        <ct-question
          question={computed(() => pendingQuestion.get()?.question ?? "")}
          options={computed(() => pendingQuestion.get()?.options ?? [])}
          onct-answer={answerQuestion({
            pendingQuestion,
            dialogMessages,
            suggestionMessages,
            addMessage: dialog.addMessage,
          })}
        />,
        ifElse(
          computed(
            () => !suggestion.pending && suggestion.result !== undefined,
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
