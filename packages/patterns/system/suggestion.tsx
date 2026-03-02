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
import {
  bash,
  fetchAndRunPattern,
  listMentionable,
  listPatternIndex,
  listRecent,
} from "./common-tools.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";
import { type MentionablePiece } from "./backlinks-index.tsx";

const triggerGeneration = handler<
  unknown,
  {
    addMessage: Stream<BuiltInLLMMessage>;
    situation: string;
    result: any | null;
  }
>((_, { addMessage, situation, result }) => {
  if (!result) {
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text: situation }],
    });
  }
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

const showRefineInput = handler<unknown, { showRefine: Writable<boolean> }>(
  (_, { showRefine }) => {
    showRefine.set(true);
  },
);

const setQuestion = handler<
  { question: string; options: string[] },
  { pendingQuestion: Writable<{ question: string; options: string[] } | null> }
>(({ question, options }, { pendingQuestion }) => {
  pendingQuestion.set({ question, options });
});

const onQuestionAnswer = handler<
  { detail: { answer: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    pendingQuestion: Writable<{ question: string; options: string[] } | null>;
  }
>(({ detail }, { addMessage, pendingQuestion }) => {
  pendingQuestion.set(null);
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: detail.answer }],
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

  const mentionable =
    wish<MentionablePiece[]>({ query: "#mentionable" }).result;
  const recentPieces = wish<MentionablePiece[]>({ query: "#recent" }).result;
  const { entries: summaryEntries } = wish<{
    entries: SummaryIndexEntry[];
  }>({ query: "#summaryIndex" }).result;

  const profileContext = computed(() => {
    const profileText = profile.result;
    return profileText ? `\n\n--- User Context ---\n${profileText}\n---` : "";
  });

  const sandboxId = Writable.of(
    `suggestion-${Math.random().toString(36).slice(2, 10)}`,
  );

  const systemPrompt = computed(() => {
    const profileCtx = profileContext;
    return `You help users by finding relevant content and patterns.${profileCtx}

Your textual responses are invisible to the user — they can only see the presented result.

Strategy:
1. First, search the space for existing relevant content using searchSpace
2. If you find something useful, call presentResult with it directly
3. If nothing exists, check listPatternIndex for patterns that could help
4. Use fetchAndRunPattern to instantiate a pattern, optionally with existing data as context
5. Call presentResult with the final cell link
6. If the request is ambiguous, has multiple valid interpretations, or you need user preferences, call askUserQuestion with a clear question and 2-4 options. After calling it, STOP and do not call any other tools — the user's answer will arrive as the next message.

Use the user context above to personalize your suggestions when relevant.`;
  });

  const messages = Writable.of<BuiltInLLMMessage[]>([]);
  const showRefine = Writable.of(false);
  const pendingQuestion = Writable.of<
    { question: string; options: string[] } | null
  >(null);

  const {
    addMessage,
    pending,
    result: suggestionResult,
  } = llmDialog({
    system: systemPrompt,
    messages,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
      bash: patternTool(bash, { sandboxId }),
      searchSpace: patternTool(summarySearchPattern, {
        entries: summaryEntries,
      }),
      listMentionable: patternTool(listMentionable, { mentionable }),
      listRecent: patternTool(listRecent, { recentPieces }),
      askUserQuestion: {
        handler: setQuestion({ pendingQuestion }),
        description:
          "Ask the user a clarifying question with 2-4 multiple-choice options. After calling, STOP and wait for the user's answer in the next message. Input: { question: string, options: string[] }",
      },
    },
    model: "anthropic:claude-sonnet-4-5",
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
      <ct-autostart
        onstart={triggerGeneration({
          addMessage,
          situation,
          result: llmResult,
        })}
      />
      <ct-cell-link
        $cell={llmResult}
        style={computed(() => (llmResult ? "" : "display:none"))}
      />
      <ct-cell-context $cell={llmResult}>
        {ifElse(
          computed(() => !!llmResult),
          computed(() => llmResult),
          undefined,
        )}
      </ct-cell-context>
      <ct-message-beads
        label="suggestion"
        $messages={messages}
        pending={pending}
        onct-refine={showRefineInput({ showRefine })}
      />
      {ifElse(
        computed(() => pendingQuestion.get() !== null),
        <ct-question
          question={computed(() => pendingQuestion.get()?.question ?? "")}
          options={computed(() => pendingQuestion.get()?.options ?? [])}
          allow-custom
          onct-answer={onQuestionAnswer({ addMessage, pendingQuestion })}
        />,
        undefined,
      )}
      <ct-prompt-input
        placeholder="Refine suggestion..."
        pending={pending}
        style={computed(() => (showRefine.get() ? "" : "display:none"))}
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
