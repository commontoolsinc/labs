---
status: historical
created: 2026-09-03
archived: 2026-09-03
reason: "Obligation-by-obligation gap analysis of cf-harness against the CFC specification's implementation profiles (CT-2178), pinned to one commit so a later run can be diffed against it."
---

# cf-harness against `CfcAgentHarnessProfile`: the gap, obligation by obligation

**The position, stated first. `@commonfabric/cf-harness` does not satisfy
`CfcAgentHarnessProfile` and does not claim it.** Of §18.3.3's nine
obligations, three have no implementation behind them (H4 registry snapshots,
H5 descriptor observation labels, H8 subagent confidentiality ceiling), four are
partly met (H2, H6, H7, H9), one is satisfied as prose only (H1), and one is
mechanized (H3). The widest gap is H9: every side-effecting tool except
`run_pattern` is admitted by a check on a static effect class crossed with a
run-level direct-command binding, which is a gate on who asked where the clause
asks for a gate on what is flowing.

**The other two profiles are mostly or entirely not this component's.** Of
§18.2.7's nineteen obligations, fifteen belong to the `runsc-cfc` runtime, the
Common Fabric FUSE daemon, and the runner's label store; cf-harness owns four
and answers them below. All seven of §18.4.4's are the shell renderer's:
**cf-harness has no user-visible render surface and is not a
`CfcTrustedRenderProfile` candidate at all**, so its absence from that profile
is a fact about what the component is rather than a gap in it.

This is the snapshot. It states, for every documentation obligation the CFC
specification's harness profile imposes, what `@commonfabric/cf-harness`
actually does, grounded in code read at the pinned commit rather than in what
any document asserts. A later run of the same exercise is meant to be diffed
against this one.

The point of the exercise is the gap, not a clean bill. Where an obligation is
unmet, partly met, or met differently than the specification describes, the row
says so. Where nothing read establishes the answer, the row says `unknown` and
names what would settle it.

## What was read, and at what revision

