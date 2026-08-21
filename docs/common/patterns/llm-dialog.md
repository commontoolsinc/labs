# llmDialog: Tools, Built-ins, and Message Flow

`llmDialog` runs a model conversation as a reactive builtin: the pattern
supplies tools and messages, the runtime executes tool calls, and results flow
back into the dialog. The behaviors below are facts about the builtin
(`packages/runner/src/builtins/llm-dialog.ts`) that pattern authors cannot
derive from its type signature.

## Built-in tools are injected unless you turn them off

`llmDialog` builds its tool catalog from the tools the pattern passes **plus
six built-in management tools**: `read`, `invoke`, `schema`, `pin`, `unpin`,
and `updateArgument`. Models frequently prefer these generic tools over a
pattern's custom ones, which shows up as the model "ignoring" the tools you
wrote.

Pass `builtinTools: false` to suppress those six. Anything other than `false`
— including omitting it — leaves them on.

`presentResult` is **not** one of the six and the flag does not control it: it
is added after the catalog is built, whenever a `resultSchema` is present. So
`builtinTools: false` alone does not guarantee that only pattern-supplied
tools are advertised.

## A tool named like a built-in is a collision, not a clean override

The two halves disagree, so do not rely on this. Catalog construction records
the external tool's model-facing definition first and then writes the built-in
definition over it at the same name, while dispatch resolves the external
catalog first. On a collision the model therefore sees the **built-in's**
schema and description, but a call is executed against the **external** tool —
which can invoke it with the wrong input shape.

Treat a name collision with a built-in as a bug to avoid: name pattern tools
distinctly from `read`, `invoke`, `schema`, `pin`, `unpin`, and
`updateArgument`.

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
