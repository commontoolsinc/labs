# Acquiring skills from the open internet

A plan for discovering skills in a public registry and loading one into an
agent, without the skill's text ever entering the context of the agent that
chose it, and with where it came from recorded on the value so anything done
under its influence stays legible.

The registry this is designed against is `https://www.skills.sh/`. What that
registry actually exposes was surveyed on 2026-08-28 and recorded in
[`../history/packages/cf-harness/skills-sh-surface-2026-08-28.md`](../history/packages/cf-harness/skills-sh-surface-2026-08-28.md).
The survey changed this design rather than confirming it; the changes are
called out where they bite.

## The asymmetry every decision here traces back to

A pattern is sandboxed fabric computation. CFC insulation is what makes
running an unseen one safe: whatever it does, it does inside a boundary that
holds.

A skill is prompt text. It enters model context and acts on the model's
authority immediately, and **there is no CFC boundary between a skill's
injection and the model's next tool call**. Nothing mediates the gap. That
makes loading an unseen skill categorically more dangerous than running an
unseen pattern, and it is the reason this cannot be `search_patterns` with a
different noun.

Three properties follow, and each part below exists to hold one of them:

- **Search returns metadata; loading is handle-only.** The chooser never reads
  what it chose.
- **Everything the registry says is hostile data.** A name is attack surface —
  injection, or squatting something we trust.
- **Provenance is recorded on the value.** Acting on an untrusted skill has to
  be an event a gate can see.

## The split the surface forces: discovery is not acquisition

The survey's central finding is that skills.sh cannot serve both halves.

**skills.sh answers "what exists, and where does it live". It does not answer
"give me these exact bytes".** It is an index over third-party GitHub
repositories and says so in its own terms — *"We do not own, host, or
relicense skill content."* Identity is a mutable name, `{owner}/{repo}/{slug}`,
resolving to whatever the upstream default branch holds at read time. There is
no fetch-by-digest endpoint on any of its surfaces. The `hash` field it
publishes could not be reproduced from the payload it accompanies, and the
vendor's own client adopts it rather than checking it, so it is an unverified
server assertion: a serviceable change detector, and not a content address.

CT-2106 as filed required "selection by content-address/handle, never by the
name or description text". Against skills.sh that requirement is
unimplementable, and the honest response is to move acquisition somewhere a
digest means something rather than to build on a number that only looks like
one. So:

| | Surface | What it gives |
| --- | --- | --- |
| Discovery | skills.sh `/api/search` | ids, names, install counts, sources |
| Acquisition | `.well-known/agent-skills`, or a GitHub commit SHA | bytes we can verify |

Both acquisition routes are content-addressed in the way the issue meant.
The `.well-known/agent-skills` index entry carries a **mandatory**,
regex-validated `sha256:` digest, and acquisition verifies it fail-closed
against the fetched bytes. A GitHub commit SHA names an immutable tree.
Neither is reachable from a skills.sh id alone; resolving a discovery hit to a
pinned address is a step this plan owns, not one the registry performs.

Two limits, stated because omitting them would make the plan read as more
finished than it is. skills.sh publishes no `.well-known` index, so today the
protocol reaches only self-hosting publishers. And the `$schema` URL those
indexes carry, `schemas.agentskills.io`, has no DNS record at all — it is a
version tag that is string-compared, not a document anyone fetches.

## Part 1 — Discovery: `search_skills`

A read-only tool over the registry, shaped on `search_patterns` and holding
the same boundary that tool's own header states: *a model needs to know what
something is for, and never what it says.*

