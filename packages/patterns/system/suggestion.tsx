/// <cts-enable />
import {
  computed,
  type Default,
  handler,
  ifElse,
  llmDialog,
  pattern,
  patternTool,
  UI,
  type VNode,
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
    const idx = confirmedIndex ?? selectedIndex.get();
    return initialResults[Math.min(idx, initialResults.length - 1)];
  });

  // --- LLM state (freeform query path) ---
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
  const llmResult = Writable.of<Writable<any>>(undefined);

  // Bind the handler to our result cell
  const presentResult = presentResultHandler({ resultCell: llmResult });

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
    <ct-cell-context $cell={llmResult}>
      {computed(() => llmResult ?? "Searching...")}
    </ct-cell-context>
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
