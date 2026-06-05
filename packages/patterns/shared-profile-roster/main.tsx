import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

/**
 * Shared-profile participant roster (CT-1649).
 *
 * Reference pattern for chat rooms / multiplayer lobbies. There is no runtime
 * primitive for "list every user's profile in this space", so instead each user
 * contributes their OWN entry on join, sourced from their shared profile
 * (`wish({ query: "#profile" })`). See `docs/specs/shared-profile-rosters.md`.
 *
 * Storage model: a **snapshot** (name + avatar copied at join time) is the
 * recommended default — the roster is then fully self-describing inside the
 * shared space and never depends on other users' profile spaces being reachable.
 * Participants render from those snapshot strings via `<cf-avatar>`. The current
 * viewer's OWN live profile is the one case where a live profile cell is
 * reliably resolvable, so it's shown with the trusted `<cf-profile-badge>`.
 */

/** One participant's contribution to the shared roster (a profile snapshot). */
export interface Participant {
  /** Display name, snapshotted from the joiner's profile at join time. */
  name: string;
  /** Avatar URL or glyph, snapshotted from the joiner's profile (may be ""). */
  avatar: string;
  joinedAt: number;
}

export interface Roster {
  participants: Participant[] | Default<[]>;
}

/** Per-user marker so a viewer only joins once and can see "joined" state. */
export interface ViewerState {
  joinedName?: string;
}

const DEFAULT_ROSTER: Roster = { participants: [] };
const EMPTY_VIEWER: ViewerState = {};

type RosterCell = Writable<Roster | Default<typeof DEFAULT_ROSTER>>;
type ViewerCell = Writable<ViewerState | Default<typeof EMPTY_VIEWER>>;

export type JoinEvent = Record<PropertyKey, never>;

// The current viewer's display name/avatar are resolved from their shared
// profile in the pattern body (via wish) and passed in as plain string state;
// the handler only appends a snapshot to the shared roster and records that this
// viewer has joined. (Named `computed` values auto-unwrap to plain strings as
// handler state — do not call `.get()` on them here.)
const join = handler<JoinEvent, {
  roster: RosterCell;
  viewer: ViewerCell;
  name: string;
  avatar: string;
}>((_event, { roster, viewer, name, avatar }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return; // No resolved profile name yet — nothing to contribute.

  // Idempotent: don't re-add this viewer.
  if ((viewer.get().joinedName ?? "") === trimmed) return;

  const participants = roster.key("participants");
  const already = participants.get().some((p) => p.name === trimmed);
  if (!already) {
    participants.push({
      name: trimmed,
      avatar: (avatar ?? "").trim(),
      joinedAt: safeDateNow(),
    });
  }
  viewer.set({ joinedName: trimmed });
});

export interface RosterDemoInput {
  /** Shared roster — every user in the space reads & appends to this. */
  roster?: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  /** Current viewer's join marker — follows the user, not broadcast directly. */
  viewer?: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
}

export interface RosterDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  roster: PerSpace<Roster | Default<typeof DEFAULT_ROSTER>>;
  viewer: PerUser<ViewerState | Default<typeof EMPTY_VIEWER>>;
  participantCount: number;
  join: Stream<JoinEvent>;
}

export default pattern<RosterDemoInput, RosterDemoOutput>(
  ({ roster, viewer }) => {
    // Resolve THIS viewer's shared profile. `#profile` yields the viewer's own
    // profile cell (the default profile / picker result under PR #3830); the
    // convenience targets give just the fields for the snapshot.
    const profileWish = wish({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const myName = computed(() => profileNameWish.result ?? "");
    const myAvatar = computed(() => profileAvatarWish.result ?? "");

    const participants = roster.participants;
    const participantCount = participants.length;
    const hasJoined = computed(() => (viewer.joinedName ?? "") !== "");
    // Inside a `computed` body, named `computed` values (hasJoined, myName)
    // auto-unwrap to their plain value — do NOT call `.get()` on them here.
    const joinLabel = computed(() =>
      hasJoined ? "Joined" : "Join as " + (myName || "…")
    );

    const boundJoin = join({ roster, viewer, name: myName, avatar: myAvatar });

    return {
      [NAME]: "Shared-profile roster",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "440px" }}>
            {
              /* The current viewer's OWN identity — a live profile cell, so the
                trusted cf-profile-badge applies. */
            }
            <cf-vstack gap="1">
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "600",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "#6b7280",
                }}
              >
                You
              </span>
              <cf-profile-badge $profile={profileWish.result} size="md" />
            </cf-vstack>

            <cf-hstack justify="between" align="center">
              <cf-heading level={3}>
                Participants ({participantCount})
              </cf-heading>
              <cf-button onClick={boundJoin} disabled={hasJoined}>
                {joinLabel}
              </cf-button>
            </cf-hstack>

            {/* Other users render from the snapshot roster via cf-avatar. */}
            <cf-vstack gap="2">
              {participants.map((p) => (
                <cf-hstack gap="2" align="center">
                  <cf-avatar src={p.avatar} name={p.name} size="sm" />
                  <span style={{ fontSize: "0.875rem" }}>{p.name}</span>
                </cf-hstack>
              ))}
            </cf-vstack>
          </cf-vstack>
        </cf-screen>
      ),
      roster,
      viewer,
      participantCount,
      join: boundJoin,
    };
  },
);
