## generateText

Free-form text generation.

```typescript
const response = generateText({
  prompt: userInput,
  system: "You are a helpful assistant.",  // optional
});

// Response: { result: string, error: string, pending: boolean }
{ifElse(response.pending,
  <span>Generating...</span>,
  ifElse(response.error,
    <span>Error: {response.error}</span>,
    <div>{response.result}</div>
  )
)}
```

---

## generateObject\<T\>

Structured data matching a TypeScript type. Schema is inferred automatically.

```typescript
interface ProductIdea {
  name: string;
  description: string;
  price: number;
}

const idea = generateObject<ProductIdea>({
  prompt: userInput,
  system: "Generate a product idea.",
  model: "anthropic:claude-sonnet-4-5",
});

// Response: { result: ProductIdea, error: string, pending: boolean }
{ifElse(idea.pending,
  <span>Generating...</span>,
  ifElse(idea.error,
    <span>Error: {idea.error}</span>,
    <div>
      <h3>{idea.result?.name}</h3>
      <p>{idea.result?.description}</p>
      <p>${idea.result?.price}</p>
    </div>
  )
)}
```

## Processing Arrays

Map over items - caching is automatic per-item:

```typescript
const summaries = articles.map((article) => ({
  article,
  summary: generateText({
    prompt: computed(() => `Summarize: ${article.title}\n${article.content}`),
  }),
}));

{summaries.map(({ article, summary }) => (
  <div>
    <h3>{article.title}</h3>
    {ifElse(summary.pending,
      <em>Summarizing...</em>,
      <p>{summary.result}</p>
    )}
  </div>
))}
```

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

For "respin" or "regenerate" features, set `cache: false` in the options:

```typescript
const result = generateText({
  prompt,
  cache: false,  // Forces fresh generation
});
```