**Reuses.** `PatternIndexClient`'s shape for a typed client over a remote
index (`packages/cf-harness/src/pattern-index/client.ts`); `HarnessFetch` from
`contracts/http-fetch.ts` so the egress is substitutable and testable;
`searchPatternsToolDescriptor`'s descriptor shape and its `effectClass:
"read"`; the `SEARCH_PATTERNS_MAX_RESULTS` convention of capping hits and
making the model narrow instead.

**What it returns.** Registry id, source, and install count — the fields
`/api/search` actually carries. Notably it does **not** carry a description,
so the free-text surface a v1 search would have exposed to the model does not
arise on this route. Where a description is later wanted, it must be fetched
deliberately and treated as the hostile string it is, not folded silently into
a hit.

**Every string is treated as hostile.** Registry values are sanitized before
they reach any context: control characters and terminal escapes stripped,
newlines collapsed, length capped. The vendor's own CLI does exactly this to
the same fields, which is a reasonable precedent to follow and a poor one to
rely on — it protects a terminal, and we are protecting a model, so ours also
refuses ids that do not match the expected `{owner}/{repo}/{slug}` shape
rather than passing an odd one through sanitized.

**No name is ever authority.** A hit names a candidate. It does not activate
anything, and it never selects a skill by matching a name we trust — that is
the squat CT-2084 retired on the load path, and discovery must not reintroduce
it above.

**The ranking signal is not imported.** See below; this is load-bearing enough
to have its own section.

**Egress.** Discovery reaches the public internet, so it belongs to a child
with network reach and no secrets, along the decomposition CT-2078 proved:
the acquirer has web reach and no task data, the user has task data and no
acquisition surface. `WEB_FETCH_SUBAGENT_PROFILE_CONFIG` is the existing
shape. The residual channel is real and unclosed: **a search query can encode
anything the searcher knows**, so a parent that has read a secret and then
chooses what to search for is a channel by construction. CT-2068 names this;
this plan does not solve it, and the mirror below is what eventually does.

## Part 2 — Handle-load: the text never reaches the chooser

**This part needs no new machinery.** CT-2084 landed on `main` (PR #6340,
`85d4b6f4c9`) despite reading Triage in the tracker. What exists today:

- `delegate_task` takes `skillHandle`, a token naming a cell whose value is
  skill text (`packages/cf-harness/src/prompt-loop.ts`).
- `resolveHandleValue` materializes it trusted-side
  (`packages/cf-harness/src/tools/handle-values.ts`): handle-table membership
  is mandatory, only a `string` resolves — a number or object is refused
  rather than stringified, "because a coerced rendering is the value by
  another name" — and a reference in another space is refused. Every failure
  is stated in terms of the reference, never the referent, so a refusal
  renders no part of the value.
- `loadHarnessSkillContextFromText` wraps the payload in a
  `<skill_context source="handle:<token>">` block and returns an activation
  carrying the token and a sha256 digest of the exact text injected
  (`packages/cf-harness/src/skills/registry.ts`).
- `scrubHandleSkillText` strips the payload from the child's final text
  **before** handle-token resolution, so the child cannot echo its skill back
  to the parent. The ordering is deliberate: resolving first would rewrite an
  embedded token and walk the echoed payload straight past the scrub.

So the load path is done. What this plan adds is only what fills the cell.

**The acquisition step.** An acquiring child — web reach, no secrets — fetches
a skill from a **pinned** address, verifies it, and writes the text into a
cell via `run_pattern`. It returns a handle. The parent can describe that
handle and cannot read it. The using child receives it as `skillHandle` and
the text materializes trusted-side at spawn, never passing through the parent.

**Pinned means one of exactly two things**, and a fetch that is neither is
refused:

1. A `.well-known/agent-skills` entry whose `sha256:` digest verifies against
   the fetched bytes. Verification is fail-closed: a mismatch yields nothing,
   not a warning.
2. A GitHub URL bearing a full commit SHA. The tree a commit names is
   immutable, so the SHA is the content address the registry could not give
   us.

A skills.sh id alone is **not** a pinned address. Resolving one into a pinned
address — reading the source repository, choosing a commit — is a discovery-side
step whose output is an address, and the acquiring child fetches only the
address, never the id.

**Gate on the parse, never on the status.** `https://www.skills.sh/.well-known/agent-skills/index.json`
returns the site's HTML 404 page with **status 200**. A client that tested
`response.ok` would treat a missing index as a present one. This is the same
class of defect as any well-formed successful response standing in for the
one that was asked for, and the rule is general, not specific to this host:
**a fetch is a hit when the payload parses into the shape we required, and at
no earlier point.** The vendor's CLI survives this by parsing JSON and failing
by accident; a check that holds by accident is not a check, and ours states it.

### Instructions-only is enforced on the payload, not assumed of the source

CT-2106 lists "we do not execute skill scripts fetched from it" as a non-goal,
phrased as though a fetched skill simply is instructions. It is not. Per the
Agent Skills specification a skill is a **directory** — `SKILL.md` required,
with optional `scripts/` (executable code), `references/`, and `assets/` — and
the registry's download endpoint returns whatever files the snapshot holds. An
unenforced assumption about what arrives is not a boundary.

