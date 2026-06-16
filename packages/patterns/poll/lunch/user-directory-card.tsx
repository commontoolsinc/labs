import {
  computed,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import {
  clearFlagConfirm,
  isFlagConfirming,
  revealFlagConfirm,
} from "../shared/confirm.tsx";
import { trimmedName } from "../shared/constants.tsx";
import { claimHost, joinAs } from "../shared/identity.tsx";
import type {
  ClaimHostEvent,
  JoinEvent,
  NameCell,
  UsersCell,
} from "../shared/types.tsx";

export interface UserDirectoryCardInput {
  users: UsersCell;
  myName: NameCell;
  adminName: NameCell;
}

export interface UserDirectoryCardOutput {
  [NAME]: string;
  [UI]: VNode;
  me: string;
  isJoined: boolean;
  isAdmin: boolean;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
}

export const UserDirectoryCard = pattern<
  UserDirectoryCardInput,
  UserDirectoryCardOutput
>(({ users, myName, adminName }) => {
  const joinName = Writable.perSession.of<string>("");
  const claimHostRevealed = Writable.perSession.of<boolean>(false);

  // This variant joins via a free-text name field. Shared-profile name/avatar
  // are still a graceful fallback for viewers who already made a profile.
  const profileNameWish = wish<string>({ query: "#profileName" });
  const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
  const profileName = computed(() => profileNameWish.result ?? "");
  const profileAvatar = computed(() => profileAvatarWish.result ?? "");

  const boundJoin = joinAs({
    users,
    myName,
    adminName,
    joinName,
    profileName,
    profileAvatar,
  });
  const boundClaimHost = claimHost({ myName, adminName });

  const me = computed(() => trimmedName(myName.get()));
  const isJoined = computed(() => trimmedName(myName.get()) !== "");
  const isAdmin = computed(() => {
    const viewer = trimmedName(myName.get());
    return viewer !== "" && viewer === trimmedName(adminName.get());
  });
  const joinHint = computed(() => {
    const admin = trimmedName(adminName.get());
    return admin === ""
      ? "First to join becomes the host."
      : `Hosted by ${admin}.`;
  });
  const isClaimHostRevealed = computed(() =>
    isFlagConfirming(claimHostRevealed.get())
  );
  const canClaimHost = computed(() => {
    const viewer = trimmedName(myName.get());
    return viewer !== "" && viewer !== trimmedName(adminName.get());
  });

  return {
    [NAME]: "User directory",
    [UI]: (
      <>
        {/* Join card — hidden after the viewer joins. */}
        {isJoined ? null : (
          <div
            style={{
              padding: "16px",
              marginBottom: "16px",
              border: "1px solid #fde68a",
              backgroundColor: "#fef3c7",
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                fontWeight: 700,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "#92400e",
                marginBottom: "8px",
              }}
            >
              Join the poll
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "#78350f",
                marginBottom: "12px",
              }}
            >
              {joinHint}
            </div>
            <div
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              {
                /* Free-text join: type a name and join. No profile required —
                  anyone with a shared profile can still join by leaving this
                  blank (joinAs falls back to it). */
              }
              <cf-input
                $value={joinName}
                placeholder="Your name…"
                aria-label="Your name"
                timing-strategy="immediate"
                style="flex:1"
              />
              <cf-button onClick={boundJoin}>Join</cf-button>
            </div>
          </div>
        )}

        {
          /* Open host takeover — kept out of the way: a non-host sees a subtle
            "Hosted by …" label and clicks it to reveal the "Become host"
            button. Plain JSX with a per-session toggle so the onClicks lower as
            handlers (not lifts). */
        }
        {canClaimHost
          ? (isClaimHostRevealed
            ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                  padding: "8px 12px",
                  marginBottom: "16px",
                  backgroundColor: "#eef2ff",
                  border: "1px solid #c7d2fe",
                  borderRadius: "8px",
                  fontSize: "13px",
                  color: "#3730a3",
                }}
              >
                <span>{joinHint}</span>
                <cf-button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    boundClaimHost.send({});
                    clearFlagConfirm(claimHostRevealed);
                  }}
                >
                  Become host
                </cf-button>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={() => clearFlagConfirm(claimHostRevealed)}
                >
                  Cancel
                </cf-button>
              </div>
            )
            : (
              <div style={{ marginBottom: "16px" }}>
                <button
                  type="button"
                  aria-label="Hosting info — click to take over as host"
                  title="Click to take over as host"
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: "13px",
                    color: "#6b7280",
                    cursor: "pointer",
                    textDecoration: "underline dotted",
                    textUnderlineOffset: "3px",
                  }}
                  onClick={() => revealFlagConfirm(claimHostRevealed)}
                >
                  {joinHint}
                </button>
              </div>
            ))
          : null}
      </>
    ),
    me,
    isJoined,
    isAdmin,
    joinAs: boundJoin,
    claimHost: boundClaimHost,
  };
});
