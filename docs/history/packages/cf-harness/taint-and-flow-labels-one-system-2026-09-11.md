---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Design memo written to open the CT-2298 discussion with Wilk; the decisions it proposes land in docs/specs."
---

# The runsc-cfc sidecar taint and the runner's flow labels as one label system

A design memo for CT-2298, written to be argued with rather than executed.
It records what the two label systems are at labs `3d0cc6dc62`, what was
reproduced on a Mac running Docker Desktop with the `runsc-cfc` runtime
registered on 2026-09-11, and a proposal with the open questions numbered for
Wilk. No code in this change.

The framing is Ben's, 2026-09-11: this is not an intentional split. It is two
implementations of the same thing that never meet, and the fix is one design
decision rather than a bridge.

## 1. What is on each side today

### 1.1 The runner's flow labels

A label is `IFCLabel = { confidentiality?: CfcConfClause[]; integrity?:
CfcAtom[] }` (`packages/runner/src/cfc/label-view-core.ts:10-13`). A
confidentiality clause is a bare atom or an `{ anyOf: [...] }` disjunction
(`packages/runner/src/cfc/clause.ts:27-29`), and an atom is any JSON value —
`CfcAtom = CfcJsonValue` (`packages/api/cfc.ts:27`). The atom families are a
flat registry of URI type tags (`packages/api/cfc.ts:29-117`), of which
`Resource`, `ExternalIngest`, `TransformedBy`, `Caveat`, `PromptSlotInfluence`
and `LlmDerived` are the ones this memo touches.

The representation is deliberately permissive about shape and strict about
meaning. Two consequences decide most of what follows:

- A clause-unaware reader deep-equals a clause against ceiling atoms, finds no
  match, and treats the value as **more** restricted
  (`packages/runner/src/cfc/clause.ts:14-25`). Unrecognized is restrictive, by
  construction.
- An atom with no registered propagation class is `value-bound` — dropped on
  combination, which under-claims integrity and is the fail-safe direction
  (`packages/runner/src/cfc/atom-classes.ts:61-70`). A bare string atom such as
  `"finance"` is exactly this case.

Labels are derived at commit by the boundary pass in
`packages/runner/src/cfc/prepare.ts`, persisted as a `labelMap` of path-anchored
entries inside the document's reserved `cfc` envelope
(`packages/runner/src/cfc/types.ts:343-350`), read back through
`readStoredCfcMetadata` (`packages/runner/src/cfc/metadata.ts:104-132`), and
fitted against sink ceilings at release points. Every persisted entry carries an
`origin` naming its update discipline — `declared`, `link`, `derived`,
`structure`, `external-ingest`, `label-metadata`
(`packages/runner/src/cfc/types.ts:284-290`) — and an `observes` class naming
which read consumes it.

Two properties of the runner side are load-bearing for the proposal:

- **Evidence atoms are runtime-minted or not minted at all.**
  `gateRuntimeMintedIntegrity` strips `ExternalIngest`, `TransformedBy`,
  `LlmDerived`, `InjectionSafe`, `PolicyCertified` and the rest from any write
  not authored by a trusted builtin
  (`packages/runner/src/cfc/prepare.ts:4717-4761`). A label an untrusted party
  can name is a label an untrusted party can forge, so the trusted mark has to
  come from a builtin mint step.
- **The split-mint is the established shape for an ingest.**
  `stampExternalIngest` / `stampExternalFetchIngest` take only host-verified
  metadata, never a byte of the payload, and the stamp travels in a
  module-private `WeakMap` keyed by the transaction so pattern code reaching
  `cell.tx` cannot set one (`packages/runner/src/cfc/external-ingest.ts:62-131`).
  The mint reads that stamp and pushes one `origin: "external-ingest"` integrity
  entry anchored at the declared target
  (`packages/runner/src/cfc/prepare.ts:7661-7688`).

A fetched skill already arrives this way. `acquire_skill` writes the pinned text
into a cell and stamps the transaction with the resolved commit SHA and the
host-computed digest (`packages/cf-harness/src/tools/acquire-skill.ts:218-234`),
so the skill cell carries an `ExternalIngest` **integrity** atom. That the atom
is integrity rather than confidentiality is the whole of §3.4 below.

