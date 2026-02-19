# CT-1205: Cell/Link Serialization Investigation

## Context

We're adding follow-up conversation support to `suggestion.tsx`. The
architecture: `generateObject` handles the initial turn (finds and launches
patterns), then `llmDialog` handles follow-up refinement. This requires passing
cell references between tool calls — e.g. `fetchAndRunPattern` returns a cell,
and `finalResult` should receive that cell to present it.

## The Problem

There are multiple interacting serialization/deserialization layers that don't
compose cleanly, making it impossible to reliably pass live Cell references
between tool calls when handler tools are involved.

## What We Know

### The Tool Call Data Pipeline

1. **Pattern tool returns result** → `handleInvoke` reads `result.get()` and
   passes it through `traverseAndSerialize` to produce JSON for the LLM.

2. **LLM sees serialized result** with `@link` references and `@resultLocation`.

3. **LLM calls next tool** passing `@link` references from previous results.

4. **`traverseAndCellify`** resolves `@link` references back to live Cells
   before invoking the tool.

5. **Tool receives input** — but HOW it receives input differs:
   - **Pattern tools**: `runtime.run(tx, pattern, input, result)` — input passed
     directly, live Cells preserved.
   - **Handler tools**: `handler.send(input)` → `Cell.set()` →
     `convertCellsToLinks()` → `scheduler.queueEvent()` — live Cells
     **destroyed** by `convertCellsToLinks`.

### Specific Issues Found

#### Issue 1: `convertCellsToLinks` in `.send()`

`Cell.set()` (cell.ts:670) calls `convertCellsToLinks(newValue)` for stream
cells before `scheduler.queueEvent()`. This converts any live Cell references in
the event data back to `@link` serialized form. So `traverseAndCellify`'s work
is undone.

**Workaround attempted**: Bypass `.send()` and call `scheduler.queueEvent()`
directly with resolved link. This preserves Cell references BUT the handler
still receives expanded cell values instead of Cell objects — the cell proxy
system returns nested proxies that auto-expand.

#### Issue 2: Infinite cell proxy nesting

`result.get()` on a pattern that uses `ifElse` returns a cell-result-proxy.
Calling `getCellOrThrow(proxy).get()` returns another cell-result-proxy,
infinitely. `isCellResultForDereferencing` is always true. This means:

- `traverseAndSerialize` collapses the entire result into a single `@link`
- The LLM never sees inner properties like `{ cell: @link, error: null }`
- The LLM can only pass the outer `@link` to `finalResult`
- `traverseAndCellify` resolves it to a Cell whose value is `{ cell, error }`
- The handler gets the wrapper, not the inner cell

#### Issue 3: Inconsistent data representations

The same data can appear in multiple forms depending on context:

- As a live Cell object (in-process, after `traverseAndCellify`)
- As a cell-result-proxy (from `.get()` on reactive cells)
- As a `{ "@link": "..." }` JSON object (serialized for LLM or storage)
- As an expanded value with nested `@link`s (after `.get()` on proxies)

There's no clear boundary or contract for when data is in which form.

## Research Questions

### 1. How does `traverseAndSerialize` actually work end-to-end?

- What is a "cell result proxy" vs a Cell vs a plain value?
- Why does `isCellResultForDereferencing` return true infinitely?
- How does `traverseAndSerialize` decide to collapse vs traverse?
- What schema information is needed to serialize correctly?

### 2. How does the omnibot-fab pipeline work for `navigateToPattern`?

- `navigateToPattern` is a pattern tool that receives a Cell and calls
  `navigateTo(cell)`. This works. Why?
- What does the LLM see in the `fetchAndRunPattern` result in omnibot-fab?
- Is the result also a single collapsed `@link`, or does it show
  `{ cell, error }`?
- If collapsed, how does `navigateToPattern` still work? Does `navigateTo`
  handle the wrapper somehow?

### 3. How should handler tools receive Cell references?

- `convertCellsToLinks` in `.send()` is by design (cells need serialization for
  storage/sync). Is there a way to opt out for in-process handlers?
- Could we add a `sendRaw()` or similar that skips serialization?
- Or should handler tool invocation bypass the stream mechanism entirely?
- How do other handler tools (e.g. `addListItem`) work with Cell args?

### 4. What's the right architecture for the serialize/deserialize pipeline?

- Should `handleInvoke` produce different output for "LLM consumption" vs "code
  consumption"?
- Should `traverseAndSerialize` be smarter about not collapsing top-level
  results?
- Is there a way to make cell-result-proxies NOT infinitely nest?
- Should the LLM see the `{ cell, error }` structure or just the cell?

## Investigation Approach

1. **Trace the omnibot-fab pipeline** end-to-end using browser dev tools:
   - Network tab: what does the fetchAndRunPattern tool result look like?
   - Console: what does `navigateToPattern` receive as input?
   - Compare with suggestion.tsx's pipeline

2. **Map the data transformation points** in `llm-dialog.ts`:
   - `handleInvoke` → `traverseAndSerialize` → LLM
   - LLM → `traverseAndCellify` → `handleInvoke` (next tool)
   - Document what form data is in at each point

3. **Understand the cell proxy system**:
   - Why does `.get()` return infinite proxies?
   - What's the difference between `isCell`, `isCellResult`,
     `isCellResultForDereferencing`?
   - How does `traverseAndSerialize` handle each case?

4. **Propose a simplified architecture** where:
   - Tool results are always serialized consistently for the LLM
   - Tool inputs are always deserialized consistently for code
   - Handler tools receive the same quality of input as pattern tools
   - The boundary between "serialized for LLM" and "live for code" is clear

## Current State of Code

### `llm-dialog.ts` changes:

- `buildToolCatalog` accepts `includeBuiltinTools` parameter
- `invokeToolCall` wraps finalResult in `{type: "json", value: ...}`
- `startRequest` resolves cell proxies in seeded messages
- Handler tools bypassed `.send()` via direct `scheduler.queueEvent()`
  (preserves Cell refs but proxies still cause issues)
- Added `resolveLink` import for handler link resolution

### `suggestion.tsx` changes:

- `presentResult` handler replaces pattern (cross-space `.set()` fix)
- `askUserHandler` handler replaces pattern (same reason)
- `fetchAndRunPattern` passed directly (no wrapper pattern)
- `finalResult` and `askUser` defined as handler tools with descriptions
- Dialog system prompt updated with explicit link-passing instructions
- `builtinTools: false` to suppress read/invoke/schema/pin/unpin

### `llm.ts` changes:

- finalResult extraction unwraps `{type, value}` wrapper
