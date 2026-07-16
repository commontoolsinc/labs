---
status: historical
created: 2026-07-15
archived: 2026-07-15
reason: "Adversarial verification panel over the C1 (user lanes) work-order decomposition; four lens-diverse skeptics plus a code-verifying synthesis judge. All 25 deduped findings confirmed, none refuted; drives the C1 plan amendments of the same date."
---

# C1 work-order decomposition: adversarial review verdicts

Four skeptics (lenses: authority/confidentiality, hidden engine contracts,
client routing/reconnect/mixed-fleet, executor replica isolation) attacked
the C1 table of implementation-plan.md Phase 4 against the design doc and
the code at branch head `10a2947d9`; a synthesis judge re-verified every
cited seam before grading. 42 raw findings deduplicated to 25; all
confirmed. The amendment list below was folded into the plan's C1 table in
the same change that archived this report.

## Synthesis summary

All 25 deduped findings from the four skeptics survive verification against the code; none is refuted (two carry small corrections: an exported resolveScopeKey does exist for the encoding finding, and C1.6's sketch acceptance is narrowly satisfiable through the floor-narrowed corner). Three blockers make the C1 table unbuildable or unsound as written: (1) the lane-scoped READ seam has no owner anywhere — every server read path (#scopeContextForSession into graph.query/watch/snapshots/writersForTargets, plus schedulerApplicableContextKeys and the scopeKey-less sync frames) resolves under the sponsor, so C1.5b/C1.9 cannot be built and a lane would read the sponsor's scoped instances; (2) no work order ever checks the lane principal's WRITE capability — fence, claim issuance/renewal, and ACL reconciliation are all sponsor-keyed, so a revoked principal's lane keeps committing as her; (3) design §2's issuance-time routing-disjointness invariant and revoke-before-issue ordering appear nowhere, while C1's own floor-narrowing guarantees space→user lane moves that create dual-live-claim and orphaned-claim windows. Twelve serious gaps follow the same pattern of required mechanisms without owners or WO text that contradicts verified code seams: the ["space"]-pinned accepted-commit wake lookup, the four-role ApplyCommitOptions.principal, the C1.4 admission-order/one-lane-per-commit contract, the unspecified cross-package link-shape backstop, the sponsor-keyed builtin gates vs resolved OQ6, the C1.5a→C1.7 rank-dial exposure window, the missing session component in C1.6's accept set, the too-late cohort-fence locus, issuance/renewal never validating lane grants, the measurement guard's one-cause hard-zero vs new by-design drain causes, the uncounted ProtocolError twin of claim-context-mismatch, the five un-re-keyed client seams, and the unstated per-lane pending-visibility invariant. Minor items are substrate corrections (sessionsForPrincipal does not exist), encoding/dependency/wording pins, and acceptance-corner clarifications. The amendment list maps each confirmed finding to a precise, minimal change on the existing C1.x rows, adding exactly one new work order (C1.4b, the read seam) — everything else is scope/acceptance text tightening on rows already in the table.

## Verdicts

### [CONFIRMED / blocker] Lane-scoped READS have no owning work order — every server read path resolves scope through the sponsor-bound session context (authority #2, engine-contracts #1, executor-replica #1)

*Work orders:* C1.4, C1.5a, C1.5b, C1.8

Verified end to end: #scopeContextForSession (server.ts:2976-2999) returns the bound executor session's principal — which bindExecutionSession (server.ts:1826-1835) forces equal to lease.onBehalfOf, the sponsor — and every read surface consumes it: graph.query (5009), listSchedulerActionSnapshots (5070-5082, filtered by schedulerApplicableContextKeys of the sponsor per 233-249), writersForTargets (5158-5180, target scopeKey resolved under sponsor at 5168), watchSet (5246-5251). `actingContext` appears nowhere in packages/ (repo grep). EntitySnapshot (v2.ts:342-348) and AcceptedCommitNotice.revisions (v2-host-provider.ts:55-60) carry declared scope only — no resolved scopeKey — so the C1.5b re-keyed replica cannot attribute sync frames per lane. Design requires reads under the acting principal (context-lattice-execution.md:235-238, 471); the C1 table gives C1.4 commits only and C1.5b Worker internals (implementation-plan.md:1766, 1768). As decomposed, a lane either reads the sponsor's user-scoped instances (confidentiality/correctness failure the commit firewall cannot catch) or gets empty results; C1.5b and C1.9 are unbuildable without this seam.

### [CONFIRMED / blocker] No work order validates the lane principal's WRITE authority — commit fence, claim issuance/renewal, and ACL reconciliation are all sponsor-keyed (authority #1, engine-contracts #6, client-routing #2)

*Work orders:* C1.3, C1.4, C1.8, C1.9

Verified: the commit-path ACL check uses session.principal = sponsor (server.ts:4677-4682); the lease-fence authorize closure resolves capability for session.principal only (3012-3028); claim issuance and renewal check #executionSponsorCanWrite for the sponsor/demand only (3352-3358, 3477-3486); #revokeDeauthorizedSessions fires on READ loss only (1664-1682) and #drainIneligibleExecutionLeases inspects lease sponsors only (2508-2536); the aclTouched reconciliation block (4807-4826) has no lane analog. Design demands lane commits be validated 'identical to the same commit arriving from that user's client' (context-lattice-execution.md:258-261). C1.3 names liveness anchoring only, C1.4 names forged-assertion rejection only. Result: a READ-only or mid-run WRITE-revoked principal's lane keeps committing durable writes recorded as her acting context under the sponsor's capability — authority amplification the moment C1 turns on.

### [CONFIRMED / blocker] Design §2's routing-disjointness invariant and revoke-before-issue lane-move ordering have no owning work order (client-routing #1, engine-contracts #4, executor-replica #2, authority #10)

*Work orders:* C1.1, C1.3, C1.5a, C1.6

Verified: claim liveness is keyed by the full ActionClaimKey including contextKey (server.ts:3319, 3378-3381; actionClaimMapKey at v2.ts:394-396), so space and user:alice claims for one action coexist freely; the executor's host map uses the same key (candidateKey = actionClaimMapKey, deno-space-executor.ts:254-255) and claim releases vs candidate admissions run on independent serialization chains (574-577 vs #handleCandidate), making revoke-before-issue accidental; renewal revalidates only lease/sponsor/demand (3477-3486). 'disjoint' and 'revoke-before-issue' appear nowhere in the plan (grep). Triggering is C1-internal and guaranteed: fresh floors default to space (engine.ts:5786) and any principal's runtime evidence narrows the global floor (5992-5993), so space→user narrowing lane moves happen during C1 itself. C1.6's chain matching would then match two live claims with no defined tie-break, and an issuance racing a lane drain leaves an orphaned claim that executor renewal keeps alive — clients suppress forever with no executor settling.

### [CONFIRMED / serious] Accepted-commit wake lookup is hard-pinned to applicableExecutionContextKeys ["space"] and no C1 work order widens it (authority #3, engine-contracts #3, executor-replica #5)

*Work orders:* C1.8, C1.5a, C1.3, C1.9

Verified: server.ts:3799-3801 pins ["space"] ('Scoped rows remain client-primary until delegated contexts arrive') into staleReadersForTargets, whose engine side filters rows by that set (engine.ts:4284-4291) while commit-time dirty marking is already cross-context-correct (findSchedulerReadersForWrite matches by read_scope_key, 4196-4230). Both wake directions are exclusively driven by the filtered staleDemandedReaders: parked wake (shared-execution-pool.ts:471 suppresses on empty) and live invalidation (executor-worker.ts:513-538, identity includes executionContextKey per scheduler-wake-identity.ts). demandedSchedulerPieceIds is a space-global union with no per-principal pairing (3766-3772). Design §7 names 'wake queries keyed by contextKey' in the server/engine row (472); no C1 row's title or acceptance covers this callsite — C1.5a is executor-side, C1.8 is demand/lifecycle. Consequence: user-lane derivations compute once at demand pull and never again; silent zero-recompute in the Phase 2.5 lunch-poll shape, discovered at the stacked C1.9 gate at best.

### [CONFIRMED / serious] ApplyCommitOptions.principal plays four roles (lease fence, scope resolution, provenance onBehalfOf, writer sessionKey); C1.4's 'scopeContext bound to the lane principal' collides with all of them (authority #6, engine-contracts #2)

*Work orders:* C1.4, C1.5b, C1.10

Verified: sessionKey = resolveCommitSessionKey(sessionId, principal) and scopeContext = {principal, ...} derive from the same option one line apart (engine.ts:7187-7188); the fence requires options.principal === lease.onBehalfOf or throws 'lane-principal-mismatch' (3614-3623); provenance.onBehalfOf is options.principal (7991-7999); pending reads resolve strictly by that sessionKey (7844-7852); the server feeds all of it from session.principal (4774-4783). Rebinding wholesale to the lane principal trips the fence on every user-lane commit; a partial rebind silently fragments the shared Worker session's pending-read localSeq namespace by lane (cross-lane pending references on shared broad docs then fail 'pending dependency not resolved' — the companion-invariant failure family, design 177-190) or mis-attributes writer identity for echo/adoption. None of the four roles is named in C1.4's row.

### [CONFIRMED / serious] C1.4 leaves the acting-context validation order and one-commit-one-lane constraint unstated — state-dependent validation currently precedes every claim/fence check (authority #5)

*Work orders:* C1.4, C1.5b

Verified ordering in applyCommit: validateCommitPreconditions (engine.ts:7263), validateConfirmedReads + resolvePendingReads (7295-7302, per-address ConflictErrors with seq details at 7849-7851/7869-7872) all execute before the claim-not-live check (7953-7960), the firewall (7344-7351), and the fence (7353-7360). Server-side scopeContext assembly (4707) is independent of live-claim resolution (4716), and #executionClaimsForCommit maps claims per localSeq (3032-3084) while applySchedulerObservationBatchCommit applies one {principal, scopeSessionId} across all items (8441-8489) — so nothing forbids one commit or batch asserting two lanes' claims under a single scopeContext. If C1.4 derives actingContext from the asserted contextKey without pinning the order, scoped-state evaluation precedes grant rejection (an error-shape probe against the C1.2/C1.5b confidentiality boundary), and mixed-lane batches corrupt or wholesale-reject.

### [CONFIRMED / serious] C1.2's broad-instance scope-naming-link backstop is unspecified where it must be exact, and the link format is runner-private — memory has no link awareness (authority #7, executor-replica #6)

*Work orders:* C1.2, C1.9

Verified: output-scoping writes createSigilLinkFromParsedLink at the broad address (pattern-binding.ts:294-299; runner.ts:3919-3925 passes resultCell.getAsLink(), which pins overwrite:'this' — cell.ts:2062-2074 — vs the design's 'self-redirect link' prose at 288-297); link payloads legally carry a `schema` field holding an arbitrary FabricValue (sigil-types.ts:23-40) — a per-lane covert channel if the predicate merely checks 'is a link'; the current firewall has no value-shape checks at all (engine.ts:5644-5682 validates addresses/coverage only); and @commonfabric/memory imports only leb128/sqlite/plug/otel with zero sigil/link code (deno.jsonc, grep) — so the engine predicate C1.2 must write has no accessible format definition. Fail-closed rejects every legitimate lane output-widening (C1.9 fails); fail-open voids §4's byte-identical-across-lanes soundness argument.

### [CONFIRMED / serious] Builtin causal-actor/sponsor gates at three sites contradict resolved OQ6 for scoped lanes, and no C1 work order owns effects vs computations for user-rank claims (authority #8, executor-replica #3, engine-contracts #11)

*Work orders:* C1.1, C1.5a, C1.5b

Verified all three sites: the host pre-claim gate drops builtin candidates when causalActorMatchesSponsor !== true (deno-space-executor.ts:603-612), the Worker egress guard rejects and records a PERMANENT builtin failure (executor-worker.ts:631-641), and the boolean compares origin.principal to lease.onBehalfOf — the sponsor (server.ts:1771-1791, v2-host-provider.ts:412-433). Design resolves that scoped-lane egress rides the lane grant with no causal-origin check, the sponsor-match rule confined to the space lane (context-lattice-execution.md:216-229, 572-579). The C1 table has no broker/egress row and no actionKind restriction on user-rank claims; C1.9's gate is a pure derivation fixture. With sponsor bob and lane alice: alice's own-caused builtins are dropped/negative-cached forever, and bob-caused runs of alice's builtin pass a consent check keyed to the wrong identity.

### [CONFIRMED / serious] The rank-enablement dial lands at C1.7 but user-claim issuance capability lands at C1.5a — the intervening flag-on window is the design's named strictly-worse-than-flag-off state (engine-contracts #7, client-routing #8)

*Work orders:* C1.1, C1.5a, C1.7, C1.9

Verified: #validateExecutionClaimInput already admits user:/session: keys (server.ts:3200-3202); #assertExecutionClaimCapabilityEnabled is actionKind-keyed with no context-rank gate (1381-1400); #sessionAcceptsClaim has no context dimension (2910-2922), so user claims broadcast to every capable session; servability.ts:102's pinned 'space' is the only current inhibitor and is exactly what C1.5a changes; C1.5a's dependency row lists only C1.1 while the dial + subcapability + EXPERIMENTAL_OPTIONS entry all sit in C1.7 ('dial' appears nowhere else in the plan — grep). Between C1.5a and C1.7 landing, flag-on runs issue user claims no client chain-routes (current clients hardcode contextKey 'space', facade.ts:1244): server and every client both execute — the §6 duplicated-compute-plus-write-race (context-lattice-execution.md:426-434) on the continuously measured branch.

### [CONFIRMED / serious] C1.6's accept set omits the client's own session component, diverging from the design's chain rule and re-creating the §6 race for C1-vintage clients at C2 (authority #4)

*Work orders:* C1.6, C1.7

Verified textually: C1.6 says 'accept iff contextKey ∈ {space, user:myDid}' (implementation-plan.md:1769) while the design's chain rule includes session:<my did>:<my sessionId> (context-lattice-execution.md:104-105), and the design names one subcapability — context-lattice-claims-v1 — as what scoped claim delivery and lane opening gate on (425-435), which C2's session lanes would reuse. A C1-built client therefore negotiates v1, is counted as capable when C2 opens session lanes, receives its own session-context claims (C1.7 delivers session events to the session they name), matches none, and races the session lane on per-keystroke state — the exact §6 failure the subcapability exists to prevent, embedded in the fleet until C2 integration. The plan currently chooses neither of the two consistent options (full chain now, or a v2 subcapability at C2).

### [CONFIRMED / serious] Mixed-fleet cohort fence anchored to the demand/watch barrier is later than the earliest possible Phase-2 commit (client-routing #3)

*Work orders:* C1.7

Verified: transact requires only an owned session — no watch or demand (server.ts:901-911); the session.open response is what enables queued-commit replay and carries the claim snapshot (4526-4552); session takeover silently recomputes capability flags from the current attach (session-registry.ts:171-176), so admission includes resume/takeover; the demand-before-replay ordering is a current-client property (client.ts:1099-1112) that old Phase-2 builds — the gate's target population — cannot be assumed to share. The synchronous fence precedent exists (#fenceOwnedExecutionLeaseForLegacyBackground, 2185-2198). C1.7's sketch ('mixed-fleet reconnect drains before racing') permits an implementation at the design's stated demand/watch-barrier locus (context-lattice-execution.md:433-442), which a raw client that transacts immediately after open outruns; a well-behaved test client passes while real old clients race.

### [CONFIRMED / serious] User-rank claim issuance and renewal never validate the lane grant, orphaning claims for departed principals (client-routing #4)

*Work orders:* C1.3, C1.8

Verified: #setExecutionClaim validates only sponsor session/demand/WRITE and re-samples only lease authority after awaits (server.ts:3342-3377); renewExecutionClaim likewise (3467-3486); the host executor renews every claim in its #claims map irrespective of lane state (deno-space-executor.ts:727-785). C1.3's sketch covers drain/fence and stale-generation commits only (implementation-plan.md:1765). An issuance in flight when a drain sweeps claims lands after the sweep and renews indefinitely: the principal's next session chain-matches the orphan, suppresses, and no lane exists to settle — a user-visible hang that fail-open never breaks because the claim stays live.

### [CONFIRMED / serious] C1.3's new lane-drain fence causes collide with the measurement guard's hard-zero contract, which tolerates exactly one cause (authority #9)

*Work orders:* C1.3, C1.9

Verified: the shared measurement assertion subtracts only claim-context-mismatch and hard-zeros every other lease-fence cause plus actionFirewallRejects (server-execution-measurement.ts:599-615); revoked-claim attempts throw claim-not-live (engine.ts:7953-7960); C1.3's acceptance adds 'a new named cause' for stale generations (implementation-plan.md:1765); and user-lane re-anchoring on anchor-session disconnect is normal C1 operation that fences in-flight work (context-lattice-execution.md:246-257). Neither C1.3 nor C1.9 states how the guard's tolerated set accounts for the new by-design causes — so the gate is either flaky or gets loosened ad hoc, erasing its defect-signal value (the R7 lesson without its retirement bookkeeping, R7 at 526).

### [CONFIRMED / serious] The claim-context equality check exists twice with different error classes; the plan's premise names only the fence-classified twin (engine-contracts #5)

*Work orders:* C1.1, C1.2

Verified: the observation-only path throws ExecutionLeaseFenceError('claim-context-mismatch') (engine.ts:8392-8402) while the main with-operations path throws a plain ProtocolError for the same semantic condition (7471-7478); only ExecutionLeaseFenceError feeds leaseFenceRejectCauses (server.ts:4887-4891), so the ProtocolError variant is uncounted and outside the R7 tolerance (measurement 599-609). The plan's premise text names ~8398 only (implementation-plan.md:1758-1759). Reachable under C1: durable per-principal session floors (engine.ts:5995-6001) can evaluate a user-claimed with-operations run to session, producing unclassified protocol failures invisible to the placement guard.

### [CONFIRMED / serious] C1.6 names only the forward routing match; five other exact-key client seams must be re-keyed or dormant-action authority-loss wakes are silently dropped (client-routing #6)

*Work orders:* C1.6

Verified: registered keys hardcode contextKey:'space' (facade.ts:1241-1255); the reverse index, adoption guard, effect capture, forward lookup, and revoke-path invalidation all key by the full actionClaimMapKey (storage/v2.ts:1013-1023, 1054-1056, 1063-1074, 1076-1086, 2281-2292, 4800-4823 resolving through invalidateRegisteredExecutionActions at 5052-5066). README's contract: 'a dormant action between pull consumers must still receive the ordered authority-loss wake' (README.md ~551-553). A user-context claim revoke (lane drain, re-anchor, mixed-fleet fence) finds no registered action and dirties nothing — stale derived state with no counter, passing C1.9 (which keeps actions hot) while failing real navigation patterns.

### [CONFIRMED / serious] Cross-lane pending/shadow visibility on shared documents is an unstated invariant of C1.5b's replica re-keying (executor-replica #4)

*Work orders:* C1.5b, C1.10

Verified: materializedVersionThroughPending applies record.pending in insertion order through a single shared prefix cache with no per-lane filtering (storage/v2.ts:580-603), and shadow-seq bookkeeping is replica-global (1993-1997). Re-keying by effective scope key separates scoped instances but not shared space-scoped docs, which every lane's Runtime re-runs as shadows (design §4 cost model, 312-329); C1.5b's sketch says only 'overlays/rebase correct per lane' and design §7's re-keying list names 'pending versions' without a visibility semantics (470). Lane B's authoritative user-scoped commit can be computed from lane A's unconfirmed speculation of a shared upstream doc — wrong durable data, timing-dependent, invisible to single-lane unit tests.

### [CONFIRMED / minor] Plan substrate claim 'sessionsForPrincipal exists' is false; the nearest primitive is a connection-liveness-blind boolean (all four lenses)

*Work orders:* C1.3, C1.7

Verified: the registry offers only hasOpenSessionForPrincipal — a boolean scan matching space+principal with no ownerConnectionId/#connections check (session-registry.ts:198-212), so detached-but-unexpired sessions count (detach keeps the session with ownerConnectionId=null until TTL, 334-339); delivery loops iterate sessionsForSpace (214-223); repo-wide grep finds sessionsForPrincipal only in the plan (1754, 1770); the correct connected-session predicate exists only at #boundExecutionSessionForCommit (server.ts:2956-2962). C1.7's enumerator, its cohort-gate liveness semantics (do TTL-detached sessions block the lane?), and C1.3's anchoring predicate must all be built and pinned, not reused.

### [CONFIRMED / minor] The canonical user:<did> contextKey encoding is engine-internal and colon-bearing DIDs make naive construction always wrong (client-routing #5)

*Work orders:* C1.1, C1.6, C1.7, C1.9

Verified: keys are built as user:${encodeURIComponent(principal)} (engine.ts:65, 108) with the encoding contract stated only in a comment (80-82); the client parses rank prefixes only (facade.ts:180-187); memory test scaffolding types the suffix as an arbitrary template string (v2-execution-control-test.ts:56); no scope-key constructor is used anywhere in packages/runner (grep). One correction to the finding: resolveScopeKey IS exported from the engine module and the runner already imports from @commonfabric/memory/v2/engine, so a shared constructor exists — the gap is that no WO requires its use and the plan text ('user:myDid') invites naive concatenation, which mismatches 100% of did:key principals. Severity capped at minor because the C1.9 end-to-end gate (zero client derived wire writes) catches a mirror-image bug — at integration rather than unit time.

### [CONFIRMED / minor] C1.6's acceptance at its listed dependency only works through the floor-narrowed space-surface corner; the client-side classifier lane-parameterization has no named owner (engine-contracts #8)

*Work orders:* C1.6, C1.5a

Verified: routeClientActionTransaction runs both classifiers after claim matching (client-execution/action-transaction-router.ts:36-84), and both reject every non-space scope (servability.ts:204-235, 269-293, 344-354). Nuance the finding overstates: a synthetic user:myDid claim over a space-surfaced transaction routes claimed-overlay (the classifiers ignore claim.contextKey), so the sketch is literally satisfiable — but for any genuinely user-scoped transaction the route goes upstream, meaning the real C1 behavior (own-user claim on a PerUser action suppresses locally, required for C1.9's zero-derived-writes gate) needs classifier lane-parameterization that only the build note's 'shared servability.ts seams' hints at, without owner or acceptance.

### [CONFIRMED / minor] C1.1's acceptance ('user claim commits at resolved user context') is reachable only through the pre-narrowed-floor corner while the C0 firewall still rejects every user-scoped surface (client-routing #9)

*Work orders:* C1.1, C1.2

Verified: assertExecutionActionTransaction rejects non-space resolution on every surface class — summary/observation addresses, preconditions, confirmed/pending reads, operations (engine.ts:5491-5507, 5543-5556, 5570-5581, 5600-5642, 5652-5660) — and C1.2 (the firewall WO) depends on C1.1, not vice versa. The one reachable path: durable floors fold into the effective context independently of the run's surfaces (globalFloor at 6004-6011, narrowed to user by any principal's evidence at 5992-5993), so a pre-narrowed floor with all-space run surfaces commits at user context. Unstated, this corner either drags firewall changes into C1.1 ad hoc or waters the acceptance down.

### [CONFIRMED / minor] C1.7 must name #sessionAcceptsClaim as the single delivery predicate or reconnect snapshots leak other principals' user claims (client-routing #7)

*Work orders:* C1.7

Verified: one predicate (server.ts:2910-2922, currently capability-only with no context dimension) feeds all four delivery surfaces — snapshot claims via #executionClaimsForSession (2935-2945, consumed at 3153-3155), live publish (3111), retained events (3141), and settlement frontiers (3159-3166). A C1.7 filter added only at #publishExecutionControl leaves reconnect snapshots delivering every principal's user-context claims and frontiers to every session — metadata leak plus the O(sessions x actions) snapshot growth the design's scoping exists to prevent (118-126) — and nothing fails loudly because chain-scoped matching discards the junk.

### [CONFIRMED / minor] C1.5a's 'laneKey gains contextKey' names the wrong seam — the only extant laneKey is the pool slot key owning the lease (engine-contracts #10, executor-replica #8)

*Work orders:* C1.5a

Verified: laneKey exists solely in shared-execution-pool.ts (191-192) keying #slots (287, 408), each slot owning one Worker and one durable lease; leases are per (space, branch) (v2.ts:432-442); the design keeps one Worker hosting multiple lanes under one lease (context-lattice-execution.md:89-93, OQ5 at 566-571). A literal reading of the WO title produces one Worker/lease per contextKey — competing leases per space. The intended seam (candidate/claim/wake identity maps; schedulerIdentityKeyForAction already carries contextKey, scheduler-wake-identity.ts:30-44) needs naming.

### [CONFIRMED / minor] C1.5b repeals the stated executor-IPC identity invariant without naming it (engine-contracts #11, IPC half)

*Work orders:* C1.5b

Verified: both channels carry the explicit invariant — 'No principal or actor identity crosses either executor IPC channel' (deno-space-executor.ts:77-79) and 'Raw origin/sponsor principals never cross the executor channel' (v2-host-provider.ts:52-54). Per-lane acting contexts require contextKey-bearing candidates and lane identity (principal DIDs) inside the Worker, so C1.5b necessarily amends these invariants; leaving them unamended sets up review rejections or a confused opaque-index workaround.

### [CONFIRMED / minor] Per-lane demand needs a wire-shape and generation split the C1.8 sketch doesn't name (executor-replica #9)

*Work orders:* C1.8

Verified: demand crosses host→Worker as one flat pieces list under one Worker-global demandGeneration with resetClaims cancelling ALL claimed attempts (executor-worker.ts:71, 79-80, 103, 839-847); candidates are stamped with the global generation (465) and the host drops stale ones (deno-space-executor.ts:595); SpaceExecutor.setDemand takes one flat set (shared-execution-pool.ts:40-42). Per-lane demand aggregation over this shape lets one lane's demand update discard other lanes' in-flight candidates and one lane's reset cancel every lane's claimed attempts — latent claim-latency gaps and C1.9 flakiness. AuthenticatedExecutionDemand already carries the principal for the aggregation (server.ts:453-460).

### [CONFIRMED / note] Phase 4 entry bullet 'without duplicating unscoped computation' contradicts the design's accepted per-lane shadow-recompute cost model (executor-replica #10)

*Work orders:* C1.9

Verified textually: the entry bullet (implementation-plan.md:1734-1736) vs §4's cost honesty ('server compute approaches the sum of client compute'; lanes share replica but not scheduler state, 89-93, 309-329). No C1 WO prunes lane graphs and claim-level dedup does not prevent shadow recompute. A reviewer applying the plan's own playbook can hold C1 to the bullet as written; reconciling the two texts (authority dedup vs accepted compute cost) and measuring per-lane schedulerRuns in C1.9 resolves it cheaply.

## Amendments (as folded into the plan)

1. BLOCKER [reads seam] Add a new work order C1.4b 'lane-scoped read seam' (engine/server/provider protocol), between C1.4 and C1.5b, with C1.5a and C1.5b depending on it: (1) reads, watch registration, listSchedulerActionSnapshots, and writersForTargets from a lease-bound executor session accept a per-request acting context (or per-lane sub-session) that the host validates against the live lane grant and its laneGeneration BEFORE resolving any scope key, rejecting with the C1.3 fence cause in constant shape; (2) EntitySnapshot and AcceptedCommitNotice.revisions gain the resolved scopeKey so the re-keyed Worker replica can attribute sync frames to lanes; (3) schedulerApplicableContextKeys for a lease-bound session derives from its open lane grants, not the session principal. Acceptance: through one sponsor-bound provider session, a read of alice's user-scoped doc under alice's live grant returns alice's instance, never the sponsor's; the same read with a dead or absent grant rejects with the named cause.

2. BLOCKER [lane authority] C1.3: lane-grant creation and every renewal require the lane principal to hold current WRITE capability. C1.4: the user-lane commit fence resolves WRITE for the acting principal inside the same transaction-time authorize, in addition to the sponsor lease checks; user-rank claim issuance requires the lane principal WRITE-capable. C1.8: the aclTouched reconciliation block (server.ts ~4807-4826) gains a third step — fence generations and revoke claims of user lanes whose principal lost WRITE or whose anchor session was removed — under the same awaited publish-before-response discipline as the existing lease drain. C1.9 adds the fixture: revoke the lane principal's WRITE mid-run; the in-flight commit fences and the lane drains before the ACL response releases, with no post-revocation row under her scope.

3. BLOCKER [routing disjointness] Add to C1.1 (or C1.3 — they share the engine.ts/server.ts seam): #setExecutionClaim rejects (or supersedes revoke-first, atomically on the control feed within one synchronous host section) any claim whose (branch, space, pieceId, actionId, fingerprints) tuple has a live claim chain-compatible with the new one — space+anything, and user:p with session:p:* — and renewExecutionClaim re-checks the invariant; lane moves are specified revoke-published-before-issue. Acceptance: a barrier test drives a space→user floor-narrowing move racing the executor's independent release/issuance chains, asserting the revoke event precedes the claim.set event and that double-issuance rejects. C1.6 additionally defines deterministic client behavior if two chain-matching claims are ever observed (route to neither, fail open, counted).

4. SERIOUS [wake widening] Assign the accepted-commit wake lookup explicitly to C1.8 (cross-referenced from C1.5a): #publishAcceptedCommit derives applicableExecutionContextKeys as ["space"] plus the contextKey of every open lane grant on that (space, branch), paired per-lane with that principal's aggregated demanded pieces. Acceptance: bob's space-scoped commit produces a non-empty staleDemandedReaders for alice's user-context reader and a Worker invalidation; a parked (no-lane) principal's rows accumulate dirt without wake (design §4 parked-wake skip).

5. SERIOUS [C1.4 principal split] C1.4 enumerates the ApplyCommitOptions split: the sponsor principal stays bound to the lease fence, the replay sessionKey, and pending-read resolution; a NEW actingContext field feeds resolveScopeKey, effective-context resolution, and CFC label validation; provenance.onBehalfOf stays the sponsor (design §3: onBehalfOf records execution authority, provenance records the acting context); the per-lane writer sessionKey/echo/adoption policy is chosen and tested. C1.10's rebase-replica fixture gains a cross-lane pending-read case (lane B's commit naming a version created by lane A's commit on a shared broad doc).

6. SERIOUS [C1.4 admission order] C1.4 states: (1) the host resolves the asserted lane (claim contextKey) against the live lane grant and generation BEFORE validateCommitPreconditions, validateConfirmedReads, and resolvePendingReads run, rejecting with a constant-shape fence cause regardless of scoped state; (2) one commit — including schedulerObservationBatch — may assert claims of exactly one lane, enforced host-side and respected by the Worker's batching. Both with tests.

7. SERIOUS [C1.2 link contract] C1.2 gains a named pre-step: capture the exact broad-instance write output-scoping emits (pattern-binding.ts createSigilLinkFromParsedLink / getAsLink overwrite:'this') into a fixture, and specify the scope-naming-link wire shape as a spec-level JSON contract with shared conformance fixtures used by both the runner emit tests and the engine accept tests (memory takes no runner dependency). The engine predicate accepts exactly the addressing-fields envelope (id self-consistent/same-space, path, scope, overwrite as actually emitted) and rejects `schema` and unknown keys; set-vs-patch granularity enumerated. Tests: accept-as-emitted, reject-broad-value, reject-schema-bearing-link, byte-identity across two lanes.

8. SERIOUS [effects scope] C1.1/C1.5a state the C1 effect posture explicitly — either user-rank claims are issued for actionKind 'computation' only in C1 (engine guard and executor candidate rank both enforce; effects stay space-lane; a named follow-on WO implements lane-grant egress per resolved OQ6), or C1.5b makes the three causal-actor gates (deno-space-executor pre-claim gate, executor-worker egress guard, originMatchesExecutionSponsor consultation) lane-conditional, applied only when claimKey.contextKey === 'space'. Acceptance names the chosen behavior for a user-floor builtin candidate (not claimed at user rank, or claimed and surviving a foreign-principal-caused recompute with egress under the lane grant).

9. SERIOUS [rank dial] Move the issuance-side rank dial into C1.1 as its first item: register it in EXPERIMENTAL_OPTIONS.md in the same change (default: space rank only), enforce it inside #assertExecutionClaimCapabilityEnabled at issuance and in renewExecutionClaim (revoke-on-disable, mirroring the flag-off revoke at server.ts:3458-3461), with acceptance 'dial off ⇒ byte-identical space-only behavior'; C1.9 flips it to user only inside the gate fixture; C1.7 then folds the dial behind the subcapability as planned. (Acceptable alternative: add C1.6 and C1.7 to C1.5a's dependency row.)

10. SERIOUS [own-chain acceptance] C1.6 either implements the full own-chain acceptance now — {space, user:myDid, session:myDid:mySessionId}, synthetically testable exactly as its dependency note allows — or the plan states today that C2 will mint context-lattice-claims-v2 with its own principal-wide lane-opening gate and R7-style retirement for v1 clients. The WO text picks one.

11. SERIOUS [cohort fence locus] C1.7 pins the mixed-fleet fence locus: inside openSession admission — new, resumed, and takeover attaches alike (capability flags are recomputed per attach) — if the session lacks context-lattice-claims-v1 and its principal has a live user lane in that space/branch, synchronously fence the lane generation and revoke its claims before attachExecutionFeed builds the snapshot and before the open response is sent; the bounded Worker drain may complete asynchronously. Client-side ordering of non-negotiating clients is explicitly out of contract. Acceptance drives the race through a raw protocol client that transacts immediately after open with no watch/demand messages.

12. SERIOUS [issuance grant binding] C1.3: user-rank claim issuance resolves a live lane grant for the claim's contextKey principal and binds its laneGeneration, re-validated after every await (mirroring the existing lease re-sample pattern at server.ts:3321-3336); renewal re-checks grant liveness and revokes on mismatch; the lane drain fences the generation BEFORE sweeping claims so a racing issuance observes the fence. Acceptance: a barrier test where an in-flight trySetExecutionClaim during a drain returns declined and no claim survives the drain.

13. SERIOUS [guard contract] C1.9 (with C1.3) defines the measurement-guard contract up front: enumerate the by-design lane-drain causes (the new C1.3 stale-generation cause; claim-not-live from host drains during re-anchor) as tolerated-with-retirement-criteria mirroring R7 — each named, counted, with the condition for returning to hard-zero — or constrain the measurement fixture to provably re-anchor-free workloads and assert that constraint explicitly.

14. SERIOUS [twin check sites] C1.1 names both context-equality sites (engine.ts ~7471 with-operations ProtocolError and ~8392 observation-only fence cause) and converts the main-path throw to ExecutionLeaseFenceError('claim-context-mismatch') so stats, the R7 tolerance, and executor handling unify (or, second-best, extends the tolerance and executor error mapping to the ProtocolError variant). Acceptance adds a with-operations mismatch case.

15. SERIOUS [client seam list] C1.6 enumerates the complete client seam list re-keyed by chain key (ActionClaimKey minus contextKey): facade registerExecutionAction, #executionActionsByKey and executionActionsForClaimKey, executionClaimForActionKey, hasLiveExecutionClaimForAction, captureExecutionClaim, and the revoke-path invalidation/diagnostics keying. Acceptance: register an action, deliver a user:myDid claim then its revoke while the action is dormant, assert exactly one execution-claim-invalidation wake fires.

16. SERIOUS [per-lane pending visibility] C1.5b states the per-lane read-visibility invariant and tests it: a lane's reads materialize confirmed state plus ONLY its own lane's pending versions (pending versions gain an owning-lane tag; the materialization prefix cache becomes per-lane or lane-keyed), and rebaseUnresolvablePendingReads treats other lanes' localSeqs as unresolvable. Acceptance adds a deterministic fixture: lane B never observes lane A's unconfirmed pending version of a shared space-scoped doc.

17. MINOR [substrate correction] Correct the C1 preamble: only the boolean, connection-liveness-blind hasOpenSessionForPrincipal exists. C1.7 builds sessionsForPrincipal(space, principal) with pinned semantics (sessions attached to a live connection, mirroring #boundExecutionSessionForCommit), uses it for delivery, reconnect snapshots, and the cohort gate, re-evaluates the gate on every attach/resume/takeover, and states whether TTL-detached sessions count (recommend: yes, conservative). Acceptance covers the detached-session case and same-session re-attach with downgraded capabilities. C1.3's anchoring uses the same connected-session predicate plus the WRITE requirement (amendment 2).

18. MINOR [canonical encoding] C1.1 exports/names the canonical user-context key helpers (userExecutionContextKey/principalOfUserContextKey delegating to the engine's encodeURIComponent encoding, or names resolveScopeKey as the required constructor) and requires engine, executor, server delivery filter, and client router to use them. C1.6 and C1.9 acceptance must use colon-bearing did:key principals end-to-end against the real engine, not synthetic string keys.

19. MINOR [C1.6 dependency] Add C1.5a to C1.6's dependency row, or state in C1.6 that it carries the client-side lane-parameterization of both servability classifiers (classifyStaticActionServability and dynamicActionTransactionUnservableReason) keyed by the accepted claim's contextKey, with the space-lane byte-identical regression check applying to both classifiers.

20. MINOR [C1.1 acceptance corner] Rewrite C1.1's acceptance to name the reachable corner — pre-narrow the global floor via a prior client-evidence commit, then commit a user-rank claim whose run surfaces are all space-scoped; assert a mismatched principal still fences claim-context-mismatch — or explicitly move the read-side firewall scope relaxation from C1.2 into C1.1.

21. MINOR [delivery predicate] C1.7 states that the principal/subcapability filter is implemented inside #sessionAcceptsClaim — the single predicate feeding publish, reconnect-snapshot claims, retained events, and settlement frontiers — with user:/session: keys requiring the subcapability and the claim's principal matching the session's under the canonical encoding. Acceptance asserts a reconnect snapshot for principal B contains none of principal A's user-context claims or frontiers.

22. MINOR [C1.5a wording] Reword C1.5a: the intra-Worker lane identity — candidate/claim/wake identity maps and the CandidateClaim message — gains contextKey (schedulerIdentityKeyForAction already carries it); the SharedExecutionPool slot key, the lease topology, and one-Worker-per-(space, branch) are explicitly unchanged (design §2/OQ5).

23. MINOR [IPC invariant text] C1.5b explicitly amends both channel-invariant comments (deno-space-executor.ts:77-79, v2-host-provider.ts:52-54) to: lane identity (contextKey including the principal DID) crosses the executor channels; raw sponsor credentials and session tokens still do not.

24. MINOR [demand wire shape] C1.8's scope names the demand restructuring: set-demand becomes lane-partitioned ({lane → pieces}) with per-lane demand generations and per-lane resetClaims; candidates carry their lane's generation; the pool aggregates per principal from AuthenticatedExecutionDemand.principal.

25. NOTE [entry bullet] Reconcile the Phase 4 entry bullet with §4's cost model: amend to 'without duplicating unscoped AUTHORITY (claims/settlements); per-lane shadow recompute is the accepted §4 cost, bounded by the C2 latency gate', or add an explicitly-deferred lane-graph-pruning WO. Either way C1.9 records per-lane schedulerRuns so the duplication cost is measured, not discovered.