### 1.2 The runsc-cfc taint

The harness talks to `runsc-cfc` through two directories, both registered on the
Docker runtime and both outside the container:

- `cfcInvocationContextDir` — the harness writes one JSON file named for the
  container ID before `docker start`
  (`packages/cf-harness/src/sandbox/docker-runsc.ts:1260-1301`).
- `cfcResultDir` — `runsc` writes the result sidecar the harness reads after
  `docker wait` (`packages/cf-harness/src/sandbox/docker-runsc.ts:1134-1184`).

The asymmetry between them is recorded in the source and matters: the result
half fails closed, and the invocation half fails **open** — nothing downstream
notices that the sandbox started untainted, so the run goes on reporting the
posture it printed at startup while dropping every input label it was handed
(`packages/cf-harness/src/sandbox/docker-runsc.ts:289-309`, `1187-1199`). That is
why `#refuseUnreadCfcInvocationContext` refuses an enforcing invocation whose
labels would be written where nothing reads them
(`packages/cf-harness/src/sandbox/docker-runsc.ts:1200-1259`).

The invocation context is
`HarnessCfcInvocationContext`
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:85-100`). Its
label-bearing member is `cfcInputLabels: CfcLabelView` — the runner's own view
type — whose entries are anchored at one of six slot roots: `command`, `argv`,
`args`, `env`, `cwd`, `stdin`
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:22-32`).

The result sidecar is four scalars and a taint
(`packages/cf-harness/src/sandbox/docker-runsc.ts:61-72`):

```json
{"version":1,"containerId":"961075…","sandboxId":"961075…","waitStatus":0,"cfcTaint":{"string":"{conf: ⊤, integ: ∅}","xattrJSON":{}}}
```

(verbatim from `~/.local/share/runsc-cfc/sidecars/results/961075f1….json` on
this machine).

`cfcResultFromRunscSidecar` turns that into a `CfcSandboxResult`
(`packages/cf-harness/src/sandbox/docker-runsc.ts:702-789`):

1. `version !== 1`, a container-ID mismatch, or a missing `cfcTaint` each
   produce `denied` on stdout, stderr and exit code, with an empty label and a
   diagnostic naming the reason (lines 707-732). A read or parse failure does the
   same (lines 1155-1184).
2. The label is `runscTaintLabel`: `xattrJSON.confidentiality` and
   `xattrJSON.integrity` are copied into an `IFCLabel` if and only if they are
   arrays, with **no validation of their contents**
   (`packages/cf-harness/src/sandbox/docker-runsc.ts:682-690`).
3. `isPublicRunscTaint` decides the disposition, and it asks a **wider** question
   than the label projection: any non-empty value under any key of `xattrJSON`
   makes the taint non-public (`docker-runsc.ts:672-701`). Public gives
   `observed` on all three channels; anything else gives `opaque` on all three
   (lines 752-789).

The per-file `trusted.cfc.contentLabel` xattr `runsc` writes is read by nothing
in `packages/cf-harness/src/`.

## 2. What was reproduced on this machine, 2026-09-11

Docker Desktop, `runsc-cfc` registered, image
`us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest`.
Method throughout: `docker create --runtime=runsc-cfc`, hand-write the
invocation-context sidecar named for the container ID, `docker start`, read the
result sidecar. This is the method the 2026-09-09 probe used, so the two runs are
comparable.

### 2.1 The file label does not cross the gofer (CT-2298 §1, confirmed)

A `finance` label on the `["command"]` slot; the sandboxed work sums three rows
with `sqlite3` and writes the total to `/workspace/total.txt`, where `/workspace`
is a host bind mount. In one run:

```text
inside the sandbox : trusted.cfc.contentLabel="{\"confidentiality\":[\"finance\"]}"
container taint    : {"string":"{conf: \"finance\", integ: ∅}","xattrJSON":{"confidentiality":["finance"]}}
on the host        : com.docker.grpcfuse.ownership — and nothing else
```

