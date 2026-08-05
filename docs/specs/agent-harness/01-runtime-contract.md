# Agent Harness Runtime Contract

Status: draft 0.1

This document specifies the caller-visible behavior of a Common Fabric agent
harness. The contract is transport-neutral: a batch CLI, long-lived stdio
service, or another protocol may conform if it preserves the same lifecycle,
authority, containment, and evidence semantics.

## 1. Roles and trust boundaries

- The **caller** selects the task, prompt-slot roles, capabilities, mounts,
  policy profile, and resource bounds.
- The **harness** runs the model/tool loop and records authoritative run
  lifecycle evidence. It does not invent authority on the model's behalf.
- The **model gateway** produces model messages and tool requests. Its output is
  untrusted proposal data unless another trusted component supplies evidence to
  the contrary.
- The **execution substrate** executes tools inside the configured containment
  boundary.
- A **mediator** supplies trusted observation or policy evidence. It may be the
  execution substrate, the Common Fabric runner, or another declared trusted
  component.
- An **integration adapter** maps a product's concepts onto the harness
  contract. Adapter routing and product policy are not implicit harness powers.

An implementation profile MUST name which components occupy these roles and
which boundaries are trusted.

## 2. Invocation contract

**AH-INV-1.** Every run MUST have a stable run identifier and a run-start
configuration snapshot.

**AH-INV-2.** The snapshot MUST identify the selected model and provider
adapter, provider-affecting controls, workspace and initial working directory,
enabled tools and child profiles, resource bounds, policy profile, prompt slots,
and caller-supplied mounts. Secret values MAY be represented by opaque
references or digests rather than copied into artifacts.

**AH-INV-3.** Prompt inputs MUST retain their declared roles. At minimum an
implementation MUST distinguish direct commands from context and quoted or
retrieved material. Text that sounds command-like MUST NOT acquire a stronger
role merely because of its content.

**AH-INV-4.** Invalid configuration, unavailable required capabilities, or paths
outside declared boundaries MUST fail before the first model request.

## 3. Capability negotiation

**AH-CAP-1.** A harness MUST expose a machine-readable capability description
without starting a model run.

**AH-CAP-2.** The description MUST distinguish parent tools, child profiles,
native model tools, repeatable configuration fields, and optional protocol
features. A caller MUST NOT infer capability from a binary's presence alone.

**AH-CAP-3.** Integrations SHOULD gate optional arguments and workflows from the
capability description so that version skew fails explicitly or degrades through
a documented path.

**AH-CAP-4.** Advertised capability means the harness understands and can
validate the feature. It does not by itself prove that an external dependency,
such as a sandbox daemon or browser lease, is healthy. Required dependency
health MUST be checked before accepting a run that needs it.

## 4. Run and turn lifecycle

**AH-LIFE-1.** A run moves from created to running and then to exactly one
terminal state: completed, failed, or cancelled.

**AH-LIFE-2.** The harness MUST durably record the terminal state and the last
accepted event before reporting terminal completion to the caller.

**AH-LIFE-3.** Cancellation MUST stop further model and tool work. An
implementation that launches child processes MUST reap or terminalize the owned
process tree; returning while owned executors continue side effects is
non-conforming.

**AH-LIFE-4.** Resource limits such as model turns, child turns, wall time, and
output size MUST be caller-visible and terminal failures MUST identify the limit
that was reached.

**AH-LIFE-5.** Automatic retries MUST be bounded, visible in run evidence, and
limited to operations whose replay semantics are declared safe.

## 5. Tools and side effects

**AH-TOOL-1.** The parent tool surface MUST be derived from an explicit
allowlist or an implementation-profile default published in the conformance
statement.

**AH-TOOL-2.** A skill, retrieved document, model message, or child result MUST
NOT expand the allowed tool surface.

**AH-TOOL-3.** Every tool call MUST record the tool identity, bounded input
summary, outcome, timing, and policy/mediation disposition. Sensitive raw inputs
MAY be retained only inside the declared artifact boundary.

**AH-TOOL-4.** A side-effecting tool call MUST be attributable to an authorized
prompt slot or another explicit authority grant. Model intent alone is not an
authority grant.

**AH-TOOL-5.** Recoverable tool failures MUST return typed failure information
rather than masquerading as successful observations.

**AH-TOOL-6.** A harness MUST distinguish model-correctable tool failures from
failures in tool setup, containment, mediation, persistence, or harness
invariants. Only the former MAY be returned to the model as recoverable tool
outcomes. The latter MUST fail the run and keep operator-only diagnostic detail
out of the model-facing channel.

## 6. Filesystem, host, and network containment

**AH-CONT-1.** The harness MUST resolve filesystem operations against an
explicit workspace or mount table and reject traversal through paths or symlinks
outside it.

**AH-CONT-2.** Read-only and writable mounts MUST remain distinguishable in the
run snapshot and enforcement path.

**AH-CONT-3.** Host execution MUST be a named capability with a narrower policy
than general sandbox execution. It MUST NOT appear in the parent surface merely
because a child profile uses it.

