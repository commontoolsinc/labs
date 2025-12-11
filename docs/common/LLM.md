<!-- @reviewed 2025-12-10 docs-rationalization -->

# LLM Integration Guide

This guide covers using language models within CommonTools patterns with `generateText` and `generateObject`.

## Core Functions

CommonTools provides two functions for LLM integration:

- **`generateText`** - Generate free-form text responses
- **`generateObject`** - Generate structured data matching a TypeScript type

These functions can only be called from within a pattern body, not from handlers or `computed()` functions.

## generateText - Free-form Text Generation

Use `generateText` for natural language responses, summaries, or any
unstructured text output.

### Basic Usage

```typescript
/// <cts-enable />
import { generateText, pattern, UI, NAME, Cell } from "commontools";

interface Input {
  userPrompt: Cell<string>;
}

export default pattern<Input>(({ userPrompt }) => {
  // Call generateText in pattern body
  const llmResponse = generateText({
    prompt: userPrompt,
    system: "You are a helpful assistant.",
  });

  return {
    [NAME]: "Text Generator",
    [UI]: (
      <div>
        <ct-input $value={userPrompt} placeholder="Ask a question..." />

        {llmResponse.pending ? (
          <div>Generating...</div>
        ) : llmResponse.error ? (
          <div>Error: {llmResponse.error}</div>
        ) : (
          <div>{llmResponse.result}</div>
        )}
      </div>
    ),
  };
});
```

### Response Object

`generateText` returns an object with:

```typescript
{
  result: string | undefined,    // Generated text (undefined when pending or error)
  error: string | undefined,     // Error message (undefined when pending or success)
  pending: boolean,              // true while generating, false when complete
}
```

**Key behavior:**

- When `pending` is `true` → `result` is always `undefined`
- When `pending` is `false` → either `result` or `error` is defined (not both)

### Parameters

```typescript
generateText({
  prompt: string | Cell<string>,           // User prompt (required)
  system?: string | Cell<string>,          // System instructions (optional)
  max_tokens?: number,                     // Max tokens to generate (optional)
  stop?: string | string[],                // Stop sequences (optional)
})
```

### Example: Email Summarizer

```typescript
/// <cts-enable />
import { generateText, pattern, UI, NAME, Default } from "commontools";

interface Email {
  subject: string;
  body: string;
  from: string;
}

interface Input {
  emails: Default<Email[], []>;
}

export default pattern<Input>(({ emails }) => {
  // Generate summaries for each email
  const summaries = emails.map((email) => ({
    email,
    summary: generateText({
      system: "Summarize the following email in one sentence.",
      prompt: `Subject: ${email.subject}\nFrom: ${email.from}\n\n${email.body}`,
    }),
  }));

  return {
    [NAME]: "Email Summarizer",
    [UI]: (
      <div>
        {summaries.map((item) => (
          <div>
            <h3>{item.email.subject}</h3>
            {item.summary.pending ? (
              <em>Summarizing...</em>
            ) : item.summary.error ? (
              <em>Error: {item.summary.error}</em>
            ) : (
              <p>{item.summary.result}</p>
            )}
          </div>
        ))}
      </div>
    ),
  };
});
```

## generateObject - Type-safe Structured Generation

Use `generateObject` for structured data that matches a TypeScript type. **The system automatically infers the JSON schema from your TypeScript type parameter.**

### Schema Root Must Be Object Type

The schema root must be an object, not an array (OpenAI API requirement).

```typescript
// ❌ Array at root fails
generateObject<CalendarEntry[]>({...})  // HTTP 400 error

// ✅ Wrap array in object
interface CalendarResponse {
  entries: CalendarEntry[];
}
generateObject<CalendarResponse>({...})  // Works
```

If you need an array, wrap it in an object property and access with `result.entries`.

### Basic Usage with Type Inference

```typescript
/// <cts-enable />
import { generateObject, pattern, UI, NAME, Cell } from "commontools";

interface ProductIdea {
  name: string;
  description: string;
  targetAudience: string;
  estimatedPrice: number;
}

interface Input {
  prompt: Cell<string>;
}

export default pattern<Input>(({ prompt }) => {
  // Type parameter automatically generates schema!
  const idea = generateObject<ProductIdea>({
    prompt: prompt,
    system: "Generate a creative product idea based on the user's request.",
  });

  return {
    [NAME]: "Product Idea Generator",
    [UI]: (
      <div>
        <ct-input $value={prompt} placeholder="Describe your product..." />

        {idea.pending ? (
          <div>Generating...</div>
        ) : idea.error ? (
          <div>Error: {idea.error}</div>
        ) : (
          <div>
            <h3>{idea.result.name}</h3>
            <p>{idea.result.description}</p>
            <p><strong>Target:</strong> {idea.result.targetAudience}</p>
            <p><strong>Price:</strong> ${idea.result.estimatedPrice}</p>
          </div>
        )}
      </div>
    ),
  };
});
```

