# File store

This directory describes a space's designated file storage: the patterns it is
made of, the contracts they fill, and what they require of the runtime and of
the programs that use them. It is a design. Nothing in it is built yet.

## Quick links

- Patterns:
  - [`FileStore`](FileStore.md): a space's set of files. It has no rendering.
  - [`FileStoreView`](FileStoreView.md): a store's rendering, for hosts that
    render VDOM.
- Contracts, named for their roles:
  - [`FileStoreOutput`](FileStoreOutput.md): what a store offers.
- Records a store holds:
  - [`FileEntry`](FileEntry.md): one file: its name, its media type, and the
    blob that holds its bytes.
- [Requirements on clients](clients.md)

## Purpose

A space holds files: the images, videos, text files and documents that people
put there, and that other parts of the space refer to, such as a chat message's
attachments. The bytes already have a home, the space's blob store
([files](../../common/capabilities/files.md)), which keeps each blob as a
content-addressed document of the space, addressed by the hash of its media
type and bytes. What the blob store doesn't offer is a _set_ of files: names a
person chose, a listing, a way to find a file by its name, and a way to take a
file out of the set. Each pattern that takes files today keeps its own list of
upload descriptors, so a space's files are scattered across its pieces and no
program can enumerate them.

A file store is that set, one per space. It is two patterns and one record:

- **The store** ([`FileStore.md`](FileStore.md)) is the set of files in one
  space. It finds a file by its name, takes new files, and removes, renames
  and lists them. It has no `[UI]`, and its module imports no rendering code.
- **The entry** ([`FileEntry.md`](FileEntry.md)) is one file: a name, a media
  type, and a reference to the blob holding its bytes. An entry is a record the
  store holds, a document of its own, so anything that refers to a file, an
  attachment included, links the entry.
- **The view** ([`FileStoreView.md`](FileStoreView.md)) renders a store for
  hosts that render VDOM, such as the shell. It is a separate pattern in a
  separate module, so a client that draws natively uses the store without
  loading any rendering code.

```text
  space
  ┌────────────────────────────────────────────────────────┐
  │ root ──fileStore──► FileStore                          │
  │                      entries: FileEntry, FileEntry, …  │
  │                        │                               │
  │                        │ blob: { space, id }           │
  │                        ▼                               │
  │                      blob store: cid:fid1:<hash>       │
  │                                                        │
  │ FileStoreView ──link──► FileStore     (VDOM hosts only)│
  └────────────────────────────────────────────────────────┘
```

[`clients.md`](clients.md) states what a separate program that uses a store must
do, and must not do, including one that draws files with its own toolkit and
one that mirrors a space's files to a local file tree.

## Status and interpretation

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are normative. Where this design depends on something the runtime does not yet
provide, the document says so, under the heading "Prerequisites".

## Reading order

1. [`FileStoreOutput.md`](FileStoreOutput.md): the contract: what a store's
   facts mean and what each request does.
2. [`FileEntry.md`](FileEntry.md): the record a store holds.
3. [`FileStore.md`](FileStore.md): how this implementation fills the contract,
   and where a space keeps it.
4. [`FileStoreView.md`](FileStoreView.md): rendering a store for hosts that
   render VDOM.
5. [`clients.md`](clients.md): the requirements on a separate program that uses
   a store.

## Terms

- **Store.** A space's set of files: a `FileStore` piece, named by the space's
  root.
- **Entry.** One file in a store: a [`FileEntry`](FileEntry.md).
- **Blob.** The bytes of a file and their media type, kept by the space's blob
  store as the document `cid:fid1:<hash>`, where `<hash>` is the hash of the
  media type and the bytes. A blob is immutable, and nothing deletes one.
- **Blob reference.** The pair of a blob's space and its `fid1:` id, which is
  everything a reader needs to fetch the bytes.
- **Name.** The string a store finds an entry by. Within one store, names are
  unique.
- **Client.** A program that reads and writes a store on a person's behalf: the
  shell, or a separate application embedding the runtime.

## Decisions

1. **One store per space, named by the space's root.** A root that offers file
   storage links its store from a `fileStore` field, as a container names its
   own chat with `chatRoom`. A pattern in the space finds the store through
   `wish({ query: "#default" })`, and a client through the root it already
   reads.
2. **An entry refers to its bytes; it never holds them.** An entry is small,
   whatever the size of its file. The bytes stay in the blob store, and an
   entry names them by blob reference.
3. **A file is a record, not a piece.** An entry is an object pushed onto the
   store's list, a document of its own, identified by its cell. A link to it
   carries its label across a space boundary, which is what an attachment
   needs, and a piece per file would cost a pattern instance per file for
   nothing a record can't do.
4. **Names are flat and unique.** A store has no folders. A name is one segment,
   valid as a file name on the common file systems (see
   [`FileEntry`](FileEntry.md#names)), so a program can mirror a store to a
   directory with one file per entry and no renaming.
5. **An entry's bytes never change.** A blob is immutable, so an entry's blob
   reference and media type are fixed when it is added. Its name can change. A
   new version of a file is a new entry.
6. **Removing a file removes the entry, not the bytes.** The blob store deletes
   nothing, so a removed file's bytes stay reachable by anyone holding its
   blob reference (see [Privacy](#privacy)).
7. **The protocol surface is UI-free.** The store, the contract and the entry
   hold data and take requests. None of them carries rendering state, such as
   a selection, a sort order or an upload in progress: that belongs to whatever
   draws the store.
8. **Rendering code is never loaded to use a store.** The store's module, and
   every module it imports, imports no module that renders. The view's module
   imports the store's; the store's never imports the view's. A client that
   draws natively instantiates and reads the store with no rendering code
   loaded.

## Privacy

A store's entries are as private as its space: a reader the space's access list
refuses reads no entry. The bytes are not, today:

- **The blob routes are unauthenticated.** Anyone who holds a blob's space and
  id can fetch it, and anyone can upload into a space
  ([files](../../common/capabilities/files.md#what-the-store-provides)). The
  bytes are only as private as their reference is secret.
- **A reference is a hash of the content.** Anyone who already has a file can
  compute its id, and so can learn whether a space holds it, by fetching it.
- **Removal doesn't revoke.** A removed entry's blob reference still fetches
  its bytes, and so do the copies of it that attachments and other links hold.

Some of this no design can prevent: anyone who can read a file can keep and
re-share its bytes, by reference or by copy. What the runtime can provide is
that a blob reference grants nothing on its own. See
[Prerequisites](#prerequisites).

## Non-goals

- Folders, or any hierarchy of names.
- Editing a file in place. A changed file is a new entry.
- Deleting bytes from the blob store.
- Uploading through the store. A client puts the bytes in the blob store
  itself, and then adds an entry for them (see [`clients.md`](clients.md)).
- Quotas and limits beyond the blob store's own.

## Prerequisites

The design depends on runtime capabilities that don't exist yet:

- **Authorized blob reads.** A blob read is admitted only for a principal the
  blob's space admits, as a read of any other document of the space is, and a
  blob write likewise. Until then, everything under [Privacy](#privacy)
  holds.
- **A blob reference a pattern can check.** The store takes a blob reference
  from a client, and can't yet confirm that the blob exists in its own space,
  or that its stored media type is the one the request names (see
  [`FileStoreOutput`](FileStoreOutput.md#add)).
- **A blob URL a pattern can form.** A rendering needs a URL for a blob, such
  as an image's `src`. An upload returns one, relative to the toolshed's
  `/<space>/` path, but nothing lets a pattern form one from a blob reference
  alone (see [`FileStoreView`](FileStoreView.md#prerequisites)).
