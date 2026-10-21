# FileStore

`FileStore` is an implementation of [`FileStoreOutput`](FileStoreOutput.md),
which states everything a file store does: what its facts mean, and what each
request does. This document says how this implementation does it, where a space
keeps it, and how its modules are laid out.

## Where it lives

A store is a piece in the space whose files it holds, and the space's root names
it with a `fileStore` link, as a container names its own chat with `chatRoom`. A
root that offers file storage declares the link in its own output, and creates
the store the first time something needs it, from a handler of its own, such as
`ensureFileStore`. A root that declares no `fileStore` offers none, and a
pattern or client that needs one there has nowhere to put files.

The link is set once, when the store is created, and never changes. Two stores
in one space would be two sets of files with no rule for which a file belongs
in, so a root MUST NOT replace its store, and nothing else in the space creates
one.

A space whose root is a FabriChat room
([`FabriChatRoom`](../fabrichat/FabriChatRoom.md)) keeps its attachments in its
own store, named by the room. A message's attachment links an entry of that
store (see [`clients.md`](clients.md#attaching-a-file)).

## State

The store keeps two values, both `PerSpace` in its space:

- **`entries`**: a list of [`FileEntry`](FileEntry.md) records. `add` pushes a
  new entry onto it, a document of its own, and `remove` takes one out. Nothing
  else changes the list.
- **`requests`**: the outcome of each request (see
  [`FileStoreOutput`](FileStoreOutput.md#facts)).

`byName` is computed from `entries`. A name check, for `add` and `rename`, reads
the names of every entry in `entries`.

## Writers

Every record names its writers. The entry list's write policy names `add` and
`remove`, and an entry's names `add`, `rename` and `remove`: `add` writes the
whole entry, `rename` its `name`, and `remove` its `removedAt`. No other code can
write either, even code a member runs in the store's space.

The handlers learn the principal they act for with `currentPrincipal()`, and an
entry's adder from its `authored-by` label, which is how `remove` and `rename`
admit the adder. They learn whether the principal is an OWNER of the store's
space with `spaceAccess()`.

## Modules

The store's patterns are in `packages/patterns/file-store/`:

- `schemas.tsx`: `FileEntry`, `BlobRef`, `FileProfile`, and
  `FileStoreOutput`.
- `names.ts`: the [name rules](FileEntry.md#names), and the choice of a free
  name for `onConflict: "rename"`, as plain functions with no pattern in them.
- `store.tsx`: `FileStore`. It has no `[UI]`.
- `view.tsx`: `FileStoreView` (see [`FileStoreView.md`](FileStoreView.md)).

`schemas.tsx`, `names.ts` and `store.tsx`, and every module they import, MUST
NOT import `view.tsx`, any other module that renders, or anything from
`packages/ui`. A root that offers file storage imports `store.tsx`, and imports
`view.tsx` only from its own rendering. A client that draws natively
instantiates the store, or reads it through a root, with no rendering code
loaded.

That rule is held by a test, beside the patterns, that walks the import graph
of `store.tsx` and fails on any module that renders.

## Prerequisites

- **A blob reference a pattern can check**: the same as the contract's (see
  [`README.md`](README.md#prerequisites)).
- **Knowing its own space.** `add` refuses a `blob.space` other than the store's
  own, so the handler needs the DID of the space it runs in.
