import {
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";

import {
  clearTargetConfirm,
  isTargetConfirming,
  requestTargetConfirm,
  type TargetConfirmCell,
} from "../shared/confirm.tsx";
import type {
  CastVoteEvent,
  NameCell,
  RemoveOptionEvent,
  Vote,
} from "../shared/types.tsx";
import { myVoteFor } from "../shared/voting.tsx";
import { GeneratedArt } from "./generated-art.tsx";
import type { LogVisitEvent, Option, SetOptionUrlEvent } from "./main.tsx";

export interface PollOptionCardInput {
  option: Option;
  rank: number;
  me: string;
  isJoined: boolean;
  isAdmin: boolean;
  votes: readonly Vote[];
  removeConfirmTarget: TargetConfirmCell;
  linkEditTarget: Writable<string | null>;
  linkDraft: NameCell;
  artUrl: string;
  artSyncState: string;
  displayHomePageUrl: string;
  homeUrl: string;
  homeLabel: string;
  isEditingLink: boolean;
  castVote: Stream<CastVoteEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  logVisit: Stream<LogVisitEvent>;
  setOptionUrl: Stream<SetOptionUrlEvent>;
}

export interface PollOptionCardOutput {
  [NAME]: string;
  [UI]: VNode;
  option: Option;
}

export const PollOptionCard = pattern<
  PollOptionCardInput,
  PollOptionCardOutput
>(
  (
    {
      option,
      rank,
      me,
      isJoined,
      isAdmin,
      votes,
      removeConfirmTarget,
      linkEditTarget,
      linkDraft,
      artUrl,
      artSyncState,
      displayHomePageUrl,
      homeUrl,
      homeLabel,
      isEditingLink,
      castVote,
      removeOption,
      logVisit,
      setOptionUrl,
    },
  ) => {
    const oid = option.id;
    const optionTitle = option.title;
    const myVote = myVoteFor(votes, me, oid);
    const isRemoveConfirm = isTargetConfirming(
      removeConfirmTarget.get(),
      oid,
    );

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
          data-art-sync={artSyncState}
          data-homepage-sync={displayHomePageUrl}
        >
          {GeneratedArt({ title: optionTitle, artUrl })}
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
            {
              /* Homepage link — persisted enrichment (no per-load LLM).
                Priority: user override > stored official site > Google Maps
                fallback, so there's always a working link. A joined viewer can
                edit/override it. */
            }
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
                marginTop: "2px",
                flexWrap: "wrap",
              }}
            >
              <a
                href={homeUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "11px",
                  color: "#2f6f4e",
                  textDecoration: "underline",
                }}
              >
                {homeLabel}
              </a>
              {isJoined
                ? (
                  <button
                    type="button"
                    aria-label="Edit homepage link"
                    title="Edit link"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#9ca3af",
                      cursor: "pointer",
                      fontSize: "11px",
                      padding: 0,
                    }}
                    onClick={() => linkEditTarget.set(option.id)}
                  >
                    ✎ edit
                  </button>
                )
                : null}
            </div>
            {isEditingLink
              ? (
                <div
                  style={{
                    display: "flex",
                    gap: "6px",
                    alignItems: "center",
                    marginTop: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  <cf-input
                    $value={linkDraft}
                    placeholder="Paste a homepage URL…"
                    aria-label="Homepage URL"
                    timing-strategy="immediate"
                    style="flex:1; min-width:160px;"
                  />
                  <cf-button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      setOptionUrl.send({
                        optionId: option.id,
                      })}
                  >
                    Save
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setOptionUrl.send({
                        optionId: option.id,
                        url: "",
                      })}
                  >
                    Clear
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => linkEditTarget.set(null)}
                  >
                    Cancel
                  </cf-button>
                </div>
              )
              : null}
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
              {
                /* Admin-only Remove — muted, far from the vote chips. Two-step
                  confirm when the option has votes (same idiom as
                  parking-coordinator). */
              }
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
                    onClick={() =>
                      requestTargetConfirm(
                        removeConfirmTarget,
                        oid,
                      )}
                  >
                    · remove
                  </button>
                )
                : null}
              {
                /* Host logs that the group actually ate here — a visible pill
                  so it reads as an action. Uses the host's date field (blank =
                  today). */
              }
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
                      clearTargetConfirm(removeConfirmTarget);
                    }}
                  >
                    Yes, remove
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => clearTargetConfirm(removeConfirmTarget)}
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
      option,
    };
  },
);
