# Surprising implications of CFC

Contextual Flow Control (CFC) is information flow control: every value carries
a label saying where it came from and who may see it, code that reads a value
takes on its label, and trusted boundaries refuse a flow the label does not
permit. Several consequences of that design run against habits learned from
access-control systems and from ordinary web frameworks, and agents designing
patterns or components get them wrong in the same ways again and again. This
page lists those consequences, most frequently missed first, so that a design
review can point at one.

The CFC specification is the authority on every point here; this page links to
it and does not restate it. Section numbers (§) refer to it, and
[`../../development/cfc-spec-correspondence.md`](../../development/cfc-spec-correspondence.md#where-the-specification-lives)
says where it lives. Where the runtime departs from it,
[`../../specs/cfc-conformance-statement.md`](../../specs/cfc-conformance-statement.md)
lists the departure. Each item ends with its status: **Runtime** means this
runtime does it today under its shipped defaults, **Partly** says which part,
and **Spec only** means the specification requires it and the runtime does not
yet check it.

1. **Reading is not the leak; flowing is.** A pattern that can reach a value it
   "should not" see, through `wish()` or a link it was handed, has not caused a
   breach: the value's label comes with it, everything the pattern derives from
   it carries that label, and the sinks it could leak through (display, a write
   to a store with a weaker label, egress) refuse. The guarantee is that labels
   are correct, not that reads are prevented, so the failure that matters is a
   value written with a label weaker than its content, and a design that
   prevents the read instead of labeling the data is solving the wrong problem.
   Some boundaries do refuse a read outright, such as a row-set read over rows
   the reader cannot see (§8.17.2); see also §3.1.4 and §8.12.4.
   _Partly:_ label propagation, the shell's display ceiling, and the
   store-write check are enforced by default. Network egress refuses only under
   the opt-in `max-enforcement` posture, the `agent` builtin refuses beyond a
   ceiling the pattern itself declares (`packages/runner/src/builtins/agent.ts`),
   and LLM calls are not gated at all
   (`packages/runner/src/cfc/sink-inventory.ts`,
   [`cfc-enforcement-matrix.md`](../../specs/cfc-enforcement-matrix.md)).

2. **Patterns cannot read the DOM, so they cannot measure what was drawn.**
   Pattern code runs in a worker, inside an SES compartment, and produces view
   nodes that the renderer turns into DOM on the main thread; it cannot read
   the DOM back, query layout, or observe what was drawn. What reaches it is
   what trusted renderer code chooses to send: an event's allowlisted fields
   and `detail`, and the writes a `cf-*` component makes to a cell bound with
   `$prop`. So "the pattern could measure the layout" is the wrong worry, and
   "a component forwards a content-dependent measurement, in an event or a
   bound cell" is the right one: `cf-vscroll`, for example, sends
   `scrollHeight` with every `cf-scroll`, which depends on how much content it
   rendered. A `cf-iframe` guest is the exception, pattern-authored code with a
   DOM of its own, and it is handed only what the display ceiling admits.
   _Runtime:_ `packages/html/src/main/events.ts` (the fields an event carries),
   `packages/html/src/main/applicator.ts` (bound cells),
   `packages/ui/src/v2/components/cf-vscroll/cf-vscroll.ts`.

3. **`cf-*` components are trusted code; patterns are not.** A component runs
   on the renderer side and can read and draw a cell that the pattern embedding
   it holds only as a reference and never reads, so the pattern's outputs are
   not tainted by what the component shows. `<cf-input $value={cell}>` is the
   everyday case; once the user edits it, the component writes the cell, and a
   pattern that later reads the cell takes on its label. That makes a component, not a pattern, the place for UI that
   must show data its host may not see, and it makes every event field a
   component emits a decision to release something to the pattern. The
   component's own reads still go through the display ceiling (item 5), so
   being trusted does not let it show the user what the user may not see.
   _Runtime:_ `packages/html/src/main/applicator.ts` (binding a cell to a
   component), `packages/runtime-client/src/backends/host-read-gate.ts`. The
   specification places the UI runtime in the trusted computing base (§9.2.1).

4. **Composition already gathers; it needs no registry.** A parent that
   instantiates sub-patterns holds their results and reads their outputs
   directly, and reading a sub-pattern's labeled output taints the parent
   exactly as any other read does. Designs keep inventing a collector, a
   registry, or a broadcast channel to gather what children produce, when
   composition hands it to the parent with the labels already right. Passing a
   child's output along as a reference, without reading it, does not take on
   the output's content label, which applies at dereference; the reference's
   own label still flows, and so does any secret that chose which reference to
   pass (§8.2.4, §8.13.4).
   _Runtime:_ a child's result is an ordinary document whose label is the
   child's flow join, read like any other; the runtime does not yet claim the
   precise reference profile (section 3 of the
   [conformance statement](../../specs/cfc-conformance-statement.md)).
   [`../patterns/composition.md`](../patterns/composition.md) covers the
   mechanics.

5. **Rendering is a sink, and the viewer is the audience.** Showing a value on
   screen is a flow to the person looking, checked like any other: the default
   display ceiling admits the acting user's own data, plus shared-space data
   through verified membership, and anything else renders as a redacted
   placeholder. A pattern cannot declassify for display on its own say-so, so
   "it's only shown, not sent" is not an exemption, and a value one user may
   see can still be refused when another user opens the same piece (§8.10.6).
   _Partly:_ the shell installs the ceiling and refuses author-supplied
   display declassification, on by default with a per-profile opt-out
   (`cfcRenderCeiling`, `packages/lib-shell/src/runtime.ts`); another host
   embedding the renderer gets no ceiling unless it sets one
   (`packages/html/src/worker/types.ts`,
   `packages/runner/src/cfc/default-display-ceiling.ts`).

6. **Taint is per action, not per value.** The runtime joins the
   confidentiality of every read an action, `computed()`, or handler makes and
   stamps that join on every write it makes, so one unrelated secret read in a handler taints all of
   its outputs. Splitting work that reads sensitive data from work that does
   not, into separate computations, is what keeps the second one clean. The
   specification's conservative program-counter label is the same join of
   every observation, with narrowing reserved for trusted precision claims
   (§8.9.2).
   _Runtime:_ `deriveFlowJoinImpl` in `packages/runner/src/cfc/prepare.ts`;
   per-value tracking is designed and unscheduled
   ([`cfc-value-level-provenance.md`](../../specs/cfc-value-level-provenance.md)).

7. **Whether something happened is as secret as what made it happen.** A read
   that only decides a branch, or whether to write at all, still taints the
   result, and a computation re-run because a cell changed carries the label of
   the cells that triggered it. A notification, a wake-up, or a badge count is
   therefore as confidential as the data that caused it, and an agent that
   treats "just a ping, no content" as safe to publish has leaked the existence
   of the content (§8.9.2, §8.11.3, invariant 9).
   _Partly:_ trigger reads always join the program-counter label, and
   `cfcTriggerReadGating` (on by default) also counts them at sinks and
   integrity gates; the residuals are in section 7 of
   [`cfc-conformance-statement.md`](../../specs/cfc-conformance-statement.md).

8. **A "trusted gesture" today is a real click on a surface the pattern names
   itself.** The renderer marks an event trusted only when the browser reports
   a real user action, and takes the surface it came from from `data-ui-*`
   attributes on the element or its ancestors. A plain `<button>` or
   `cf-button` without them carries no UI provenance, so it cannot satisfy a
   contract that names `trustedPattern` or `requiredEventIntegrity`, though a
   contract naming neither accepts any real click. Those attributes,
   `data-ui-event-integrity` included, are ordinary JSX that any pattern can
   write, and a UI contract's `trustedPattern` is compared with that string
   with no check of which piece or code rendered it. The specification binds a gesture to
   the render and snapshot that produced it (§3.8.1, §6.3), which the runtime
   does not yet do, so do not rely on a surface name to prove which code drew
   the button.
   _Partly:_ `packages/html/src/main/event-provenance.ts`,
   `packages/runner/src/cfc/ui-contract.ts`.

9. **Endorsement adds evidence; it never removes a restriction.** Integrity is a
   set of claims a value has, starting empty, and endorsing a value adds a
   claim; it does nothing to confidentiality, which only an exchange rule
   releases (§3.1.6.2, §3.7.2). Combining values keeps only the claims they
   share, and most claims are bound to the exact value, so any transformation
   drops them; a trusted value mixed with an untrusted one is untrusted (§8.6.2).
   An agent that "endorses the output to make it safe to send" has added a
   claim and released nothing.
   _Runtime:_ `packages/runner/src/cfc/atom-classes.ts`,
   `packages/runner/src/cfc/minted-integrity.ts`; the staging level is
   section 4 of the conformance statement.

10. **Changing the code changes who may write.** A handler's write authority is
    its identity, the content hash of the module plus the symbol, so any edit to
    the source re-identifies every handler in it, and rebinding the code is
    re-authorization, not inheritance (§8.15.6). After a `setsrc`, a field that
    names its writer with `writeAuthorizedBy` refuses the new version's writes
    unless the update was authorized with the old version named as predecessor.
    _Partly:_ enforced for fields that declare `writeAuthorizedBy`
    (`packages/runner/src/cfc/writer-claim-correspondence.ts`,
    `packages/runner/src/cfc/schema-merge.ts`); a cell that declares no writer
    claim has no identity check.

11. **Model output influenced by third-party text stays influenced.** When a
    prompt includes text someone else wrote, such as a message from a contact
    mentioning a party, the output carries a prompt-influence caveat, and
    screening the input or the output for injection does not clear it. Only
    evidence bound to the same source and sink, such as a disclosure the user
    saw, discharges it, and choosing a destination or recipient needs stronger
    evidence still (§8.10.5, §10.1). Screening does clear the separate
    injection-risk caveats; it is the influence caveat it cannot clear. The
    caveat is a confidentiality marking, not a missing integrity claim.
    _Spec only_ for minting the caveat: the runtime stamps model output with its
    prompt's flow join and the `LlmDerived` integrity atom
    (`packages/runner/src/cfc/llm-derived-stamp.ts`), a caveat already on an
    input propagates, and the discharge rules are installed only under
    `max-enforcement` (`packages/runner/src/cfc/standard-profile.ts`).

12. **Release is the data owner's decision, one clause at a time.** Code does
    not declassify by deciding to: a release needs an exchange rule with the
    authority of the principal whose clause it removes, and removing one
    principal's clause leaves every other clause in place (§5.3.3, invariants 3,
    11 and 15). A design where a pattern "decides the user meant to share it" is
    missing the rule that would let it.
    _Partly:_ exchange-rule evaluation is on by default
    (`cfcPolicyEvaluation`), and no deployment policy records ship; what
    releases by default is module-authored policy acting on its own home clause
    and the space-membership rules at a display boundary
    (`packages/runner/src/cfc/policy-resolver.ts`,
    `packages/runner/src/cfc/space-membership.ts`).

13. **Untrusted input must not choose what is released, to whom, or when.**
    Every parameter that sets a release's scope, selection, destination,
    audience, or trigger must carry the integrity the policy requires, so a
    recipient address or a send time taken from an incoming message cannot
    steer a release even when the release itself is permitted (§3.8.4). A
    reader list computed from stored content counts as an
    audience parameter (invariant 7).
    _Spec only._

14. **Nothing may endorse on a branch that depends on a secret.** An endorsement
    decision that compares against data the endorser cannot see leaks that
    data through whether the endorsement happened, so such a decision fails
    closed instead (§3.8.5, invariant 8).
    _Spec only._

15. **Counting or filtering rows you cannot read leaks them.** A count, a
    total, or an empty result over rows outside the reader's clearance reveals
    that they exist, so a derived output over them is tainted by them, and
    silently skipping unreadable rows is a release that a policy has to permit
    (§8.17.1, §8.17.2, invariant 14).
    _Partly:_ SQLite row-label reads implement the opt-in clearance path
    (`packages/runner/src/builtins/sqlite/row-label-read.ts`).
