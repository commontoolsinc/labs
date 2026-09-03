# @commonfabric/llm

The caller's half of the language-model boundary: the request and response
types, the HTTP client that sends a request to the toolshed, and the check that
a request survives the trip through JSON.

## The model catalog is not here

If you came looking for the list of models, the aliases, which provider serves a
given name, or the chain that decides what `default` means, it is in
[`packages/toolshed/routes/ai/llm/models.ts`](../toolshed/routes/ai/llm/models.ts).
That file is the whole provider abstraction: it registers a model under a name,
records what the model can do, and hands back the provider client to call.

The split is deliberate. A caller sets `model` on an `LLMRequest` to a name and
posts it to `/api/ai/llm`; the toolshed turns that name into a provider to call.
Which models a deployment has depends on the credentials it was configured with
and on what the gateway answers when asked, so the real list exists only in the
server and only at run time. A copy on this side would be a guess, which is why
a caller that wants the list fetches `GET /api/ai/llm/models` instead of
importing one.

Two rules follow for this package. It reaches a browser tab, through
`@commonfabric/runner` and `runtime-client`, so nothing a browser may not load
belongs here — no provider SDK, no `node:` module;
[`test/package-boundary.test.ts`](test/package-boundary.test.ts) checks that
against an allowlist. And `@commonfabric/runner` imports this package, so
importing the runner back would close a cycle, which the repo-wide
`deno task check-package-cycles` catches.

[`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
sets all of this out in full, including the two places the division leaks.

## What is here

- [`src/types.ts`](src/types.ts) — the request and response shapes that cross
  the boundary, and the predicates that recognize them. `LLMRequest`,
  `LLMResponse`, `LLMGenerateObjectRequest`, tool calls and tool results, and
  the native model tools a request may ask a model to run for itself.
- [`src/client.ts`](src/client.ts) — `LLMClient`, which posts to the toolshed
  and reassembles a streamed answer. It also carries the mock mode that tests
  use in place of a live call, and the guard that blocks a live call under
  `ENV=test` or `CI=true`.
- [`src/schema-transport.ts`](src/schema-transport.ts) — the check that a schema
  is still the same schema after a round trip through JSON.

## The routes on the other side

| Route                        | Method | What it does                                 |
| ---------------------------- | ------ | -------------------------------------------- |
| `/api/ai/llm/models`         | GET    | The registered models and their capabilities |
| `/api/ai/llm`                | POST   | Text generation, streamed or whole           |
| `/api/ai/llm/generateObject` | POST   | Generation constrained to a JSON schema      |

Their handlers are in
[`packages/toolshed/routes/ai/llm/`](../toolshed/routes/ai/llm/).

## Related documentation

- [`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
  — what each side of the boundary owns, and how a model name is resolved
- [`docs/features/llm-testing.md`](../../docs/features/llm-testing.md) — testing
  patterns and routes that call a model
- [`docs/development/CONFIGURATION.md`](../../docs/development/CONFIGURATION.md)
  — the environment variables that decide which providers register
