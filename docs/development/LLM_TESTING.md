# LLM Testing

## Overview

LLM-powered patterns have test coverage at three layers:

1. **Client guard** — `LLMClient` blocks live LLM calls in test environments
2. **Server-side tests** — toolshed route logic (model resolution, JSON mode,
   tool conversion)
3. **Runner smoke tests** — full pattern-to-mock-response path

## Test-environment guard

`packages/llm/src/client.ts` includes a test-environment check (evaluated once
at module load) which detects:

- `CI=true` (CI runners)
- `ENV=test` (set by `deno task test` in llm, runner, and toolshed packages)

The guard throws before any `fetch` call when running in a test environment
without mock mode enabled:

```
LLMClient: live LLM calls are blocked in test environments.
Use enableMockMode() and addMockResponse() to set up mocks.
```

When mock mode is enabled via `enableMockMode()`, the mock interception runs
first and the guard is never reached.

## Writing tests that use LLM

```ts
import {
  enableMockMode,
  addMockResponse,
  addMockObjectResponse,
  clearMockResponses,
  resetMockMode,
} from "@commontools/llm/client";

// Enable once at module level
enableMockMode();

// In beforeEach, clear previous mocks
beforeEach(() => clearMockResponses());

// Register mock responses with matchers
addMockResponse(
  (req) => req.messages.some(m =>
    typeof m.content === "string" && m.content.includes("hello")
  ),
  { role: "assistant", content: "Hi!", id: "mock-1" },
);

// For generateObject (no tools path)
addMockObjectResponse(
  (req) => req.schema.type === "object",
  { object: { name: "Alice" }, id: "mock-2" },
);
```

Mock responses are **one-time use** — they're consumed when matched.

## Test files

| File | What it tests |
|------|--------------|
| `packages/llm/src/client.test.ts` | Guard behavior, mock mode API |
| `packages/toolshed/routes/ai/llm/generateText.test.ts` | JSON mode config, response cleaning |
| `packages/toolshed/routes/ai/llm/generateObject.test.ts` | Model resolution, error paths |
| `packages/runner/test/llm-pattern-smoke.test.ts` | generateText, generateObject, and tool-calling through runtime |

## Running tests

```bash
# LLM client tests (guard + mock)
cd packages/llm && deno task test

# Toolshed server tests
cd packages/toolshed && deno task test

# Runner tests (includes smoke tests)
cd packages/runner && deno task test
```