**AH-CONT-4.** Network posture MUST be explicit per profile. A caller MUST be
able to distinguish disabled, destination-constrained, and general network
access.

**AH-CONT-5.** Raw operator artifacts SHOULD be outside ordinary model-readable
workspace mounts. When they are not, artifact paths MUST be reserved from model
file and discovery tools.

## 7. Delegation

These clauses apply when delegation is advertised.

**AH-DEL-1.** A child run MUST begin with a fresh model context and an explicit
profile. Parent context, skills, tools, mounts, and credentials MUST NOT
transfer implicitly.

**AH-DEL-2.** A child profile MUST publish its tools, host powers, network
posture, skills, resource limits, and return policy.

**AH-DEL-3.** Raw child transcripts, tool outputs, and failure detail MUST
remain inside the child artifact boundary unless a declared release step
authorizes them for the parent.

**AH-DEL-4.** The ordinary parent return channel MUST be bounded and sanitized.
If a structured return schema is supplied, the harness MUST validate it before
exposure to the parent and fail closed on invalid values.

**AH-DEL-5.** The parent run MUST retain references to child identity, profile,
terminal state, and operator-visible artifacts.

## 8. Interactive sessions

These clauses apply when interactive sessions are advertised.

**AH-INT-1.** Sessions, turns, requests, responses, and events MUST have stable
identifiers sufficient for idempotent correlation and replay.

**AH-INT-2.** A session MUST define whether turns are serial or concurrent and
MUST reject unsupported overlap rather than silently interleave model context.

**AH-INT-3.** Event replay MUST have an explicit cursor or sequence contract.
Bounded in-memory retention MUST NOT erase events promised as durable.

**AH-INT-4.** Restoring a session MUST validate its workspace, policy, model,
mounts, and other authority-bearing configuration. A caller MUST NOT attach a
persisted session to a different authority context by changing metadata alone.

**AH-INT-5.** Turn cancellation and session closure MUST follow the terminality
and child-reaping requirements in section 4.

## 9. Artifacts and resume

**AH-ART-1.** A run MUST retain a configuration/capability snapshot, ordered
transcript or event log, terminal run state, policy events, and references to
tool and child outputs.

**AH-ART-2.** Artifact writes that represent accepted lifecycle state MUST be
atomic with respect to readers. A crash MUST produce either the prior complete
state or the next complete state, not a silently accepted partial document.

**AH-ART-3.** Artifact paths and run identifiers MUST be confined beneath the
declared artifact root.

**AH-ART-4.** Resume MUST preserve the original authority-bearing run
configuration. Any allowed override MUST be explicit, recorded, and unable to
silently broaden tools, mounts, policy, or prompt authority.

**AH-ART-5.** Resume MUST detect incompatible or missing state and fail closed
rather than synthesizing a plausible transcript.

## 10. Model usage and cost evidence

These clauses apply when the selected provider reports usage or the harness
publishes usage or cost metadata.

**AH-USAGE-1.** Usage evidence MUST preserve which counters the provider
reported for each model attempt and MUST associate them with the selected model,
provider adapter, and attempt identity. An absent counter MUST remain absent; a
harness MUST NOT silently replace it with zero.

**AH-USAGE-2.** Direct-run usage and usage inclusive of completed descendants
MUST remain distinguishable. Every aggregate MUST define its coverage and MUST
avoid counting descendant usage both through a parent total and again as a
separate entry.

**AH-USAGE-3.** Cache-read, cache-write, reasoning, input, and output counters
MUST retain the selected provider's documented semantics. In particular, a
harness MUST NOT assume that cache counters are additive to input tokens, or
subsets of input tokens, without a provider contract that says so.

**AH-USAGE-4.** Provider-reported monetary cost and harness-estimated cost MUST
be separate fields with explicit provenance. An estimate MUST identify its
currency and rate-card source or version and MUST NOT be described as an
invoice, provider-reported charge, or subscription-quota conversion.

**AH-USAGE-5.** An aggregate monetary cost MUST be omitted when any included
record lacks compatible cost evidence. The result SHOULD include a typed reason
that distinguishes incomplete coverage from unsupported pricing, missing
provider detail, and invalid counters.

**AH-USAGE-6.** Terminal run artifacts MUST retain the usage and cost evidence
exposed to the caller. A transport with a structured terminal result SHOULD
include the same aggregate or an unambiguous reference to it.

## 11. Diagnostics and disclosure

**AH-DIAG-1.** Operator diagnostics SHOULD identify the failing boundary—model
gateway, configuration, sandbox, mediator, tool, child, artifact store, or
integration—without exposing secrets to the model-facing channel.

**AH-DIAG-2.** Reduced-assurance operation MUST be explicit in both the run
snapshot and terminal report. A warning in a transient log is insufficient.

**AH-DIAG-3.** Implementation profiles MUST list known deviations, provisional
host or network paths, and product adapters that deliberately select a weaker
profile.
