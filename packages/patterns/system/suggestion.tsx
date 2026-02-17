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

// Sanitize generateObject's accumulated messages for use in llmDialog.
// After cell serialization round-trip, tool-result messages have an internal
// output format ({ type: "json", value: ... }) that the Vercel AI SDK rejects.
// FIXME(ben): Find a way to include tool-call context (pattern URLs, @link refs) so
// the dialog model knows what was previously launched. Current approach strips
// too much context — the model can't effectively refine the result without
// knowing which pattern was used or the result cell link.
function sanitizeMessagesForDialog(msgs: any[]): BuiltInLLMMessage[] {
  const result: BuiltInLLMMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === "tool") continue; // Drop tool-result messages entirely
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Keep only text parts from assistant messages (strip tool-call parts)
      const textParts = msg.content.filter(
        (p: any) => p.type === "text" && p.text?.trim(),
      );
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts });
      }
      continue;
    }
    // Pass user/system messages through as-is
    result.push(msg);
  }
  return result;
}

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
  // Note: suggestionMessages is a computed, CTS auto-unwraps it to a plain
  // value in handler state bindings — do NOT call .get() on it.
  if (dialogMessages.get().length === 0) {
    const msgs = suggestionMessages;
    if (msgs && msgs.length > 0) {
      dialogMessages.set(sanitizeMessagesForDialog(msgs));
    }
  }
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.message }],
  });
});

// Pattern-based tools for llmDialog. handler() state bindings don't work when
// invoked via llmDialog's tool system (it calls .send(input) without state).
// These patterns receive a Writable via extraParams to write results into.
const presentResultFn = pattern<{
  cell: Writable<any>;
  target: Writable<Writable<any> | undefined>;
}>(({ cell, target }) => {
  // Guard: .set() fails during ct check (no space context).
  // At runtime, extraParams provides a real Writable with a space.
  try {
    target.set(cell);
  } catch { /* ct check only */ }
  return { cell };
});

const askUserFn = pattern<{
  question: string;
  options?: string[];
  target: Writable<{ question: string; options?: string[] } | null>;
}>(({ question, options, target }) => {
  try {
    target.set({ question, options });
  } catch { /* ct check only */ }
  return { question, options };
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
  // Same as sendFollowUp — suggestionMessages is auto-unwrapped by CTS.
  if (dialogMessages.get().length === 0) {
    const msgs = suggestionMessages;
    if (msgs && msgs.length > 0) {
      dialogMessages.set(sanitizeMessagesForDialog(msgs));
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
      presentResult: patternTool(presentResultFn, { target: activeResult }),
      askUser: patternTool(askUserFn, { target: pendingQuestion }),
    },
    model: "anthropic:claude-haiku-4-5",
    // NOTE: Intentionally NOT passing `context` here. The context cells contain
    // complex running patterns ($UI, $mentionable, etc.) that cause circular
    // reference errors when llmDialog tries to serialize them for the LLM.
    // The dialog has fetchAndRunPattern/listPatternIndex tools which is sufficient.
  });

  const suggestionMessages = computed(() => suggestion.messages);

  // llmResult: prefer activeResult (set by presentResult tool via extraParams),
  // fall back to initial generateObject result.
  const llmResult = computed(() => {
    const dialogResult = activeResult;
    if (dialogResult !== undefined) return dialogResult;
    return suggestion.result?.cell;
  });

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
