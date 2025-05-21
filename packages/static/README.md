# @commontools/static

This is a package that abstracts away handling of lazy-loaded static assets in both our Deno and browser environments. In Deno, the assets are loaded from disk, and in browsers, rely on the host (`toolshed`) to serve assets at a well-known route (`/static/*`).
