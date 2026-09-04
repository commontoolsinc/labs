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
- `/<space-name-or-did>/<piece-id-or-slug>`: opens a specific piece. Where the
  slug names a collection rather than a piece, this opens the piece that holds
  the collection.
- `/<space-name-or-did>/<collection-slug>/<member>`: opens the member the
  collection calls `<member>`. One segment reaches one member, so a member's own
  fields never answer to the collection's namespace. A member the collection
  does not hold is reported by name, alongside the collection's. The header
  offers the member's portable reference, `/@<space>/<collection>/<member>`,
  which carries its own space and so depends on no binding of the reader's. `cf`
  resolves it; this shell's own URLs and a pattern's `cellFromUrl` do not read
  that grammar. Where the slug names a piece rather than a collection there are
  no members to name, so the segment is dropped and the address settles on the
  piece the page is showing.
- `/.embed/<space-name-or-did>/<piece-id-or-slug>`: opens the same piece in
  embed mode.

Embed mode is intended for rendering the shell inside another web view, such as
an iframe. It removes shell-owned chrome around the pattern, including the
header, debugger, outer content padding, sidebar, and fab surfaces.

Shell navigation preserves embed mode. For example, a pattern calling
`navigateTo(...)` from a `/.embed/...` URL navigates to another `/.embed/...`
URL rather than leaving the embedded surface.
