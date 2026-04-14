# gVisor integration gaps for Brighid

This document tracks the gaps that still appear real after the 2026-04-13 audit
of the current `labs` and sibling `gvisor` checkouts.

It intentionally does **not** restate items that are now working in practice,
such as Linux Docker + `runsc-cfc` execution or host-backed `/fabric`
availability. Those are now validated runtime paths, not hypothetical future
work.

## What is now validated

These paths are real and covered today:

- Linux Docker + `runsc-cfc`: `integration/docker-cfc.test.ts`
- Linux direct `runsc` fallback: `integration/runsc-direct.test.ts`
- macOS `cfc-sandbox` wrapper path: `integration/cfc-sandbox.test.ts`
- sandbox bridge/export/import behavior: `test/sandbox.test.ts`

In addition, the runtime selector now has unit coverage for macOS explicitly
targeting `docker-cfc`, and for auto mode falling back to `docker-cfc` when the
`cfc-sandbox` wrapper is unavailable. That is selector coverage, not a separate
claim that native macOS `runsc` exists.

The practical state is that Brighid can already run real sandboxed bash on the
supported runtime paths. The remaining gaps are about fidelity, interaction
model, and architectural shape.

## Confirmed remaining gaps

### 1. Root filesystem mirroring is still incomplete

Brighid still cannot present its whole VFS as the guest root in one step.

- `../gvisor/tools/cfc-sandbox/Sources/CFCSandbox/RunCommand.swift` rejects
  guest mount target `/`.
- `src/commands/exec.ts` therefore exports `"/"` and asks the executor to
  mirror the root into the guest.
- `src/sandbox/executor.ts` implements that by bind-mounting each top-level
  directory individually, plus the fallback workspace mount.

Impact:

- top-level directories work best
- absolute-path handling still depends on translation/workspace fallback
- this is still short of the spec's ideal of a fully mediated guest root

### 2. Interactive shell / TTY support is still batch-oriented

Real sandboxed execution works, but the current Brighid + gVisor path is still
oriented around non-interactive command execution.

- `../gvisor/tools/cfc-sandbox/Sources/CFCSandbox/ContainerRunner.swift`
  disables terminal mode when `runsc` is active.
- `src/commands/exec.ts` explicitly returns
  `bash: interactive mode not supported` when `bash` is invoked without `-c` or
  a script path.

Impact:

- `deno task brighid` is interactive as a supervisor loop, but the sandboxed
  `bash` tool is still effectively batch-first
- PTY-heavy workflows are not yet a first-class runtime path

### 3. `source` is unsupported on the gVisor backend

`source` cannot currently round-trip through the real sandbox path because a
subprocess cannot safely mutate the current shell session's environment.

Evidence:

- `src/commands/exec.ts`

Impact:

- shell workflows that rely on `source` changing the live session environment do
  not yet map cleanly onto the gVisor-backed execution model

### 4. VFS bridge fidelity still skips symlinks

The bridge is stronger than it used to be, but it still does not preserve full
filesystem semantics.

- `src/sandbox/vfs-bridge.ts` skips symlinks on export
- `src/sandbox/vfs-bridge.ts` skips symlinks on import

Impact:

- symlink-heavy POSIX workflows still diverge from a real mounted filesystem
- the bridge is good enough for file/tree round-trips, but not yet a full POSIX
  mirror

### 5. `/fabric` is still a host-backed compatibility bridge, not the final architecture

Brighid's practical `/fabric` path today is to bind-mount a host labs FUSE tree
into the guest.

- `src/sandbox/executor.ts` either reuses `BRIGHID_FABRIC_HOST_PATH` or creates
  a temporary labs FUSE mount with `--allow-root` and binds it into `/fabric`
- `integration/docker-cfc.test.ts` and `integration/cfc-sandbox.test.ts`
  validate that this host-backed path is visible from inside the sandbox

On the gVisor side, the current `pkg/cfc/fabric` package is a narrow host-side
projection, not a general in-sandbox POSIX filesystem:

- `../gvisor/pkg/cfc/fabric/README.md`
- `../gvisor/pkg/cfc/fabric/doc.go`

Current projected-tree limits include:

- metadata files are eager, but `result.json` bodies are lazy
- only `pieces/*/input.json` is writable
- refresh is still pull-based/debounced rather than push-invalidated

