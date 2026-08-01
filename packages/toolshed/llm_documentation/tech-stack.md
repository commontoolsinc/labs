# Tech Stack

Toolshed is a deno hono app.

For intra-service communication, we use hono stacks RPC style calls. See
[Hono Stacks Documentation](https://hono.dev/docs/concepts/stacks) for more
details.

We use Deno 2 and resolve bare imports through workspace import maps. Declare
Toolshed-only registry dependencies in `packages/toolshed/deno.jsonc`. Follow
the [dependency maintenance guide](../../../docs/development/DEPENDENCIES.md)
for registry choice, dependency placement, and update procedures.

## Core Technologies

- Deno 2 (typescript)
- Hono (http api)
- Deno Queue (used as a task queue for background tasks)
- Zod (schema validation)
