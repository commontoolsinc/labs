# LLM Generation

LLM calls are reactive nodes, not promises: never `await` them. `generateText`
and `generateObject` return an `AsyncResult<T>` directly: either the usable
result or a runtime-owned unavailable state. Keep the request value for loading
and error guards, then call `resultOf(request)` once for the ordinary usable
value.

## generateText

Free-form text generation.

```typescript
// Shown for illustration only.
const responseRequest = generateText({
  prompt: userInput,
  system: "You are a helpful assistant.",  // optional
});
const response = resultOf(responseRequest);

{isPending(responseRequest)
  ? <span>Generating...</span>
  : hasError(responseRequest)
  ? <span>Error: {responseRequest.error.message}</span>
  : <div>{response}</div>}
```

---

## generateObject\<T\>

Structured data matching a TypeScript type. Schema is inferred automatically.

```typescript
// Shown for illustration only.
interface ProductIdea {
  name: string;
  description: string;
  price: number;
}

const ideaRequest = generateObject<ProductIdea>({
  prompt: userInput,
  system: "Generate a product idea.",
  model: "anthropic:claude-sonnet-4-5",
});
const idea = resultOf(ideaRequest);

{isPending(ideaRequest)
  ? <span>Generating...</span>
  : hasError(ideaRequest)
  ? <span>Error: {ideaRequest.error.message}</span>
  : (
    <div>
      <h3>{idea.name}</h3>
      <p>{idea.description}</p>
      <p>${idea.price}</p>
    </div>
  )}
```

The generated object is validated strictly against the schema inferred from
`T`. A response that violates it becomes the terminal `schema-mismatch` state
and is not automatically retried until the generation inputs change. The
marker intentionally carries no schema detail; enable the `generateObject`
debug logger to inspect the exact validation failure.

## Processing Arrays

Map over items - caching is automatic per-item:

```typescript
// Shown inside a pattern body.
const summaries = articles.map((article) => ({
  article,
  request: generateText({
    prompt: computed(() => `Summarize: ${article.title}\n${article.content}`),
  }),
}));

{summaries.map(({ article, request }) => (
  <div>
    <h3>{article.title}</h3>
    {isPending(request)
      ? <em>Summarizing...</em>
      : <p>{resultOf(request)}</p>}
  </div>
))}
```

The guards `isPending`, `hasError`, `isSyncing`, and `hasSchemaMismatch`
narrow the request to the corresponding state. A computation that only uses
`resultOf(request)` does not need guards: unavailability propagates until the
result exists.

## Partial streaming output

Use `generateTextStream` or `generateObjectStream<T>` when a pattern needs
intermediate provider text. The stream call returns the final request directly;
`partialResultOf()` returns its usable partial value:

```typescript
// Shown for illustration only.
const request = generateTextStream({ prompt });
const finalText = resultOf(request);
const partialText = partialResultOf(request);
```

Use the ordinary availability guards on `request`. Before the first chunk, a
computation that consumes `partialText` waits just as one consuming
`resultOf(request)` would. A replacement request resets both final and partial
channels atomically, and a terminal failure is visible through `request`. The
current direct object-generation provider may emit no intermediate text; its
partial value then remains unavailable while the final object resolves.

The runtime retains legacy persisted generation state internally, but the
public streaming API does not expose its sibling state fields or metadata.

## llmDialog\<T\>

Use `llmDialog<T>()` for a multi-turn conversation whose model can publish a
structured result with `presentResult`. The transformer derives that tool's
schema from `T`; do not add `resultSchema` manually.

```typescript
// Shown for illustration only.
const dialog = llmDialog<ResearchResult>({
  messages,
  tools: { search: patternTool(search) },
});
const result = resultOf(dialog.result);

return (
  <>
    <cf-message-beads $messages={messages} pending={dialog.pending} />
    {hasError(dialog.result)
      ? <p>{dialog.result.error.message}</p>
      : <ResearchView result={result} />}
  </>
);
```

`dialog.pending` reports whether a turn is active. It is independent of
`dialog.result`: after `presentResult` succeeds, later turns keep the last
successful result even while pending or if that turn fails. The separate
`dialog.error` field reports the most recent failed turn. Before the first
presentation, `dialog.result` is pending; a terminal failure changes it to an
error availability value.

Calling `llmDialog({ messages })` without a result type creates a control-only
dialog. It has `addMessage`, `pending`, cancellation, pinning, and tool state,
but no public `result` channel and no perpetual result-pending marker.

As with fetch, `resultOf(request) ?? previousValue` is not a
fallback-while-loading mechanism: an unavailable marker remains present at
runtime. Keep the request for explicit status UI, or retain a last successful
snapshot with `latestComplete(request)`.

### Valid Model Names

Model names must match the registry format exactly. Invalid names cause cryptic errors:

```typescript
// ❌ WRONG - causes "Cannot read properties of undefined"
model: "claude-3-5-sonnet-20241022"   // Wrong format
model: "claude-sonnet-4-5"            // Missing vendor prefix
model: "anthropic/claude-sonnet-4-5"  // Wrong separator

// ✅ CORRECT - use vendor:model format
model: "anthropic:claude-sonnet-4-5"
model: "anthropic:claude-haiku-4-5"
model: "anthropic:claude-opus-4-1"
model: "openai:gpt-4o"

// ✅ ALSO CORRECT - aliases work
model: "sonnet-4-5"
model: "opus-4-1"
```

If you get `TypeError: Cannot read properties of undefined (reading 'model')`, check your model name format first.

**Discovery:** Query `/api/ai/llm/models` to see all available models.

### Cache Busting for Regeneration

For "respin" or "regenerate" features, set `cache: false` in the options.
Only `generateObject` accepts it (`generateText` is always cached per
distinct input):

```typescript
// Shown for illustration only.
const request = generateObject({
  prompt,
  cache: false,  // Forces fresh generation
});
const result = resultOf(request);
```
