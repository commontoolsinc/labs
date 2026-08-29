/**
 * Contract breaks the repository has decided to ship.
 *
 * Tier 1's default answer to "this contract cannot be applied over a deployed
 * one" is to change the pattern, and that answer is right almost every time: a
 * new required field wants a `Default<>`, not an exemption. But it is not right
 * every time. A surface can be removed on purpose — the feature behind it is
 * gone, the pieces holding its state are accepted casualties — and then there
 * is no pattern change that satisfies the check, because the check is
 * measuring exactly the decision that was made.
 *
 * `--update` cannot express that: it records only when "not recorded" is the
 * sole finding, so an incompatible contract never reaches a baseline. Deleting
 * the offending baselines cannot express it either — that is the laundering
 * `check-baselines-append-only` exists to stop, and it destroys the evidence
 * that would catch a LATER break against the same contract. So the decision
 * gets written down here instead, where review sees it as a diff.
 *
 * An entry forgives specific `(pattern, baseline)` pairs, and within a pair
 * only the schema paths it names. Both bounds matter. The pair bound keeps the
 * exemption from becoming an off switch over time: the contract recorded once
 * the break ships is a new baseline that no entry names, so the very next
 * change to that pattern is gated again, against the shape the break left
 * behind. The path bound keeps it from becoming one within a single change: the
 * compatibility proof reports every issue it found against a baseline as ONE
 * finding, so forgiving by pair alone would suppress an unintended break that
 * happened to land beside the accepted one — and `--update` would then record
 * that broken contract as the new baseline.
 *
 * Paths are written exactly as the proof names them (`result.crossrefs`,
 * `argument.topics[]`). One limitation is worth knowing: the proof reports at
 * most one issue per role, so where an accepted path is the reported issue for
 * its role, a second problem in that same role can be hidden behind it. Keep
 * accepted paths as few as the removal actually needs.
 *
 * The list can only shrink. A listed pair that no longer produces a finding —
 * because the pattern grew the surface back, or the baseline is gone — fails
 * the run, so an exemption cannot outlive the break it was granted for.
 */
export interface AcceptedContractBreak {
  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;

  /** Baseline labels (filename stems) this pattern may fail to apply over. */
  baselines: readonly string[];

  /**
   * Schema paths this break may blame, spelled as the compatibility proof
   * spells them. A finding blaming anything else stands.
   */
  paths: readonly string[];

  /** Why the break was accepted. */
  reason: string;

  /**
   * Repo-relative path of the decision record under `docs/history/` — the
   * deliberation behind this entry's declaration. Its existence is enforced
   * when either gate runs (`pattern-break-registry-guards.ts`).
   */
  record: string;
}

