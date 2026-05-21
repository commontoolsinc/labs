# 10. CFC Filesystem API Semantics

## Scope

This chapter defines how the Common Fabric FUSE filesystem behaves when CFC
annotations and writeback are enabled. It is normative for the filesystem API:
ordinary programs must see normal POSIX-like success and error behavior. CFC
adds labels, authorization checks, and fail-closed policy; it must not require
ordinary programs to understand custom pending-success semantics.

The default write contract is commit-confirmed: a mutating syscall reports
success only after the corresponding Common Fabric mutation, runtime invocation,
or explicitly specified acceptance boundary has succeeded. A mount may offer a
separate local-ack compatibility mode, but that mode is non-default and must
surface pending, failed, or unknown outcomes through diagnostics such as
`.status` or operation logs.

## Trust Model

FUSE is the annotation producer and writeback reconciler. It is not, by itself,
the sandbox observation-policy authority.

- `trusted.cfc.*` is the logical protected namespace used for enforcement.
  In production, these values are trusted only when carried through a
  gVisor-mediated protected path.
- `user.commonfabric.cfc.*` is a local compatibility/debug namespace. It may
  mirror protected values for tools that cannot access `trusted.*`, but it must
  not be used as enforcement input.
- gVisor remains responsible for hiding or synthesizing sandbox-visible CFC
  metadata, mediating metadata and path observations, tracking fd labels,
  enforcing syscall-visible read/write policy, and passing trusted write-label
  evidence back to FUSE.
- Missing authoritative labels fail closed. FUSE must emit incomplete labels
  rather than silently treating unknown data as public.

## CFC Modes

| Mode | Annotation output | Mutation behavior |
|------|-------------------|-------------------|
| `disabled` | CFC annotations are omitted unless explicitly requested for debugging. | CFC does not deny operations. Normal filesystem errors still apply. |
| `observe` | CFC annotations are emitted. Missing runner metadata emits fail-closed labels. | Mutations proceed while missing, malformed, or stale prepare metadata is recorded as diagnostics. Valid prepare metadata may still be applied for testing and reconciliation. |
| `enforce-explicit` | CFC annotations are emitted. | Annotated protected targets require valid trusted prepare metadata. Unannotated targets may proceed unless another policy denies them. |
| `enforce-strict` | CFC annotations are emitted. | Projected mutations fail closed unless the relevant target or parent has coherent annotations and valid trusted prepare metadata. |

## Common Operation Lifecycle

Every mutating operation follows the same high-level lifecycle:

1. Resolve the path to a logical Common Fabric ref: space, entity, cell,
   JSON path, projection kind, and projection generation.
2. Perform deterministic local validation: path type, JSON syntax, size/range,
   supported operation, readonly projection, and CFC mode policy.
3. For enforcing CFC modes, validate trusted prepare metadata against the current
   ref, generation, operation, name, and parent/target annotations.
4. Apply the Common Fabric mutation or runtime invocation.
5. Rebuild or reconcile the projection and finalize any prepared CFC writeback.
6. Reply success only if the operation reached its configured success boundary;
   otherwise reply with the most specific standard errno.

Read and traversal operations should remain cache-first and POSIX-like. Missing
CFC labels on readable data do not make FUSE reads fail by themselves; instead,
FUSE exposes fail-closed labels and the sandbox layer decides whether the caller
may observe the bytes or metadata.

## Errno Policy

Use standard errno values. Do not invent a custom success state for pending CFC
work.

| Condition | Errno | Notes |
|-----------|-------|-------|
| CFC policy denial, missing required prepare, or unauthorized read/write/search | `EACCES` | Permission denied by policy. |
| Operation forbidden independent of access bits, immutable/protected metadata mutation | `EPERM` | Use when the operation itself is not permitted. |
| Read-only mount, disconnected read-only degradation, or immutable readonly projection | `EROFS` | Mutations cannot proceed in this state. |
| Unsupported operation or unsupported xattr namespace | `ENOTSUP` / `EOPNOTSUPP` | Use for unsupported CFC operation classes, arbitrary symlink targets in enforcing modes, and unsupported xattr namespaces. |
| Missing xattr | `ENODATA` on Linux, `ENOATTR` on macOS where exposed | Platform compatibility layer may normalize internally. |
| Malformed CFC payload, invalid JSON, invalid flags, invalid symlink target | `EINVAL` | The caller supplied an invalid argument or file content. |
| Stale ref, stale projection generation, or prepare metadata for an old generation | `ESTALE` | Prefer this over generic `EACCES` when the denial is retryable after re-reading metadata. |
| Retryable race with current generation or in-flight rebuild | `EAGAIN` | Use only for explicitly retryable races, not for pending-success semantics. |
| Backend timeout | `ETIMEDOUT` | The operation did not reach its success boundary before its deadline. |
| Backend/storage/transport failure | `EIO` | Generic I/O failure when no more specific errno applies. |
| Cross-space, cross-piece, or cross-cell rename | `EXDEV` | Rename cannot be atomic across those boundaries. |
| Existing destination where replacement is not allowed | `EEXIST` | Especially create/mkdir and no-replace rename semantics. |
| Directory type mismatch | `ENOTDIR` / `EISDIR` | Use the path-type-specific errno rather than collapsing to `ENOENT`. |
| Non-empty directory removal or incompatible directory replacement | `ENOTEMPTY` | Applies when preserving normal directory semantics. |

