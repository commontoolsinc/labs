# Common Issues and Solutions

This document covers frequently encountered issues when developing CommonTools patterns.

## LLM Response Caching

### Issue: llmDialog Returns Same Response on Retry

**Symptom**: When using `llmDialog` with tools, the LLM sometimes says what it will do but doesn't execute tools. Retrying gets the exact same (wrong) response.

**Cause**: LLM responses are cached based on the prompt. If you retry with the same prompt, you get the cached response.

**Solution**: Add a cache-busting timestamp to the prompt on retry:

```tsx
const cacheBuster = cell<string>("");

const resetHandler = handler<never, { messages: Cell<BuiltInLLMMessage[]>; cacheBuster: Cell<string> }>(
  (_event, { messages, cacheBuster }) => {
    messages.set([]);
    cacheBuster.set(`retry-${Date.now()}`); // Bust cache
  }
);

const executeHandler = handler<never, { addMessage: Stream<BuiltInLLMMessage>; instructions: string; cacheBuster: string }>(
  (_event, { addMessage, instructions, cacheBuster }) => {
    const cachedBustedInstructions = cacheBuster
      ? `${instructions}\n\n[${cacheBuster}]`
      : instructions;

    addMessage.send({
      role: "user",
      content: cachedBustedInstructions,
    });
  }
);
```

See `space-setup.tsx` for a complete example with Reset button that busts cache.

## generateObject Running on Initialization

### Issue: Extraction Modal Shows Empty {} Immediately

**Symptom**: When using `generateObject` for data extraction (e.g., extracting person data from notes), a modal showing `{}` or empty results appears as soon as the pattern loads, before the user clicks Extract.

**Cause**: `generateObject` is reactive and runs whenever its prompt changes. If you initialize `extractTrigger` to `""`, it immediately runs with an empty prompt and may return `{}`.

**Solution**: Validate that results have content before showing UI:

```tsx
// ❌ Problem: Shows modal whenever result is not null
const hasExtractionResult = derive(
  extractionResult,
  (result) => result !== null && result !== undefined,
);

// ✅ Solution: Check for actual content
const hasExtractionResult = derive(
  extractionResult,
  (result) => {
    if (!result || result === null || result === undefined) return false;
    // Ensure result has meaningful content
    return Object.keys(result).length > 0;
  },
);

{ifElse(
  hasExtractionResult,
  <ExtractionPreviewModal />,
  null
)}
```

Alternative: Use a `hasAnalyzed` flag that only gets set when user explicitly clicks Extract.

## wish() for Auto-Discovery

### Pattern Not Finding Related Charms

**Issue**: Your meta-analyzer or aggregator pattern can't find the charms it should analyze.

**Wrong Approach**: Manually linking every charm with `ct charm link`

**Right Approach**: Use `wish("#allCharms")` to auto-discover:

```tsx
// Get all charms in the space
const allCharms = derive<any[], any[]>(
  wish<any[]>("#allCharms", []),
  (c) => c,
);

// Filter for specific charm types
const personCharms = derive(allCharms, (charms) =>
  charms.filter((charm: any) =>
    charm && typeof charm === "object" && "profile" in charm
  )
);
```

Common wishes:
- `wish("#allCharms", [])` - all charms in space
- `wish("#mentionable", [])` - charms available for `[[` references
- `wish("#recentCharms", [])` - recently viewed charms

## Default Pattern Setup Required

### Issue: [[` References Don't Work

**Symptom**: Typing `[[` in ct-code-editor doesn't show autocomplete, even though your pattern has all the right props.

**Cause**: The `[[` reference system depends on backlinks-index pattern, which is only created when you set up the default pattern for a space.

**Solution**:
1. Navigate to a new space: `http://localhost:8000/my-space`
2. Click the "Create default pattern?" Go! button
3. This creates backlinks-index and other infrastructure
4. Now `[[` references will work

**Don't**: Create charms with `ct charm new` before setting up default pattern - references won't work until you add the infrastructure.