Impact:

- `/fabric` is usable today, but it is still a pragmatic bridge rather than the
  final mediated filesystem model

### 6. If we later want native in-sandbox FUSE, gVisor still has notable fusefs gaps

This is **not** the blocker for today's host-bind `/fabric` flow, but it is an
important forward-looking limitation if we ever want to replace the host-backed
bridge with a true in-sandbox FUSE path.

Evidence:

- `../gvisor/pkg/sentry/fsimpl/fuse/connection.go`
- `../gvisor/pkg/sentry/fsimpl/fuse/directory.go`
- `../gvisor/pkg/sentry/fsimpl/fuse/regular_file.go`
- `../gvisor/pkg/sentry/fsimpl/fuse/inode.go`

Examples of still-missing or constrained areas:

- `FUSE_READDIRPLUS` support is still TODO
- mmap / mapping support is still incomplete
- some FUSE init flags remain unsupported
- `allow_other` semantics still carry a user-namespace FIXME

### 7. The wrapper contract is still coarser than the full spec-level mediation model

The spec calls for deeper syscall- and object-level mediation than Brighid's
current wrapper contract exposes directly.

The underlying gVisor/CFC substrate is in better shape than it used to be, but
Brighid still consumes it mainly through:

- real command execution
- host-side VFS export/import
- output filtering and supervisor-side policy
- a host-backed `/fabric` bind mount

Impact:

- Brighid can launch real bash inside the sandbox today
- the full spec-level mediated filesystem/runtime contract is still not exposed
  end-to-end through the current Brighid wrapper surface

Evidence:

- `../specs/cfc/14-open-problems-and-proposals.md` §14.2
- `../gvisor/docs/cfc-gap-analysis.md`

## Closed or stale items from older versions of this doc

These should no longer be treated as current gaps:

### Empty directory export is no longer a confirmed gap

The old doc called this out as a live limitation. That is now stale.

- `src/sandbox/vfs-bridge.ts` explicitly creates directories during export and
  import
- `test/sandbox.test.ts` covers recursive directory export/import behavior

The bridge is still incomplete because of symlink handling, but empty-directory
lossiness is no longer the strongest current gap.

### Linux Docker + `runsc-cfc` viability is no longer a gap

This path is now the preferred Linux runtime and has integration coverage.

- `src/sandbox/executor.ts`
- `README.md`
- `integration/docker-cfc.test.ts`

### `/fabric` availability is no longer a gap

The real remaining issue is architectural shape and semantics, not whether the
mount point can exist.

- `integration/docker-cfc.test.ts`
- `integration/cfc-sandbox.test.ts`

### Old lisafs/fabricd file references are stale

Older versions of this doc pointed at deleted lisafs-specific files such as
`pkg/cfc/fabric/lisafs.go` and `pkg/cfc/fabric/fs.go`. Those references are no
longer accurate for this branch.

Use the current host-bridge documentation instead:

- `../gvisor/pkg/cfc/fabric/README.md`
- `../gvisor/pkg/cfc/fabric/doc.go`

## Current practical stance

For now, Brighid should keep using the validated real-runtime paths where they
exist:

- Linux: Docker + `runsc-cfc` first, then `runsc-direct` fallback
- macOS: prefer `cfc-sandbox`; explicit `docker-cfc` is supported, and auto
  mode may fall back to `docker-cfc` when the wrapper is unavailable and Docker
  exposes the configured runtime alias

That macOS Docker path should still be treated as a Linux-daemon-backed
compatibility path rather than a new native Apple runtime. `/fabric` also
remains conservative there: the reliable contract is still an explicit
host-backed path when one is needed.

Operator note: the gVisor repo now owns the primary build/install/validate flow
for the Docker Desktop proof-of-concept (build `runsc`, configure Docker
Desktop, validate with `docker run`). Brighid documents how to consume that
runtime and how its own simulated built-ins differ from explicit real bash.

And it should continue to keep these responsibilities outside the sandbox:

- command selection and policy decisions
- output filtering / supervisor visibility control
- VFS export/import and label bookkeeping
- host-backed `/fabric` setup

The next iteration should focus on runtime fidelity improvements, especially:

- better guest-root projection
- clearer interactive shell semantics
- symlink fidelity
- narrowing the gap between the wrapper contract and the deeper CFC mediation
  model