- **The authority.** The CFC specification, `commontoolsinc/specs`, at
  `8b8613ea` ("fix(fabric-bootstrap): add permission + sandbox flags to
  `claude -p` calls"). Chapters read in full: `cfc/18-runtime-implementation-profiles.md`
  §§18.1-18.4.4, `cfc/10-safety-invariants.md`, `cfc/09-threat-model.md`,
  `cfc/08-16-agent-tooling-sandbox.md`, `cfc/08-13-opaque-inputs.md`.
- **The implementation.** Labs at `889e34c55a`
  ("refactor(data-model): rename `data-uri-codec.ts` to `codec-data-uri.ts`",
  #6783). Every `path:line` below is at that commit.
- **Method.** Each obligation was answered by reading the named source, not by
  reading `packages/cf-harness/docs/IMPLEMENTATION_PROFILE.md` or
  `docs/specs/agent-harness/`. Two disagreements between a document and the
  code were found and are recorded as findings in their own right.

Nothing here was measured by running the audit over a corpus. The corpus
numbers quoted under "Two findings the map inherits" come from the audit runs
that motivated this work and are attributed as such.

## Status vocabulary

| Status         | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `mechanized`   | Satisfied, and something fails if it stops being true — a type, a gate, an audit check, or a test.       |
| `documented`   | Satisfied, but only as prose or by inspection. Nothing breaks if the behavior drifts away from the claim. |
| `partial`      | Part of the obligation is met. The row says which part, and which part is not.                           |
| `absent`       | Not implemented. Nothing in cf-harness answers the obligation.                                            |
| `elsewhere`    | Not cf-harness's to answer. The row names the component that owns it.                                     |
| `unknown`      | Nothing read establishes the answer. The row says what would settle it.                                   |

`documented` is the status that most invites overreading. A `documented` row is
a claim a reader has to take on trust, and the two findings below are both
cases where a `documented` claim turned out to disagree with the code.

## Headline counts

Nine obligations in §18.3.3, the checklist for the profile cf-harness would
claim:

| Status       | Count | Obligations                |
| ------------ | ----: | -------------------------- |
| `mechanized` |     1 | H3                         |
| `documented` |     1 | H1                         |
| `partial`    |     4 | H2, H6, H7, H9             |
| `absent`     |     3 | H4, H5, H8                 |
| `elsewhere`  |     0 | —                          |
| `unknown`    |     0 | —                          |

Nineteen obligations in §18.2.7, the gVisor sandbox profile's checklist. Four
are cf-harness's; the other fifteen belong to the `runsc-cfc` runtime, the
Common Fabric FUSE daemon, or the runner's label store, and cf-harness cannot
answer them:

| Status       | Count | Obligations                                                          |
| ------------ | ----: | -------------------------------------------------------------------- |
| `partial`    |     3 | G2, G17, G18                                                          |
| `documented` |     1 | G16                                                                   |
| `elsewhere`  |    15 | G1, G3-G15, G19                                                       |

Seven obligations in §18.4.4, the trusted-render profile's checklist. All seven
are the shell renderer's. cf-harness has no user-visible render surface at all,
so it is not a candidate to claim `CfcTrustedRenderProfile`.

## §18.3.3 — the harness conformance checklist

### H1 — which surfaces may mint, and which roles

> which prompt/input surfaces can mint `PromptSlotBound` evidence and which
> roles each surface may mint

**Status: `documented`.**

Two surfaces mint, and both go through one constructor,
`createCliPromptSlotBinding` in
`packages/cf-harness/src/contracts/prompt-slot.ts:158`:

- The batch CLI, at `packages/cf-harness/src/cli.ts:3108`. It mints whatever
  role `--prompt-slot-role` names, defaulting to `direct-command`
  (`cli.ts:1816`). A Loom run manifest may supply a whole binding instead, in
  which case the CLI adopts the manifest's rather than minting one.
- The console web server, at `packages/cf-harness/console/server.ts:673`. It
  mints `direct-command` on the `console-web` surface.

The set of roles is closed at the type level — `PromptSlotRole` is
`"direct-command" | "context" | "quote"` (`prompt-slot.ts:7`) — and
`normalizePromptSlotBinding` rejects anything else on the way in
(`prompt-slot.ts:117`).

What makes this `documented` rather than `mechanized`: nothing constrains
*which* role *which* surface may mint. The console's constant and the CLI's
flag both reach the same constructor with the same freedom, and a third surface
added tomorrow would inherit that freedom silently. The specification's phrasing
— "which roles each surface may mint" — anticipates a per-surface restriction
that does not exist here.

**Evidence:** No audit check covers the surface/role pairing. `AUD-1` reads the
posture a run recorded, not the surface that minted its binding, and run
artifacts carry no surface tag at all (which is why `AUD-18` says it "cannot
say which surface produced which", `packages/cf-harness/audit/checks/deployment.ts:404`).

### H2 — how input-capture records bind subject, surface, value digest, role, kernel name

> how UI, CLI, and API input-capture records bind subject, surface, value
> digest, role, and kernel name

**Status: `partial`.** Two of the five fields are bound; two are bound weakly
or not at all; one is bound but to something that is not a subject.

§18.3.1 is explicit that a non-UI surface may skip `renderRef` only if it
supplies "an equivalent trusted input-capture record such as `UserSurfaceInput`
and bind the same subject, surface, value digest, role, and kernel name."
Neither cf-harness surface supplies such a record.

| Field         | CLI (`cli.ts:3108`)                     | Console (`console/server.ts:673`) |
| ------------- | --------------------------------------- | --------------------------------- |
| `kernelName`  | `"cf-harness"`, constant                | `"cf-harness"`, constant          |
| `surface`     | `"cli"` (the constructor default)       | `"console-web"`                   |
| `role`        | `--prompt-slot-role`, default `direct-command` | `direct-command`, constant |
| `subject`     | `parsed.resumeRun ?? parsed.workspace`  | absent                            |
| `valueDigest` | absent                                  | absent                            |

Two things stand out.

**`subject` is not a subject.** The CLI binds a resume-run id or a workspace
path into the field §18.3.1 reserves for an authenticated subject DID. That is
a run-scoping fact, not an identity, and it is what
`evaluateHarnessWriteFileAuthorization` receives as `promptSlot.subject`
(`packages/cf-harness/src/prompt-loop.ts:2415`).

**The console's binding is a module-level constant.** `CONSOLE_PROMPT_SLOT` is
built once at module load (`console/server.ts:673`) and reused for every turn
of every session the server handles. It therefore binds no submitted value, no
event, and no user — the three things a `valueDigest`, an `eventId`, and a
`subject` exist to bind. Its own comment states the intent correctly ("the
page's textarea is the user typing the command themselves"), and the constant
cannot express that intent: it is identical whether a user typed the text or
not.

The contract has the fields. `PromptSlotBinding` carries optional `subject`,
`eventId`, `valueDigest`, `slotDigest`, `snapshotDigest`, and `targetPath`
(`prompt-slot.ts:19-31`), and `normalizePromptSlotBinding` validates each when
present. No mint site populates the digests.

**Closing it** means giving each surface a real input-capture step: for the
console, a per-turn binding minted at submit time over the submitted text's
digest and the authenticated session subject; for the CLI, a digest over the
prompt argument and a subject that is an identity rather than a path. Both are
additive — the contract already types them.

**Evidence:** nothing checks this. No audit check reads `valueDigest`, and no
test asserts a mint site populates one.

### H3 — how direct-command evidence is kept unforgeable

> how direct-command evidence is kept unforgeable by application code, model
> output, sandboxed tools, and free-form documents

**Status: `mechanized`,** and this is the strongest row in the map.

Four separate mechanisms, each of which breaks something if removed:

1. **The model cannot reach the binding.** The binding lives in run state,
   passed to `evaluateToolPolicy` as an argument
   (`prompt-loop.ts:2402-2408`). It is never a field of a tool input schema and
   never a value the model authors. A model that emits the literal text of a
   binding produces a string in a transcript.
2. **A skill's text is pinned to `context` at the type level.**
   `HarnessSkillCfcPromptRole` is the single-member union `"context"`
   (`packages/cf-harness/src/contracts/skill.ts:31`). A free-form document read
   through `read_skill_resource` cannot carry a `direct-command` role, and
   widening that would be a type change under review rather than a data change.
   This is exactly AH-CFC-4 and §18.3.1's "a README or webpage containing
   "ignore previous instructions" remains `quote` or ordinary labeled content."
3. **What crosses into the sandbox is influence, not authority.** The harness
   converts its binding into a `PromptSlotInfluence` atom for the invocation
   context (`packages/cf-harness/src/contracts/cfc-invocation-context.ts:194`),
   never a `PromptSlotBound` one. Sandboxed code therefore observes that a
   direct command occurred without acquiring the authority it conferred — the
   `PROMPT_INFLUENCE` / authority split §18.2.4 insists on.
4. **A pattern-authored schema cannot self-attach the atom.**
   `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`
   (`packages/runner/src/cfc/prepare.ts:4525`) lists `PromptSlotBound` among
   the atoms the runner strips from schema-declared labels. This one is the
   runner's, not the harness's, but it closes the application-code arm of the
   obligation for anything the harness runs through `run_pattern`.

**Evidence:** `AUD-5` (handle discipline) covers the adjacent claim that a
model never wrote a token the harness had not disclosed. The four mechanisms
above are covered by the type system and by package tests rather than by an
audit check.

### H4 — descriptor and measured-contract registry snapshots

> how tool descriptor and measured-contract registry snapshots are issued,
> accepted, expired, revoked, and bound to invocations

**Status: `absent`.**

There is no snapshot. `BUILTIN_TOOL_REGISTRY`
(`packages/cf-harness/src/tools/registry.ts:41`) is a `Map` built at module
load from a compile-time array. `HarnessToolDescriptor`
(`packages/cf-harness/src/contracts/tool-descriptor.ts:123-131`) carries
`toolId`, `title`, `description`, `effectClass`, `inputSchema`, an optional
`outputSchema`, and optional `tags`. Set against §18.3.2's illustrative
`ToolDescriptor`, every trust-bearing field is missing: no `descriptorDigest`,
no `registrySnapshotDigest`, no `inputSchemaHash` or `outputSchemaHash`, no
`contractPredicateDigest`, no `requiresIntentKind`, no `sink`. Nothing mints
`ToolRegistrySnapshot` or `ToolDescriptorBound` evidence, and no invocation
pins a snapshot.

There is no measured-contract registry at all. §18.2.4.1's `ToolContract` — a
bundle predicate, a parser identity, a decision about clearing prompt-injection
risk by construction — has no counterpart in the harness or in `runsc-cfc`'s
harness-side wiring. Sandboxed `bash` output is treated under §18.2.4.1's
conservative default, which is the conforming behavior in the absence of a
contract; what is absent is the ability to have one.

Two mitigating facts, which reduce the exposure without meeting the obligation.
The tool set is **not** dynamic runtime data in the sense §18.3.2 anticipates —
it is fixed at build, so there is no registry mutation for a snapshot to pin
against. And the one genuinely dynamic acquisition path, `acquire_skill`, does
carry snapshot-grade provenance: `HarnessSkillAcquisition`
(`packages/cf-harness/src/contracts/skill.ts:204`) records a `registryId`, a
full `commitSha`, the exact pinned `sourceUrl`, a `verification` discriminant
fixed at `"git-commit-sha"`, a host-computed `valueDigest` over the fetched
bytes, and a receipt time. That is issuance and binding for skills. It is not
acceptance, expiry, or revocation, and it does not extend to tools.

**Closing it** for tools is cheap while the registry is static: a digest over
the descriptor array computed at module load, stamped into the run report, and
carried on each invocation would give a reader the "which tool surface was this
run planned against" answer that nothing gives today. Acceptance and revocation
are only worth building when the surface becomes dynamic.

**Evidence:** nothing. No check reads a descriptor digest, because none exists.

### H5 — which descriptor fields are low-observable by default

> which descriptor fields are low-observable by default and which are protected
> by policy state or tool-availability labels

**Status: `absent`.**

Descriptor fields carry no observation labels, and there is no notion of a
low-safe descriptor view. Every field of every offered descriptor reaches the
model.

Tool *availability* is nonetheless narrowed, and narrowed in a way that happens
to avoid the hidden-availability leak §18.3.2 is guarding against.
`withheldToolIds` (`tool-descriptor.ts:81`) removes a tool from the surface
when the run cannot back it — no fabric session, no pattern index, no skill
registry — and its own comment says the tool is "absent rather than
present-but-failing." A model therefore cannot distinguish "this deployment
withheld the tool from you" from "this run has no fabric session", because the
harness never offers a tool it would then refuse. That is the right shape by
accident of ergonomics rather than by a labeling decision, and it is not what
the obligation asks to be documented.

**Evidence:** nothing.

### H6 — free-form documentation kept separate from structured metadata

> how free-form tool documentation is kept separate from structured capability
> metadata

**Status: `partial`.** Separated for skills; not separated for tools.

**Skills: separated, and mechanically.** A skill's text is a labeled document
read through `read_skill_resource` and pinned to the `context` prompt role
(`skill.ts:31`); a read is recorded with a registry digest, an observed digest,
and whether the two match (`skill.ts:89-91`). That is §18.3.2's `docRef`
treatment — free-form text handled as ordinary labeled content, with structured
provenance beside it rather than inside it.

**Tools: not separated.** `HarnessToolDescriptor.description`
(`tool-descriptor.ts:126`) is a plain string inside the same record as
`effectClass` and `inputSchema`, and it is authored in the harness's own source
rather than fetched. There is no `docRef`, no opaque-handle path for a
description a caller may not read, and no way for a taint-intolerant agent to
ask for "shapes and tags only".

The exposure here is small, because a built-in tool's description is
first-party text under review rather than attacker-controlled prose. It becomes
real the moment a tool description can come from anywhere else.

**Evidence:** nothing checks the split.

### H7 — opaque handles passed to tools and subagents without revealing bytes

> how opaque handles are passed to tools and subagents without revealing hidden
> payload bytes to the parent agent

**Status: `partial`.** The reference half is built and disciplined; the payload
half is not built.

What exists is an **address** handle table. `mintAddressHandle`
(`packages/cf-harness/src/handle-table.ts:208`) derives a deterministic
`cfh:a:` token from a positively identified cell address;
`swapLinksForTokens` and `swapTokensForRefs` (`handle-table.ts:363`, `:476`)
replace addresses with tokens on the way to the model and tokens with addresses
on the way back, before policy evaluation and dispatch. A delegation seeds the
child table with only the parent handles its goal names, and unheld
token-shaped text in a child's return is scrubbed. `describe_handle`
(`packages/cf-harness/src/tools/describe-handle.ts`) reports a referent's
structural schema with value-bearing fields recursively removed, never its
value.

That is genuinely the property §18.2.4.2 and AH-CFC-18 want for a reference: a
token names a referent without carrying it, and holding one discloses nothing.
`run_pattern` builds on it correctly — its answer sink admits nothing at all
(`packages/cf-harness/src/tools/run-pattern.ts:570`), and a refusal withholds
values while returning the reference.

What does not exist is §18.2.4.2's opaque handle over **bytes** as a *resolvable
capability*. The distinction matters, because the mint half is built and the
resolve half is not, and describing this as "no opaque handles" would be wrong
in the direction that hides where the work is.

A blocked observation does come back carrying a handle. `createOutputHandle`
(`packages/cf-harness/src/prompt-loop.ts:1932`) mints one as
`${resultRef.outputId}:${suffix}` at run scope, and six call sites use it —
blocked sandbox streams (`:1954`), a withheld exit code (`:2084`, `:2090`),
and withheld error and output values (`:3917`, `:3949`, `:4063`) — with
`passThrough` distinguishing an opaque value that could be passed on from one
that is denied outright. The shape is fully declared in
`packages/cf-harness/src/contracts/observation.ts`.

**Nothing reads a `handleId`.** A grep across `packages/cf-harness/src` returns
the six mint sites and the contract that defines the field, and no consumer.
There is no resolution step, so the token identifies a denial rather than
conferring a capability: it cannot be handed to a tool or a subagent to recover
the value, which is the whole of what §18.2.4.2 asks a handle to do
("`resolved`: a trusted boundary substitutes the payload into a callee input
and taints the callee `pc` by `payloadLabel`").

`HarnessHandleCapability` is the single-member union `"skill-context"`
(`packages/cf-harness/src/contracts/handle-table.ts:23`), which is the address
table saying in the type system that it holds addresses and not payloads.

So the recovery flow §18.2.4.2 describes — supervisor is denied, passes the
`opaqueId` to a sanitizer sub-agent that may observe it, receives a
schema-validated result — cannot be run end to end. The harness's response to a
blocked observation is a denial that names itself, not a denial plus a
resolvable capability.

**Cheap as a mechanism, not as an obligation.** The trusted-side store this
needs largely exists: `FileSystemHarnessArtifactStore.persistToolOutput`
(`packages/cf-harness/src/artifacts.ts:258`) already writes every tool output
host-side, outside the sandbox, keyed by the same `ToolOutputId` the handle ids
are derived from — which is §18.2.4.4's "every tool output has an id" already
in place. Three things are missing, all harness-local: a label stored beside
the bytes, a resolution step that substitutes a payload into a callee input and
taints that callee, and a ceiling check at resolution time.

The third couples this obligation to H8. §18.2.4.3 requires that resolving a
handle into a callee input be rejected when it exceeds the callee's ceiling,
and cf-harness has no ceiling for that check to consult. **Building H7 alone
buys the recovery flow without the attenuation** — a supervisor could route a
blocked value to a sanitizer, and nothing would bound what that sanitizer may
observe. That is still worth having, and it is why "cheapest" is a claim about
the mechanism rather than about the obligation: H7's machinery is the smallest
of the four to build, and H7 is not complete until H8 exists.

**Evidence:** `AUD-5` (handle discipline) covers the address table against
AH-CFC-18, AH-CFC-19, AH-CFC-12, and AH-CFC-13, and passed on all 180 corpus
runs that minted a handle. It has nothing to say about the payload form,
because none is minted.

`IMPLEMENTATION_PROFILE.md` deviation 4 states this correctly today
("Address handles cover cell addresses but not the reserved value-handle
form"), which is the one place the existing profile document is ahead of its
own claims table.

### H8 — subagent ceilings and observation policies before inherited handles resolve

> how subagent ceilings and observation policies are applied before inherited
> handles are resolved

**Status: `absent`.**

`HarnessSubagentProfileConfig`
(`packages/cf-harness/src/contracts/subagent.ts:319-347`) is the complete
statement of what a delegation binds: allowed tool ids, host tool ids, an
optional model override, native model tools, skill names, allowed skill
scripts, a script execution target, a turn budget, a return schema, a return
contract authority, and a return policy. There is no confidentiality ceiling
and no principal attenuation. §18.2.4.3's mechanism —
`principal_callee.principals ⊆ principal_caller.principals`, with reads denied
above the ceiling — has no representation.

The containment that does exist is real but is a different property. A child
receives a fresh context, an exact tool and network policy, no implicit
transfer of parent skills or authority, and only the parent handles its goal
names; child artifacts and raw browser observations stay under the child
boundary. That satisfies AH-CFC-12 and AH-CFC-13 and is what `AUD-5` checks.
It is *capability* attenuation. §18.2.4.3 asks for *observation* attenuation —
"the research sub-agent runs with `User(Alice)` but not with `Admin`" — and
the two are not substitutes: a child that inherits a handle to a cell the
parent could read can read it, whatever tools it was given.

The clause's ordering requirement ("before inherited handles are resolved")
therefore does not arise. There is nothing to apply, so there is no question of
when it is applied.

**Closing it** is the largest single piece of work the map identifies, because
a ceiling has to be represented in the profile, enforced at every read a child
can perform, and threaded through handle resolution. It is not a harness-local
change: the reads a child performs bottom out in the runner, so the ceiling has
to be something the runner's `canAccess` can consume.

**Evidence:** nothing.

### H9 — side effects bottoming out in sink-specific intent and commit-point checks

> how side-effecting tool calls bottom out in the same sink-specific intent and
> commit-point checks used outside the agent harness

**Status: `partial`,** and this is the widest gap in the map, because the part
that is missing is the part the clause is about.

**One tool bottoms out where the clause asks.** `run_pattern` runs its program
against the configured Fabric space through the runner's ordinary commit path:
it measures the release against a named sink and an explicit ceiling
(`run-pattern.ts:1608-1612`), and a refusal the commit boundary raises comes
back as a structured `policyRefusal` naming the gates that refused and the
sinks involved. That is the same sink-request and commit-point machinery a
non-harness caller gets, reached by the same route.

**Every other side-effecting tool does not.** The gate they pass through is
`evaluateToolPolicy` (`prompt-loop.ts:2402-2506`). Read plainly, it is:

```
allow if effectClass === "read"
allow if the run's prompt-slot binding has role === "direct-command"
otherwise deny
```

with `write_file` taking a slightly richer path through
`evaluateHarnessWriteFileAuthorization` (`prompt-loop.ts:2410`) and the
enforcement mode selecting which of four reason codes is recorded.

Three properties of that gate matter against the clause:

- **It is not sink-specific.** It turns on the descriptor's static
  `effectClass`, which is one of three words fixed in the harness's own source.
  No sink is named, no ceiling is consulted, no intent kind is required. The
  runner's sink registry — ten sinks, each carrying a ceiling or a published
  ungated rationale (`packages/runner/src/cfc/sink-inventory.ts:26`) — is not
  reached by this path at all.
- **It is not a commit point.** The decision is recorded before the tool runs.
  A refusal the boundary raises *inside* a tool cannot appear in the policy
  decisions as a denial, which
  `packages/cf-harness/audit/checks/deployment.ts:120-127` states as the trap
  to avoid when reading those codes.
- **It decides on authority, not on a label.** Once a run carries a
  `direct-command` binding — which the CLI mints by default and the console
  mints as a module constant — every side-effecting tool it offers is allowed,
  whatever the labels on the data flowing into the call. Influence is
  accumulated (AH-CFC-7, AH-CFC-8) and is not consulted here.

The honest summary is that cf-harness has a **gate on who asked**, and the
clause asks for a **gate on what is flowing**. The first is necessary and is
correctly built; it is not the second.

**Closing it** means routing each side-effecting tool's effect through a named
sink with a declared ceiling, the way `run_pattern` already routes its answer,
so that the runner's `prepareBoundaryCommit` decides rather than a boolean in
the prompt loop. `web_fetch`, `write_file`, and the browser child's network
egress are the three that most obviously want it.

**Evidence:** `AUD-14` (ungated sink coverage) is the closest existing check
and is currently classified `extends`. See "Which audit checks change
classification" below — this clause is why `AUD-14` should be `required-by`.

## §18.2.7 — the four gVisor obligations that are cf-harness's

cf-harness runs tools under the sibling gVisor runtime `runsc-cfc`
(`packages/cf-harness/src/sandbox/docker-runsc.ts:50`), so
`CfcGVisorSandboxProfile` is in scope for the *deployment*. It is not in scope
for the harness as an implementation: fifteen of the nineteen bullets are
statements about a sandbox kernel's filesystem, exec, and timing mediation, and
cf-harness implements none of that. Those fifteen — G1, G3 through G15, and G19
— are `elsewhere`, owned by the `runsc-cfc` runtime, the Common Fabric FUSE
daemon (§18.2.3.5-18.2.3.6), and the runner's label store. Nothing read in this
exercise establishes their state, and this document does not guess at it.

Four are the harness's, because the harness is the thing that constructs them.

### G2 — which mounts are CFC-mediated, rootfs, scratch, or out of scope

**Status: `partial`.** The harness classifies mounts into three kinds —
`workspace`, `fabric-fuse`, `host-bind`
(`packages/cf-harness/src/sandbox/types.ts:6`) — records each with its host
path, sandbox path, read-only flag, and mode in the capability snapshot
(`packages/cf-harness/src/diagnostics.ts:87-96`), and reports them per run.
That is a mount inventory, and it is published.

It is not §18.2.7's classification. The three kinds do not map onto
"CFC-mediated / immutable public rootfs identified by a measured digest /
scratch derived from the invocation `pc` / out of CFC scope", and no mount
carries a measured image or rootfs digest. A reader of a capability snapshot
learns where each mount came from and not which CFC claim it falls under.

### G16 — where the opaque-handle store and label store live

**Status: `documented`.** The handle table is session-local, persisted with the
run's artifacts, and reconstructed across batch resume; it is not visible to
the sandbox, which sees only tokens. The label store is not the harness's — it
is the runner's, and the sandbox's own labels arrive through the
`cfcResultDir` sidecar. Both facts are stated in prose here and in
`IMPLEMENTATION_PROFILE.md`; nothing checks either.

### G17 — handle scopes, TTLs, revocation, metadata labels

**Status: `partial`.** `OpaqueHandleScope` is
`"invocation" | "run" | "session"` and `OpaqueHandle` carries an optional
`expiresAt` (`packages/cf-harness/src/contracts/observation.ts:1-11`), so the
vocabulary §18.2.4.2 asks for is declared. No revocation or tombstoning exists,
no handle metadata is labeled, and — per H7 — no payload sits behind a handle
for a TTL to protect. The scopes are typed and unexercised.

Note the spec's third scope is `plan` and the harness's is `run`. That is a
naming difference over the same idea, not a semantic gap, but a conformance
statement should say so rather than let a reader match the lists by eye.

### G18 — how stdout/stderr are prevented from bypassing the trusted runtime

**Status: `partial`,** and this is the strongest of the four.

Raw sandbox streams come back through the `runsc-cfc` CFC result sidecar, and
the harness withholds them from model context when the sidecar reports tainted
output (`docker-runsc.ts:732`). The dangerous half — a run that claims to
enforce while the sidecar transport is not wired, so input taint is silently
dropped — is closed by a startup assertion:
`assertDockerRunscCfcTransportForMode` (`docker-runsc.ts:311`) refuses to start
an enforcing run whose `cfcInvocationContextDir` or `cfcResultDir` is unset,
"refusing to start a run that would silently degrade enforcement". A second
reading, `cfcTransportReadinessFromDockerRuntimes`, checks that the Docker
runtime is registered with an absolute directory for each flag.

What keeps this `partial` rather than `mechanized`: the readiness check
deliberately does not compare the directory the harness names against the one
the runtime is registered with, because "no comparison of two spellings can
establish that they are, or are not, one directory" (`docker-runsc.ts:515`).
That is the right call and it leaves a real hole — two absolute paths that
disagree pass both checks. Closing it needs an identity probe rather than a
string comparison, or a handshake through the sidecar itself.

## §18.4.4 — the trusted-render profile

All seven obligations are the shell renderer's. cf-harness has no user-visible
render surface: its outputs are model context, operator terminal lines, and
artifact files, and none of those is a certified authorship boundary. It is not
a candidate to claim `CfcTrustedRenderProfile` and should not appear as one.

The runner does have a display-sink render ceiling
(`packages/runner/src/cfc/render-ceiling.ts`), but that resolves
*confidentiality* for a display egress under §8.10.6. §18.4 is about *integrity*
— an ambient `authored-by(subject)` predicate committed into `RenderRef` and
`snapshotDigest` evidence — and nothing read establishes that such a predicate
is committed anywhere. Whether §18.4's obligations are met by the shell is
`unknown` from here; establishing it means reading `packages/html` and
`packages/shell`, which this exercise did not.

This is exactly why `AUD-19` exists and reports `inconclusive` permanently
(`audit/checks/deployment.ts:510-518`): no surface publishes the render ceiling,
so an audit of harness artifacts establishes nothing about it. Reporting a
permanent `inconclusive` rather than staying silent is the right shape — an
audit that said nothing about the render ceiling would read as a clean bill for
it.

## Two findings the map inherits

Both are cases where a *description* of the system disagreed with the system.
Neither is a bug in a check; both are the failure mode a documentary
conformance model cannot catch, which is the argument for the property suite
CT-2178 phase 3 is building.

### A posture record published `writeFloor: enforce` against an actual `off`

The mechanism, traced through code:

1. The console defaults its fabric session to the `max-enforcement` posture
   bundle (`packages/cf-harness/console/server.ts:221`, `:556`).
2. `MAX_ENFORCEMENT_CFC_OPTIONS` sets `cfcWriteFloor: "enforce"`
   (`packages/runner/src/runtime-presets.ts:636`).
3. `harnessFabricSessionPosture`
   (`packages/cf-harness/src/cfc-posture.ts:41`) projects the record from those
   options and stamps it `provenance: "projected"` — a prediction about a
   session runtime built lazily on the first `run_pattern` call, and possibly
   never built at all.
4. The runtime that actually decides a write on the serving side is the
   toolshed's, built by `runtimePresets.productionServer` with no `cfcPosture`
   (`packages/toolshed/runtime-options.ts:26`), which resolves
   `cfcWriteFloor` to the fleet default `"off"`
   (`RUNTIME_CFC_DIAL_DEFAULTS`, `packages/runner/src/cfc/posture-report.ts:302`).

So the record says `enforce` and names a dial that, on the far side of the
session, is `off`. The record is not lying about itself — it says `projected`
in its own `provenance` field, and `posture-report.ts`'s header comment is
precise about the difference. What it cannot do is stop a reader from taking a
projection for an attestation, which is what `AUD-17` exists to catch: it
`fail`s a `/api/meta` publishing anything other than `provenance: "resolved"`
(`audit/checks/deployment.ts:345`).

The general lesson the map should carry: **a projected posture is a claim about
a path that has not run.** Every row of this document that reads a projected
record is weaker than it looks.

### 191 runs declaring `absenceBehavior: permissive-if-absent` while denying 151 times

These are two different questions with one word between them, and the word is
doing no work.

`absenceBehavior` is derived from the enforcement mode alone.
`cfcAbsenceBehaviorForMode` (`packages/cf-harness/src/diagnostics.ts:268-279`)
maps `enforce-explicit` to `permissive-if-absent`. What it describes is what
happens when **trusted mediation metadata is absent**: the run proceeds rather
than fail-closing. That is AH-CFC-6's question.

The denials come from somewhere else entirely.
`evaluateToolPolicy` (`prompt-loop.ts:2402`) denies when the run has no
`direct-command` binding and the tool's static `effectClass` is not `read`. It
never consults whether mediation metadata is present. That is AH-CFC-9's
question.

So a corpus can carry 191 runs saying "permissive if absent" and 151 denials
without a single contradiction, and a reader comparing the two numbers is
comparing an authority gate against a mediation-absence policy. The field is
accurate and its name invites exactly this misreading, which is a legibility
defect rather than an enforcement one — and legibility is what a conformance
document is for.

Note also that `absenceBehavior` is a pure function of the mode. It is a
restatement of `enforcementMode`, not an independent observation, so it can
never disagree with the mode and can never catch a run whose behavior departed
from it.

## Where the gap is widest

Four obligations, in the order the work should be taken.

1. **H9 — side effects do not bottom out in sink checks.** Everything except
   `run_pattern` is gated on authority rather than on flow. Closing it means
   routing each side-effecting tool through a named sink with a declared
   ceiling so the runner's commit boundary decides. Largest security payoff.
2. **H8 — no subagent confidentiality ceiling.** Capability attenuation is
   built; observation attenuation is not. Closing it needs a representation the
   runner's access check can consume, so it is not harness-local.
3. **H7 — an opaque handle nothing can resolve.** The reference half is good,
   and the byte half is half-built: six sites mint a handle for a blocked
   observation and no code reads a `handleId`, so §18.2.4.2's recovery flow
   stops at the denial. The smallest mechanism of the four to build, because
   the host-side store already exists — but not the smallest obligation, since
   its resolution-time ceiling check needs H8's ceiling to mean anything.
   Sequence it after H8, or build it before and accept recovery without
   attenuation knowingly.
4. **H2 — input-capture records bind neither a subject nor a value digest.**
   Both surfaces mint direct-command authority from a constant. The contract
   already types the missing fields; the work is at the two mint sites.

H4 and H5 are real gaps and are ranked below these because the tool surface is
static and first-party, which bounds what they can cost today.

## Which audit checks change classification

Phase 2 marked six checks `extends` — "the check serves the clause's purpose;
the clause does not state the requirement" — judged against the labs harness
spec alone. Re-judged against the CFC specification:

| Check     | Today     | Recommended  | Clause                                                                                                                                          |
| --------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUD-14`  | `extends` | `required-by` | §18.3.3: "how side-effecting tool calls bottom out in the same sink-specific intent and commit-point checks used outside the agent harness"     |
| `AUD-17`  | `extends` | `required-by` | §18.3.3 read with §18.1: a profile is "a conformance target: an implementation that claims the profile must satisfy the listed ... evidence requirements" |
| `AUD-19`  | `extends` | `extends`     | §18.4.4 states the obligation, but for a profile cf-harness does not claim                                                                      |
| `AUD-15a` | `extends` | `extends`     | no CFC counterpart                                                                                                                              |
| `AUD-16`  | `extends` | `extends`     | no CFC counterpart                                                                                                                              |
| `AUD-18`  | `extends` | `extends`     | no CFC counterpart                                                                                                                              |

**`AUD-14` is the clear reclassification.** The check reports a sink the
deployment leaves ungated. §18.3.3's last bullet requires a claimant to document
how side effects reach the same sink-specific checks used outside the harness,
and a sink with no ceiling reaches no check at all. That is the specification
stating the requirement, which is what `required-by` means. The `llm`-class
sinks are the live instance: four sinks release with no ceiling
(`sink-inventory.ts:128-133`), each carrying a published reason, owner, and
retirement condition — a published deviation, which is the honest form of the
gap and still a gap.

**`AUD-17` is the defensible one.** The check reports whether a deployment
publishes a posture and whether it matches a named spec. No §18.3.3 bullet says
"publish your posture" in those words. §18.1 does say a profile is a
conformance target an implementation "must satisfy", and a claim nobody can
read is not a claim; §18.3's framing of the harness as "the trusted control
plane" carries the same weight. This is a reasonable `required-by` and a
reasonable `extends`, and the argument for raising it is that a deployment
publishing a *projected* posture where an attestation is required — the
`AUD-17` fail path — is precisely a profile claim that cannot be checked. Take
it if you want the citation chain to carry the weight; leave it if you want
`required-by` reserved for clauses that state the requirement in words.

**`AUD-19` I disagree with the brief on.** §18.4 does exist and does want
ambient text-integrity policy committed into `RenderRef` / `snapshotDigest`
evidence, so there is a clause. But it is §18.4.4's clause, and §18.4.4 binds
"a deployment claiming `CfcTrustedRenderProfile`". cf-harness does not claim
that profile and should not; the shell would. Citing §18.4.4 as `required-by`
from a harness audit check would lend a profile's authority to a check about a
component outside it — the inward-pointing divergence `citations.ts`'s own
header warns against. `extends`, with a §18.4.4 citation added so a reader can
see what the check is serving, is the right shape.

**`AUD-15a`, `AUD-16`, `AUD-18` are ours, and correctly so.** I agree with the
brief. `AUD-15a` (default-sourced dial drift) is a property of how our
configuration defaults are sourced. `AUD-16` (refusal liveness) is a property of
our test corpus — a conforming deployment that happened to be handed only
benign work would show zero refusals and be conforming. `AUD-18` (posture
uniformity) is a property of our having several surfaces that pick different
postures. No CFC clause states any of the three.

## The citation-chain problem

`packages/cf-harness/audit/test/citation-drift.test.ts` reads each cited
document and requires the quote to still be a substring of it, with whitespace
collapsed so a rewrap is invisible and a rewording is loud. It works because
every cited document is in-tree. The CFC specification is in
`commontoolsinc/specs`, so quoting it directly cannot be drift-tested the same
way.

Four approaches, weighed:

- **Vendor a pinned snapshot of the chapter.** Full drift guarantee, in-tree,
  no network. Costs a copy of another team's document that will go stale
  silently, and a copy is the thing `docs/README.md` and the word-choice rule
  both push against — a search for a CFC clause would hit our copy of it.
- **Cite a commit SHA plus a content hash of the quoted section.** Precise and
  small. But nothing in-tree can *check* it: the hash is verified by a human
  with a clone, so a wrong hash is indistinguishable from a right one until
  someone looks. That is a weaker guarantee wearing a strong guarantee's
  clothes, which is worse than a weak one that says so.
- **Cite through an in-tree mirror document checked against the external
  source by a gate.** The strongest guarantee, and the most machinery: a new
  gate that needs the specs repository present, which means the network in CI
  or a submodule, and a mirror that is a third document to keep honest.
- **Accept a weaker guarantee for external citations and mark them as such.**
  Cheapest, honest, and gives up the property the drift test exists for.

**Recommendation: the last one, with a specific shape.** Extend `SpecCitation`
with an optional `externalRef: { repo, commit, section }`, make `doc` optional
when `externalRef` is present, and have the drift test split its assertions:
in-tree citations keep the verbatim-substring check unchanged; external
citations assert only that `repo`, `commit`, and `section` are present and
well-formed, and the check's report renders an external citation with a visible
marker so a reader can tell which authority is drift-guarded and which is
pinned-by-reference.

The reason to prefer it over the mirror: the drift test's value is that a
*rewording of our own spec* breaks a check that rested on it, and our spec is
what we edit. A CFC chapter changing under us is a different event with a
different response — someone re-runs this mapping — and a gate is a poor way to
schedule that. Marking external citations as pinned-by-commit says exactly what
is true, and `docs/specs/agent-harness/04-cfc-spec-correspondence.md` is where
the re-derivation gets recorded when the pin moves.

The trade-off taken: a CFC clause can be reworded without anything in this
repository noticing, and the correspondence document's commit pin becomes the
only record of what was true. Mitigate it by pinning the commit in one constant
rather than per-citation, so bumping it is one visible edit.

## What contradicts the brief

Two things, both small.

- The brief lists `AUD-19` as a reclassification candidate on the strength of
  §18.4 existing. I recommend against it, for the reason given above: §18.4.4
  binds a profile cf-harness does not claim.
- The brief says the audit "cites AH-CFC clauses as its authority" and asks
  whether they are a faithful derivation. The correspondence document answers
  the derivation question in full. The short form is that AH-CFC is a faithful
  but **narrow** derivation with two clauses that have no CFC counterpart at
  all, and one — AH-CFC-15 — that is *stronger* than the CFC spec rather than
  weaker. No AH-CFC clause contradicts the CFC specification.
