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
  which carries its own space and so depends on no binding of the reader's.
  Where the slug names a piece rather than a collection there are no members to
  name, so the segment is dropped and the address settles on the piece the page
  is showing.
- `/@<space-name-or-did>/...`: any of the other forms, `.embed` included,
  written with the mark that says which segment is the space. This is the
  spelling the portable reference above is written in, so what one page copies
  is what another opens; `cf` reads it too, and a pattern's `cellFromUrl` does
  not — it reads through `parseFabricUrl`, which wants an entity id where a
  collection's name sits. The mark is no part of the space, so a page opened
  this way settles on the URL the shell would have written for that address, and
  a segment that is nothing but the mark names no space and opens the home view.
- `/.embed/<space-name-or-did>/<piece-id-or-slug>`: opens the same piece in
  embed mode.

Embed mode is intended for rendering the shell inside another web view, such as
an iframe. It removes shell-owned chrome around the pattern, including the
header, debugger, outer content padding, sidebar, and fab surfaces.

Shell navigation preserves embed mode. For example, a pattern calling
`navigateTo(...)` from a `/.embed/...` URL navigates to another `/.embed/...`
URL rather than leaving the embedded surface.
