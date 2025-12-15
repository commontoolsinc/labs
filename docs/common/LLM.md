<!-- @reviewed 2025-12-11 docs-rationalization -->

# LLM Integration

Using `generateText` and `generateObject` in patterns.

**Important:** These functions can only be called from pattern bodies, not handlers or `computed()`.

---

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

### Schema Root Must Be Object

Arrays at root fail (OpenAI API requirement). Wrap in object:

```typescript
// ❌ Fails
generateObject<TodoItem[]>({...})

// ✅ Works
interface TodoResponse { todos: TodoItem[]; }
generateObject<TodoResponse>({...})
// Access via result.todos
```

### Requires `/// <cts-enable />`

If you get "schema is required" error, add to file top:

```typescript
/// <cts-enable />
```

---

## Handling Pending State

### With ct-loader

```typescript
{ifElse(
  data.pending,
  <span><ct-loader size="sm" /> Generating...</span>,
  <div>{data.result}</div>
)}
```

### With Elapsed Time and Cancel

```typescript
const { result, pending, error, cancel } = generateText({ prompt });

{ifElse(
  pending,
  <span><ct-loader show-elapsed show-stop onct-stop={cancel} /> Generating...</span>,
  <div>{result}</div>
)}
```

### Disable Button While Pending

```typescript
<ct-button disabled={analysis.pending} onClick={regenerate}>
  {ifElse(analysis.pending, "Analyzing...", "Regenerate")}
</ct-button>
```

---

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

### Template Strings Require computed()

When referencing multiple properties from opaque refs:

```typescript
// ❌ Fails: "Tried to directly access an opaque value"
prompt: `Title: ${article.title}\nContent: ${article.content}`

// ✅ Works: defer evaluation with computed()
prompt: computed(() => `Title: ${article.title}\nContent: ${article.content}`)
```

---

## Constraints

### Call From Pattern Body Only

```typescript
// ❌ Won't work - handler
const myHandler = handler((_, { prompt }) => {
  const result = generateText({ prompt });
});

// ❌ Won't work - computed()
const summary = computed(() => generateText({ prompt }));

// ✅ Works - pattern body
export default pattern(({ prompt }) => {
  const result = generateText({ prompt });
  return { [UI]: <div>{result.result}</div> };
});
```

### No Async/Await

Results are reactive nodes, not promises:

```typescript
// ❌ Don't await
const result = await generateText({ prompt });

// ✅ Check pending/error/result
const result = generateText({ prompt });
if (!result.pending && !result.error) {
  // use result.result
}
```

---

## Automatic Caching

The framework caches LLM responses by content hash. Don't build custom caching:

```typescript
// ❌ Unnecessary - framework handles this
const cache = new Map();
if (!cache.has(key)) cache.set(key, generateText({...}));

// ✅ Just call directly - caching is automatic
const result = generateText({ prompt });
```

When adding items to an array, only new items trigger LLM requests.

---

## Summary

| Function | Returns | Use For |
|----------|---------|---------|
| `generateText` | `{ result: string, error, pending }` | Free-form text |
| `generateObject<T>` | `{ result: T, error, pending }` | Structured data |

**Key rules:**
- Call from pattern body only
- Handle pending/error/result states
- Use `computed()` for template strings with opaque refs
- Schema root must be object (not array)
