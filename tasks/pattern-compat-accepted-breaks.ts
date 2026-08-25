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
    // Topics no longer derives a prose reference graph. `crossrefs` published
    // that graph, and there is no shape of the board that both keeps the
    // published field and removes the feature behind it.
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
    ],
    // `argument.topics[]` is every change to `TopicPiece` seen from the board's
    // list: each stored topic's defaults moved, which the proof cannot show is
    // stable under insertion. The `crossrefs[]` fields are the old graph row's,
    // which the pivot row replaces wholesale.
    //
    // The last defaults to move are `title`, `body` and `createdByName`, which
    // gained one so the board's card list can be declared over the topic itself
    // rather than over a card-shaped copy of it. A card's argument schema is
    // what a piece holding older topics is updated against, so every field a
    // card renders has to carry a default for that update to be accepted —
    // `deno task pattern-vintage` refuses it otherwise, naming the field.
    //
    // `mention` moves for the opposite reason: its payload stopped being
    // `unknown` and now names `title`. Naming it does not by itself refuse
    // anything — an `asCell` payload is wrapped whole, without validating what
    // is behind it — but it is what lets the verb tell a reference from a
    // non-reference in one read of one field, and `mention` now rejects rather
    // than storing an entry that resolves to no piece. A narrowed payload is a
    // real tightening of what the verb accepts, which is the decision being
    // recorded here rather than worked around.
    paths: [
      "argument.topics[]",
      "result.mentionable[].mention",
      "result.crossrefs",
      "result.crossrefs[].fid",
      "result.crossrefs[].commentCount",
      "result.index[].fid",
    ],
    reason:
      "Topics' reference graph was removed and then rebuilt on cell identity. " +
      "The board still publishes `crossrefs`, but as a `{ topic, mentionedBy }` " +
      "pivot rather than the old summary-bearing graph row, so the old row's " +
      "fields go. `index` is the full-board survey surface, and its rows ARE " +
      "the topics: a row's own address is the topic's, so the copied `fid` " +
      "field goes with the copy.",
    record: "docs/history/topics-crossref-identity-break.md",
  },
  {
    // The same removal seen from a topic: its own `crossrefs` row, and the
    // `boardCrossrefs` input the board wired in to feed it.
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
    ],
    paths: [
      "argument.boardCrossrefs",
      "argument.boardCrossrefs[].referencedBy",
      "argument.mentionable[]",
      "result.mention",
      "result.crossrefs",
    ],
    reason:
      "Topics' reference graph was removed and then rebuilt on cell identity. " +
      "A topic no longer derives an edge row and no longer publishes " +
      "`crossrefs`; it publishes `referencedBy`, read out of the board's pivot, " +
      "whose row shape the `boardCrossrefs` input changed to match. " +
      "`mentionable[]` moves because `TopicPiece` gained the reference fields, " +
      "and `mention` because its payload now names `title` rather than being " +
      "`unknown` — the one field that lets the verb read a payload and tell a " +
      "reference from a bare string, which it now rejects rather than storing " +
      "inert.",
    record: "docs/history/topics-crossref-identity-break.md",
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
    // The lobby's admin roster declared a `requiredIntegrity` floor on the
    // `lobby-admin` atom that nothing minted at that path: the roles inside
    // the roster carry the atom, and an endorsement on an array's entries
    // does not reach a floor declared on the array path. Under
    // `cfcWriteFloor: "enforce"` every write to the roster is refused, so the
    // floor had to gain the mint that satisfies it. The registry's other four
    // rules already held — one atom throughout, endorsed entries, no
    // self-granted credential, and a `writeAuthorizedBy` binding to
    // `commitTrustedLobbyAction` — so the mint is the whole correction.
    pattern: "lobby/main.tsx",
    baselines: ["20260729T022742Z-GhLFnf8OCmke_Jje"],
    // `ifc` is compared for exact equality, so adding the mint that makes an
    // unsatisfiable floor satisfiable reads as a break. The registry is not
    // part of the pattern's result, so only the argument role is blamed.
    paths: ["argument.adminRegistry.admins"],
    reason:
      "The admin roster's integrity floor was unsatisfiable, so no write to " +
      "it could be accepted once the write floor is enforced. Minting the " +
      "atom the floor names at the path the floor sits on is the only thing " +
      "that satisfies it, and that changes the `ifc` at that path. A piece " +
      "holding a roster keeps its stored roles; what it loses is the ability " +
      "to be updated in place to the corrected contract.",
    record: "docs/history/lobby-admin-floor-contract-break.md",
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
