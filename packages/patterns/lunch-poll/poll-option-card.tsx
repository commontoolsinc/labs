import {
  computed,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type {
  CastVoteEvent,
  LogVisitEvent,
  Option,
  RemoveOptionEvent,
  Vote,
  VoteColor,
} from "./main.tsx";

/** Shared per-session target cell used for one open option editor at a time. */
export type PollOptionLinkTargetCell = Writable<string | null>;

const myVoteFor = (
  votes: readonly Vote[],
  me: string,
  optionId: string,
): VoteColor | undefined => {
  if (!me) return undefined;
  return votes.find(
    (v) => v.voterName === me && v.optionId === optionId,
  )?.voteType;
};

/**
 * PollOptionCard renders one complete ranked restaurant option row.
 *
 * Use it when a parent pattern already owns option, vote, viewer, and admin
 * state and wants composed UI for voting and admin-only remove/history
 * actions. This is not a standalone vote engine; durable mutations happen
 * through the input streams supplied by the parent.
 */

/**
 * Inputs for one rendered ranked option row.
 *
 * The parent owns all durable and shared UI state. This pattern receives one
 * option, current viewer/admin facts, shared per-session editor state, and the
 * streams it should emit for mutations. When rendering inside `options.map()`,
 * pass the resolved `me` value from the parent, not the raw `myName` PerUser
 * cell.
 */
export interface PollOptionCardInput {
  /** Option record to render. */
  option: Option;

  /** One-based display rank supplied by the parent's ranking computation. */
  rank: number;

  /** Resolved current viewer name; required for per-option vote styling. */
  me: string;

  /** Whether the current viewer is allowed to vote. */
  isJoined: boolean;

  /** Whether the current viewer owns admin-only actions. */
  isAdmin: boolean;

  /** Shared vote list used to compute this viewer's selected vote. */
  votes: readonly Vote[];

  /** Per-session option id awaiting admin remove confirmation. */
  removeConfirmTarget: PollOptionLinkTargetCell;

  /** Parent-owned stream that toggles or records this viewer's vote. */
  castVote: Stream<CastVoteEvent>;

  /** Parent-owned admin stream that removes this option after confirmation. */
  removeOption: Stream<RemoveOptionEvent>;

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
      me,
      isJoined,
      isAdmin,
      votes,
      removeConfirmTarget,
      castVote,
      removeOption,
      logVisit,
    },
  ) => {
    const oid = option.id;
    const optionTitle = option.title;
    const myVote = computed(() => myVoteFor(votes, me, oid));
    const isRemoveConfirm = computed(() => removeConfirmTarget.get() === oid);

    return {
      [NAME]: optionTitle,
      [UI]: (
        <div
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
            #{rank}
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
              {isAdmin
                ? (
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
                    onClick={() => removeConfirmTarget.set(oid)}
                  >
                    · remove
                  </button>
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
            </div>
            {isRemoveConfirm
              ? (
                <div
                  style={{
                    marginTop: "8px",
                    padding: "8px 10px",
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    fontSize: "12px",
                    color: "#991b1b",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    Remove "{optionTitle}" and discard its votes?
                  </span>
                  <cf-button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      removeOption.send({ optionId: oid });
                      removeConfirmTarget.set(null);
                    }}
                  >
                    Yes, remove
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeConfirmTarget.set(null)}
                  >
                    Cancel
                  </cf-button>
                </div>
              )
              : null}
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
