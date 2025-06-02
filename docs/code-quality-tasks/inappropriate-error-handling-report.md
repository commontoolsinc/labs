# Inappropriate Error Handling Report

Based on the analysis of the codebase against AGENTS.md guidelines, the
following inappropriate error handling patterns were found:

## 1. Try/catch Blocks That Silently Swallow Errors

### `packages/jumble/src/components/NetworkInspector.tsx`

**Lines**: 236-238

```typescript
} catch (e) {
  return null;
}
```

**Issue**: Silently catches errors and returns null without any logging or
re-throwing. This makes debugging impossible and hides potential issues.

### `packages/toolshed/lib/otel.ts`

**Lines**: 60-62

```typescript
} catch (_) {
  // ignored – not running on Deno with telemetry support
}
```

**Issue**: Empty catch block that completely swallows errors. Even if the error
is expected, it should at least be logged for debugging purposes.

## 2. Different Error Handling Approaches in the Same Code Path

### `packages/runner/src/runner.ts`

**Lines**: 358-363

```typescript
try {
  cancel();
} catch (error) {
  console.warn("Error canceling operation:", error);
}
```

**Issue**: Uses `console.warn` for errors in a method that should likely
propagate errors up to the caller for proper handling.

### `packages/js-runtime/typescript/compiler.ts`

**Lines**: 111-114

```typescript
} catch (e) {
  console.warn(`There was an error parsing "${key}" source map: ${e}`);
}
```

**Issue**: Uses `console.warn` instead of throwing or properly handling the
parsing error. Source map parsing errors could indicate serious issues.

### `packages/llm/src/client.ts`

**Lines**: 101-103, 115-117

```typescript
} catch (error) {
  console.error("Failed to parse JSON line:", line, error);
}
```

**Issue**: Logs errors to console instead of propagating them, while other parts
of the same method throw errors. This creates inconsistent error handling.

## 3. Functions Returning undefined/null on Error Instead of Throwing

### `packages/jumble/src/components/NetworkInspector.tsx`

**Lines**: 213-239

```typescript
const extractTransactionDetails = (value: any): any => {
  try {
    // ... processing logic ...
  } catch (e) {
    return null;
  }
};
```

**Issue**: Returns null on any error instead of throwing or properly handling
specific error cases. Callers can't distinguish between "no data" and "error
occurred".

### `packages/ui/src/components/common-form.ts`

**Lines**: 64-66

```typescript
} catch {
  return "Invalid reference format";
}
```

**Issue**: Returns an error string instead of throwing, inconsistent with other
validation patterns that throw errors.

### `packages/charm/src/spellbook.ts`

```typescript
} catch (error) {
  console.error("Failed to save spell:", error);
  return false;
}
```

**Issue**: Returns false on error instead of throwing, preventing callers from
understanding why the operation failed.

## 4. Overly Broad try/catch Blocks

### `packages/charm/src/manager.ts`

**Lines**: 500-700+

```typescript
try {
  // Hundreds of lines of code including:
  // - Multiple async operations
  // - Complex data transformations
  // - Nested function calls
} catch (error) {
  console.debug("Error in findReferencedCharms:", error);
}
```

**Issue**: Try block covers too much code, making it difficult to understand
which operation actually failed. Errors from very different operations are
handled identically.

## 5. Low-level try/catch Where Errors Should Propagate

### `packages/charm/src/workflow.ts`

Multiple instances of:

```typescript
try {
  // Some operation
} catch (error) {
  console.warn("Operation failed:", error);
  // Continues execution
}
```

**Issue**: Error handling at the workflow processing level prevents higher-level
error handlers from taking appropriate action (retry, fallback, user
notification).

### `packages/background-charm-service/src/worker.ts`

**Lines**: 186-188

```typescript
} catch (error) {
  const errorMessage = String(error);
  // Loses stack trace and error type information
}
```

**Issue**: Converts errors to strings, losing valuable debugging information
like stack traces and error types.

## 6. Missing Error Context or Unhelpful Error Messages

### `packages/toolshed/routes/integrations/google-oauth/google-oauth.utils.ts`

**Lines**: 162, 195

```typescript
throw new Error(`Failed to get auth cell: ${error}`);
throw new Error(`Error persisting tokens: ${error}`);
```

**Issue**: Simply wraps errors without adding meaningful context about what was
being attempted, what the inputs were, or suggestions for resolution.

## 7. Console Logging in Production Code

Multiple files use console methods for error handling instead of proper error
propagation:

- `packages/charm/src/format.ts` - Uses `console.error`
- `packages/charm/src/search.ts` - Uses `console.warn`
- `packages/charm/src/workflow.ts` - Mixed `console.warn` and `console.error`
- `packages/charm/src/iframe/recipe.ts` - Uses `console.log` for errors

**Issue**: Console logging is not appropriate for production error handling.
Errors should be propagated or logged through proper logging mechanisms.

## Recommendations Based on AGENTS.md

### 1. Let Errors Propagate

```typescript
// Good - let caller handle the error
async function getData(): Promise<string> {
  const res = await fetch(URL);
  if (res.ok) {
    return res.text();
  }
  throw new Error("Unsuccessful HTTP response");
}

// Bad - swallowing errors
async function getData(): Promise<string | undefined> {
  try {
    const res = await fetch(URL);
    if (res.ok) {
      return res.text();
    }
  } catch (e) {
    console.error(e);
  }
}
```

### 2. Only Catch When You Can Handle

```typescript
// Good - specific error handling with retry
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (i === retries - 1) throw error;
      await delay(1000 * Math.pow(2, i)); // exponential backoff
    }
  }
  throw new Error("Should not reach here");
}
```

### 3. Add Meaningful Context

```typescript
// Good - adds context to errors
try {
  await saveUserData(userId, data);
} catch (error) {
  throw new Error(
    `Failed to save data for user ${userId}: ${error.message}`,
    { cause: error },
  );
}
```

### 4. Use Type Guards for Expected Errors

```typescript
// Good - handle specific, expected scenarios
function isFeatureSupported(): boolean {
  try {
    // Try to use feature
    crypto.subtle.importKey(...);
    return true;
  } catch {
    // Expected error - feature not supported
    return false;
  }
}
```

## Priority Areas to Fix

1. **High Priority**: Error swallowing in core libraries (`runner`, `builder`,
   `charm`)
2. **Medium Priority**: Console logging instead of proper error handling
3. **Low Priority**: Missing error context in utility functions
