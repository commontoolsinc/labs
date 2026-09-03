import {
  computed,
  Default,
  equals,
  lift,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
} from "commonfabric";
import type {
  CastVoteEvent,
  LogVisitEvent,
  LunchProfileCell,
  Option,
  OptionTargetEvent,
  Vote,
  VoteColor,
} from "./main.tsx";
import { safeImageUrl } from "./generated-art.tsx";

const myVoteFor = (
  votes: readonly Vote[],
  viewerProfile: LunchProfileCell | undefined,
  optionId: string,
): VoteColor | undefined => {
  if (!viewerProfile) return undefined;
  return votes.find(
    (v) => v.optionId === optionId && equals(v.voter, viewerProfile),
  )?.voteType;
};

const formatRank = lift<{ rank: number | undefined }, string>(({ rank }) =>
  rank === undefined || rank <= 0 ? "—" : `#${rank}`
);

/**
 * PollOptionCard renders one complete ranked restaurant option row.
 *
 * Use it when a parent pattern already owns option, vote, viewer, and admin
 * state and wants composed UI for voting and admin-only remove/history actions.
 * This is not a standalone vote engine; durable mutations happen through the
 * input streams supplied by the parent.
 */

/**
 * Inputs for one rendered ranked option row.
 *
 * The parent owns all durable and shared UI state. This pattern receives one
 * option, current viewer/admin facts, the shared vote list, and the streams it
 * should emit for mutations or selection in the parent's editor surfaces. It
 * derives the viewer's own vote itself: measured on the 14-option poll, a
 * per-row vote handed down from the parent's ranked tallies re-ran three
 * times as many nodes per vote as this lookup does.
 */
export interface PollOptionCardInput {
  /** Option record to render. */
  option: Option;

  /** One-based display rank, or undefined while the parent ranking settles. */
  rank: number | undefined;

  /** The viewer's profile cell — identity, compared with `equals()`. */
  viewerProfile?: LunchProfileCell;

  /** Shared vote list used to compute this viewer's selected vote. */
  votes: readonly Vote[];

  /** Whether the current viewer is allowed to vote. */
  isJoined: boolean;

  /** Whether the current viewer owns admin-only actions. */
  isAdmin: boolean;

  /** Parent-owned stream that opens this option's remove confirmation. */
  requestRemove?: Stream<OptionTargetEvent>;

  /** Parent-owned stream that opens this option in the generated-art editor. */
  requestArt?: Stream<OptionTargetEvent>;

  /**
   * Whether the parent wires `requestRemove` and `requestArt`. A card
   * instance deployed under the earlier contract has neither stream, and an
   * absent optional stream still materializes as an unresolved handle, so
   * their presence cannot tell that instance apart. This scalar defaults to
   * false for it, which hides the two controls it could not dispatch.
   */
  parentOwnsEditors?: boolean | Default<false>;

  /** Parent-owned stream that toggles or records this viewer's vote. */
  castVote: Stream<CastVoteEvent>;

  /** Parent-owned admin stream that records this option in visit history. */
  logVisit: Stream<LogVisitEvent>;
}

/**
 * Outputs for one rendered ranked option row.
 *
 * Parents normally embed this sub-pattern with JSX.
 */
export interface PollOptionCardOutput {
  /** Human-readable pattern name, matching the option title. */
  [NAME]: string;

  /** Static VNode rendering the complete option row. */
  [UI]: VNode;
}

