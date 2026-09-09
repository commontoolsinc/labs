# Background piece service — Agent Guide

The package directory is `background-piece-service`; the package itself is named
`@commonfabric/background-piece`.

Polls registered pieces and fires their `bgUpdater` handlers on the server, so a
piece can do scheduled work with no browser open. Each poll sends `{}` to the
piece's `bgUpdater` stream. The default interval is 60 seconds.

## Facts that will bite you

- A piece receives no polling until it is registered. Registration is a
  `POST /api/integrations/bg` carrying `pieceId`, `space`, and `integration`, or
  the `<cf-updater $state={someCell} integration="name" />` element in the
  piece's own UI.
- The service deploys built binaries rather than running from source in the
  usual local loop, so `deno task build-binaries` from the repository root has
  to have run for the version you are testing.
- Reaching the system space needs the admin piece, which is a one-time
  `deno task add-admin-piece` in this package. Skipping it surfaces as
  `AuthorizationError` rather than as anything mentioning the admin piece.
- A space DID is derived, not looked up:
  `Identity.fromPassphrase("common user").derive(spaceName).did()`.
- `CompilerError: no exported member 'pattern'` means the binaries are stale
  against the current source, not that the piece is wrong. Rebuild them.

## Running it against local servers

Start the local servers first
([`LOCAL_DEV_SERVERS.md`](../../docs/development/LOCAL_DEV_SERVERS.md)), build
the binaries, then grant and run:

```bash
# once per space, from this package
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-piece

# from the repository root
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" ./dist/bg-piece-service
```

A poll that reached the piece prints
`Successfully executed piece did:key:.../fid1:…`. Nothing printing at all means
the piece is not registered.

## Where answers live

Coding style is [`DEVELOPMENT.md`](../../docs/development/DEVELOPMENT.md); the
test and check commands are in `deno.jsonc` and
[`TESTING.md`](../../docs/development/TESTING.md).
