---
status: historical
created: 2026-09-04
archived: 2026-09-04
reason: "Record of the deliberate contract break taken when the LLM message role stopped admitting `system`."
---

# The LLM message role stops admitting `system`

`BuiltInLLMMessage` declared four roles — `user`, `assistant`, `system`, and
`tool` — and `LLMMessageSchema`, the runtime schema describing that type, wrote
the same four into its `role` enum. That schema reaches the durable argument
contract of every pattern that calls the `llm`, `generateText`, or
`generateObject` builtin, because each of their parameter schemas carries a
`messages` array of it.

A system-role message was never legal anywhere else. `isLLMMessage()` in
`packages/llm/src/types.ts` accepted only three roles, and the toolshed's LLM
route gates every incoming payload on it, so a request carrying a system-role
message was refused with a 400. Behind that refusal is the AI SDK: the version
this repository pins refuses a system-role message inside `messages` whether
its content is a string or an array of parts, and directs the caller to an
option of its own instead. The toolshed never overrides that.

So the role was a surface three declarations disagreed about, and the two that
decide what actually happens both said no. It is gone from the type, from the
runtime schema, and from the route's own request schema. A system instruction
travels in the request's `system` field, which `LLMRequest`,
`BuiltInLLMParams`, and all three builtins already carry.

## Why this could not be done compatibly

An enum in a deployed contract may not stop accepting a value it already
accepts, so narrowing one is a break by construction. There is no shape of
`LLMMessageSchema` that both drops the role and applies over a baseline that
declared it. Keeping the role would have left the runtime schema describing a
message the guard in front of the model refuses, which is the defect this
change exists to remove.

Three `(pattern, baseline)` pairs produce the finding — `chatbot.tsx` against
two baselines and `deep-research.tsx` against one — and each blames the single
path `argument.messages[].role`. Every other pattern whose contract moved
produced only the routine "not recorded" finding.

## What happens to the pieces holding the old shape

Nothing is stranded. The narrowing was checked against a stored value directly:
a cell holding `{ role: "system", content: "Be brief" }` was read back through
the narrowed `LLMMessageSchema` and came back unchanged. The runtime does not
enforce an `enum` on read or on write, so the enum in these schemas describes
the type rather than policing it, and a message written under the old contract
still materializes under the new one.

There is also very little for that to matter to. No code in the tree ever
constructed a system-role `BuiltInLLMMessage`; every builtin populates the
separate `system` field. A piece that somehow held one held a message that
could never have reached a model, because the route refused the request
carrying it.

One operational consequence is real. `cf piece setsrc` calls
`assertPatternSchemasBackwardCompatible`, which reads neither this record nor
the accepted-break registry, so updating a live `chatbot` or `deep-research`
piece by hand is refused and needs `--dangerously-allow-incompatible-schema`.
The automatic updater performs no structural check at all, so pieces it updates
take the narrowed contract and go on working, for the reason above.

## Where the decision is declared

`tasks/pattern-compat-accepted-breaks.ts`, as one entry per pattern, bounded to
the baselines above and to the single path `argument.messages[].role`. No Tier 2
entry accompanies it: `deno task pattern-vintage` proves that a document written
by an older version is still readable, and this change strands no state for it
to lose.