## Operation Matrix

| Operation class | Operations | Normal program contract | CFC behavior | Primary CFC errors |
|-----------------|------------|-------------------------|--------------|--------------------|
| Traversal and attributes | `lookup`, `getattr`, `access`, `open`, `opendir`, `readdir`, `read`, `readlink`, `statfs` | Return cached or freshly resolved data, or a normal path/type/backend error. Reads should not require callers to understand CFC. | Emit annotation xattrs and fail-closed labels. gVisor mediates whether sandbox code may observe bytes, names, attrs, or xattrs. | `EACCES` for sandbox-mediated denial, `ENOENT`, `ENOTDIR`, `EISDIR`, `EINVAL`, `EIO`, `ETIMEDOUT`. |
| Content writes | `write`, `flush`, `fsync`, `truncate`, `ftruncate` | Buffer partial writes as needed; validate complete file content at flush/fsync/close boundary; report success only after commit/acceptance boundary. | Existing annotated targets require trusted prepare in enforcing modes. Prepared content and metadata labels are applied before mutation and finalized after recomputation. | `EACCES`, `ESTALE`, `EINVAL`, `EROFS`, `EFBIG`, `ETIMEDOUT`, `EIO`. |
| Handle cleanup | `release`, `releasedir` | Cleanup is best-effort; callers should receive writeback failures earlier via `write`, `flush`, or `fsync`. | Must not be the only place CFC or backend failures are reported. May record diagnostics for late failures. | Usually none; late failures become diagnostics, not hidden success contracts. |
| Creation | `create`, `mkdir` | Create a file as an empty string or directory as an empty object only if parent and name are valid and backend mutation succeeds. | Parent namespace annotation controls the new entry. Enforcing modes require valid trusted prepare where required by mode. | `EACCES`, `ESTALE`, `EEXIST`, `EINVAL`, `ENOTDIR`, `EROFS`, `ETIMEDOUT`, `EIO`. |
| Namespace deletion | `unlink`, `rmdir` | Remove the file or directory only if type checks and backend mutation succeed. Array deletion re-indexes as specified by the JSON mapping. | Parent namespace/entry labels govern the removal. In enforcing modes, prepare metadata must describe the removed name and generation. | `EACCES`, `ESTALE`, `ENOENT`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EROFS`, `ETIMEDOUT`, `EIO`. |
| Rename | `rename` | Same-cell rename is copy/delete at the JSON level but must appear as one filesystem operation. Cross-cell rename fails. Replacement semantics must be explicit. | Source and destination parent namespace labels govern the move. Prepare metadata must cover both sides when both are protected. | `EACCES`, `ESTALE`, `EXDEV`, `ENOENT`, `EEXIST`, `ENOTEMPTY`, `EINVAL`, `EROFS`, `ETIMEDOUT`, `EIO`. |
| Symlink | `symlink`, `readlink` | Only Common Fabric sigil-link targets are supported by default. Invalid or escaping targets fail. | Parent namespace labels plus link-text/target-identity labels govern creation. Arbitrary symlink targets are unsupported in enforcing modes until modeled. | `EACCES`, `ESTALE`, `EINVAL`, `EEXIST`, `ENOTSUP`, `EROFS`, `ETIMEDOUT`, `EIO`. |
| Metadata mutation | `setattr`, chmod/chown/timestamps | Apply only supported metadata changes. Synthetic metadata may acknowledge only when the specified semantics are modeled. | Prepare metadata must cover each requested metadata field. Unspecified labels fail closed. Unknown setattr flags fail rather than being silently trusted. | `EACCES`, `EPERM`, `ESTALE`, `EINVAL`, `ENOTSUP`, `EROFS`, `ETIMEDOUT`, `EIO`. |
| Xattr reads | `getxattr`, `listxattr` | Expose supported JSON type and CFC annotation names/values; hide or omit unsupported/inaccessible attrs. | `trusted.cfc.*` is protected. `user.commonfabric.cfc.*` is compat/debug only. Missing labels are represented as fail-closed values, not public values. | `ENODATA`/`ENOATTR`, `ENOTSUP`, `ERANGE`, `EACCES`, `EIO`. |
| Xattr writes | `setxattr`, `removexattr` | Only the documented CFC prepare/finalize names are writable, and only when the temporary writeback bridge is enabled. | Trusted prepare/finalize records seed and complete writeback reconciliation. Compat names may be accepted for local transports but are not trusted for sandbox enforcement. | `EACCES`, `EPERM`, `EINVAL`, `ESTALE`, `ENOTSUP`, `ENODATA`, `EROFS`, `EIO`. |
| Callable projections | `.handler`, `.tool`, `cf exec` | `.tool` files are read-only. Handler file writes remain a compatibility path outside enforcing CFC writeback unless a CFC invocation contract is specified. `cf exec` is the preferred invocation surface. | Callable files are descriptors; invocation authority remains at the Common Fabric runtime boundary. Enforcing modes should reject callable-send writeback until label propagation and authorization are specified. | `EACCES`, `ENOTSUP`, `EINVAL`, `ETIMEDOUT`, `EIO`. |
| Unsupported filesystem objects | `mknod`, hard links, device files, arbitrary host symlinks | Not supported by the Common Fabric JSON projection unless a future spec models them. | Fail closed in CFC modes. | `ENOTSUP` or `EPERM`. |

## Creation, Open, and Xattr Ordering

Normal programs running inside the sandbox must not need to perform CFC-specific
syscalls or special syscall ordering. `create`, `open`, `write`, and `setxattr`
are still distinct filesystem operations at the FUSE boundary, but any trusted
CFC write-intent evidence required for a mutation must be supplied transparently
by the enforcement stack before FUSE commits the mutation. In the current gVisor
prototype, the distinction is made at the syscall layer: ordinary sandbox
`setxattr`/`removexattr` calls to `trusted.cfc.contentLabel` are blocked unless
the task is privileged, while the kernel CFC hooks update internal
device/inode-keyed label state and then call VFS/file `SetXattr` themselves.
For a FUSE-backed file this reaches the userspace daemon as an ordinary
`FUSE_SETXATTR` request carrying a trusted `trusted.cfc.*` name/value; there is
no separate FUSE transport flag today that says "kernel policy metadata".

Because FUSE sees a normal xattr request, it should trust only the protected CFC
names and the deployment assumption that gVisor has hidden or blocked those
names from unprivileged sandbox callers. A future transport may replace this
with explicit per-operation metadata or a gVisor-private side channel, but that
is not the current implementation.

The temporary writable xattr bridge remains a local testing and integration
mechanism. It is not the normal application contract and must not be the only way
for ordinary programs to create or write files under CFC enforcement.

Bridge to quarantine semantics: today, incomplete CFC writeback state is
represented only by mediated prepare/finalize xattrs plus persisted
`CfcWritebackStore` records. The current implementation does not create hidden
quarantine dentries, does not publish incomplete entries into the confirmed
`FsTree`, and does not make ordinary path lookup depend on quarantine state. The
next quarantine implementation must keep that separation explicit: quarantine is
a private transaction store layered beside the confirmed projection, not a hidden
file in the normal namespace.

For creation-like operations:

1. Validate the parent namespace annotation, target name, current generation, and
   operation-specific trusted write intent before mutating the parent cell. That
   intent currently arrives as a protected CFC xattr request emitted by gVisor's
   kernel-managed CFC hooks; a future implementation may use another trusted
   transport. It must not depend on the sandboxed program issuing xattrs in a
   special order.
2. Derive the new entry's initial annotation from the parent namespace policy and
   the prepared entry/content labels. Missing labels are incomplete/fail-closed,
   never implicitly public.
3. In `enforce-explicit` and `enforce-strict`, fail the app-visible
   `create`/`mkdir` with `EACCES` or `ESTALE` when required trusted write intent
   is absent, stale, malformed, or insufficient. Do not return success to a
   normal program until the entry is fully labeled and committed.
4. FUSE may still use a private quarantine record as an internal staging or
   recovery artifact. That record is outside the normal POSIX namespace and is
   not inserted into the confirmed `FsTree`, parent child maps, readdir indexes,
   or kernel-visible inode/dentry state. If metadata cannot be completed, the
   original operation fails and the quarantine record is aborted or
   garbage-collected.
5. In `observe`, or in an explicitly configured compatibility mode outside the
   trusted gVisor path, creation may proceed without complete write-intent
   metadata, but the resulting annotation remains incomplete/fail-closed and
   diagnostics must note the missing or stale evidence.

A quarantine record is a private FUSE/gVisor transaction record, not an
unlabeled public object and not a POSIX-visible file state. When implemented,
quarantine state must live in a private `QuarantineStore`. It must not live in
the confirmed `FsTree`, parent child maps, readdir indexes, or kernel-visible
inode/dentry state. Records must be keyed at least by `{ operationId, parentRef,
name, expectedGeneration }`, with operation type, prepared label state, finalize
state, timestamps, and diagnostics stored as record data.

Normal namespace and handle paths must not consult `QuarantineStore`. This
includes `lookup`, `readdir`, `readdirplus`, `getattr`, `access`, `open`, and
`opendir`. Those operations resolve only the confirmed projection and must behave
exactly as if no quarantine record exists. If a normal application file handle to
a quarantine record would escape, treat that as an implementation error and fail
or abort before reporting create success.

Only the following trusted actors may read `QuarantineStore`: completion/finalize
handling for protected prepare/finalize metadata, trusted abort handling, startup
recovery, and TTL garbage collection. Completion must match by operation ID and
validate the parent ref, target name, operation type, expected generation, and
prepared/finalized label state before publishing anything into the normal
projection. Once validation succeeds, FUSE may publish/invalidate the normal
dentry as needed and report success or make the entry visible according to normal
CFC policy. Invalid metadata leaves the record quarantined until trusted abort or
garbage collection removes it.

In the current gVisor/FUSE path, prepare/finalize metadata arrives as ordinary
`FUSE_SETXATTR`; FUSE has no transport-level discriminator for kernel CFC
metadata versus privileged/admin `setxattr`. FUSE therefore trusts protected
`trusted.cfc.*` writeback names only under the deployment invariant that gVisor
blocks or mediates user-origin writes before they reach FUSE. Ordinary
applications must not be required to issue CFC prepare/finalize xattrs or follow
special xattr ordering. Prepare/finalize xattrs are an enforcement-stack
writeback bridge, not the POSIX application API.

Quarantines must have bounded lifetime. FUSE should scan quarantine records on
startup and periodically during runtime, aborting records older than the
configured TTL; one hour is the default initial target unless active trusted
completion is in progress. Cleanup events, expired quarantine counts, and any
timed-out-unknown operations should be visible through `.status` diagnostics, not
through normal directory entries.

Post-create `setxattr` is a separate metadata mutation. It may write only the
documented prepare/finalize records for local bridge testing, or another
explicitly modeled metadata change. It must not retroactively authorize a create
that should have failed, must not lower confidentiality or integrity policy, and
must not expose an unlabeled file as public while reconciliation is pending.

## Prepare and Finalize Requirements

Prepared writeback metadata must be operation-specific and generation-specific.
The operation must fail closed in enforcing modes when any of the following is
true:

- trusted prepare metadata is required but absent;
- prepare metadata is malformed;
- the prepared operation name does not exactly match the filesystem operation;
- the prepared target or parent ref does not match the current projection ref;
- `expectedGeneration` differs from the current annotation generation;
- required content, namespace, entry, symlink, target identity, or metadata-field
  labels are missing;
- strict mode requires an annotation but the target or parent annotation is
  absent or incoherent.

After the Common Fabric mutation succeeds, FUSE must reconcile the rebuilt
projection against the prepared labels. Until exact recomputation/finalization,
the affected annotation remains incomplete/fail-closed rather than public.

## Compatibility Notes

The current implementation contains local compatibility behavior that should not
be mistaken for the normative contract:

- Some write paths currently reply before backend commit and report later
  failures through logs, `.status`, or writeback recovery records. This is a
  compatibility behavior to be tightened for the default POSIX-like contract.
- Some implementation errors currently collapse to `ENOENT` or `EACCES` where
  the normative spec calls for `ENOTDIR`, `EISDIR`, `EINVAL`, `ESTALE`,
  `ENOTSUP`, or `ENODATA`/`ENOATTR`.
- The temporary writeback xattr bridge is useful for local testing and early
  gVisor integration. The inspected gVisor FUSE path currently transports
  kernel-managed CFC labels as ordinary `FUSE_SETXATTR` requests after blocking
  unprivileged sandbox writes to protected names at the syscall layer. A
  non-xattr side channel would be a future design, not current behavior.

## Open Questions

1. Should production keep using protected `trusted.cfc.*` FUSE xattrs for
   prepare/finalize, or add an explicit gVisor/FUSE discriminator so the daemon
   can distinguish kernel CFC metadata from privileged/admin xattr calls?
2. What exact event is the default write success boundary for each operation:
   durable cell commit, runtime acceptance, or another named backend ack?
3. How should handler/tool invocation carry CFC labels and writeback evidence?
   Until specified, enforcing modes should reject callable-send writeback.
4. Should stale CFC generation consistently return `ESTALE` in implementation,
   or remain `EACCES` for compatibility until clients are updated?
5. Which metadata mutations should be modeled as real durable Common Fabric
   metadata rather than synthetic POSIX attributes?

---

**Previous:** [CFC Annotations](./9-cfc-annotations.md)
