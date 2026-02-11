# CT-1206: Add Conversation Continuation to `generateText` for `suggestion.tsx`

## Problem Statement

`suggestion.tsx` needs to run an LLM with tools (fetchAndRunPattern,
listPatternIndex, presentResult) that auto-starts when the pattern mounts. The
previous attempt used `llmDialog`, which failed due to architectural mismatches
between llmDialog's event-driven chat model and the reactive auto-start
requirement.

The fix: extend `generateText` to expose the full conversation history in its
result, enabling `suggestion.tsx` to use it as a reactive, auto-starting LLM
call with tool support.

## Why `generateText` Is the Right Fit

`generateText` is a **reactive builtin**: its action function runs whenever its
input cell changes. It already supports:

- `messages` input (array of user/assistant/tool messages)
- `tools` parameter with full tool catalog (handlers, patterns)
- `executeWithToolsLoop` for multi-turn tool calls
- Hash-based deduplication (`previousCallHash` / `requestHash`) to prevent
  redundant requests
- Streaming partial results

What it lacks: the result cell does not include the final conversation
`messages` (including tool call/result messages from the tool loop). Adding this
single field unlocks conversation continuation.

### Reactivity Model (Critical)

Understanding what triggers re-evaluation and what does not:

**What triggers the reactive function:**

- Any change to `inputsCell` (the params cell). This includes `prompt`,
  `messages`, `system`, `model`, `maxTokens`, `tools`, `context`.
- Any change to cells read via `context` (because `buildContextDocumentation`
  reads them inside the action).

**What does NOT trigger the reactive function:**

- Writing to `resultCell` (the output cell). The reactive function reads from
  `inputsCell`, not `resultCell`. This is why writing conversation history to
  the result is safe.
- The in-memory tool loop (`executeWithToolsLoop`). This runs asynchronously
  outside the reactive transaction. Messages accumulate in a local array
  (`currentMessages` in `executeRecursive`). Only the final result is written to
  the result cell.

**Conversation continuation flow:**

1. Pattern sets `messages` input to `[{ role: "user", content: "Go" }]`
2. `generateText` reactive function fires, hashes the params, starts LLM call
3. Tool loop runs in memory (fetchAndRunPattern, listPatternIndex, etc.)
4. On completion, writes `{ result, messages, pending: false }` to result cell
5. Pattern reads `result.messages` -- this does NOT re-trigger generateText
   because the pattern reads from the result cell, not the input cell
6. To continue: pattern sets input `messages` to
   `[...result.messages, { role: "user", content: "follow up" }]`
7. This changes `inputsCell`, which triggers a new reactive evaluation with a
   new hash

**Why this avoids the llmDialog problems:**

- No auto-start race: generateText fires automatically on message change
- No read-only input issue: the pattern owns a Writable messages cell
- No handler state binding: we use the result cell's `messages` field instead of
  a `presentResult` handler tool
- No abort check fighting: tool loop is in-memory, result writes don't trigger
  re-evaluation

## Lessons Learned (from Failed llmDialog Approach)

### 1. `initialMessage` parameter on llmDialog (reactive section)

- Added `initialMessage` to llmDialog's schema, read it in the reactive section
- FAILED: `addMessage` handler overwrites entire `internal` cell via `.set()`,
  losing `initialMessageSent` flag. Infinite re-send loop on next reactive pass.
- Even after fixing with key-level writes, stream `.send()` from reactive
  section triggers handler in different transaction context. Handler sets
  closure variables (`requestId`) that reactive abort check misinterprets.

### 2. `autoStart` flag on llmDialog (init block)

- Moved auto-start to init block with static boolean flag and synthetic "Go"
  message
- FAILED: `startRequest` (async) from init block causes race conditions with
  reactive abort check. Abort check sees `pending` state from `startRequest`
  completing and aborts the request.

### 3. Handler state binding

- `handler((event, state) => { state.resultCell.set(event.cell) })` pattern
  fails because `state` is undefined when tool fires inside CTS-compiled
  patterns. The handler API's state binding does not survive the CTS compilation
  and tool execution pipeline.

### 4. Core architectural mismatch

- llmDialog is designed for interactive chat (external event-driven control)
- Auto-starting from within a CTS pattern fights the reactive function, stream
  handlers, and abort checks which all assume external event-driven control

