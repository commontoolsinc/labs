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

## A tool named like a built-in shadows it

A pattern tool may carry the name of one of the six: `read`, `invoke`,
`schema`, `pin`, `unpin`, or `updateArgument`. Dispatch resolves the pattern's
tools first, so the pattern's tool is what runs, and the tool declarations
follow it — the model is offered its schema and description, the UI lists it,
and the CFC gates read their policy from its declaration. The built-in becomes
unreachable under that name, and the runtime logs a warning saying so.

One thing does not follow: the system prompt's standing guidance describes the
built-ins in prose whenever built-ins are enabled, so a model can still be told
about `read()` and `invoke()` in their built-in sense while a pattern's tool
holds the name. Shadowing is therefore safe but confusing, and rarely worth it,
since it also costs the built-in. Give a tool its own name unless you mean to
replace one, and if a built-in seems to have gone missing, check the log for a
shadowing warning.

`presentResult` is different and is a **reserved name**: supplying a tool
called `presentResult` throws when the catalog is built. The dialog stores the
call carrying that name as its structured result, matching by name, and that
match cannot follow a resolution — so a pattern holding the name would be
dispatched the call while its input was still captured as the result. The name
is refused rather than allowed to mean two things.

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