**What's happening:**

- `generateObject<ProductIdea>` automatically creates a JSON schema from the `ProductIdea` type
- The LLM receives this schema and generates matching JSON
- The result is type-safe: `idea.result` has type `ProductIdea`

### Response Object

`generateObject<T>` returns an object with:

```typescript
{
  result: T | undefined,         // Generated object (undefined when pending or error)
  error: string | undefined,     // Error message (undefined when pending or success)
  pending: boolean,              // true while generating, false when complete
}
```

**Same behavior as generateText:**

- When `pending` is `true` → `result` is always `undefined`
- When `pending` is `false` → either `result` or `error` is defined (not both)

### Parameters

```typescript
generateObject<T>({
  prompt: string | Cell<string>,           // User prompt (required)
  system?: string | Cell<string>,          // System instructions (optional)
  max_tokens?: number,                     // Max tokens to generate (optional)
})
```

**Note:** No `schema` parameter needed! The schema is inferred from the type parameter `<T>`.

### How Schema Inference Works

The `/// <cts-enable />` directive at the top of your file enables the CommonTools TypeScript transformer. When you write:

```typescript
generateObject<ProductIdea>({ prompt: "..." })
```

The transformer automatically injects the schema parameter at compile-time:

```typescript
generateObject<ProductIdea>({ prompt: "...", schema: { type: "object", properties: { ... } } })
```

**If you get a "schema is required" error**, check that your file starts with `/// <cts-enable />`.

### Example: Contact Extractor

```typescript
/// <cts-enable />
import { generateObject, pattern, UI, NAME, Cell } from "commontools";

interface Contact {
  name: string;
  email: string;
  phone?: string;
  company?: string;
}

interface Input {
  text: Cell<string>;
}

export default pattern<Input>(({ text }) => {
  // Schema automatically inferred from Contact type
  const contact = generateObject<Contact>({
    prompt: text,
    system: "Extract contact information from the provided text.",
  });

  return {
    [NAME]: "Contact Extractor",
    [UI]: (
      <div>
        <ct-input
          $value={text}
          placeholder="Paste text with contact info..."
        />

        {contact.pending ? (
          <div>Extracting...</div>
        ) : contact.error ? (
          <div>Error: {contact.error}</div>
        ) : (
          <div>
            <h3>Extracted Contact</h3>
            <p><strong>Name:</strong> {contact.result.name}</p>
            <p><strong>Email:</strong> {contact.result.email}</p>
            {contact.result.phone && (
              <p><strong>Phone:</strong> {contact.result.phone}</p>
            )}
            {contact.result.company && (
              <p><strong>Company:</strong> {contact.result.company}</p>
            )}
          </div>
        )}
      </div>
    ),
  };
});
```

### Example: Array Generation

To generate arrays, wrap them in an object property:

```typescript
interface TodoItem {
  title: string;
  priority: "high" | "medium" | "low";
  estimatedMinutes: number;
}

// Wrap array in object
interface TodoListResponse {
  todos: TodoItem[];
}

const response = generateObject<TodoListResponse>({
  prompt: "Generate 5 todos for launching a new product",
  system: "Create a prioritized task list.",
});

// Access via response.result.todos when complete
{response.pending ? (
  <div>Generating tasks...</div>
) : (
  response.result.todos.map((todo) => (
    <div>
      <strong>{todo.title}</strong> - {todo.priority} - {todo.estimatedMinutes}min
    </div>
  ))
)}
```

## Handling Pending State

The `pending` flag is reactive - your UI will automatically update when generation completes.

### Pattern: Show Partial Results

For long-running generations, you might want to show something while waiting:

```typescript
const summary = generateText({ prompt: longDocument });

{summary.pending ? (
  <div>
    <div>Analyzing document...</div>
    <progress />
  </div>
) : summary.error ? (
  <div>Failed to analyze: {summary.error}</div>
) : (
  <div>
    <h3>Summary</h3>
    <p>{summary.result}</p>
  </div>
)}
```

### Pattern: Disable Actions While Pending

```typescript
const analysis = generateObject<Analysis>({ prompt: userInput });

<ct-button
  disabled={analysis.pending}
  onClick={regenerate}
>
  {analysis.pending ? "Analyzing..." : "Regenerate"}
</ct-button>
```

## Common Patterns

### Pattern: Process Array of Items

```typescript
interface Article {
  title: string;
  url: string;
  content: string;
}

interface Summary {
  title: string;
  keyPoints: string[];
  sentiment: "positive" | "neutral" | "negative";
}

const articles: Article[] = [...];

const summaries = articles.map((article) => ({
  article,
  summary: generateObject<Summary>({
    prompt: `Title: ${article.title}\n\n${article.content}`,
    system: "Summarize the article with key points and sentiment.",
  }),
}));

// Display results
{summaries.map(({ article, summary }) => (
  <div>
    <h3>{article.title}</h3>
    {summary.pending ? (
      <em>Summarizing...</em>
    ) : summary.error ? (
      <em>Error: {summary.error}</em>
    ) : (
      <div>
        <ul>
          {summary.result.keyPoints.map((point) => (
            <li>{point}</li>
          ))}
        </ul>
        <p>Sentiment: {summary.result.sentiment}</p>
      </div>
    )}
  </div>
))}
```