## Implementation Plan

### Step 1: Add `messages` field to GenerateTextResultSchema

**File:** `/Users/ben/code/labs/packages/runner/src/builtins/llm.ts`

Add a `messages` property to `GenerateTextResultSchema`:

```typescript
const GenerateTextResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: { type: "string" },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
    messages: { type: "array", items: LLMMessageSchema }, // NEW
  },
  required: ["pending"],
} as const satisfies JSONSchema;
```

Import `LLMMessageSchema` is already present (used by
`GenerateTextParamsSchema`).

**Rationale:** This is the foundational data model change. Everything else
builds on having conversation history in the result.

**Validation:** The schema change is backward-compatible (new optional field).
Existing consumers that don't read `messages` are unaffected.

### Step 2: Write conversation history to result cell in `generateText`

**File:** `/Users/ben/code/labs/packages/runner/src/builtins/llm.ts`

In the `generateText` function, modify `executeWithToolsLoop`'s `onComplete`
callback and the surrounding code to capture and write the final message array.

The key change is in the `onComplete` handler. Currently:

```typescript
onComplete: async (llmResult) => {
  await runtime.idle();
  const textResult = extractTextFromLLMResponse(llmResult);
  await runtime.editWithRetry((tx) => {
    resultCell.key("pending").withTx(tx).set(false);
    resultCell.key("result").withTx(tx).set(textResult);
    // ...
  });
},
```

