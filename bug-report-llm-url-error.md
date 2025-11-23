# Bug Report: Invalid URL Error in generateObject

## Summary
When using `generateObject()` in a CommonTools recipe, the LLM client throws an `Invalid URL` error with the malformed URL `'//api/ai/llm/generateObject'`. This prevents any recipe using `generateObject` from successfully making LLM calls.

## Environment
- **CT Version**: 0.0.1
- **Platform**: macOS (Darwin 24.6.0, ARM64)
- **API URL**: `https://toolshed.saga-castor.ts.net/`
- **Space**: `alex-coral-1020b`
- **Affected Charm**: `baedreifke24ixixzhns6noogfczmkdkjtysg7ck2otbikpi7me5rdnioki`

## Error Details

### Full Error Stack Trace
```
Error generating object TypeError: Invalid URL: '//api/ai/llm/generateObject'
    at getSerialization (ext:deno_url/00_url.js:98:11)
    at new URL (ext:deno_url/00_url.js:405:27)
    at new Request (ext:deno_fetch/23_request.js:338:25)
    at ext:deno_fetch/26_fetch.js:374:29
    at new Promise (<anonymous>)
    at fetch (ext:deno_fetch/26_fetch.js:370:20)
    at LLMClient.generateObject (file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/llm/src/client.ts:28:28)
    at file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/runner/src/builtins/llm.ts:308:34
    at file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/runner/src/scheduler.ts:285:25
    at new Promise (<anonymous>)
    at Scheduler.run (file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/runner/src/scheduler.ts:231:27)
    at Scheduler.execute (file:///var/folders/h1/lybj898n2nl7ymy2qcb1hpfm0000gn/T/deno-compile-ct/packages/runner/src/scheduler.ts:563:20)
    at eventLoopTick (ext:core/01_core.js:178:7)
```

### Error Location
The error originates from:
- **File**: `packages/llm/src/client.ts:28:28` in `LLMClient.generateObject`
- **Runtime**: `packages/runner/src/builtins/llm.ts:308:34`

## Reproduction Steps

### 1. Create a recipe using generateObject:
```typescript
import { generateObject, cell, recipe } from "commontools";

const MyRecipe = recipe("Test", () => {
  const trigger = cell<string>("");

  const { result, pending } = generateObject({
    system: "Extract data from input",
    prompt: trigger,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" }
      }
    }
  });

  return {
    result,
    pending
  };
});
```

### 2. Deploy the recipe:
```bash
export CT_API_URL="https://toolshed.saga-castor.ts.net/"
export CT_IDENTITY="./space-identity.key"
./dist/ct charm new --space alex-coral-1020b ./recipe.tsx
```

### 3. Trigger the LLM call:
Either:
- Set the trigger cell to a non-empty value via `ct charm set`
- Call a handler that updates the trigger cell

### 4. Observe the error:
The `generateObject` call fails with `Invalid URL: '//api/ai/llm/generateObject'`

## Root Cause Analysis

The URL `'//api/ai/llm/generateObject'` is malformed:
- Missing protocol (https://)
- Missing hostname
- It appears to be a relative URL that wasn't resolved against a base URL

This suggests that `LLMClient` in `packages/llm/src/client.ts` is not receiving or using a properly configured base URL when making fetch requests.

## Expected Behavior

`generateObject` should:
1. Resolve the relative API endpoint against a configured base URL
2. Make a request to a fully-qualified URL like `https://toolshed.saga-castor.ts.net/api/ai/llm/generateObject`
3. Return structured data according to the provided schema

## Actual Behavior

`generateObject` attempts to fetch from an invalid relative URL `'//api/ai/llm/generateObject'`, causing the fetch to fail immediately with a URL parsing error.

## Additional Context

### Working Example in Codebase
The `TitleGenerator` recipe in `packages/patterns/chatbot.tsx` uses `generateObject` successfully in some contexts:

```typescript
export const TitleGenerator = recipe<
  { model?: string; messages: Array<BuiltInLLMMessage> }
>("Title Generator", ({ model, messages }) => {
  const titleMessages = derive(messages, (m) => {
    if (!m || m.length === 0) return "";
    // ...
  });

  const { result } = generateObject({
    system: "Generate at most a 3-word title...",
    prompt: titleMessages,
    model,
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title of the chat" }
      },
      required: ["title"]
    }
  });

  return derive(result, (t) => t?.title || "Untitled Chat");
});
```

This suggests the issue may be environment-specific or related to how the charm runtime is initialized.

## Potential Fixes

### Option 1: LLM Client Configuration
Ensure `LLMClient` receives and uses a base URL during initialization:
```typescript
// In packages/llm/src/client.ts
constructor(private baseUrl: string) { }

generateObject(...) {
  const url = new URL('/api/ai/llm/generateObject', this.baseUrl);
  return fetch(url, ...);
}
```

### Option 2: Runtime Configuration
Ensure the runner/scheduler passes the correct API URL to the LLM client when executing built-in functions:
```typescript
// In packages/runner/src/builtins/llm.ts
// Pass context.apiUrl or similar to LLMClient
```

### Option 3: Environment Variable
If the LLM client should read from an environment variable, ensure it's properly set in the charm execution context.

## Workaround

Currently, there is no workaround. Recipes using `generateObject` cannot function until this is resolved.

## Impact

- **Severity**: High - Blocks all LLM-based data extraction features
- **Scope**: Affects any recipe using `generateObject`
- **User Impact**: Cannot use structured LLM outputs in recipes

## Test Recipe

The full reproduction recipe is available at:
- **Path**: `/Users/alex/Code/labs/packages/patterns/profile.tsx`
- **Deployed Charm**: `baedreifke24ixixzhns6noogfczmkdkjtysg7ck2otbikpi7me5rdnioki`
- **Space**: `alex-coral-1020b`

To test:
```bash
# Set some notes content
echo '"Test content for extraction"' | ./dist/ct charm set \
  --space alex-coral-1020b \
  --charm baedreifke24ixixzhns6noogfczmkdkjtysg7ck2otbikpi7me5rdnioki \
  notes --input

# Trigger extraction (will fail with URL error)
echo '{}' | ./dist/ct charm call \
  --space alex-coral-1020b \
  --charm baedreifke24ixixzhns6noogfczmkdkjtysg7ck2otbikpi7me5rdnioki \
  triggerExtraction
```

## Related Issues

This may be related to:
- Base URL configuration in the CT runtime
- Environment variable handling for API endpoints
- Differences between local development (`./dist/ct dev`) and deployed charm execution

## Contact

- **Reporter**: Alex (via Claude Code assistant)
- **Date**: 2025-10-21
- **Session**: Implementing profile recipe with LLM extraction feature