Enforcement lives in the acquiring child's write step, at the single point
where fetched bytes become a cell value, and it is a **whitelist on paths, not
a blacklist on names**:

- Exactly one file is admitted: the `SKILL.md` at the skill root. Its text is
  what the cell holds.
- Any other path in the payload causes the acquisition to **refuse**, naming
  the count and the offending paths, rather than to succeed while quietly
  dropping them. Silently discarding scripts would make "instructions-only"
  true of the cell and invisible in the record, and the operator reading that
  record could not tell a plain skill from one that arrived carrying code.
- The refusal is the honest outcome because a skill whose instructions
  reference `scripts/foo.py` is not the same skill without it. Admitting the
  prose alone yields a skill that will instruct the model to run something
  that is not there.

Two structural properties back this up rather than duplicating it. A
handle-delivered skill **bypasses the registry entirely**, and
`run_skill_script` resolves its target by name against the registry
(`skills.find((skill) => skill.name === name)`) and requires a match against
the run-start registry digest — so a transient skill has no record for a
script to resolve through. And `isSkillScriptAllowlisted` returns `false` for
an absent or empty allowlist, so the operator allowlist defaults to refusing.
The path whitelist is the first of three, and the only one that is about this
plan rather than inherited.

## Part 3 — Integrity labeling: where it came from, on the value

CT-2106 says CT-2068's "where it came from" dial "has no mechanism yet".
Checked in code, that is wrong in a way worth stating precisely, because it
changes what this plan has to build.

**The labeling half exists.** `packages/runner/src/cfc/external-ingest.ts`
mints an `ExternalIngest` provenance mark on a durably-appended value.
`CFC_ATOM_TYPE.ExternalIngest` is classified as `provenance` in
`atom-classes.ts`. The design is a **split-mint**: every field of the mark
comes from the trusted operator-side helper and none from the presenter's
payload, "which is what makes the mark honest: the mint derives only from this
metadata, touching zero attacker bytes". The trigger is a module-private
`WeakMap` keyed by transaction, deliberately not a field on `CfcTxState` and
not a method on the public transaction surface, because exposing it would be a
forge oracle — any pattern reaching `cell.tx` could stamp a trusted "arrived
via channel X" mark on its own writes. It is documented in
[`../features/vouched-ingest-channel-mint.md`](../features/vouched-ingest-channel-mint.md).

That is exactly the shape this part needs, and the reason is the same one: the
metadata we want on a fetched skill — which registry, which pinned address,
which digest, when — is all known to the trusted fetcher and none of it should
be read out of the fetched bytes.

**What is missing is the declassification direction**, not the labeling.
CT-2068's proposal is that an integrity fact ("this came from a static,
digest-pinned skill served by a policy-trusted source") can be converted into
releasing some classes of taint, sitting beside `schemaAllowsRawString` in
`packages/runner/src/cfc/structured-result.ts` as an integrity predicate next
to a shape predicate. Nothing implements that today.

**This plan is a consumer of the first half and deliberately not of the
second.** A skill acquired here carries a provenance mark saying it came from
an external registry with an untrusted origin. That mark **declassifies
nothing**. Its entire job is to make acting under an untrusted skill's
influence a legible, gate-able event: rendered by the CFC-legibility console
work, and available to refusal gates. If we ever want the converse — an
integrity fact that *permits* something — that is CT-2068's declassification
work and it should be built deliberately, with this as its driving use case
rather than its first quiet exception.

Recorded alongside the mark, because they are what a later reader will want:
the pinned address fetched, the verified digest, the verification method
(`well-known-digest` or `git-commit-sha`), the discovery id that led here if
any, and the fetch time. The digest is the verified one, not the registry's
`hash` — which is not recorded as a digest at all, because recording an
unverified server assertion in a provenance field is how it later gets read as
a verified one.

## The ranking signal, theirs and ours

skills.sh's index is populated by **unauthenticated client telemetry**. Its
FAQ says skills appear "automatically through anonymous telemetry when users
run `npx skills add`", and in the CLI's source that telemetry is a bare `GET`
with query parameters and no credential. **Install count — the leaderboard's
ranking signal — is therefore forgeable by anyone who can make an HTTP
request.** We must not import it as a trust input. It may be shown to a model
as what it is, a popularity number of unknown provenance; it may never gate,
rank-for-selection, or stand in for review.

