# @commonfabric/shell

## Commands

- `deno task build`: Builds the frontend to `dist/`.
- `deno task serve`: Builds and serves the front at `localhost:5173`.
- `deno task dev`: Watches source directory and rebuilds/reloads host at
  `localhost:5173`. Access via `localhost:8000` when running with toolshed.
- `deno task production`: Builds the frontend to `dist/` with production
  settings.

## Routes

The shell supports these browser URL forms:

- `/<space-name-or-did>`: opens the space root pattern.
- `/<space-name-or-did>/<piece-id-or-slug>`: opens a specific piece.
- `/.embed/<space-name-or-did>/<piece-id-or-slug>`: opens the same piece in
  embed mode.

Embed mode is intended for rendering the shell inside another web view, such as
an iframe. It removes shell-owned chrome around the pattern, including the
header, debugger, quick jump, outer content padding, sidebar, and fab surfaces.

Shell navigation preserves embed mode. For example, a pattern calling
`navigateTo(...)` from a `/.embed/...` URL navigates to another `/.embed/...`
URL rather than leaving the embedded surface.
