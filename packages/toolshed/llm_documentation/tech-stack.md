# Tech Stack

Toolshed is a deno hono app.

For intra-service communication, we use hono stacks RPC style calls. See
[Hono Stacks Documentation](https://hono.dev/docs/concepts/stacks) for more
details.

Whenever possible, make sure to use packages from JSR instead of npm.

We are using Deno 2, so imports are a little different than deno 1. The
deno.json file includes all of the dependencies and handles the mapping.

## Core Technologies

- Deno 2 (typescript)
- Hono (http api)
- Deno Queue (used as a task queue for background tasks)
- Zod (schema validation)