## patternTool Not Appearing in Chatbot

### Issue: Exported patternTool Functions Not Available

**Symptom**: You exported `patternTool` functions from your pattern but the chatbot doesn't show them as available tools.

**Debugging**:
1. Verify the pattern exports the patternTool in the return object
2. Attach the charm to the chatbot (it won't see tools from unattached charms)
3. Check chatbot's Tools list to confirm they appear

**Example**:
```tsx
return {
  [UI]: <MyUI />,
  content,
  // Pattern tools for chatbot
  searchContent: patternTool(
    ({ query, content }: { query: string; content: string }) => {
      return derive({ query, content }, ({ query, content }) => {
        return content.split("\n").filter((line) =>
          line.toLowerCase().includes(query.toLowerCase())
        );
      });
    },
    { content }
  ),
};
```

See `note.tsx` for grep and translate examples.

## Inconsistent Tool Execution in llmDialog

### Issue: LLM Says It Will Call Tools But Doesn't

**Symptom**: Using `llmDialog` with tools, the LLM responds with "I'll create X" but never actually calls the tool. Behavior is inconsistent - sometimes works, sometimes doesn't.

**Cause**: LLM model variability - even with strong prompts, tool calling isn't 100% reliable.

**Solutions**:
1. **Strengthen system prompt** with explicit rules:
   ```
   CRITICAL RULES:
   1. ALWAYS call tools - never just describe what you'll do
   2. Call tools IMMEDIATELY in your first response
   3. Do NOT say "I'll..." or "I will..." - just call the tools
   ```

2. **Provide cache busting** for retries (see LLM Response Caching above)

3. **List available tools** in system prompt so LLM knows what's available

4. **For critical flows**: Consider replacing LLM with direct handler execution if 100% reliability is required

See `space-setup.tsx` for an example of handling this with prompts and cache busting.

## JSX in Utility Files

### Issue: Cannot Export JSX Components from Utility Files

**Symptom**: When trying to create reusable JSX components in utility files (e.g., `lib/my-utils.tsx`), you get compilation errors like:
```
[ERROR] This JSX tag requires 'h' to be in scope, but it could not be found.
[ERROR] Module '"commontools"' has no exported member 'h'.
```

**Cause**: JSX compilation requires `h` to be in scope, which is only available within recipe contexts. Utility files can't import or use JSX because they're not recipes.

**Solution**: Share utility functions instead of JSX components:

**✅ DO THIS** - Export pure functions from utility files:
```typescript
/// <cts-enable />

// lib/diff-utils.tsx
export function computeWordDiff(from: string, to: string): DiffChunk[] {
  // Pure function logic - no JSX
  return [...];
}
```

Then use the function with inline JSX in your recipe:
```typescript
// my-pattern.tsx
import { computeWordDiff } from "./lib/diff-utils.tsx";

export default recipe("MyPattern", ({ data }) => {
  return {
    [UI]: (
      <div>
        {computeWordDiff(data.from, data.to).map((part) => {
          if (part.type === "added") {
            return <span style={{ color: "green" }}>{part.word}</span>;
          }
          // ... more rendering
        })}
      </div>
    )
  };
});
```

**❌ DON'T DO THIS** - Try to export JSX components from utilities:
```typescript
// lib/diff-utils.tsx
export function DiffText({ from, to }) {  // Won't compile!
  return <div>{from} → {to}</div>;  // Error: h not in scope
}
```

**Key Principles**:
- Utility files: Export pure functions, types, and non-JSX logic
- Recipe files: Use JSX and compose with utility functions
- Use `/// <cts-enable />` directive at the top of utility files

## Transaction Conflicts and Retry Storms

If you see `ConflictError` messages in console, this is normal - the system retries transactions automatically. These warnings don't indicate a problem unless they occur continuously (retry storm).

If you see continuous transaction failures, it may indicate a performance issue. File a bug report with reproduction steps.
