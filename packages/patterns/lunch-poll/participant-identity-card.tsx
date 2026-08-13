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
  HostCell,
  JoinEvent,
  LunchProfileCell,
  User,
} from "./main.tsx";

/** Parent-owned roster cell shared by all viewers. */
export type ParticipantIdentityUsersCell = Writable<User[] | Default<[]>>;

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

/**
 * Join as the viewer's shared profile.
 *
 * There is nothing to type: identity is the profile cell, so the roster entry
 * is derived from it rather than from anything the joiner can supply. Joining
 * twice is idempotent — the entry is found by `equals()`, so a second press,
 * a second device, or a rename all resolve to the same participant.
 */
const joinAs = handler<JoinEvent, {
  users: ParticipantIdentityUsersCell;
  host: HostCell;
  profile: LunchProfileCell | undefined;
  // Display strings arrive pre-resolved from `#profileName` / `#profileAvatar`.
  // Field reads off the live `#profile` result are not a reliable display
  // source; the dedicated string wishes are.
  profileName: string;
  profileAvatar: string;
}>(
  (_event, { users, host, profile, profileName, profileAvatar }) => {
    // Gate on the NAME, not on `profile` being falsy: an unset optional CELL
    // input reads as a present-but-empty cell, so `!profile` never fires and a
    // viewer with no resolved profile would join with an empty identity. The
    // name string is honestly "" when nothing resolved.
    const name = trimmedName(profileName);
    if (!name || !profile) return;
    // A `Default<[]>` cell reads undefined until something writes it.
    const existing = users.get() ?? [];
    // Already joined — on any device, under any name. Nothing to do.
    if (existing.some((u) => equals(u.profile, profile))) return;
    users.set([...existing, {
      profile,
      name,
      avatar: (profileAvatar ?? "").trim(),
      color: colorForIndex(existing.length),
    }]);
    // First to join hosts the poll.
    if ((host.get() ?? {}).profile === undefined) host.set({ profile });
  },
);

const claimHost = handler<ClaimHostEvent, {
  users: ParticipantIdentityUsersCell;
  host: HostCell;
  profile: LunchProfileCell | undefined;
  profileName: string;
}>((_event, { users, host, profile, profileName }) => {
  if (!trimmedName(profileName) || !profile) return;
  // Only a participant may host, and taking a host role you already hold is a
  // no-op rather than a redundant write.
  if (!(users.get() ?? []).some((u) => equals(u.profile, profile))) return;
  const current = (host.get() ?? {}).profile;
  if (current !== undefined && equals(current, profile)) return;
  host.set({ profile });
});

/**
 * ParticipantIdentityCard renders the join and host-claim surface.
 *
 * Joining is profile-only: identity is the viewer's `#profile` cell, so two
 * people who share a display name are still distinct participants, a rename
 * never orphans anything, and no per-user state exists to go stale and lock
 * someone out. When no profile resolves, the card renders the `#profile`
 * wish's own create/pick surface, passed down by the parent.
 */

/** Inputs for the participant identity/host controls. */
export interface ParticipantIdentityCardInput {
  /** Shared roster of participants who have joined. */
  users: ParticipantIdentityUsersCell;

  /** Shared pointer to whoever hosts the poll. */
  host: HostCell;

  /**
   * The viewer's resolved `#profile` cell — their identity. Undefined until it
   * resolves, or when the viewer has no profile yet.
   */
  profile?: LunchProfileCell;

  /** The viewer's resolved display name ("" until `#profileName` resolves). */
  profileName: string;

  /** The viewer's resolved avatar. */
  profileAvatar: string;

  /**
   * The `#profile` wish's built-in create/pick surface, rendered by the parent
   * and passed down so the card can show it when no profile resolves.
   */
  profileSetupUI?: VNode;
}

/** Outputs for the participant identity/host controls. */
export interface ParticipantIdentityCardOutput {
  [NAME]: string;
  [UI]: VNode;
  /** Whether the viewer has joined this poll. */
  isJoined: boolean;
  /** Whether the viewer hosts this poll. */
  isAdmin: boolean;
  joinAs: Stream<JoinEvent>;
  claimHost: Stream<ClaimHostEvent>;
}

export default pattern<
  ParticipantIdentityCardInput,
  ParticipantIdentityCardOutput
>(
  ({ users, host, profile, profileName, profileAvatar, profileSetupUI }) => {
    const boundJoin = joinAs({
      users,
      host,
      profile,
      profileName,
      profileAvatar,
    });
    const boundClaimHost = claimHost({ users, host, profile, profileName });

    // Identity is derived, never stored per-user: compare the viewer's profile
    // cell against the roster. `equals()` follows links to the end, and a
    // comparison is position-independent — unlike a `list.key(i)` handle, which
    // follows the slot and retargets when an earlier entry is removed.
    const isJoined = computed(() => {
      const mine = profile;
      if (!mine) return false;
      return (users.get() ?? []).some((u) => equals(u.profile, mine));
    });
    const isAdmin = computed(() => {
      const mine = profile;
      const current = (host.get() ?? {}).profile;
      if (!mine || current === undefined) return false;
      return equals(current, mine);
    });
    const hasProfile = computed(() => trimmedName(profileName) !== "");
    const canonicalProfileName = computed(() => trimmedName(profileName));
    const hostName = computed(() => {
      const current = (host.get() ?? {}).profile;
      if (current === undefined) return "";
      const entry = (users.get() ?? []).find((u) => equals(u.profile, current));
      return entry ? entry.name : "";
    });
    const joinHint = computed(() =>
      hostName === ""
        ? "First to join becomes the host."
        : `Hosted by ${hostName}.`
    );
    const canClaimHost = computed(() => isJoined && !isAdmin);

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
              {hasProfile
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
                      aria-label="Join the poll with your profile"
                      onClick={() => boundJoin.send({})}
                    >
                      Join as {canonicalProfileName}
                    </cf-button>
                  </div>
                )
                : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    {
                      /* The wish's own create/pick surface. Joining needs a
                        profile, so this is the only path in — there is no
                        typed-name fallback to collide or be spoofed. */
                    }
                    <div data-profile-setup>{profileSetupUI}</div>
                  </div>
                )}
            </div>
          )}
          {canClaimHost
            ? (
              <div style={{ marginBottom: "12px" }}>
                <cf-button
                  id="lp-claim-host"
                  variant="ghost"
                  size="sm"
                  aria-label="Take over hosting"
                  onClick={() => boundClaimHost.send({})}
                >
                  Take over hosting
                </cf-button>
              </div>
            )
            : null}
        </div>
      ),
      isJoined,
      isAdmin,
      joinAs: boundJoin,
      claimHost: boundClaimHost,
    };
  },
);
