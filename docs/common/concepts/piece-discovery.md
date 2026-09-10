# Finding Pieces

Common Fabric storage contains cells and links. It does not maintain a complete
catalog of which stored cells are piece roots. The supported piece APIs
therefore cannot enumerate every piece stored in a space.

## The Piece Registry Is the Discovery Root

The space's default pattern owns `pieceRegistry`. A piece in that list is a
**registered piece**. Top-level creation normally registers the new piece
through the default pattern's `addPiece` handler. Instantiating a child pattern
does not register the child automatically.

The following surfaces show registered pieces:

| Surface | Discovery boundary |
| --- | --- |
| `cf piece ls` | Reads the piece registry, then starts each registered piece to obtain its display metadata |
| `cf piece search` | Searches the readable input and result data of registered pieces only |
| `cf piece map` | Compares links among registered pieces only |
| `wish({ query: "#pieceRegistry" })` | Resolves the piece registry directly rather than running a hashtag search |
| `PiecesController.getPieceRegistry()` and `PiecesController.getRegisteredPieces()` | Return the piece registry |
| `RuntimeClient.getPiecesListCell()` | Returns a reactive handle to the piece registry |
| The FUSE `pieces/` directory | Projects the piece registry as named directories |

These are not storage-wide piece listings. In particular, `cf piece search`
does not return an unregistered piece just because a registered piece links to
data owned by it.

## The Slug Index Is the Namespace Root

Slugs have their own discovery boundary, beside the registry's. A slug document
lives at an ID derived from its name, so nothing can enumerate slugs it was
never told the names of. The space's **slug index** — one document naming every
slug assigned through `--slug` or `set-slug` — is what makes the namespace
enumerable: `cf piece slugs` lists it, resolving each name to where it points —
the piece it addresses, or, where the name points at a cell inside a piece, that
piece and the path to the cell. The index records the names only; where a name
points remains the slug document's own answer. It records assignments made
since it existed, so a slug written by an older client still resolves but is
not listed. A slug may
also name an unregistered piece, which makes the slug listing a discovery path
the registry does not have.

## Finding Pieces Outside the Registry

The ordinary piece-discovery surfaces can find a piece outside the registry
only from information that is already known:

- A pattern can publish it through a searchable collection such as
  mentionables, favorites, or profile elements. `wish()` searches those
  explicit collections.
- A caller can start with a known piece, normally one from the registry, and
  follow its stored links. Such a walk finds only pieces connected to its
  starting points. There is no supported comprehensive piece-graph walk.
- A caller that already has the exact piece address, including its scope, can
  address the piece directly. Direct lookup is access by a known address, not
  discovery.

The FUSE `entities/` directory is a lower-level exception when the memory
server supports identifier listing. It lists every live space-scoped entity ID.
A caller can inspect each entity and use recognizable metadata to identify some
piece roots. This provides a best-effort brute-force recovery path for
space-scoped pieces even when a piece ID was lost. The listing does not classify
entities as pieces, cannot enumerate user- or session-scoped roots, and may not
distinguish an identity-less root from an ordinary entity. Its cost is
proportional to every live entity rather than every piece.

## Orphan Pieces

An **orphan piece** is outside the registry and has no path from a known
discovery collection or piece. It may still have durable data in storage, but
it does not appear in `cf piece ls`, `cf piece search`, `cf piece map`, the
named FUSE `pieces/` projection, or the registry APIs. A caller that knows its
exact address, including scope, can address it directly. A caller that lost a
space-scoped ID may be able to recover it by enumerating and inspecting
unclassified entities through a supported low-level surface such as FUSE
`entities/`. This recovery is not available for user- or session-scoped roots
and is not guaranteed for roots without recognizable metadata.

Removing a piece from the registry does not delete its cells. Register pieces
that must remain discoverable, and deliberately publish or retain references to
child pieces that should stay reachable.
