# @commontools/storage

New storage backend implementation per `docs/specs/storage/*`.

This package will provide the storage provider implementing the
content-addressed, append-only model with spaces, transactions, queries,
subscriptions, and snapshots.

Status: active development.

Testing: prefer running from the repo root with the workspace test runner:

- deno task test

This ensures import maps and env flags are applied consistently. Running plain deno test -A at the root will include mirrored .conductor paths and can fail outside of this package.