export default pattern<PollOptionCardInput, PollOptionCardOutput>(
  (
    {
      option,
      rank,
      viewerProfile,
      votes,
      isJoined,
      isAdmin,
      requestRemove,
      requestArt,
      parentOwnsEditors,
      castVote,
      logVisit,
    },
  ) => {
    const oid = option.id;
    const optionTitle = option.title;
    const displayRank = formatRank({ rank });
    const myVote = computed(() => myVoteFor(votes, viewerProfile, oid));
    const storedImageUrl = computed(() => safeImageUrl(option.imageUrl));
    const canRequestRemove = computed(() =>
      isAdmin && parentOwnsEditors === true
    );
    const canGenerateArt = computed(() =>
      isAdmin && parentOwnsEditors === true &&
      safeImageUrl(option.imageUrl) === ""
    );

    return {
      [NAME]: optionTitle,
      [UI]: (
        <div
          data-option-title={optionTitle}
          style={{
            marginBottom: "10px",
            padding: "10px 12px",
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            backgroundColor: "white",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <div
            style={{
              width: "96px",
              height: "96px",
              flexShrink: 0,
              borderRadius: "8px",
              overflow: "hidden",
              backgroundColor: "#f9fafb",
              border: "1px solid #eee",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "32px",
            }}
          >
            {storedImageUrl
              ? (
                <img
                  src={storedImageUrl}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              )
              : <span aria-hidden="true">🍽️</span>}
          </div>
          <span
            style={{
              minWidth: "28px",
              height: "28px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "9999px",
              backgroundColor: "#f3f4f6",
              color: "#374151",
              fontSize: "12px",
              fontWeight: 700,
            }}
          >
            {displayRank}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: "14px",
                color: "#111827",
              }}
            >
              {optionTitle}
            </div>
            <div
              style={{
                fontSize: "11px",
                color: "#6b7280",
                display: "flex",
                gap: "6px",
                alignItems: "baseline",
              }}
            >
              <span>added by {option.addedByName}</span>
              {canRequestRemove
                ? (
                  <>
                    <span
                      aria-hidden="true"
                      style={{ textDecoration: "none" }}
                    >
                      ·
                    </span>
                    <button
                      type="button"
                      aria-label="Remove option (host)"
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        color: "#9ca3af",
                        fontSize: "11px",
                        textDecoration: "underline",
                        cursor: "pointer",
                      }}
                      onClick={() => requestRemove?.send({ optionId: oid })}
                    >
                      remove
                    </button>
                  </>
                )
                : null}
              {isAdmin
                ? (
                  <button
                    type="button"
                    aria-label="Log that we went here (host)"
                    style={{
                      background: "#eaf6ef",
                      border: "1px solid #b7e0c8",
                      borderRadius: "9999px",
                      padding: "2px 10px",
                      color: "#2f6f4e",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={() => logVisit.send({ optionId: oid })}
                  >
                    ✓ we went here
                  </button>
                )
                : null}
              {canGenerateArt
                ? (
                  <button
                    type="button"
                    aria-label="Generate art (host)"
                    style={{
                      background: "#eef2ff",
                      border: "1px solid #c7d2fe",
                      borderRadius: "9999px",
                      padding: "2px 10px",
                      color: "#4338ca",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={() => requestArt?.send({ optionId: oid })}
                  >
                    ✦ generate art
                  </button>
                )
                : null}
            </div>
          </div>
          {isJoined
            ? (
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  alignItems: "center",
                }}
              >
                <cf-button
                  data-vote="green"
                  aria-label={myVote === "green"
                    ? "Clear my green vote"
                    : "Love it"}
                  style={myVote === "green"
                    ? "background-color: #22c55e; color: white; font-weight: bold; border: 2px solid #16a34a;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "green",
                    })}
                >
                  🟢
                </cf-button>
                <cf-button
                  data-vote="yellow"
                  aria-label={myVote === "yellow"
                    ? "Clear my yellow vote"
                    : "Okay with it"}
                  style={myVote === "yellow"
                    ? "background-color: #eab308; color: white; font-weight: bold; border: 2px solid #ca8a04;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "yellow",
                    })}
                >
                  🟡
                </cf-button>
                <cf-button
                  data-vote="red"
                  aria-label={myVote === "red" ? "Clear my red vote" : "Veto"}
                  style={myVote === "red"
                    ? "background-color: #ef4444; color: white; font-weight: bold; border: 2px solid #dc2626;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "red",
                    })}
                >
                  🔴
                </cf-button>
              </div>
            )
            : null}
        </div>
      ),
    };
  },
);
