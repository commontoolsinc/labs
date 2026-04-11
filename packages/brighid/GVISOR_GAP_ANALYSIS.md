# gVisor integration gaps for Brighid

This package now has two real-runtime paths for `bash`: the macOS
`../gvisor/tools/cfc-sandbox` wrapper and a Linux Docker + `runsc-cfc` path.
Those paths are good enough for practical agent execution today, but the current
fork and wrappers still leave important gaps relative to the POSIX/CFC
agent-tooling design in `../specs/cfc/14-open-problems-and-proposals.md` §14.2.

## Gaps observed during integration

### 1. Root filesystem mirroring is incomplete

The `cfc-sandbox` CLI only accepts directory mounts and rejects `/` as a guest
mount target. That means Brighid cannot present its whole VFS as the guest root
in one step; it has to mirror top-level directories individually and keep a
fallback workspace mount.

Impact:

- absolute paths that live in top-level mounted directories work best
- root-level files need fallback path translation
- this diverges from the spec's ideal of a fully mediated filesystem view

Evidence:

- `../gvisor/tools/cfc-sandbox/Sources/CFCSandbox/RunCommand.swift`
- `../gvisor/tools/cfc-sandbox/README.md`

### 2. Empty directory export is lossy today

`packages/brighid/src/vfs-bridge.ts` only materializes directories that are
reached while exporting files. Empty directories therefore do not automatically
appear in the sandbox.

Impact:

- some POSIX workflows that depend on empty directory presence will differ
- top-level mirror mounts are incomplete unless those directories contain files

This is currently a Brighid bridge limitation, not a gVisor kernel issue.

### 3. Interactive TTY support is still constrained

The workstation wrapper explicitly disables Apple terminal mode when runsc is
active, even for `/bin/bash`, and the Linux Docker path is currently tuned for
batch-style command execution rather than a fully interactive terminal.

Impact:

- interactive shell UX is weaker than the non-runsc path
- Brighid should currently treat the gVisor backend as batch-oriented first

Evidence:

- `../gvisor/tools/cfc-sandbox/Sources/CFCSandbox/ContainerRunner.swift`

### 4. `/fabric` is currently best treated as a host-backed fallback mount

For Brighid right now, the most practical route is to bind-mount the labs FUSE
filesystem into `/fabric` instead of relying on the fork's lisafs/fabricd path.

Impact:

- this gives the agent the expected `/fabric` mount point today
- it bypasses some of the special lisafs/runtime behavior, so it is a pragmatic
  compatibility bridge rather than the final architecture

Evidence:

- `../gvisor/tools/cfc-sandbox/repro-labs-fuse-bind.sh`
- `src/sandbox/executor.ts`

### 5. `/fabric` is intentionally not full POSIX

The local fork's `/fabric` bridge is a restricted lisafs surface rather than a
general POSIX filesystem.

Impact:

- it is appropriate for labeled workspace/piece operations
- it is not yet a drop-in replacement for arbitrary shell-heavy filesystem use

Evidence:

- `../gvisor/pkg/cfc/fabric/README.md`
- `../gvisor/pkg/cfc/fabric/lisafs.go`
- `../gvisor/pkg/cfc/fabric/fs.go`

### 6. The spec wants more syscall-level coverage than the current wrapper exposes

The spec calls out mediation around `openat`, `read`, `write`, `getdents64`,
`renameat`, `linkat`, `unlinkat`, `execve`, and `mmap`, plus distinct content
labels vs directory-entry name labels.

The fork already has meaningful CFC hooks, but the wrapper layer used by Brighid
still exposes only a coarse command + mount contract.

Impact:

- Brighid can launch real bash inside the sandbox now
- deeper label fidelity still depends on expanding the fork's exposed runtime
  contract, not just the CLI wrapper

Evidence:

- `../specs/cfc/14-open-problems-and-proposals.md` §14.2.2.5-14.2.2.10
- `../gvisor/docs/cfc-gap-analysis.md`

## Current practical stance

For now, Brighid should use the gVisor path for real shell execution where
available, preferring Docker + `runsc-cfc` on Linux and the macOS wrapper on
Apple hosts, while keeping the trusted supervisor responsibilities outside the
sandbox:

- command selection and policy decisions
- output filtering / supervisor observation gating
- VFS export/import and label bookkeeping

The next iteration should reduce the amount of path translation and host-side
mirroring by aligning more directly with the fork's mediated filesystem model.