We need to pass the final messages array through to `onComplete`. The
`executeWithToolsLoop` function already has access to the accumulated messages
internally (in `executeRecursive`'s `currentMessages` parameter), but it does
not expose them to `onComplete`.

**Approach: Extend `onComplete` signature.**

Change `executeWithToolsLoop`'s `onComplete` to:

```typescript
onComplete: ((
  llmResult: LLMResponse,
  finalMessages: readonly BuiltInLLMMessage[],
) => Promise<void>);
```

In `executeRecursive`, the non-tool-call branch becomes:

```typescript
} else {
  // No more tool calls, finish
  // Build the final assistant message and append to messages
  const assistantMessage: BuiltInLLMMessage = {
    role: "assistant",
    content: llmResult.content,
  };
  const finalMessages = [...currentMessages, assistantMessage];
  await onComplete(llmResult, finalMessages);
}
```

Then in `generateText`'s `onComplete`:

```typescript
onComplete: async (llmResult, finalMessages) => {
  await runtime.idle();
  const textResult = extractTextFromLLMResponse(llmResult);
  await runtime.editWithRetry((tx) => {
    resultCell.key("pending").withTx(tx).set(false);
    resultCell.key("result").withTx(tx).set(textResult);
    resultCell.key("error").withTx(tx).set(undefined);
    resultCell.key("partial").withTx(tx).set(textResult);
    resultCell.key("requestHash").withTx(tx).set(hash);
    resultCell.key("messages").withTx(tx).set(finalMessages);  // NEW
  });
},
```

**Impact on `llm` builtin:** The `llm` function also calls
`executeWithToolsLoop`. Its `onComplete` would need the updated signature but
can ignore the second arg:

```typescript
onComplete: async (llmResult, _finalMessages) => { ... }
```

**Rationale:** `executeWithToolsLoop` already accumulates messages internally.
Exposing them via the callback is the minimal change.

**Validation:** Write a unit test that calls `generateText` with tools and
verifies that `result.messages` contains the full conversation (user message,
assistant tool calls, tool results, final assistant response).

### Step 3: Add `messages` to `BuiltInGenerateTextState` type

**File:** `/Users/ben/code/labs/packages/api/index.ts`

Update the TypeScript interface:

```typescript
export interface BuiltInGenerateTextState {
  pending: boolean;
  result?: string;
  error?: unknown;
  partial?: string;
  requestHash?: string;
  messages?: BuiltInLLMMessage[]; // NEW
}
```

`BuiltInLLMMessage` is already defined in the same file and used by
`BuiltInLLMParams`.

**Rationale:** Type safety for pattern code that reads `messages` from the
result.

**Validation:** TypeScript compilation succeeds; `suggestion.tsx` can type-check
access to `.messages`.

### Step 4: Rewrite `suggestion.tsx` to use `generateText` instead of `llmDialog`

**File:** `/Users/ben/code/labs/packages/patterns/system/suggestion.tsx`

This is the largest change. The new pattern:

1. Removes `llmDialog`, `handler` imports
2. Adds `generateText` import
3. Replaces the `presentResult` handler with extracting the result from
   conversation message history
4. Uses a `Writable` messages cell as input to `generateText`

**Key design decision: How does the LLM communicate which cell is "the
result"?**

With `llmDialog`, this was done via the `presentResult` handler tool. Since
handler state binding is broken in CTS patterns, we need an alternative.

**Approach: `presentResult` as a pattern tool (not handler)**

Create a tiny pattern that receives a cell link and just returns it. The LLM
calls `presentResult({ cell: { "@link": "/of:xyz" } })` via `patternTool(...)`.
Then `suggestion.tsx` reads the `messages` from the generateText result, finds
the `presentResult` tool call's result, and extracts the cell reference.

This works because `generateText` now exposes `messages` in the result (Step 2).

```typescript
// New pattern tool in suggestion.tsx or common-tools.tsx:
export const presentResult = pattern<
  { cell: Writable<any> },
  { cell: Writable<any> }
>(({ cell }) => {
  return { cell };
});
```

Then in the pattern body, extract from messages:

```typescript
const resultCellFromLLM = computed(() => {
  const msgs = llmResponse.messages;
  if (!msgs) return undefined;
  // Find the tool result for presentResult
  for (const msg of msgs) {
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.toolName === "presentResult" && part.output) {
          // The tool result from handleInvoke includes @resultLocation
          // which is a cell link that can be resolved
          return part.output;
        }
      }
    }
  }
  return undefined;
});
```

**Alternative considered: Parse the LLM's text response for a structured
marker.** Rejected -- less reliable, depends on LLM following formatting
instructions.

**Alternative considered: Add a `finalResult`-style builtin tool to
generateText.** This is Option C / fallback if Option A proves fragile. It would
add a special `capturedResult` field to the result schema, similar to how
`generateObject` uses `FINAL_RESULT_TOOL_NAME`. Adds complexity to
`generateText` that may not be warranted initially.

**Sketch of the new pattern body:**

```tsx
export default pattern<
  {
    situation: string;
    context: { [id: string]: any };
    initialResults: Default<Writable<unknown>[], []>;
  },
  WishState<Writable<any>> & { [UI]: VNode }
>(({ situation, context, initialResults }) => {
  // --- Picker state (unchanged from current) ---
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

  const systemPrompt = computed(() => {
    const profileText = profile.result;
    const profileCtx = profileText
      ? `\n\n--- User Context ---\n${profileText}\n---`
      : "";
    return `The user asked: "${situation}"

Find a useful pattern, run it, then call presentResult with the result cell.${profileCtx}

Use the user context above to personalize your suggestions when relevant.`;
  });

  // Writable messages cell - pattern owns this, generateText reads it
  const messages = Writable.of<any[]>([
    { role: "user", content: "Go" },
  ]);

  const llmResponse = generateText({
    system: systemPrompt,
    messages,
    context,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      listPatternIndex: patternTool(listPatternIndex),
      presentResult: patternTool(presentResult),
    },
    model: "anthropic:claude-haiku-4-5",
  });

  // Extract result cell from conversation history
  const llmResult = computed(() => {
    const msgs = llmResponse.messages;
    if (!msgs) return undefined;
    for (const msg of msgs) {
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.toolName === "presentResult" && part.output) {
            // handleInvoke returns { "@resultLocation": link, result: ... }
            // The result field contains the cell reference
            return part.output?.result?.cell;
          }
        }
      }
    }
    return undefined;
  });

  const result = computed(() => {
    if (initialResults.length > 0) return pickerResult;
    return llmResult;
  });

  // UI (unchanged structure)
  const freeformUI = (
    <ct-cell-context $cell={llmResult}>
      {computed(() => llmResult ?? llmResponse.partial ?? "Searching...")}
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
```

**Rationale for step ordering:** This step depends on Steps 1-3 (messages in
result schema, written by generateText, typed in API).

**Validation:** Manual test: create a wish with a freeform query, verify
suggestion.tsx launches, LLM calls tools, result cell is captured and displayed.

### Step 5: Verify `wish.ts` needs no changes

**File:** `/Users/ben/code/labs/packages/runner/src/builtins/wish.ts`

Review `wish.ts` for any llmDialog-specific code from the failed migration
branch. The current code uses `launchSuggestionPattern` which calls
`runtime.runSynced(suggestionPatternResultCell, suggestionPattern,
suggestionPatternInput)`.
This is pattern-agnostic -- it does not care whether suggestion.tsx uses
generateText or llmDialog internally.

The key interface between `wish.ts` and `suggestion.tsx` is the `WishState`
type: `{ result, candidates, [UI] }`. As long as `suggestion.tsx` returns this
shape, `wish.ts` needs no changes.

**Likely outcome:** No changes needed. But verify that no llmDialog-specific
result shape assumptions exist (e.g., reading `pending` from the suggestion
pattern result).

**Validation:** Run existing wish.test.ts tests.

### Step 6: Test the tool loop with `generateText`

**File:** `/Users/ben/code/labs/packages/runner/test/llm.test.ts` (or new file)

Write integration tests:

1. **Basic tool loop test:** generateText with a mock tool, verify `messages` in
   result contains the full conversation.
2. **Hash dedup test:** Verify that reading `result.messages` does not
   re-trigger generateText (because messages is on the result cell, not the
   input cell).
3. **Conversation continuation test:** After first completion, set input
   messages to `[...result.messages, newUserMsg]`, verify new LLM call fires
   with full context.

**Validation:** All tests pass. The hash-dedup test is especially critical -- it
proves the reactivity model works as claimed.

### Step 7: Clean up llmDialog `autoStart` code (optional)

If the `autoStart` parameter on `llmDialog` was added during the failed
migration and is not used elsewhere, remove it to reduce confusion. Check
`LLMParamsSchema` in `llm-schemas.ts` (line 77:
`autoStart: { type: "boolean"
}`) and `llmDialog` init block (lines 2032-2060).

**Decision point:** If `autoStart` is used by other callers (e.g., the chat UI),
keep it. If it was only added for this migration, remove it.

## Risk Assessment

**Low risk:**

- Schema/type changes (Steps 1, 3) are additive
- `wish.ts` likely needs no changes (Step 5)

**Medium risk:**

- `executeWithToolsLoop` signature change (Step 2) touches both `llm` and
  `generateText` builtins. Must update both callers.
- Extracting the result cell from conversation messages (Step 4) depends on the
  tool result message format from `llmToolExecutionHelpers`. Need to verify the
  exact shape of tool result messages returned by `createToolResultMessages` and
  `handleInvoke`.

**Key unknowns:**

- Does `patternTool()` work correctly with `generateText`'s tool catalog? It
  should, since `generateText` already delegates to
  `llmToolExecutionHelpers.buildToolCatalog`, which handles pattern tools. But
  this has not been tested with CTS-compiled patterns calling generateText.
- The `fetchAndRunPattern` tool is async and polls for results. The
  `executeWithToolsLoop` already handles this via `executeToolCalls`. Verify
  timeout is sufficient for pattern compilation + execution.
- The exact format of tool result messages needs verification. `handleInvoke`
  returns `{ "@resultLocation": link, result: serializedValue, schema: ... }`.
  `createToolResultMessages` wraps this in
  `{ type: "tool-result", output: ... }`. The `presentResult` pattern would
  return `{ cell: cellRef }`, so the output would be
  `{ "@resultLocation": "/of:xyz", result: { cell: <serialized cell link> } }`.
  Need to confirm cell links survive serialization through
  `traverseAndSerialize`.

## File Change Summary

| File                                          | Change                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/runner/src/builtins/llm.ts`         | Add `messages` to result schema; extend `onComplete` signature; write messages to result cell        |
| `packages/api/index.ts`                       | Add `messages?: BuiltInLLMMessage[]` to `BuiltInGenerateTextState`                                   |
| `packages/patterns/system/suggestion.tsx`     | Rewrite to use `generateText`; add `presentResult` pattern tool; extract result from message history |
| `packages/runner/src/builtins/llm-schemas.ts` | No changes needed                                                                                    |
| `packages/runner/src/builtins/llm-dialog.ts`  | No changes needed (Step 7 optional cleanup only)                                                     |
| `packages/runner/src/builtins/wish.ts`        | Likely no changes needed                                                                             |
| `packages/runner/test/`                       | New/updated tests for generateText messages field                                                    |
