# Guarding writes through the cf-harness Fabric mount

Status: Proposed for CT-2313. The first implementation cut makes every
cf-harness `fabric-fuse` mount read-only. Writable, CFC-mediated mounts are a
follow-up after the gVisor xattr trust boundary and the runner writeback
protocol exist end to end.

## Decision

Take candidate A now: a harness session may browse `/fabric`, but cannot write
through it. Make that a forced invariant at the sandbox configuration boundary,
not only a default, and do not add an unsafe writable override. The Docker bind
mount's `readonly` option is the enforcement mechanism.
`packages/cf-harness/src/sandbox/docker-runsc.ts:229-236`

Candidate B follows later at `enforce-strict`, never `enforce-explicit`.
Strict is the only rung that requires prepare metadata for every projected
write; explicit requires it only for an already annotated target or an
annotated parent. `packages/fuse/cfc-writeback.ts:312-357`

This ordering is required by the xattr trust boundary. The FUSE daemon accepts
the compatibility spelling
`user.commonfabric.cfc.writeback.prepare` as the trusted prepare channel, and
normalizes it to `trusted.cfc.writeback.prepare`.
`packages/fuse/cfc-writeback.ts:74-94` Until runsc-cfc prevents an untrusted
sandbox process from setting that compatibility xattr, a process can forge the
operation, target, generation, and output labels that authorize its own write.
That is Wilk's finding in
[PR #7284, section 2](https://github.com/commontoolsinc/labs/pull/7284#issuecomment-5640324241),
and Ben's reply makes the xattr gate a prerequisite to the writable path.
[PR #7284 reply](https://github.com/commontoolsinc/labs/pull/7284#issuecomment-5656741600)

## Goals and non-goals

The immediate cut will:

- make every `/fabric` mount assembled or accepted by cf-harness read-only;
- keep reads, traversal, and using `/fabric` as a working directory available;
- make the capability snapshot's `host-read-only` word describe an enforced
  Docker mount property;
- fail construction if a direct API caller requests a writable `fabric-fuse`
  mount; and
- leave the workspace and ordinary explicitly writable `host-bind` mounts
  unchanged.

The immediate cut will not start a FUSE daemon, add a new experimental flag,
change the runner's enforcement ladder, trust `/fabric/.status` as admission
evidence, or implement the prepare/finalize channel. The existing CLI accepts a
host path that has already been mounted and gives it to the session; it does not
own the daemon lifecycle. `packages/cf-harness/src/cli.ts:543-554`
`packages/cf-harness/src/cli.ts:1658-1667`

## Defect as verified

### End-to-end mount trace

1. `HarnessSessionConfig.fabricMount` is an optional host path.
   `harnessSessionAdditionalMounts()` turns it into a `fabric-fuse` entry with
   no `readOnly` field, and `harnessSessionEngineOptions()` passes that list to
   the engine. `packages/cf-harness/src/session-assembly.ts:202-210`
   `packages/cf-harness/src/session-assembly.ts:222-280`
2. The public sandbox config permits an optional Boolean `readOnly` for both
   `fabric-fuse` and `host-bind` mounts.
   `packages/cf-harness/src/sandbox/types.ts:22-39`
3. `normalizeAdditionalMount()` currently defaults a `host-bind` to read-only
   with `mount.readOnly ?? true`, but defaults `fabric-fuse` to writable with
   `mount.readOnly ?? false`.
   `packages/cf-harness/src/sandbox/docker-runsc.ts:181-210`
4. `dockerMountArg()` adds `,readonly` only when the normalized value is true,
   and every sandbox command builds its Docker container from those mount
   arguments. `packages/cf-harness/src/sandbox/docker-runsc.ts:229-236`
   `packages/cf-harness/src/sandbox/docker-runsc.ts:1027-1049`
5. `/fabric` is an allowed sandbox root, so path-resolving tools accept paths
   below it even though it is not the workspace.
   `packages/cf-harness/src/sandbox/docker-runsc.ts:1001-1025`

The regression is pinned directly by the existing normalization test, which
expects omitted `readOnly` to become `false`.
`packages/cf-harness/test/docker-runsc-sandbox.test.ts:226-240` A separate test
shows that explicitly setting `readOnly: true` produces the Docker
`,readonly` mount argument. That proves the enforcement primitive is already
available; the session does not select it.
`packages/cf-harness/test/docker-runsc-sandbox.test.ts:636-696`

### How the daemon starts, and where its mode is selected

Cf-harness does not start the daemon. An operator starts it separately with
`cf fuse mount <mountpoint>` and then supplies that mountpoint to
`cf-harness --fabric-mount`. Foreground mount starts the FFI-owning child
directly; background mount starts a supervisor, which starts the child and
forwards every mount flag by argv.
`packages/fuse/README.md:228-269`
`packages/cli/lib/fuse-supervisor.ts:49-88`

The daemon mode belongs on that independent mount command as
`cf fuse mount ... --cfc-mode enforce-strict`. The CLI captures the value in
`FuseMountFlags.cfcMode`, and the shared flag encoder carries it through the
direct and supervised spawn paths.
`packages/cli/commands/fuse.ts:268-305`
`packages/cli/commands/fuse.ts:377-410`
`packages/cli/lib/fuse-mount-flags.ts:1-31`
`packages/cli/lib/fuse-mount-flags.ts:118-123`
`packages/cli/lib/fuse-mount-flags.ts:176-208`

`CF_CFC_MODE` is the fallback only when the process that starts the daemon
inherits it. The daemon parses `--cfc-mode`, passes the flag value and the
environment value to `resolveCfcMode()`, and refuses an invalid selected name.
`packages/fuse/mod.ts:390-430` `packages/fuse/mod.ts:549-568` Setting
`CF_CFC_MODE` in a cf-harness process does not reach a daemon that was started
earlier by another process.

The normal console launch does not provision a Fabric FUSE mount. Its resolved
environment contains the fabric-session runtime posture and the two runsc-cfc
sidecar directories, but neither a mountpoint nor a FUSE daemon mode; the local
development launcher starts that console after toolshed without starting FUSE.
`packages/cf-harness/console/launch.ts:85-101`
`packages/cf-harness/console/launch.ts:559-580`
`scripts/start-local-dev.sh:381-449`

### `resolveCfcMode()` and every ladder rung

The shared ladder is `disabled`, `observe`, `enforce-explicit`, then
`enforce-strict`; its default is `disabled`.
`packages/runner/src/cfc/types.ts:136-155` `resolveCfcMode()` gives a nonempty
CLI value precedence over a nonempty environment value, validates whichever
source wins against that ladder, and otherwise returns the disabled default.
An empty string is treated as absent.
`packages/fuse/cfc-writeback.ts:208-246`

| Mode | FUSE writeback behavior |
| --- | --- |
| `disabled` | Annotations are not enabled by the mode, and writeback authorization allows the operation without prepare metadata. `packages/fuse/cfc-writeback.ts:248-256` `packages/fuse/cfc-writeback.ts:359-369` |
| `observe` | Annotations are enabled. Missing or malformed prepare metadata produces diagnostics, but the operation continues. A coherent prepare may be applied to the projected annotation. `packages/fuse/cfc-writeback.ts:248-252` `packages/fuse/cfc-writeback.ts:370-382` `packages/fuse/cfc-writeback.ts:416-443` |
| `enforce-explicit` | Existing annotated targets require prepare metadata. Creates and namespace mutations require it only when the parent has a namespace or entry annotation. Unannotated targets and parents still pass. `packages/fuse/cfc-writeback.ts:312-357` `packages/fuse/cfc-writeback.ts:383-413` |
| `enforce-strict` | Every projected existing-file, metadata, create, namespace, and symlink write requires a coherent annotation and matching prepare metadata; missing, malformed, or stale state fails closed. `packages/fuse/cfc-writeback.ts:312-357` `packages/fuse/cfc-writeback.ts:388-413` `packages/fuse/cfc-writeback.ts:449-475` |

The daemon enables annotations for every rung except `disabled`, while
`isCfcEnforcing()` names only the two `enforce-*` rungs as enforcement.
`packages/fuse/cfc-writeback.ts:248-256`

### What diagnostics currently records

`HarnessFabricWriteGovernancePolicy` has five words:
`not-configured`, `host-read-only`, `host-writable-non-strict`,
`host-writable-cfc-strict-attested`, and
`host-writable-cfc-strict-unattested`.
`packages/cf-harness/src/diagnostics.ts:66-86`

The mount snapshot begins with the sandbox runtime's normalized `readOnly`
description. For a configured Fabric mount, diagnostics then runs `cat` on
`/fabric/.status`, parses `cfc.mode`, and calls
`createFabricWriteGovernance()` with two independent modes: the harness run's
enforcement mode and the daemon-reported mode.
`packages/cf-harness/src/diagnostics.ts:329-377`
`packages/cf-harness/src/diagnostics.ts:190-202`
`packages/cf-harness/src/diagnostics.ts:393-464`
`packages/cf-harness/src/diagnostics.ts:538-551`

The words do not control admission. In particular, harness
`enforce-strict` makes `delegatedToCfc: true` even if the status probe is
missing; a readable status file that says daemon `enforce-strict` changes only
the final word to `host-writable-cfc-strict-attested`.
`packages/cf-harness/src/diagnostics.ts:441-463` The test fixtures assert both
descriptions without exercising a write.
`packages/cf-harness/test/diagnostics.test.ts:299-329`

The engine persists this snapshot into run state and `capabilities.json`.
`packages/cf-harness/src/engine.ts:1842-1885`
`packages/cf-harness/src/artifacts.ts:199-205` The prompt loop copies selected
CFC capability fields into `policy-snapshot.json`, but omits mounts and their
write-governance word. `packages/cf-harness/src/prompt-loop.ts:2862-2899` The
only operational reader of the capability snapshot in the engine's tool path
uses command availability to improve missing-binary errors, not mount policy.
`packages/cf-harness/src/engine.ts:1967-1979`
`packages/cf-harness/src/diagnostics.ts:658-733` Therefore the mount policy is
an audit-facing description for humans and artifact tooling, not an
enforcement decision.

For candidate A, `host-read-only` becomes true because the same normalized
`readOnly: true` value both enters the snapshot and adds Docker's `readonly`
bind option. `packages/cf-harness/src/sandbox/docker-runsc.ts:229-236`
`packages/cf-harness/src/diagnostics.ts:424-439` For candidate B, a strict word
becomes true only when a trusted host admission gate verifies the daemon mode,
the gVisor sentry alone can prepare writes, and the runner commits the prepared
labels. Reading a JSON status file after admission is not that gate.

## Every write-capable harness surface

Four builtin execution paths can write through `/fabric` today:

1. `bash` runs an arbitrary shell command in any allowed root. Its curl policy
   narrows one network command but does not restrict filesystem writes.
   `packages/cf-harness/src/tools/bash.ts:65-80`
   `packages/cf-harness/src/tools/bash.ts:97-169`
2. `write_file` resolves its destination through the common allowed-root
   resolver, optionally creates parent directories, and uses `cat >` or
   `cat >>`. `packages/cf-harness/src/tools/write-file.ts:46-75`
   `packages/cf-harness/src/tools/write-file.ts:78-153`
3. `edit_file` resolves the same way, reads the old file, and writes the edited
   content back with `cat >`. `packages/cf-harness/src/tools/edit-file.ts:638-708`
   `packages/cf-harness/src/tools/edit-file.ts:724-806`
4. A sandbox-target `run_skill_script` executes an allowlisted script inside
   the shared sandbox. Its `cwd` uses the common resolver and the script itself
   is ordinary executable code, so it can address `/fabric` absolutely.
   `packages/cf-harness/src/tools/run-skill-script.ts:82-114`
   `packages/cf-harness/src/tools/run-skill-script.ts:1118-1123`
   `packages/cf-harness/src/tools/run-skill-script.ts:1181-1207`

`read_file` is the only other builtin tool that invokes the sandbox, and its
command is read-only. The registry shows the complete builtin surface, while
the sandbox-call sites are confined to `bash`, `read_file`, `edit_file`,
`write_file`, and `run_skill_script`.
`packages/cf-harness/src/tools/registry.ts:27-49`
`packages/cf-harness/src/tools/read-file.ts:94-135`

`delegate_task` is a transitive fifth surface: a sandboxed child reuses the
parent's `SandboxRuntime`, and the default child profile includes `bash`,
`edit_file`, and `write_file`; the browser child can run a skill script.
`packages/cf-harness/src/prompt-loop.ts:4549-4555`
`packages/cf-harness/src/contracts/subagent.ts:59-80`

Under candidate A, reads and `cwd=/fabric/...` continue, while write attempts
from all five surfaces fail with the mount's read-only filesystem error. Under
candidate B at strict mode, the same writes fail with `EACCES` until a trusted
component supplies valid prepare metadata. Even after that protocol exists,
arbitrary symlink targets and callable-send writeback remain unsupported in
enforcing modes. `packages/fuse/README.md:359-381`

The remaining builtin tools do not execute sandbox filesystem commands; the
complete registry and the sandbox call sites bound that claim.
`packages/cf-harness/src/tools/registry.ts:27-49` The demos' `run_pattern`
writes use the independently configured, host-owned Fabric session rather than
the FUSE path. `packages/cf-harness/src/cli.ts:545-554`
`packages/cf-harness/src/tools/run-pattern.ts:1366-1380`

## Candidate A: force `/fabric` read-only

### Behavior

The configuration boundary will reject a `fabric-fuse` entry whose
`readOnly` value is explicitly false, normalize omitted or true to true, and
always emit `,readonly` to Docker. The session assembler will state
`readOnly: true` explicitly so the product policy is visible at the point that
creates the mount as well as enforced at the lower boundary.

There will be no CLI flag or environment escape hatch for writable mode. A
future writable variant must carry trusted daemon admission evidence in its
type; it must not reopen the Boolean.

### Compatibility and demos

The affected behavior is intentional:

- `bash`, `write_file`, `edit_file`, sandbox skill scripts, and delegated
  children can still browse `/fabric`, but any create, replace, append,
  truncate, rename, unlink, mkdir, rmdir, symlink, metadata mutation, or handler
  send through that mount fails. The current FUSE writeback scaffold covers
  that operation set except arbitrary symlinks and callable sends.
  `packages/fuse/cfc-writeback.ts:60-71` `packages/fuse/README.md:359-381`
- Workspace writes remain available because the workspace mount is constructed
  separately with `readOnly: false`; named host binds retain their explicit
  mode and default to read-only.
  `packages/cf-harness/src/sandbox/docker-runsc.ts:934-974`
- CT-2189 does not need a FUSE write path. Its documented harness flow attaches
  the transaction cell by `inputCells`/`--input-cell`, creates the dashboard
  through the Fabric session, and reads the labels from the store.
  `packages/cf-harness/ONBOARDING.md:532-565`
  `packages/cf-harness/ONBOARDING.md:596-625`
- CT-2091 also does not pass `--fabric-mount`. Its demo stages skill files in
  the workspace, supplies a Fabric API session plus an input-cell handle, and
  delegates pattern creation through `run_pattern`.
  `packages/cf-harness/scripts/hostile-skill-demo.sh:52-71`
  `packages/cf-harness/scripts/hostile-skill-demo.sh:76-107`
  `packages/cf-harness/scripts/hostile-skill-demo.sh:118-141`
  Making `/fabric` read-only therefore preserves the demo and strengthens its
  required receipt that a sandboxed hostile skill cannot dereference or alter
  Fabric values through a filesystem side door.

Candidate A is the only sound cut available before the xattr gate. It neither
accepts a forgeable prepare record nor depends on the daemon's current disabled
default; Docker rejects the write before the FUSE writeback authorization path
is reached.

## Candidate B: harness-controlled, strict CFC writeback

### Required mode

Use `enforce-strict`. `enforce-explicit` preserves compatibility for
unannotated files and parents, but that compatibility is exactly the bypass the
fix must close. `packages/fuse/cfc-writeback.ts:312-357` The runner's named
`max-enforcement` posture does not change this answer: that bundle deliberately
leaves `cfcEnforcementMode` at the first-party `enforce-explicit` pin, with
strict reserved for a host raise.
`packages/runner/src/runtime-presets.ts:631-661`
`packages/runner/src/runtime-presets.ts:681-697`

The harness enforcement mode, the Fabric session runtime mode, and the FUSE
daemon mode are three separately resolved settings today. The CLI help already
states that `--fabric-cfc-enforcement-mode` is distinct from the harness mode,
and neither field is threaded to the FUSE launcher.
`packages/cf-harness/src/cli.ts:538-554`

### Wilk's compatibility-spelling forgery

When the temporary writeback xattr path is enabled, the FUSE `setxattr`
callback accepts both trusted and compatibility spellings and stores a parsed
prepare record. `packages/fuse/mod.ts:2555-2595` A prepare record contains the
operation, projection references and names, expected generation, and every
class of output label. `packages/fuse/cfc-writeback.ts:97-125` The authorization
checks compare those attacker-supplied fields to the current visible projection
and generation, but the labels themselves come from the prepare record and are
applied to the optimistic projection.
`packages/fuse/cfc-writeback.ts:668-766`
`packages/fuse/cfc-writeback.ts:1566-1703`

Therefore a sandbox process that can set
`user.commonfabric.cfc.writeback.prepare` can read the current projection
xattrs, construct a matching prepare, choose labels favorable to itself, and
race or replace the legitimate preparation. Strict mode then proves only that
*a syntactically coherent prepare* existed, not that the trusted sentry minted
it. Enabling `--cfc-writeback-xattrs` makes option B functional but unsound;
leaving that flag off makes strict mode fail closed but makes every projected
write unusable. The gVisor change must prevent sandbox-originated writes to
both the compatibility content-label spelling and the compatibility prepare
spelling while still permitting the sentry-owned transport.

### Runner-side prepare/finalize contract

The trusted side must satisfy all of the following before candidate B can
replace candidate A:

1. Read the exact projected target or parent reference and generation, compute
   the post-write content, namespace, entry, symlink, and metadata labels from
   the sandbox invocation/result label, and write a version-1 prepare record
   immediately before the matching syscall. The daemon validates operation,
   name, reference, projection kind, and generation.
   `packages/fuse/cfc-writeback.ts:107-125`
   `packages/fuse/cfc-writeback.ts:668-875`
2. Make the prepare channel sentry-only. The current temporary flag explicitly
   exposes an integration-testing channel and the package documentation says it
   is not a sandbox trust boundary.
   `packages/cli/commands/fuse.ts:299-305`
   `packages/fuse/README.md:359-375`
3. Carry the prepared label into the durable Common Fabric transaction and run
   the runner's write-down and integrity checks before commit. The current
   `CellBridge.writeValue()` accepts only a path and an unlabeled value, then
   calls `Cell.set()`; it has no parameter for the prepare label or the sandbox
   sidecar label. `packages/fuse/cell-bridge.ts:1947-1956`
4. Return only after the value and label commit is durable, then rebuild the
   projection from the committed cell's exact label view. The current finalize
   path rereads the cell and rebuilds its annotation, while the writeback store
   records mutation-applied, commit-failed, ready-for-exact-recomputation, and
   finalized-pending-cleanup phases.
   `packages/fuse/cell-bridge.ts:1734-1758`
   `packages/fuse/cell-bridge.ts:2221-2267`
   `packages/fuse/cfc-writeback.ts:1002-1062`
5. Preserve crash recovery and stale-generation behavior. Prepare records are
   persisted outside the mount, and successful exact recomputation removes the
   pending record; a failed runner commit remains a fail-closed recovery record.
   `packages/fuse/cfc-writeback.ts:894-999`
   `packages/fuse/cfc-writeback.ts:1064-1123`
   `packages/fuse/cfc-writeback.ts:1250-1263`

The present daemon already performs an optimistic local mutation, commits
through the bridge, calls exact recomputation, and cleans up the prepare record
on success. `packages/fuse/mod.ts:2682-2760` What is missing is a trusted
producer for the prepare and a runner write API that consumes its label; the
optimistic `incomplete` annotation is not a durable runner label.
`packages/fuse/cfc-writeback.ts:1566-1590`

### Compatibility when B eventually lands

All five write-capable harness surfaces require sentry preparation for every
write under strict mode. Plain shell programs need no source change if runsc-cfc
interposes every supported syscall and supplies the protocol. Operations that
the scaffold excludes remain denied: arbitrary symlinks, callable sends, and
operations outside the enumerated writeback vocabulary.
`packages/fuse/cfc-writeback.ts:55-71` `packages/fuse/README.md:359-381`

The two demos still need no writable mount. Candidate B is valuable for future
workflows that intentionally edit Fabric cells or pattern source through the
filesystem; it is not a prerequisite for CT-2189 or CT-2091.

## Implementation plan for candidate A

### Stage 1: make read-only an invariant

- [ ] In `packages/cf-harness/src/session-assembly.ts`, change
  `harnessSessionAdditionalMounts()` so its `fabric-fuse` entry states
  `readOnly: true`. This is the session-level policy at the only assembly seam
  that turns `HarnessSessionConfig.fabricMount` into a sandbox mount; the
  existing seam is at `packages/cf-harness/src/session-assembly.ts:202-210`.
- [ ] In `packages/cf-harness/src/sandbox/docker-runsc.ts`, change
  `normalizeAdditionalMount()` so an omitted Fabric value normalizes to true
  and an explicit false throws a configuration error stating that writable
  Fabric mounts require trusted CFC writeback. Keep the host-bind branch
  unchanged. The current divergent defaults are at
  `packages/cf-harness/src/sandbox/docker-runsc.ts:181-210`.
- [ ] In `packages/cf-harness/src/sandbox/types.ts`, narrow
  `DockerRunscFabricAdditionalMountConfig.readOnly` to `true | undefined` so a
  typed caller cannot request the rejected state. Keep
  `DockerRunscHostBindAdditionalMountConfig.readOnly` Boolean because named
  host mounts intentionally support both modes.
  `packages/cf-harness/src/sandbox/types.ts:22-39`
- [ ] In `packages/cf-harness/src/cli.ts`, describe `--fabric-mount` as a
  read-only mount and make `appendHostMountInstructions()` say the mounted
  space is read-only and available for browsing. Do not add a writable flag.
  `packages/cf-harness/src/cli.ts:543-554`
  `packages/cf-harness/src/cli.ts:2083-2103`

Completion gate: a CLI-created engine, a direct session assembly, and a direct
sandbox configuration all describe the Fabric mount as read-only, and a
runtime `readOnly: false` request is rejected before Docker starts.

### Stage 2: make the artifacts and documentation say exactly that

- [ ] In `packages/cf-harness/test/diagnostics.test.ts`, add a read-only Fabric
  fixture and assert `policy: "host-read-only"`, `delegatedToCfc: false`, and
  the daemon status only as an optional reported mode. Keep the writable strict
  cases as documentation of the future admission state, but rename their test
  descriptions so they do not imply enforcement. The current assertions are at
  `packages/cf-harness/test/diagnostics.test.ts:203-229` and
  `packages/cf-harness/test/diagnostics.test.ts:299-329`.
- [ ] Do not change `packages/cf-harness/src/diagnostics.ts` in candidate A.
  Its existing `readOnly` branch already emits the truthful word. Candidate B
  must replace the status-file-derived strict wording with the result of its
  trusted admission gate rather than add another inference here.
  `packages/cf-harness/src/diagnostics.ts:424-464`
- [ ] In `docs/development/EXPERIMENTAL_OPTIONS.md`, state that
  `CF_CFC_MODE` independently selects cf-harness and FUSE modes only in the
  process that reads it; it does not make an externally supplied mount writable
  or couple the two processes. State that `cfcPosture: "max-enforcement"`
  governs the Fabric session runtime, not the `/fabric` bind mount. The current
  descriptions are at `docs/development/EXPERIMENTAL_OPTIONS.md:650-706`,
  `docs/development/EXPERIMENTAL_OPTIONS.md:753-775`, and
  `docs/development/EXPERIMENTAL_OPTIONS.md:1908-1916`.
- [ ] In `packages/cf-harness/docs/system-map/cfc-system-map.html`, update the
  filesystem boundary and threat text to distinguish writable workspace files
  from the read-only Fabric projection, then advance the snapshot metadata and
  visually verify the affected panels. The map currently summarizes all file
  sinks as unlabeled at
  `packages/cf-harness/docs/system-map/cfc-system-map.html:2372`, and its update
  procedure is defined in
  `packages/cf-harness/docs/system-map/README.md:61-90`.

Completion gate: a run with a configured mount persists
`writeGovernance.policy = "host-read-only"` in `capabilities.json`, and no live
documentation implies that the runner posture or the daemon's status word
authorizes a writable mount.

### Stage 3: tests that can fail

Existing tests to change:

- [ ] `packages/cf-harness/test/docker-runsc-sandbox.test.ts`: change the
  normalization expectation from `readOnly: false` to true; change the Docker
  argv test to omit the explicit true so it proves the default itself emits
  `,readonly`; add an explicit-false rejection case. Mutations that make these
  fail: restore `?? false`, remove `,readonly`, or accept false.
  `packages/cf-harness/test/docker-runsc-sandbox.test.ts:226-260`
  `packages/cf-harness/test/docker-runsc-sandbox.test.ts:636-696`
- [ ] `packages/cf-harness/test/cli.test.ts`: extend the existing end-to-end
  CLI threading test to assert `mounts[1].readOnly === true` and update the
  prompt assertion to require the word `read-only`. Mutations that make it
  fail: omit the assembly field, change the lower default, or regress the
  operator guidance. `packages/cf-harness/test/cli.test.ts:5233-5253`
  `packages/cf-harness/test/cli.test.ts:5273-5340`
- [ ] `packages/cf-harness/test/session-assembly.test.ts`: add a focused case
  for `harnessSessionAdditionalMounts()` with `fabricMount`, asserting the exact
  read-only entry. Mutation that makes it fail: remove the session-level
  `readOnly: true`. The existing mount assertion covers only a host bind.
  `packages/cf-harness/test/session-assembly.test.ts:215-234`
- [ ] `packages/cf-harness/test/diagnostics.test.ts`: add the read-only policy
  assertion described in Stage 2. Mutation that makes it fail: report a
  writable policy for a read-only mount or delegate it to CFC.

New live test:

- [ ] Add
  `packages/cf-harness/test/docker-runsc-fabric-mount-live.test.ts`, guarded by
  an explicit `CF_HARNESS_RUNSC_CFC_LIVE=1` opt-in. It creates separate
  temporary workspace and Fabric directories, constructs the real
  `DockerRunscSandboxRuntime` with a `fabric-fuse` mount and omitted
  `readOnly`, then runs `/bin/sh -c 'printf changed > /fabric/probe'` in the
  configured sandbox image. It asserts a nonzero command status and that the
  host Fabric directory contains no `probe`. Mutation that makes it fail:
  restoring the writable default or removing Docker's `readonly` makes the
  command succeed and creates the sentinel. The runtime entry point exercised
  is `packages/cf-harness/src/sandbox/docker-runsc.ts:1027-1049`.

The live test is opt-in because it requires Docker, the registered runsc-cfc
runtime, and the sandbox image. Run it unsandboxed on the same machine used for
the demo before push; a passing unit test over argv is necessary but not a
substitute for this syscall-level refusal.

### Stage 4: candidate-B follow-up boundary

Do not reopen the mount in this change. File a follow-up that starts only after
Wilk's sentry xattr gate and CT-2314's sidecar validator land. That follow-up
must name:

- the host-owned daemon lifecycle or authenticated external-daemon admission
  record;
- `enforce-strict` as the daemon mode;
- the sentry-only prepare transport;
- the runner API that commits the prepared label and returns the committed
  generation;
- exact recomputation and recovery tests for every supported operation; and
- the point where a successful trusted admission changes the mount from
  read-only to writable.

`packages/fuse/cfc-writeback.ts`, `packages/fuse/mod.ts`, and
`packages/fuse/cell-bridge.ts` are researched dependencies, not files in the
candidate-A changeset. Candidate B will require changes there or in a lower
runner API; candidate A must not alter them.

## File inventory for the immediate cut

| File | Planned change |
| --- | --- |
| `packages/cf-harness/src/session-assembly.ts` | State the read-only Fabric mount in `harnessSessionAdditionalMounts()`. |
| `packages/cf-harness/src/sandbox/docker-runsc.ts` | Normalize Fabric mounts to read-only and reject explicit false. |
| `packages/cf-harness/src/sandbox/types.ts` | Remove writable Fabric mount from the typed configuration state space. |
| `packages/cf-harness/src/cli.ts` | Describe the mount as read-only in help and operator instructions. |
| `packages/cf-harness/test/docker-runsc-sandbox.test.ts` | Pin normalization, rejection, and Docker argv. |
| `packages/cf-harness/test/cli.test.ts` | Pin CLI-to-engine read-only threading and prompt text. |
| `packages/cf-harness/test/session-assembly.test.ts` | Pin the assembly-level policy. |
| `packages/cf-harness/test/diagnostics.test.ts` | Pin the truthful `host-read-only` artifact. |
| `packages/cf-harness/test/docker-runsc-fabric-mount-live.test.ts` | Prove a real sandbox write fails and changes no host file. |
| `docs/development/EXPERIMENTAL_OPTIONS.md` | Separate the three CFC settings and record that no posture enables mount writes. |
| `packages/cf-harness/docs/system-map/cfc-system-map.html` | Update the filesystem boundary and snapshot. |

No `packages/fuse` or `packages/runner` file belongs in the immediate cut.

## Blast radius

- **Batch cf-harness:** only sessions that pass `--fabric-mount` change. The
  flag is optional, and omission leaves no Fabric mount.
  `packages/cf-harness/src/cli.ts:1658-1667`
- **Console and local development:** unchanged because the standard launcher
  does not supply a FUSE mount. Its Fabric access remains the host-owned session
  runtime. `packages/cf-harness/console/launch.ts:559-580`
  `scripts/start-local-dev.sh:413-449`
- **Subagents:** sandboxed children share the parent runtime, so they inherit
  the same read-only projection. Host-tool children remain workspace-only.
  `packages/cf-harness/src/prompt-loop.ts:4549-4555`
  `packages/cf-harness/src/prompt-loop.ts:4576-4585`
- **Existing tools:** the four direct write-capable tools and delegated children
  lose only `/fabric` writes. Workspace and explicitly writable named host
  mounts keep their current behavior.
  `packages/cf-harness/src/sandbox/docker-runsc.ts:934-974`
- **CT-2189:** no required step changes; the demo uses connector/input handles,
  `run_pattern`, and store label reads, not FUSE writes.
  `packages/cf-harness/ONBOARDING.md:532-565`
  `packages/cf-harness/ONBOARDING.md:596-625`
- **CT-2091:** no required step changes; the executable demo has no
  `--fabric-mount` argument and writes its staging files under the workspace.
  `packages/cf-harness/scripts/hostile-skill-demo.sh:52-71`
  `packages/cf-harness/scripts/hostile-skill-demo.sh:118-141`
- **Experimental flags and presets:** no new flag and no change to
  `MAX_ENFORCEMENT_CFC_OPTIONS`. The eventual documentation cut must clarify
  the scope of `CF_CFC_MODE`, `--fabric-cfc-*`, and
  `cfcPosture: "max-enforcement"`; the posture explicitly excludes the master
  enforcement mode. `packages/runner/src/runtime-presets.ts:631-661`
  `docs/development/EXPERIMENTAL_OPTIONS.md:675-706`

## Gates before push

Run the following for the implementation cut:

1. `deno fmt --check`
2. `deno lint`
3. `deno task check`
4. `deno task --cwd packages/cf-harness test`
5. `CF_HARNESS_RUNSC_CFC_LIVE=1 deno test -A
   packages/cf-harness/test/docker-runsc-fabric-mount-live.test.ts` outside the
   agent sandbox
6. `deno task check-no-waitfor`
7. `deno task check-docs`
8. `deno task check-docs-history-index`
9. `deno task check-conflict-markers`
10. `deno task check-control-characters`
11. `deno task check-skill-facts`
12. `deno task check-verb-session-sync`
13. `deno task check-single-copy-deps`
14. `deno task check-unused-deps`
15. `deno task check-deno-pins`
16. `deno task check-package-cycles`
17. `deno task check-completion-slots`
18. `deno task check-command-docs`
19. `deno task check-local-program`
20. `deno task check-baselines-append-only`
21. `deno task check-test-aliases`
22. `deno task check-pattern-tiers`

`deno task cfcheck` is not required unless the implementation unexpectedly
touches a pattern. Browser integration is not required by this cut. The live
Docker test is the proportional integration gate for the changed boundary.

## Surprises and open questions

- **[for Wilk] Which exact runsc-cfc release gates both compatibility xattrs?**
  One position is that blocking sandbox writes to
  `user.commonfabric.cfc.writeback.prepare` and the compatibility content-label
  xattr is sufficient. The other is that the sentry also needs a new protected
  transport, because merely blocking the sandbox may leave no legitimate way
  to prepare the FUSE syscall. Candidate B waits for Wilk to name and test that
  boundary.
  [Wilk's section 2](https://github.com/commontoolsinc/labs/pull/7284#issuecomment-5640324241)
- **[for Berni] What runner API owns a sandbox-originated prepared label?** One
  position is to extend the FUSE bridge's write methods with a trusted label and
  generation that the runner commits atomically. The other is to make the
  sentry's sidecar result a runner-owned transaction input and keep FUSE as a
  projection-only client. The current `CellBridge.writeValue()` carries no
  label, so choosing the owner is design work, not a local bug fix.
  `packages/fuse/cell-bridge.ts:1947-1956`
- **[for Berni] Is strict mode the permanent writable-mount posture?** One
  position is yes: only strict closes unannotated targets and parents. The other
  is to use explicit for compatibility and separately prove that every exposed
  projection is annotated. The latter adds an annotation-completeness invariant
  that does not exist today; this plan recommends strict.
  `packages/fuse/cfc-writeback.ts:312-357`
- **[for Ben] Should direct API callers retain an explicit unsafe writable
  escape?** One position is to preserve `readOnly: false` for trusted local
  experiments and change only the default. The other is to reject it until the
  trusted writeback path exists. This plan recommends rejection because an
  unadvertised programmatic escape leaves a harness session with the original
  bypass. `packages/cf-harness/src/sandbox/types.ts:22-39`
- **[for Ben] Should the current `host-writable-cfc-strict-attested` diagnostic
  word be renamed before candidate B?** One position is to keep it because it
  accurately reports agreement between harness mode and `/fabric/.status`.
  The other is to rename it to `reported` now because no admission gate or
  trusted writeback channel stands behind it. Candidate A makes the normal word
  `host-read-only`; this plan leaves the rename for the candidate-B design but
  requires its tests to stop calling the current word enforcement.
  `packages/cf-harness/src/diagnostics.ts:441-463`

## Ordering with CT-2314 and CT-2315

1. Land candidate A from CT-2313 first or independently. It has no dependency
   on either sibling and closes the direct filesystem bypass immediately.
2. Land CT-2314's `isPublicRunscTaint` correction and runner-owned sidecar label
   validator. CT-2314 exclusively owns that validator; CT-2313 must consume it
   in candidate B rather than define another.
3. Land CT-2315 after CT-2314 so its FUSE label-type collapse consumes the one
   validator. CT-2313 must not duplicate either change.
4. Land Wilk's runsc-cfc compatibility-xattr gate and verify the sentry-only
   prepare transport.
5. Plan and implement candidate B after steps 2-4. It consumes CT-2314's
   validated sidecar label, uses CT-2315's collapsed FUSE label vocabulary, and
   replaces the read-only admission only when strict daemon mode and the runner
   commit protocol are both attested.

Candidate A remains a safe fallback after candidate B: absent or failed
attestation selects read-only rather than a weaker writable mode.