The same registry's terms disclaim exactly the property we would want the
number to supply: *"we cannot guarantee the quality, safety, correctness, or
security of any skill listed here."* And its audit endpoint, which returns
verdicts from five third-party scanners, carried audit dates four to five
months stale against the survey — which by itself argues the verdicts are not
re-run when a skill changes, and so cannot be read as current.

**The uncomfortable half: our own index has the same structural weakness.**
The pattern index ranks on a weighted sum over event counts whose types are
`created`, `instantiated`, `run_succeeded`, `run_failed`, `thumbs_up`,
`thumbs_down`. Every one of those events is emitted by the harness about its
own run, and `record_feedback` has never been called — so the thumbs weights
are inert, as
[the seed-and-quality report](../history/packages/cf-harness/pattern-index-seed-and-quality-2026-08-28.md)
records. Our score is therefore "an agent started it and nothing threw"
wearing the clothes of a quality judgement. It is the same mistake as
skills.sh's, minus the adversary — and a neighbouring system making it *with*
an adversary attached is the argument for not repeating it. The lesson
transfers in both directions: do not import their ranking, and do not present
ours as more than it is.

One asymmetry is in our favour and worth keeping: a `patternId` **is** a
content-addressed entry identity — `computeEntryIdentity` over the same `main`
and files — so the same source published twice is the same entry. Our index
has the property skills.sh's lacks. That is the bar the acquisition side of
this plan is trying to reach, not a bar it already clears.

## Dependencies, as they actually stand

Checked in code rather than in the tracker, because both entries were wrong
there.

- **CT-2084 (`skillHandle`) — landed**, on `main`, PR #6340, `85d4b6f4c9`,
  with tests including refusals for a handle the run does not hold, a run with
  no fabric session, and a non-string value. Reads Triage in the tracker;
  commented there.
- **CT-2078 (acquisition by handle) — Done**, and it is the proof that the
  acquiring/using decomposition needs no new machinery.
- **CT-2068 — half available.** Provenance minting exists (above);
  integrity-based declassification does not. This plan needs only the half
  that exists.
- **The registry's undocumented routes — a standing risk, not a dependency.**
  `/api/search` and `/api/download` are the routes the vendor's CLI uses and
  the routes any integration would use, and neither is documented or
  versioned. The documented API describes something else and is closed to us:
  it authenticates only via a Vercel OIDC token, obtainable only by a Vercel
  deployment. A change to either route breaks discovery with no notice and no
  standing to object.

## Staging

1. **`search_skills`, read-only, not registered.** The client, the
   sanitization, the shape refusals, and tests against recorded fixtures. No
   tool-registry entry, so nothing can call it yet.
2. **Address resolution.** Turning a discovery hit into a pinned address, or
   refusing. This is where the honest answer is often "no pinned address
   exists for this hit", and that refusal is the feature.
3. **Verified acquisition.** The `.well-known` digest path and the commit-SHA
   path, both fail-closed, with the single-file payload whitelist and its
   refusal. Write into a cell, return a handle.
4. **The provenance mark**, minted split-mint style on the acquiring write.
5. **Register `search_skills`** and wire the end-to-end path, with an
   adversarial run: a skill whose text attempts to make the child exfiltrate,
   and a canary proving the payload never reached the parent's context.
6. **The mirror.** The registry's terms explicitly encourage it —
   *"caching results on your own infrastructure, is encouraged and not
   restricted"* — and CT-2068 already names a mirror as the destination and
   "trusted not to log" as the interim. A mirror removes third-party egress
   from acquisition entirely, which is the only thing that actually closes the
   search-query channel Part 1 leaves open.

## What this plan does not do

- It does not execute anything fetched, and it does not extend the operator
  script allowlist.
- It does not retire the trusted operator `--skills-root` path.
- It does not build CT-2068's declassification predicate, and nothing here
  should be taken as a precedent for an integrity fact granting permission.
- It does not close the search-query channel. Stage 6 does; until then a
  parent that has read a secret and then chooses a query is a channel, and
  that is a known, stated gap rather than a solved problem.
- It does not make the registry trustworthy. Nothing here is a claim about
  the quality or safety of anything skills.sh lists — the registry itself
  makes no such claim, and this design's whole shape is what it costs to
  consume something that makes none.