The host's `xattr` lists exactly one name on the same file. The finding holds
unchanged from 2026-09-09: there is no trusted-side read of the file's label, and
the only channel out of the container the workload cannot reach is the result
sidecar.

### 2.2 The `stdin` slot's fail-closed behavior, and its explanation (CT-2298 §2)

Reproduced first, then explained.

With an identical container and command, a `finance` label on one slot at a time:

| label slot  | `echo > /tmp/plain.txt` | `cat > /tmp/fromstdin.txt`        | container taint          |
| ----------- | ----------------------- | --------------------------------- | ------------------------ |
| `command`   | OK                      | OK                                | `{conf: "finance"}`       |
| `args`      | OK                      | OK                                | `{conf: "finance"}`       |
| `stdin`     | OK                      | `cat: write error: Permission denied` | `{conf: "finance"}`   |
| none        | OK                      | OK                                | `{conf: ⊤, integ: ∅}`     |

The accumulated taint is identical in the first three rows, so the slot is not
changing what the container ends up tainted with. It is changing **when** the
taint arrives.

Three further runs settle it, all with the label on `["stdin"]`:

| case                                                           | result                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `D=$(cat); printf '%s\n' "$D" > /tmp/after.txt`                | **OK**, and `/tmp/after.txt` carries `{"confidentiality":["finance"]}`      |
| `: > /tmp/pre.txt` (unlabeled), then `cat >> /tmp/pre.txt`      | **denied** — the pre-created file has no `trusted.cfc.contentLabel`        |
| `cat > /tmp/direct.txt`                                         | **denied**                                                                |

The explanation: `command`, `args`, `env` and `cwd` labels form the container's
**initial** taint, so every file the workload creates is created at that level
and a write into it is level-matched. A `stdin` label is not initial taint — it
is a label on the stdin stream, which raises the task's taint at the moment the
task reads. The shell's `>` redirection creates the target **before** `cat` reads
stdin, so the target exists at the ambient (public) level and the subsequent
write is a write-down, which `runsc-cfc` refuses. Create the file after
absorbing stdin and it is created at the raised level and the write succeeds.

The `runsc` binary this machine runs (`~/.local/share/runsc-cfc/runsc`, built
2026-08-11) carries the two symbols that name this distinction directly:
`pkg/cfc.InvocationInitialTaint` and `pkg/cfc.InvocationStdinSourceLabel`. The
source for that build is not on this machine (see §6), so the symbol names are
corroboration of the behavior rather than a reading of the rule.

**This is not a curiosity.** `edit_file` is the one tool that already does what
AH-CFC-10 asks — it carries the label of the read into the write
(`packages/cf-harness/src/tools/edit-file.ts:783-806`), via
`cfcLabelViewForReadStdout`, which anchors the read's stdout label at exactly
`["stdin"]` (`edit-file.ts:479-485`). Its write command is `cat > "$path"` on a
file `edit_file` has already required to exist (`edit-file.ts:624-636`). So the
target is a pre-existing file and the label rides in on the stdin slot. Probed
with the shapes `edit_file` actually produces:

| invocation labels                                     | result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| `args: [influence]`, `stdin: [influence, finance]`    | seed file labeled `[influence]`; overwrite **denied** |
| `args: [influence, finance]`, `stdin: [influence, finance]` | overwrite **OK**                  |

Whenever the label of the file being edited exceeds the invocation's initial
taint — which is the ordinary case, since the initial taint is the run's
prompt-slot influence and model-context accumulation and the file's label is
whatever the file holds — `edit_file` fails closed with an EPERM that reaches the
model as an ordinary shell failure. The conformance-correct behavior is the one
that breaks.

### 2.3 An integrity atom on an invocation kills the sandbox (new, and it blocks CT-2091)

Not previously recorded. Any non-empty `integrity` array anywhere in
`cfcInputLabels` makes the container fail to start:

