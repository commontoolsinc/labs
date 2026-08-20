# llmDialog: Tools, Built-ins, and Message Flow

`llmDialog` runs a model conversation as a reactive builtin: the pattern
supplies tools and messages, the runtime executes tool calls, and results flow
back into the dialog. The behaviors below are facts about the builtin
(`packages/runner/src/builtins/llm-dialog.ts`) that pattern authors cannot
derive from its type signature.

## Built-in tools are always injected

`llmDialog` builds its tool catalog from the tools the pattern passes **plus a
set of built-in management tools**: `read`, `invoke`, `schema`, `pin`,
`unpin`, `presentResult`, and `updateArgument`. Models frequently prefer these
generic tools over a pattern's custom ones, which shows up as the model
"ignoring" the tools you wrote.

To run with only your own tools, pass `builtinTools: false` in the inputs.
Anything other than `false` — including omitting it — leaves the built-ins on.

## An external tool with a built-in's name wins

Tool calls resolve against the external (pattern-supplied) catalog first and
fall back to the built-in names second. Supplying a tool named like a built-in
therefore overrides the built-in — deliberately. The corollary: an accidental
name collision silently replaces built-in behavior rather than erroring.

## Passing an options object literal can fail type-checking

The transformer's typing for builtin inputs (`Opaque<T>`) triggers excess-
property checking on inline object literals. A call that passes an option the
checker cannot reconcile — `builtinTools: false` is the recurring example —
fails when written inline and compiles when the object is extracted to a
variable first:

```typescript
// Shown for illustration only.
// ❌ May fail excess-property checking inline
llmDialog({ messages, tools, builtinTools: false });

// ✅ Extract the inputs object to a variable
const dialogInputs = { messages, tools, builtinTools: false };
llmDialog(dialogInputs);
```

## A tool that writes caller state must be a handler

Pattern-based tools run as patterns: they compute over their inputs in their
own space and cannot `.set()` cells belonging to the calling pattern.
A tool that needs to mutate caller state — append to a list, update a field —
must be a bound `handler()`, which receives the writable state it was bound
with. Prefer a `resultSchema` (letting the dialog produce a value the pattern
stores) over mutation tools where the shape allows it.

## Do not transform messages between builtins

Messages produced by the LLM builtins (for example a `generateObject` step
feeding an `llmDialog`) are already in the dialog's own message format,
tool-result parts included. Pass them through unchanged; reshaping or
"sanitizing" them breaks tool-result correlation.

## See Also

- [composition](composition.md) — passing tool collections between patterns
- [@handler](../concepts/handler.md) — handlers as bound streams
- [debugging README](../../development/debugging/README.md) — runtime error
  triage
