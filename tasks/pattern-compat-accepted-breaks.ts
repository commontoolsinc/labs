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
];
