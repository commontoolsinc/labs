import {
  computed,
  Default,
  equals,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type {
  ClaimHostEvent,
  JoinEvent,
  LunchProfileCell,
  ParticipantProfileDirectoryCell,
  User,
} from "./main.tsx";

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
  participantProfiles: ParticipantProfileDirectoryCell;
  profile: LunchProfileCell | undefined;
  // The display strings arrive pre-resolved (from `#profileName` /
  // `#profileAvatar`, or the injected profile object) — field reads off the
  // live `#profile` result are NOT a reliable display source; the dedicated
  // string wishes are (the battleship-lobby idiom, multi-user-patterns.md).
  profileName: string;
  profileAvatar: string;
}>(
  (
    { name },
    {
      users,
      myName,
      adminName,
      joinName,
      participantProfiles,
      profile,
      profileName,
      profileAvatar,
    },
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
    };
    // A duplicate name must reject the second join rather than silently make
    // two sessions the same participant. Keep the admission read and write the
    // resulting roster as one conflict-safe read-modify-write transaction.
    users.set([...existing, user]);
    if (!override && profile) {
      const currentLinks = participantProfiles.get().participants ?? [];
      if (!currentLinks.some((entry) => equals(entry.profile, profile))) {
        participantProfiles.key("participants").set([
          ...currentLinks,
          { name: trimmed, profile },
        ]);
      }
    }
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
 * Joining is profile-first. The parent resolves the viewer's `#profile` at
 * top level (per docs/specs/shared-profile-rosters.md) and passes the cell,
 * display name, and the wish's create/pick surface in. When a profile
 * resolves, the card offers a one-click "Join as <name>" and retains the live
 * cell in the shared profile directory. When it doesn't, the card renders the
 * passed create/pick surface — the typed-name guest path never appears
 * automatically; "Continue as guest" is an explicit choice, and guest entries
 * store only the entered string.
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

  /** Object-wrapped directory of live canonical profile links. */
  participantProfiles: ParticipantProfileDirectoryCell;

  /**
   * The viewer's resolved `#profile` cell, from the parent's top-level wish
   * (or an injected cell in tests). Used only as the badge/`equals()` identity
   * — never read for its name; the display name arrives as `profileName`.
   * Undefined until it resolves (or when the viewer has no profile).
   */
  profile?: LunchProfileCell;

  /**
   * The viewer's resolved display name, from the parent's top-level
   * `#profileName` wish (or injected in tests). "" until it resolves; the join
   * card gates on this being non-empty and snapshots it into the roster.
   */
  profileName: string;

  /** The viewer's resolved avatar, from the parent's `#profileAvatar` wish. */
  profileAvatar: string;

  /**
   * The `#profile` wish's built-in create/pick surface (`profileWish[UI]`),
   * rendered by the parent's top-level wish and passed down so the card shows
   * it in the no-profile state. Omitted in tests without a wish environment.
   */
  profileSetupUI?: VNode;
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

  /** Current canonical profile display name, or empty for a guest/no profile. */
  profileName: string;

  /** Bound stream that joins the current viewer and claims admin if first. */
  joinAs: Stream<JoinEvent>;

  /** Bound stream that transfers admin ownership to the current viewer. */
  claimHost: Stream<ClaimHostEvent>;
}

export default pattern<
  ParticipantIdentityCardInput,
  ParticipantIdentityCardOutput
>(
  (
    {
      users,
      myName,
      adminName,
      participantProfiles,
      profile,
      profileName,
      profileAvatar,
      profileSetupUI,
    },
  ) => {
    const joinName = Writable.perSession.of<string>("");
    // The parent resolves the viewer's profile at top level (per
    // docs/specs/shared-profile-rosters.md) and passes the results in:
    // `profile` is the identity cell (badge + `equals()` dedup), `profileName`
    // / `profileAvatar` are the display strings. The card never reads the name
    // off the cell — the cross-space `#profileName` value is the source, and
    // it is snapshotted into the roster on join.
    const canonicalProfileName = computed(() => trimmedName(profileName));
    const canonicalProfileAvatar = computed(() => (profileAvatar ?? "").trim());
    const boundJoin = joinAs({
      users,
      myName,
      adminName,
      joinName,
      participantProfiles,
      profile,
      profileName: canonicalProfileName,
      profileAvatar: canonicalProfileAvatar,
    });
    const boundClaimHost = claimHost({ myName, adminName });

    // Joining is profile-first, and the typed-name path is never automatic:
    // with no resolved profile the card renders the wish's create/pick UI,
    // and "Continue as guest" is an explicit secondary action. `useCustomName`
    // also lets a profile-holder deliberately join under a one-off name.
    const useCustomName = Writable.perSession.of<boolean>(false);
    // Gate on the resolved profile NAME. `#profileName` is a cross-space
    // computed value: the profile's `initialNameApplied` lift lives in its own
    // inSpace child space and only materializes once a `$profile` badge starts
    // the profile pattern in this runtime (the raw `#profile` result is a
    // pending proxy, not a usable truthiness signal). The badge in the setup
    // branch below is what does that priming, so the empty-name window is a
    // brief transient, not a deadlock — see its comment.
    const hasProfile = computed(() => canonicalProfileName !== "");
    const showProfileJoin = computed(() => hasProfile && !useCustomName.get());
    const showProfileSetup = computed(() =>
      !hasProfile && !useCustomName.get()
    );
    const showManualEntry = computed(() => useCustomName.get());

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
              {showProfileJoin
                ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      data-profile-identity="canonical"
                      style={{ display: "inline-flex", alignItems: "center" }}
                    >
                      <cf-profile-badge
                        $profile={profile}
                        size="sm"
                        noNavigate
                      />
                    </div>
                    <cf-button
                      id="lp-join-button"
                      variant="primary"
                      aria-label="Join the poll with your profile name"
                      onClick={() => boundJoin.send({})}
                    >
                      Join as {canonicalProfileName}
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
                )
                : null}
              {showProfileSetup
                ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    {
                      /* Built-in profile create/pick surface, resolved by the
                        parent's top-level `#profile` wish and passed in. The
                        typed-name path never appears automatically — guests
                        opt in below. */
                    }
                    <div data-profile-setup>{profileSetupUI}</div>
                    <div>
                      <cf-button
                        id="lp-guest-button"
                        variant="ghost"
                        size="sm"
                        aria-label="Continue as guest with a typed name"
                        onClick={() => useCustomName.set(true)}
                      >
                        Continue as guest
                      </cf-button>
                    </div>
                  </div>
                )
                : null}
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
                    <cf-button
                      variant="ghost"
                      size="sm"
                      aria-label="Back to profile join"
                      onClick={() => {
                        useCustomName.set(false);
                        joinName.set("");
                      }}
                    >
                      Back
                    </cf-button>
                  </div>
                )
                : null}
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
      profileName: canonicalProfileName,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
    };
  },
);
