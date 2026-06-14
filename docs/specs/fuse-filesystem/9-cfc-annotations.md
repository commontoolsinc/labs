# CFC FUSE Annotation Slice

This package now has an opt-in CFC annotation layer for projected FUSE nodes. It
is enabled by constructing `CellBridge` with `cfcAnnotations: true` or by
mounting with `--cfc-annotations`.

## Emitted Metadata

Annotated nodes carry an internal `CfcNodeAnnotation` and can be exposed through
xattr-compatible names. The local default exposes both `trusted.cfc.*` and
`user.commonfabric.cfc.*`; `--cfc-xattr-namespace=trusted|compat|both` selects
the exported spelling. Unknown namespace values are rejected. The logical
protected vocabulary is:

- `trusted.cfc.ref`
- `trusted.cfc.generation`
- `trusted.cfc.contentLabel`
- `trusted.cfc.metadataLabels`
- `trusted.cfc.namespaceLabel`
- `trusted.cfc.entries`
- `trusted.cfc.derivedSlots`
- `trusted.cfc.callable`
- `trusted.cfc.symlink`

Refs are canonical logical projection refs, not FUSE inodes or mount paths. They
include the space DID, entity ID when available, `pieces` / `entities`, `input`
/ `result` when applicable, logical JSON path, projection kind, and the
projection generation.

The first slice annotates scalar JSON files, object/array directories, aggregate
`.json` siblings, top-level `input.json` / `result.json`, sigil symlinks,
callable handler/tool files, piece metadata, piece manifests, space metadata,
handler summaries, and source projections.

## Conservative Behavior

When authoritative path-granular runner CFC metadata is absent, stale, or not
available through the current cell API, FUSE emits a fail-closed label
containing `CommonFabricFuseProjectionMetadataIncomplete`. It does not silently
downgrade missing labels to public.

For CFC-enabled mounts, observe mode allows local writes, creates, renames,
symlinks, truncates, and metadata mutations while recording diagnostics.
Enforce-* modes require the prepare/finalize flow before those operations
proceed. The existing non-CFC behavior is unchanged.

The temporary writeback xattr bridge accepts the trusted prepare/finalize names
and the equivalent `user.commonfabric.cfc.*` compatibility spellings when a host
transport cannot carry `trusted.*` xattrs. gVisor remains responsible for
exposing only the trusted logical namespace to the sandbox.

Derived slot metadata is emitted as an explicit empty `no-trusted-derived-slots`
structure. Digest-looking names therefore remain ordinary names unless a future
trusted-derived identifier source supplies evidence.

## Chapter 18 Mapping

This implements the annotation-producer side of §18.2.3.5 and §18.2.3.6:

- FUSE publishes protected CFC metadata as xattr-like annotations.
- Directory entry labels live on parent directory annotations through
  `trusted.cfc.entries`.
- Stable refs are based on logical Common Fabric identity and projection
  generation, not transient inodes.
- Aggregate JSON labels join descendant labels.
- Callable files are descriptor bytes only; invocation authority remains at the
  Common Fabric runtime boundary.

## gVisor Work Remaining

This package does not enforce CFC observation policy. A conforming gVisor
deployment still needs to hide or synthesize these xattrs from sandbox-visible
metadata calls, mediate path and metadata observations under the active profile,
track fd labels, enforce syscall-visible read/write policy, and pass trusted
write-label metadata back to FUSE before CFC-enabled writeback can be enabled.