| `cfcInputLabels`                                                  | result                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `{"integrity": []}` on `["command"]`                               | runs                                                        |
| `{"integrity": ["x"]}` on `["command"]`                            | `cannot create sandbox: cannot read client sync file: waiting for sandbox to start: EOF` |
| `{"integrity": ["x"]}` on `["stdin"]`                              | same failure                                                |
| `{"integrity": [{type: ExternalIngest, …}]}` on `["command"]`      | same failure                                                |
| `{"confidentiality": ["finance"], "integrity": ["x"]}`             | same failure                                                |
| `{"confidentiality": ["finance"]}` (control)                       | runs                                                        |

It is not an atom-shape problem. A fully object-shaped **confidentiality** atom
round-trips whole, through the invocation context, through the per-file xattr and
back through the result sidecar:

```text
in  : {"confidentiality":[{"type":"https://commonfabric.org/cfc/atom/Resource","version":1,"class":"finance"}]}
file: trusted.cfc.contentLabel = {"confidentiality":[{"class":"finance","type":"…/Resource","version":1}]}
out : cfcTaint.xattrJSON = {"confidentiality":[{"class":"finance","type":"…/Resource","version":1}]}
```

Two things follow. First, the CT-2091 demo's central move — put a fetched
skill's `ExternalIngest` integrity on the invocation that runs its scripts —
cannot be made today, at the transport, not at the policy. Second, the reason
nothing has hit this in production is that every production producer of
`cfcInputLabels` is confidentiality-only: the prompt-slot influence atom is
minted into `confidentiality`
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:262-273`), and the
model-context producer calls `confidentialityOnlyIfcLabel` before emitting
(`packages/cf-harness/src/contracts/cfc-model-context.ts:170-192`).

There is a second, independent reason integrity cannot ride an invocation even
if the transport accepted it: `isPublicRunscTaint` treats a non-empty
`integrity` array as non-public like any other non-empty value
(`docker-runsc.ts:672-701`), so an integrity-only taint would make stdout,
stderr and the exit code `opaque`. Carrying a provenance mark is not
confidentiality and must not withhold output.

## 3. The four places they fail to meet, re-verified

### 3.1 Out of the sandbox

Confirmed at §2.1. The file label exists only inside gVisor; the host sees
`com.docker.grpcfuse.ownership` alone. Every in-container channel — an epilogue
on stdout, a manifest file — is a claim by the party the label constrains, and
since a file's label is bounded above by its container's taint such a claim can
only refine downward, which is what a forgery wants. The trustworthy channel is
the sidecar the workload cannot reach.

The consequence stands: a cell minted from sandbox output can carry at best the
**container's** accumulated taint, not the file's. That over-approximates, which
is the safe direction, and it is what the closed PR #7138 (`ingest_sandbox_file`)
minted from. Both #7138 and #7143 are closed unmerged; nothing of either is on
main (`packages/cf-harness/src/sandbox-taint.ts` and
`packages/cf-harness/src/ifc-label-shape.ts` do not exist).

### 3.2 Into the sandbox

Confirmed on main, with one correction to the issue's wording.

`cfcInputLabels` has no production producer **from a cell**. It does have three
producers, none of which reads a label off fabric data:

- prompt-slot influence, minted from the run's binding
  (`cfc-invocation-context.ts:251-273`);
- the model-context accumulation, confidentiality-only
  (`cfc-model-context.ts:170-192`);
- `edit_file`'s internal read label (`edit-file.ts:783-790`) — the AH-CFC-10
  case, and the one that fails closed per §2.2.

The missing link is unchanged: no file-writing tool takes a handle, and handle
resolution drops the label by construction — `HandleValueResolution` is
`{ value: string } | { error: string }`
(`packages/cf-harness/src/tools/handle-values.ts:34-36`), and the only two call
sites are `browser.ts:591` and the prompt loop's own resolution at
`prompt-loop.ts:3926`. A model cannot supply the field either:
`cfcInputLabels` is stripped from model-authored tool input
(`packages/cf-harness/src/prompt-loop.ts:302-314`), which is correct — a
model-supplied label is a forge oracle — and leaves the trusted producer as the
only possible one.

### 3.3 Vocabulary

Sharper than "two representations". The labs side has exactly one
representation: the harness imports `CfcLabelView` and `IFCLabel` from
`@commonfabric/runner/cfc` and puts the runner's own view on the wire
(`cfc-invocation-context.ts:5-11`). And §2.3 shows `runsc-cfc` is agnostic about
atom shape — it carries an object-shaped `Resource` atom through unchanged.

So the gap is not a transport that cannot carry runner atoms. It is that:

- **nothing constructs runner atoms on the way in.** The one probe label a human
  has ever written by hand is the bare string `"finance"`, and a bare string
  atom has no registered propagation class
  (`atom-classes.ts:61-70`) and matches no ceiling
  (`clause.ts:14-25`) — permanently restrictive, never satisfiable, never
  exchangeable.
- **nothing validates atoms on the way out.** `runscTaintLabel` copies whatever
  arrays it finds into an `IFCLabel` with no check
  (`docker-runsc.ts:682-690`). Today that label only decides an
  `observed`/`opaque` rendering; the moment it is minted onto a cell, it is
  unvalidated foreign data entering the persisted labelMap — where
  `gateRuntimeMintedIntegrity` would strip its integrity atoms unless the mint
  is builtin-authored (`prepare.ts:4717-4761`), which is precisely why the mint
  must be a split-mint.

### 3.4 Skills scripts

The skill cell already carries `ExternalIngest` integrity
(`acquire-skill.ts:218-234`; the mint at `prepare.ts:7661-7688`). Putting that on
an invocation is blocked twice over by §2.3: the transport rejects a non-empty
integrity array, and the disposition rule would render the whole result opaque if
it did not. Getting the outputs' taint back as runner labels is blocked by §3.1
for per-file precision, and needs the mint of §3.2's inverse.

## 4. Proposal

Four decisions, in the order they have to be made.

### 4.1 One representation, not a bijection

**Adopt the runner's `IFCLabel` as the taint representation on both sides.** No
mapping table, no string vocabulary, no translation layer to keep in agreement.
`runsc-cfc` already carries object atoms unchanged (§2.3), so what is needed is
not a transport change but a rule and a check:

- The invocation context's `cfcInputLabels` is a `CfcLabelView` of runner atoms —
  it already is, typed (`cfc-invocation-context.ts:99`).
- The sidecar's `cfcTaint.xattrJSON` is an `IFCLabel` of runner atoms. This is
  what it already looks like structurally; the change is that it becomes a stated
  contract rather than a coincidence.
- The harness validates on the way out, in the runner's CFC module, not in the
  harness: a single `parseIFCLabel` that the sidecar reader and any future ingest
  share, rejecting a label it cannot interpret rather than passing it through.
  The precedent is `UnknownCfcMetadataVersionError` — an envelope the build
  cannot interpret is not an unlabeled envelope
  (`packages/runner/src/cfc/metadata.ts:24-39`).
- `cfcTaint.string` stays a human-readable rendering for logs and is never
  parsed.

Ownership is the runner's CFC module, per CT-2298. The harness should hold no
label parsing of its own — that duplication is the thing this issue exists to
remove, and it is what PR #7143's `ifc-label-shape.ts` was explicitly not to
inherit.

### 4.2 What the sidecar must add, and what it costs

The result sidecar names **output paths and their labels** beside the container
taint. Shape, as a strawman to argue with:

```json
{
  "version": 2,
  "containerId": "…",
  "cfcTaint": { "string": "…", "xattrJSON": { "confidentiality": [ … ] } },
  "outputs": [
    { "path": "/workspace/total.txt", "label": { "confidentiality": [ … ] } }
  ]
}
```

Three constraints on it:

- **`version` must go to 2.** A version the harness does not interpret produces
  `denied`, not silence (`docker-runsc.ts:707-714`), so an old harness meeting a
  new sidecar fails closed. That is the correct direction and it is free.
- **`outputs` must not live under `cfcTaint.xattrJSON`.** `isPublicRunscTaint`
  scans every value under that key, so an `outputs` member nested there would
  make every run non-public and every stream opaque
  (`docker-runsc.ts:692-701`). Beside the taint, not inside it.
- **Which paths.** Naming every file the sandbox touched is unbounded. The
  honest scope is the mediated mounts (the workspace), and the question of
  whether it is every write or only paths the invocation nominated is Q3 below.

Cost in `runsc-cfc`: the labels already exist — the per-file
`trusted.cfc.contentLabel` xattr is written today (§2.1). The work is recording
which paths were written under the mediated mounts during the container's life
and emitting them with their labels at the same point the taint is emitted. It
is a sibling-runtime change, outside labs, and it is the only item here that is.

### 4.3 Which side mints, and which side produces

- **On the way out, the runner mints.** A builtin ingest tool takes a sandbox
  path, reads the bytes, and stamps the transaction with host-verified metadata
  — the container ID, the sidecar's own label for that path, the digest the host
  computed over the bytes it read — in exactly the shape
  `stampExternalFetchIngest` already has
  (`external-ingest.ts:112-131`). The label comes from the sidecar, never from a
  tool argument and never from inside the container. A path the sidecar does not
  name refuses rather than writing unlabeled. This is §4.1's parse at the only
  place where a foreign label becomes durable.

  Recommended atom: a third `ExternalIngest` variant, `kind: "sandbox"`, naming
  the container and the invocation rather than a channel or a URL. Adding a
  variant to an existing family keeps the mint gate and the propagation class
  unchanged (`atom-classes.ts:41`); adding a family means deciding both again.

- **On the way in, the harness produces from cells by handle.** A file-writing
  tool gains a handle-taking sibling field; the resolution returns the cell's
  label beside its value instead of dropping it
  (`handle-values.ts:34-36`), and the tool anchors that label on the slot the
  value occupies. Two conditions fall out of §2:

  - It must be anchored on `["args"]`/`["command"]` — initial taint — and **not**
    on `["stdin"]`, or the tool's own writes fail closed the way `edit_file`'s do
    (§2.2). The clean way to say that is a rule: *a label that must govern a file
    the invocation creates belongs in the initial taint.* `edit_file`'s current
    `["stdin"]` anchoring is then a defect to fix in the same change, not an
    unrelated bug.
  - It carries confidentiality only until §4.4 lands, because integrity kills the
    container (§2.3).

### 4.4 How a skill's integrity rides an invocation and returns

CT-2091 needs three things that do not exist:

1. `runsc-cfc` accepts a non-empty `integrity` array in `cfcInputLabels` — today
   it fails to start (§2.3). This is the first ask on the sibling runtime and
   the smallest.
2. Integrity is excluded from the public/non-public decision. `isPublicRunscTaint`
   must ask about confidentiality alone
   (`docker-runsc.ts:692-701`); a provenance mark is not a secret, and withholding
   output because a script came from a known source is backwards.
3. Integrity propagates by **meet**, not join. This is the one place where the
   runner's semantics must be taught to the sandbox rather than merely carried
   through it: confidentiality accumulates by join, integrity by the class-aware
   meet where an output carries a hereditary atom only if every input did
   (`atom-classes.ts:1-19`). A sandbox that joins integrity the way it joins
   confidentiality manufactures integrity the fabric would never mint. If that is
   too much to ask of `runsc-cfc` in this round, the fail-safe fallback is for
   the sandbox to carry integrity **verbatim and unpropagated** on the invocation
   record, and for the runner to apply the meet when it mints — integrity that
   does not propagate under-claims, which is the safe direction
   (`atom-classes.ts:15-19`).

With those, the CT-2091 chain is: `acquire_skill` writes the skill cell with
`ExternalIngest` fetch integrity → a handle-taking tool puts that integrity on
the invocation's initial taint → the scripts run → the sidecar names the outputs
and their labels → the ingest builtin mints a cell carrying the sandbox
`ExternalIngest` variant and the meet of the invocation's integrity → the pattern
that consumes it sees a runner label and the audit reads the chain end to end.

## 5. Acceptance criteria

The four properties PR #7143 established, restated as criteria on whatever
CT-2298 builds (Ben, 2026-09-11; the PR's implementation is not the design).

1. **Origin.** A result the harness synthesized because it could not read
   `runsc`'s sidecar — unsupported version, container-ID mismatch, missing or
   unreadable taint, read or parse failure — is never evidence of a public
   container. Only a result `runsc` reported is evidence. Note the shape this
   has to survive: a synthesized denial carries an empty label
   (`docker-runsc.ts:641-670`), which is byte-identical to a public container's
   label, so only a recorded origin distinguishes them.
2. **Agreement.** Stdout, stderr and the exit code, their policies and their
   labels, must agree. Disagreement is a refusal, not a default.
3. **Boundary.** Taint evidence is collected at the sandbox invocation boundary,
   not from tool outputs. A tool that fails before reaching the sandbox is not a
   lost container; a delegated child observes into its own record, not its
   parent's.
4. **Absence is unknown.** A run record that says nothing about its taint is
   `unknown`, never clean; a clean run writes `{kind: "known"}` explicitly. An
   invocation that left no readable evidence poisons the run to `unknown` for
   the rest of it, with no recovery, because nothing later can establish what it
   did.

Explicitly **not** inherited: a second label representation with its own
hardened walk. Both the sidecar and the run record are `JSON.parse` output, which
cannot hold a proxy, a getter, a cycle or a hidden key. One parse, in the
runner's CFC module (§4.1).

Two criteria this memo adds:

5. **No tool is made to fail by carrying a label correctly.** The AH-CFC-10 case
   (`docs/specs/agent-harness/02-cfc-integration.md:68-72`) must not be the case
   that EPERMs (§2.2).
6. **A label the harness cannot interpret refuses.** Unparseable is not
   unlabeled, on the same principle as
   `UnknownCfcMetadataVersionError` (`metadata.ts:24-39`).

## 6. Questions for Wilk

Each with the option recommended and why.

**Q1. One representation, or a bijection?**
*Recommend: one representation — the runner's `IFCLabel`, validated once in the
runner's CFC module.* A bijection is two things to keep in agreement across two
repositories, and it buys nothing: §2.3 shows `runsc-cfc` already carries an
object-shaped runner atom through the invocation context, the file xattr and the
result sidecar unchanged. The string form stays as a log rendering.

**Q2. Does `runsc-cfc` accept integrity on an invocation, and on what timescale?**
*Recommend: yes, and first — it is the smallest change with the largest
unblock.* Today a non-empty `integrity` array makes the sandbox fail to start
(§2.3), which blocks the CT-2091 demo at the transport. Pairs with the labs-side
fix that integrity must not make output opaque (§4.4 item 2).

**Q3. What does the sidecar name — every write under a mediated mount, or only
paths the invocation nominated?**
*Recommend: nominated paths, with every-write as a later widening.* Nomination
bounds the cost, makes the refusal case sharp (a path the sidecar does not name
cannot be ingested), and matches how an ingest tool is called. The cost is that a
workload writing somewhere unexpected produces nothing to ingest — which fails
closed.

**Q4. Does integrity propagate inside the sandbox, or ride verbatim?**
*Recommend: ride verbatim in this round; the runner applies the meet when it
mints.* Integrity propagates by class-aware meet, not join
(`atom-classes.ts:1-19`), and a sandbox that gets that wrong manufactures
integrity. Verbatim-and-unpropagated under-claims, which is fail-safe, and it
keeps the semantics in one place — the module that already owns them.

**Q5. What is a sandbox-minted cell's label — a new `ExternalIngest` variant or a
new atom family?**
*Recommend: a third variant of `ExternalIngest`, `kind: "sandbox"`.* The family
is already gated as runtime-minted (`prepare.ts:4735`), already classed
`provenance` (`atom-classes.ts:41`), and already has the split-mint plumbing
(`external-ingest.ts:62-131`). A new family means re-deciding the gate, the class
and the update discipline for no gain.

**Q6. Where does the initial-taint rule live?**
*Recommend: state it in the spec, and fix `edit_file` in the same change.* §2.2
shows the rule — a label that must govern a file the invocation creates belongs
in the initial taint, not on `["stdin"]` — is invisible from the labs side and
currently violated by the one tool that does the conformance-correct thing. It is
a property of the sandbox's semantics, so it belongs beside them, not in a
comment in `edit-file.ts`.

**Q7. Does the container taint stay a run-level poison, or become per-invocation
evidence?**
*Recommend: per-invocation evidence, joined into a run-level summary.* Criterion
4 makes one unreadable invocation poison the run to `unknown`. That is right for
the summary and wrong for the record: an audit that has to explain which
invocation went dark cannot do it from a run-level flag.

## 7. What changes in `docs/specs` once this is decided

Named, not edited, per the brief.

- **`docs/specs/agent-harness/02-cfc-integration.md` §3 (AH-CFC-6/7/8)** — the
  absence-is-unknown rule of criterion 4 is stronger than AH-CFC-6's current
  "MUST NOT be interpreted as an unlabeled successful observation", which is
  about one observation rather than about the run's record. §3 gains the
  run-level statement and the `{kind: "known"}` requirement.
- **`docs/specs/agent-harness/02-cfc-integration.md` §4 (AH-CFC-10)** — the
  initial-taint rule of Q6: an implementation that carries a read's label into a
  write must place it where the sandbox's semantics let the write succeed.
- **`docs/specs/agent-harness/02-cfc-integration.md` §7 (AH-CFC-16)** — the
  artifact boundary's retention list gains the per-invocation taint record and
  its origin (Q7).
- **`docs/specs/agent-harness/04-cfc-spec-correspondence.md`, "CFC obligations no
  `AH-CFC` clause carries"** — the sandbox-to-cell mint is currently in neither
  the `AH-CFC` clauses nor the obligations they derive from; whichever way Q5
  goes, the row is added or the absence is recorded deliberately.
- **`docs/specs/agent-harness/03-conformance.md`, "Evidence rules"** — a
  synthesized result and a reported one must be distinguishable in the evidence,
  which is criterion 1 stated where conformance is judged.
- **`docs/specs/cfc-value-level-provenance.md`** — the `ExternalIngest`
  `kind: "sandbox"` variant and what it claims, if Q5 goes that way.
- **`docs/specs/cfc-enforcement-matrix.md`** — the invocation-context transport
  fails open today (`docker-runsc.ts:289-309`); a matrix that names a dial for
  it is what makes the refusal in `#refuseUnreadCfcInvocationContext` a
  documented posture rather than a local guard.