export const ACCEPTED_CONTRACT_BREAKS: readonly AcceptedContractBreak[] = [
  {
    // ONE entry per pattern, and that is a requirement rather than tidiness:
    // the gate keys accepted pairs into a Map, so a second entry naming a
    // baseline this one also names REPLACES its path set rather than adding to
    // it. Two breaks on one pattern therefore share an entry, and share its
    // single `record`; the other is named in the reason.
    //
    // Carried here: the reference graph rebuilt on cell identity, and the
    // board's demand narrowed to the eight members it reads — which narrows
    // the published projection with it, opens the link and author `kind`
    // domains a closed enum in provided data could never widen, and stops
    // `addLink` requiring the two fields its handler already defaulted.
    pattern: "topics/main.tsx",
    baselines: [
      "20260729T022742Z-31DT95VXuyOj8JeU",
      "20260803T191013Z-jUl4tnb6Dw8LBVJj",
      "20260804T003803Z-4eh5RiQl5phB1jpX",
      "20260806T230301Z-96vyQcPJ2htEfat9",
      "20260807T155936Z-wBGKcf6ruadhes3g",
      "20260807T190842Z-SD0Ii3eK0ZnJnIhs",
      "20260810T212206Z-cIIz70jbLbbPc-F3",
      "20260812T003521Z-Jy37T5qk4KSHkgQe",
      "20260814T233350Z-jHoJZsDa5eUdWU-B",
      "20260817T051200Z-NIE10ssgY89CXloq",
      "20260817T212730Z-3FUPLp4oeb7gwpch",
      "20260817T231646Z-3OsO1miQLNSxm34N",
      "20260818T002831Z-Lk1mtrXcWtEV2FAK",
      "20260818T020120Z-AfZn709Q7YVH7WlZ",
      "20260819T172917Z-ocrU646RD4YKITBc",
    ],
    paths: [
      "argument.topics[]",
      "result.mentionable[].mention",
      "result.crossrefs",
      "result.crossrefs[].fid",
      "result.crossrefs[].commentCount",
      "result.index[].fid",
      "argument.topics[].createdBy",
      "result.index[].createdBy",
      "result.mentionable[].addComment",
      // The unsigned caller retires: `agentName` is required on every verb, and the display-name mirrors that path filled go with it.
      "result.myName",
    ],
    reason:
      "Two accepted breaks on one pattern: the reference-graph rebuild on cell " +
      "identity (docs/history/topics-crossref-identity-break.md), and the " +
      "demand narrowing recorded below.",
    record: "docs/history/topics-demand-narrowing-break.md",
  },
  {
    // ONE entry per pattern, and that is a requirement rather than tidiness:
    // the gate keys accepted pairs into a Map, so a second entry naming a
    // baseline this one also names REPLACES its path set rather than adding to
    // it. Two breaks on one pattern therefore share an entry, and share its
    // single `record`; the other is named in the reason.
    //
    // Carried here: the reference graph rebuilt on cell identity, and the
    // board's demand narrowed to the eight members it reads — which narrows
    // the published projection with it, opens the link and author `kind`
    // domains a closed enum in provided data could never widen, and stops
    // `addLink` requiring the two fields its handler already defaulted.
    pattern: "topics/topic.tsx",
    baselines: [
      "20260729T022742Z-6pmDbdEVBz84jJRa",
      "20260804T003803Z-I2QhJWkighYF1Fa1",
      "20260806T230301Z-JAM7epNCGeRRdbAJ",
      "20260807T155937Z-T6UB0k9yc-pCo6Fj",
      "20260807T190842Z-XNG2XTMFFTjcmnX0",
      "20260808T001558Z-H7ntBZnGU80t30LL",
      "20260810T212206Z-FQasUmU3p-SDapLo",
      "20260812T003521Z-XWPlA9Dl3OHXlHEH",
      "20260814T233350Z-ignmxWvAy2vygaDl",
      "20260817T212731Z-S2Y3ePoq7Zj_7fLa",
      "20260817T231646Z-bBfPByCuBScHp-Ou",
      "20260818T002831Z-ULPZkKYbQEmzLpDl",
      "20260818T020121Z-Y5Q-u4fiTKGUrP5Y",
      "20260819T172917Z-K_8fL8hZtM4xYV7V",
    ],
    paths: [
      "argument.boardCrossrefs",
      "argument.boardCrossrefs[].referencedBy",
      "argument.mentionable[]",
      "result.mention",
      "result.crossrefs",
      "argument.bodyUpdatedBy.kind",
      "result.addLink.kind",
      // The unsigned caller retires: a comment always carries a structured author now, so the mirror beside it goes.
      "argument.comments[]",
      "result.createdByName",
    ],
    reason:
      "Two accepted breaks on one pattern: the reference-graph rebuild on cell " +
      "identity (docs/history/topics-crossref-identity-break.md), and the " +
      "demand narrowing recorded below.",
    record: "docs/history/topics-demand-narrowing-break.md",
  },
  {
    // The parking coordinator's admin roster declared a `requiredIntegrity`
    // floor that nothing in the pattern could satisfy: no `addIntegrity` mint
    // on the roster path, and the roles' own mint does not reach the path the
    // floor sits on. Under `cfcWriteFloor: "enforce"` every write to the
    // roster is refused, so the floor had to gain the mint that satisfies it,
    // and the roster had to name the same atom the spot list is floored on —
    // a write may only consume reads that all carry one witness for its floor,
    // and checking a spot write reads the roster. The floor also gained a
    // `writeAuthorizedBy` binding, so the roster is written by one reviewed
    // handler rather than by any action that happens to hold the cell.
    pattern: "factory-outputs/parking-coordinator/main.tsx",
    baselines: [
      "20260729T022742Z-ZaBTuPX0s1ITifoj",
      "20260804T003803Z-xkP59lcpdOUTy_M1",
    ],
    // `ifc` is compared for exact equality, so any correction to an
    // unsatisfiable floor reads as a break. Both roles name the same one
    // path: the roster's own.
    paths: [
      "argument.adminRegistry.admins",
      "result.adminRegistry.admins",
    ],
    reason:
      "The admin roster's integrity floor was unsatisfiable, so no write to " +
      "it could be accepted once the write floor is enforced. Correcting the " +
      "declaration changes the `ifc` at that path, which no shape of the " +
      "pattern avoids. A piece holding a roster keeps its stored roles; what " +
      "it loses is the ability to be updated in place to the corrected " +
      "contract.",
    record: "docs/history/parking-admin-floor-contract-break.md",
  },
  {
    // Lot Watch's admin roster declared a `requiredIntegrity` floor nothing
    // could satisfy: no `addIntegrity` mint on the roster path, and a floor
    // atom that differed from the one its roles carry, so the roster read a
    // roster change has to make could never witness the floor either. Under
    // `cfcWriteFloor: "enforce"` every write to the roster is refused. The
    // declaration gained the mint, the single `lot-watch-admin` atom, and a
    // `writeAuthorizedBy` binding naming the one handler that may write it,
    // so the roster is no longer written by any action that holds the cell.
    pattern: "factory-outputs/lot-watch/main.tsx",
    baselines: [
      "20260729T022742Z-W-iDVp0QJ9fPJBsi",
      "20260804T003803Z-MtNQDxsoMJZjryZC",
    ],
    // `ifc` is compared for exact equality, so any correction to an
    // unsatisfiable floor reads as a break. The registry is not published in
    // the result, so only the argument role names the roster's own path.
    paths: ["argument.adminRegistry.admins"],
    reason:
      "The admin roster's integrity floor was unsatisfiable, so no write to " +
      "it could be accepted once the write floor is enforced. Correcting the " +
      "declaration changes the `ifc` at that path, which no shape of the " +
      "pattern avoids. A piece holding a roster keeps its stored roles; what " +
      "it loses is the ability to be updated in place to the corrected " +
      "contract.",
    record: "docs/history/lot-watch-admin-floor-contract-break.md",
  },
  {
    // The lunch poll's identity moved from display names to profile cells
    // (see docs/history/lunch-poll-identity-break.md). The proof reports two
    // paths here: the published name-keyed admin result went away, and the
    // visit array's nested defaults changed when legacy roster links were
    // replaced by optional profile links. The latter cannot be proven stable
    // under default insertion even though the vintage replay preserves the
    // stored visit rows.
    pattern: "lunch-poll/main.tsx",
    baselines: ["20260729T022742Z-5bjUubcOZ-gpvz7F"],
    paths: ["argument.visits[]", "result.adminName"],
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "The published `adminName` result cannot survive the removal of " +
      "name-keyed identity; `argument.visits[]` is the proof's summary path " +
      "for nested default changes introduced while legacy roster links became " +
      "optional profile links. The vintage replay preserves those rows, but " +
      "the root argument contract cannot be updated in place.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
  {
    // Same decision, seen from the join card. The removed optional admin input
    // is compatible; the checker exemption is only for `me`, which published
    // the viewer's display name as identity. Joined-ness and host status are
    // now derived from profile-cell comparison.
    pattern: "lunch-poll/participant-identity-card.tsx",
    baselines: ["20260729T022742Z-KMaq_J9475tWtRxW"],
    paths: ["result.me"],
    reason: "Lunch-poll identity moved from display names to profile cells. " +
      "The card's published `me` result treated the viewer's display name as " +
      "identity, so it goes with the model it keyed.",
    record: "docs/history/lunch-poll-identity-break.md",
  },
  {
    pattern: "agent-sessions-debug/main.tsx",
    baselines: ["20260818T001423Z-_DSuxwZWgUTcB_2z"],
    // The proof reports `ownerDid` first. Holding it compatible in a separate
    // proof reports the command cell's change from an optional opaque input to
    // the required writable queue that the connector host supplies.
    paths: ["argument.ownerDid", "argument.commandsCell"],
    reason:
      "Before its first deployment, the connector-managed debug view changed " +
      "to require the host's configured owner DID and one authoritative, " +
      "writable command queue. The owner isolates discovery and commands in " +
      "a shared space, while the writable queue is the host's protected " +
      "command input. The earlier contract was not deployed, and neither " +
      "input has a safe compatibility default.",
    record: "docs/history/agent-connector-owner-identity-break.md",
  },
];
