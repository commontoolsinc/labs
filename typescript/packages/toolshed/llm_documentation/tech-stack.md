# Tech Stack

Toolshed is a deno hono app.

main.ts is the entrypoint for the app, but it's also a cli.

Whenever possible, make sure to use packages from JSR instead of npm.

We are using Deno2, so imports are a little different than deno 1. The deno.json file includes all of the dependencies and handles the mapping.

- Deno 2 (typescript)
- Hono (http api)
- Deno Queue (used as a task queue for background tasks)
- cliffy for cli