The `runsc-cfc` side (sidecar `version: 2`, the `outputs` member, integrity on
invocations) is a sibling-runtime contract and does not live in `docs/specs`; it
needs its own written contract wherever that repository keeps one.

## 8. What is not verified here

- **Why a non-empty `integrity` array kills the sandbox.** Reproduced five ways
  (§2.3) but not explained. The `runsc` source for the build on this machine is
  not here: `/Users/ben/code/gvisor` is on branch `cfc_v2`, whose
  `runsc/config/config.go` knows only `--cfc` and `--cfc-policy` — neither
  `--cfc-result-dir` nor `--cfc-invocation-context-dir`, both of which the
  installed binary carries. Settling it needs either the branch that built
  `~/.local/share/runsc-cfc/runsc` (2026-08-11) or a run with `runsc` debug
  logging enabled; the binary's own strings include
  `invalid CFC invocation input labels: %w`, which is the likely message.
- **Whether the `outputs` sidecar member is cheap in `runsc-cfc`.** §4.2 reasons
  from the fact that the per-file labels already exist, which is a lower bound on
  the work, not an estimate of it. Wilk's call.
- **Whether the no-write-down rule has exceptions** — for example on a mediated
  bind mount versus the container's own overlay. Every probe here wrote to
  `/tmp` inside the container or to a `/workspace` bind mount, and both behaved
  the same way, but the rule was not enumerated.
- **Live `edit_file` breakage.** §2.2's last table reproduces the shape
  `edit_file` produces, with hand-written labels. It was not driven through a
  live enforcing harness run against a labeled file; the prediction is that such
  a run EPERMs, and it should be confirmed before the fix is designed around it.
