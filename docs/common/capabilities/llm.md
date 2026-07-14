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

## Partial and metadata state

Use `generateTextStream` or `generateObjectStream<T>` when a pattern needs
partial output or generation metadata. These advanced forms return a state
object whose `result` field is itself an `AsyncResult<T>`; the ordinary
`generateText` and `generateObject` calls remain the concise default.

Persisted advanced state from before the direct-result migration may contain a
terminal `{ pending: false, error }` without a `result` field. The runtime still
materializes that legacy state; newly produced state always writes the explicit
availability marker in `result`.

As with fetch, `resultOf(request) ?? previousValue` is not a
fallback-while-loading mechanism: an unavailable marker remains present at
runtime. Keep the request for explicit status UI, or retain a last successful
snapshot in state until the planned `latestComplete()` helper is available.

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
