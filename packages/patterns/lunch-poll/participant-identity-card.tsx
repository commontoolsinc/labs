import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  safeDateNow,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { ClaimHostEvent, JoinEvent, User } from "./main.tsx";

/** Parent-owned roster cell shared by all viewers. */
export type ParticipantIdentityUsersCell = Writable<User[] | Default<[]>>;

/** Parent-owned viewer/admin name cell. */
export type ParticipantIdentityNameCell = Writable<string | Default<"">>;

const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

const trimmedName = (n: string | undefined) => (n ?? "").trim();
const colorForIndex = (i: number) => PLAYER_COLORS[i % PLAYER_COLORS.length];

const joinAs = handler<JoinEvent, {
  users: ParticipantIdentityUsersCell;
  myName: ParticipantIdentityNameCell;
  adminName: ParticipantIdentityNameCell;
  joinName: ParticipantIdentityNameCell;
  profileName: string;
  profileAvatar: string;
}>(
  (
    { name },
    { users, myName, adminName, joinName, profileName, profileAvatar },
  ) => {
    const override = trimmedName(name) || trimmedName(joinName.get());
    const trimmed = override || trimmedName(profileName);
    if (!trimmed) return;
    const current = trimmedName(myName.get());
    if (current) return;
    const existing = users.get();
    if (existing.some((u) => u.name === trimmed)) return;
    const user: User = {
      name: trimmed,
      avatar: override ? "" : (profileAvatar ?? "").trim(),
      color: colorForIndex(existing.length),
      joinedAt: safeDateNow(),
    };
    users.push(user);
    myName.set(trimmed);
    if (trimmedName(adminName.get()) === "") {
      adminName.set(trimmed);
    }
    joinName.set("");
  },
);

const claimHost = handler<ClaimHostEvent, {
  myName: ParticipantIdentityNameCell;
  adminName: ParticipantIdentityNameCell;
}>((_, { myName, adminName }) => {
  const me = trimmedName(myName.get());
  if (!me) return;
  if (trimmedName(adminName.get()) === me) return;
  adminName.set(me);
});

/**
 * ParticipantIdentityCard renders a participant join and admin-claim surface.
 *
 * Use it when a parent pattern owns the roster, current viewer, and admin cells
 * and needs composed UI for joining, resolving the current participant, and
 * taking over admin duties. The resolved identity outputs (`me`, `isJoined`,
 * and `isAdmin`) are intended for downstream sub-patterns such as per-option
 * cards.
 *
 * Joining is profile-first: when `#profileName` resolves, the surface offers a
 * one-click "Join as <name>" (carrying the profile name and avatar) with a
 * "Use a different name" escape hatch. The manual name input is the FALLBACK,
 * shown by default only when no profile resolves. This keeps the shared profile
 * — not a hand-typed name — the primary identity, so avatars aren't dropped and
 * viewers aren't asked to retype who they already are.
 */

/**
 * Inputs for the participant identity/admin controls.
 *
 * The parent owns the durable user directory and viewer identity cells. This
 * pattern only owns local per-session UI state for the join draft and admin
 * takeover reveal.
 */
export interface ParticipantIdentityCardInput {
  /** Shared roster of participants who have joined. */
  users: ParticipantIdentityUsersCell;

  /** Per-user current viewer name cell. */
  myName: ParticipantIdentityNameCell;

  /** Shared admin name cell. */
  adminName: ParticipantIdentityNameCell;
}

/**
 * Outputs for the participant identity/admin controls.
 *
 * Instantiate this sub-pattern by function call when the parent needs `me`,
 * `isJoined`, `isAdmin`, or the bound streams. The `[UI]` value may then be
 * embedded in the parent's layout.
 */
export interface ParticipantIdentityCardOutput {
  /** Human-readable pattern name. */
  [NAME]: string;

  /** Static VNode rendering the join form and admin controls. */
  [UI]: VNode;

  /** Trimmed current viewer name resolved once for downstream sub-patterns. */
  me: string;

  /** Whether the current viewer has joined the participant roster. */
  isJoined: boolean;

  /** Whether the current viewer currently owns admin actions. */
  isAdmin: boolean;

  /** Bound stream that joins the current viewer and claims admin if first. */
  joinAs: Stream<JoinEvent>;

  /** Bound stream that transfers admin ownership to the current viewer. */
  claimHost: Stream<ClaimHostEvent>;
}

export default pattern<
  ParticipantIdentityCardInput,
  ParticipantIdentityCardOutput
>(
  ({ users, myName, adminName }) => {
    const joinName = Writable.perSession.of<string>("");
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

    // The join name/avatar default to the viewer's shared profile; the manual
    // input is only a fallback for when no profile resolves (or the viewer
    // deliberately wants a one-off name). `useCustomName` reveals that input
    // even when a profile IS present.
    const useCustomName = Writable.perSession.of<boolean>(false);
    const profileDisplayName = computed(() =>
      trimmedName(profileNameWish.result ?? "")
    );
    const hasProfile = computed(() =>
      trimmedName(profileNameWish.result ?? "") !== ""
    );
    const showManualEntry = computed(() =>
      trimmedName(profileNameWish.result ?? "") === "" || useCustomName.get()
    );

    const me = computed(() => trimmedName(myName.get()));
    const isJoined = computed(() => trimmedName(myName.get()) !== "");
    const isAdmin = computed(() => {
      const viewer = trimmedName(myName.get());
      return viewer !== "" && viewer === trimmedName(adminName.get());
    });
    const joinHint = computed(() =>
      trimmedName(adminName.get()) === ""
        ? "First to join becomes the host."
        : `Hosted by ${trimmedName(adminName.get())}.`
    );
    const canClaimHost = computed(() => {
      const viewer = trimmedName(myName.get());
      return viewer !== "" && viewer !== trimmedName(adminName.get());
    });

    return {
      [NAME]: "Participant identity",
      [UI]: (
        <div style="display:contents">
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
              {showManualEntry
                ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <cf-input
                      id="lp-join-name"
                      $value={joinName}
                      placeholder="Your name…"
                      aria-label="Your name"
                      timing-strategy="immediate"
                      style="flex:1"
                    />
                    <cf-button
                      id="lp-join-button"
                      aria-label="Join the poll"
                      onClick={() => boundJoin.send({})}
                    >
                      Join
                    </cf-button>
                    {hasProfile
                      ? (
                        <cf-button
                          variant="ghost"
                          size="sm"
                          aria-label="Use my profile name instead"
                          onClick={() => {
                            useCustomName.set(false);
                            joinName.set("");
                          }}
                        >
                          Cancel
                        </cf-button>
                      )
                      : null}
                  </div>
                )
                : (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <cf-button
                      id="lp-join-button"
                      variant="primary"
                      aria-label="Join the poll with your profile name"
                      onClick={() => boundJoin.send({})}
                    >
                      Join as {profileDisplayName}
                    </cf-button>
                    <cf-button
                      variant="ghost"
                      size="sm"
                      aria-label="Use a different name"
                      onClick={() => useCustomName.set(true)}
                    >
                      Use a different name
                    </cf-button>
                  </div>
                )}
            </div>
          )}

          {canClaimHost
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
                  aria-label="Become host"
                  onClick={() => boundClaimHost.send({})}
                >
                  Become host
                </cf-button>
              </div>
            )
            : null}
        </div>
      ),
      me,
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
    };
  },
);
