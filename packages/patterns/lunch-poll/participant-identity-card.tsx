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
  wish,
  Writable,
} from "commonfabric";
import type {
  ClaimHostEvent,
  JoinEvent,
  LunchProfile,
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
const profileDisplayName = (profile: LunchProfile | undefined) =>
  trimmedName(profile?.initialNameApplied ?? profile?.name);

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
 * Joining is profile-first: this card owns the canonical `#profile` wish.
 * When it resolves, the surface offers a one-click "Join as <name>" and
 * retains the live cell in the shared profile directory. When it doesn't,
 * the card renders the wish's built-in [UI] (profile create/pick) — the
 * typed-name guest path never appears automatically; "Continue as guest" is
 * an explicit choice, and guest entries store only the entered string.
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
   * Optional override for the canonical profile cell. When absent (the
   * production shape) the card resolves its own `#profile` wish; tests inject
   * a live cell here to exercise the profile path without a wish environment.
   */
  profile?: LunchProfileCell;
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
  ({ users, myName, adminName, participantProfiles, profile }) => {
    const joinName = Writable.perSession.of<string>("");
    // This card owns the canonical `#profile` wish: the resolved cell is the
    // durable identity stored on join, and the wish's built-in [UI] carries
    // the whole create/pick lifecycle when no profile resolves
    // (multi-user-patterns.md#presenting-identity). The optional `profile`
    // input overrides the wish — the injection seam tests use to supply a
    // live profile cell without a resolving wish environment. Input presence
    // is fixed at instantiation, so the `??` selections below are static.
    const profileWish = wish<LunchProfile>({ query: "#profile" });
    // The companion string wishes are the DISPLAY source (the battleship
    // lobby idiom; multi-user-patterns.md prescribes this trio). Reading
    // display fields off the live `#profile` result object comes back empty
    // against the real profile shape — only the injected test override
    // carries them as plain fields.
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    // Static selection at build time (input presence is fixed per
    // instantiation) — hoisted so JSX/bindings below see one plain ref.
    const activeProfile = profile ?? profileWish.result;
    const canonicalProfileName = computed(() =>
      profile !== undefined
        ? profileDisplayName(profile.get())
        : trimmedName(profileNameWish.result ?? "")
    );
    const canonicalProfileAvatar = computed(() =>
      profile !== undefined
        ? (profile.get()?.avatar ?? "").trim()
        : (profileAvatarWish.result ?? "").trim()
    );
    const boundJoin = joinAs({
      users,
      myName,
      adminName,
      joinName,
      participantProfiles,
      profile: activeProfile,
      profileName: canonicalProfileName,
      profileAvatar: canonicalProfileAvatar,
    });
    const boundClaimHost = claimHost({ myName, adminName });

    // Joining is profile-first, and the typed-name path is never automatic:
    // with no resolved profile the card renders the wish's create/pick UI,
    // and "Continue as guest" is an explicit secondary action. `useCustomName`
    // also lets a profile-holder deliberately join under a one-off name.
    const useCustomName = Writable.perSession.of<boolean>(false);
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
                        $profile={activeProfile}
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
                      /* Built-in profile UI: create a profile when there is
                        none, pick between existing profiles otherwise. The
                        typed-name path never appears automatically — guests
                        opt in below. */
                    }
                    <div data-profile-setup>{profileWish[UI]}</div>
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