### Pattern: Chained Generation

Use one LLM result as input to another:

```typescript
// First: Generate topic ideas
const topics = generateObject<{ topics: string[] }>({
  prompt: "Technology trends for 2024",
});

// Second: Expand on first topic (once available)
const expansion = computed(() => {
  if (!topics.pending && !topics.error && topics.result.topics.length > 0) {
    return generateText({
      prompt: `Explain this trend in detail: ${topics.result.topics[0]}`,
    });
  }
  return null;
});

// Display both
{topics.pending ? (
  <div>Generating topics...</div>
) : (
  <div>
    <h3>Topics:</h3>
    <ul>
      {topics.result.topics.map((topic) => <li>{topic}</li>)}
    </ul>

    {expansion && (
      expansion.pending ? (
        <div>Expanding on first topic...</div>
      ) : (
        <div>
          <h3>Detail:</h3>
          <p>{expansion.result}</p>
        </div>
      )
    )}
  </div>
)}
```

### Pattern: User-triggered Generation

Store LLM results in a cell for user-controlled generation:

```typescript
interface Input {
  prompt: Cell<string>;
  generatedIdeas: Cell<string[]>;
}

export default pattern<Input>(({ prompt, generatedIdeas }) => {
  // Only generate when triggered
  let currentGeneration: ReturnType<typeof generateObject<{ ideas: string[] }>> | null = null;

  return {
    [UI]: (
      <div>
        <ct-input $value={prompt} placeholder="Enter topic..." />

        <ct-button onClick={() => {
          currentGeneration = generateObject<{ ideas: string[] }>({
            prompt: prompt.get(),
            system: "Generate 3 creative ideas.",
          });

          // Wait for completion and store
          if (!currentGeneration.pending && !currentGeneration.error) {
            generatedIdeas.set(currentGeneration.result.ideas);
          }
        }}>
          Generate Ideas
        </ct-button>

        <ul>
          {generatedIdeas.map((idea) => <li>{idea}</li>)}
        </ul>
      </div>
    ),
    generatedIdeas,
  };
});
```

## Type Safety Benefits

`generateObject` provides full TypeScript type safety:

```typescript
interface Recipe {
  name: string;
  ingredients: string[];
  steps: string[];
  cookingTime: number;
}

const pattern = generateObject<Recipe>({
  prompt: "Generate a pattern for chocolate chip cookies",
});

// TypeScript knows the structure
if (!recipe.pending && !recipe.error) {
  pattern.result.name;           // ✅ string
  pattern.result.ingredients;    // ✅ string[]
  pattern.result.cookingTime;    // ✅ number
  pattern.result.invalidField;   // ❌ TypeScript error!
}
```

## Constraints and Limitations

### Can Only Call from Recipe Body

❌ **Don't call from handlers:**

```typescript
const handler = handler((_, { prompt }) => {
  const result = generateText({ prompt });  // Won't work!
});
```

❌ **Don't call from computed():**

```typescript
const summary = computed(() => {
  return generateText({ prompt: text });  // Won't work!
});
```

✅ **Call from pattern body:**

```typescript
export default pattern(({ prompt }) => {
  const result = generateText({ prompt });  // ✅ Works!

  return { [UI]: <div>{result.result}</div> };
});
```

### No Async/Await

You cannot `await` LLM calls - they're nodes in the reactive graph:

```typescript
// ❌ Don't try to await
const result = await generateText({ prompt });  // Won't work!

// ✅ Use the returned object's properties
const result = generateText({ prompt });
if (!result.pending && !result.error) {
  // Use result.result
}
```

## Best Practices

1. **Use generateObject for structured data** - Don't parse JSON from generateText
2. **Handle all three states** - pending, error, and success
3. **Keep prompts in pattern body** - Don't try to generate from handlers
4. **Use type parameters** - Let TypeScript infer schemas for generateObject
5. **Show pending state** - Users need feedback during generation
6. **Provide error messages** - Display errors clearly to users
7. **Consider UX** - Long generations should show progress/feedback

## Summary

**Key Takeaways:**

1. **generateText** - Free-form text, returns `{ result: string, error, pending }`
2. **generateObject<T>** - Structured data with type inference, returns `{ result: T, error, pending }`
3. **Call from pattern body only** - Not from handlers or computed()
4. **Handle pending/error/result** - Always check all three states
5. **Type safety** - generateObject automatically creates schemas from TypeScript types
6. **Reactive** - Results update automatically when generation completes
