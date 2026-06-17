import {
  type Cell,
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
 * Profile group chat — a real multi-user chat that identifies participants by
 * their **shared profile** instead of a free-text name field.
 *
 * Demonstrates the CT-1649 roster approach in a genuine multiplayer pattern:
 *   - Messages live in a `PerSpace` array (shared by everyone in the space).
 *   - The sender's identity is resolved from THEIR shared profile via
 *     `wish({ query: "#profile" })`, and the live profile **cell** is stored on
 *     each message — cross-space reads resolve for any viewer (CT-1667/1687), so
 *     every identity in the UI renders through the trusted, first-class
 *     `<cf-profile-badge>`: message gutters as `circle` badges (avatar + seal,
 *     with a plain name label), the participant strip as `chip` badges, the
 *     viewer's own as `full`. Each badge carries the verified-identity seal and
 *     links to that person's profile.
 *   - A snapshot of name/avatar rides alongside the cell as a durable fallback
 *     label (used for participant dedup and if the live cell is momentarily
 *     unresolved).
 *
 * Compare to `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`, which
 * this is modeled on — the change is sourcing identity from the shared profile
 * (cell, not just strings) and rendering it through the badge.
 * See `docs/specs/shared-profile-rosters.md`.
 */

/** Live link to a contributor's profile cell — stable identity + live data. */
export type ChatProfileCell = Cell<{ name?: string; avatar?: string }>;

export interface ChatMessage {
  /** Sender's live profile cell — rendered first-class via cf-profile-badge. */
  authorProfile: ChatProfileCell;
  /** Sender's profile name, snapshotted at send time (durable fallback label). */
  author: string;
  /** Sender's profile avatar (URL or glyph), snapshotted at send time. */
  avatar: string;
  body: string;
  sentAt: number;
}

const DEFAULT_MESSAGES: ChatMessage[] = [];

type MessagesCell = Writable<ChatMessage[]>;
type DraftCell = Writable<string>;

export type SendEvent = Record<PropertyKey, never>;

// Append a message. `profile` is the sender's live profile cell (the identity
// rendered first-class via cf-profile-badge); it round-trips through `push` as a
// link. `name`/`avatar` arrive as plain strings (named `computed` values
// auto-unwrap as handler state) and are snapshotted as a durable fallback label;
// `draft` is a live PerUser cell.
const sendMessage = handler<SendEvent, {
  messages: MessagesCell;
  draft: DraftCell;
  // May be undefined until the viewer's `#profile` wish resolves; guarded below.
  profile: ChatProfileCell | undefined;
  name: string;
  avatar: string;
}>((_event, { messages, draft, profile, name, avatar }) => {
  const author = (name ?? "").trim();
  const body = (draft.get() ?? "").trim();
  if (!author || !body) return; // No profile yet, or empty message.
  if (!profile) return; // No resolved profile cell — no first-class identity.
  messages.push({
    authorProfile: profile,
    author,
    avatar: (avatar ?? "").trim(),
    body,
    sentAt: safeDateNow(),
  });
  draft.set("");
});

export interface ProfileGroupChatInput {
  /** Shared message log — every user in the space reads & appends to this. */
  messages?: PerSpace<ChatMessage[] | Default<typeof DEFAULT_MESSAGES>>;
  /** Current viewer's message draft — follows the user, not broadcast. */
  draft?: PerUser<string | Default<"">>;
}

export interface ProfileGroupChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<ChatMessage[] | Default<typeof DEFAULT_MESSAGES>>;
  draft: PerUser<string | Default<"">>;
  messageCount: number;
  sendMessage: Stream<SendEvent>;
}

const headerLabel = {
  fontSize: "0.75rem",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6b7280",
};

export default pattern<ProfileGroupChatInput, ProfileGroupChatOutput>(
  ({ messages, draft }) => {
    // Resolve THIS viewer's shared profile (their default profile / picker
    // result under PR #3830). `#profile` is the live cell — the identity key
    // stored on each message and rendered via cf-profile-badge; the field
    // targets give the snapshot strings (fallback label + participant dedup).
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const myName = computed(() => profileNameWish.result ?? "");
    const myAvatar = computed(() => profileAvatarWish.result ?? "");
    const hasProfile = computed(() => (profileNameWish.result ?? "") !== "");
    // The live profile cell — stored on each message and passed to the badge.
    const myProfile = profileWish.result;

    const messageCount = messages.length;

    // Distinct participants (deduped by author name), derived from the shared
    // log — the roster, rendered as a strip of `chip` profile badges bound to
    // each contributor's live profile cell.
    const participants = computed<{ name: string; profile: ChatProfileCell }[]>(
      () => {
        const seen = new Set<string>();
        const out: { name: string; profile: ChatProfileCell }[] = [];
        for (const m of messages ?? []) {
          if (m && m.author && m.authorProfile && !seen.has(m.author)) {
            seen.add(m.author);
            out.push({ name: m.author, profile: m.authorProfile });
          }
        }
        return out;
      },
    );
    const participantCount = computed(() => participants.length);

    const send = sendMessage({
      messages,
      draft,
      profile: myProfile,
      name: myName,
      avatar: myAvatar,
    });

    return {
      [NAME]: "Profile group chat",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "560px" }}>
            <cf-hstack justify="between" align="center" gap="4">
              <cf-heading level={3}>Profile chat</cf-heading>
              <cf-vstack gap="1" align="end">
                <span style={headerLabel}>You</span>
                <cf-profile-badge $profile={profileWish.result} size="sm" />
              </cf-vstack>
            </cf-hstack>

            {
              /* Roster strip — distinct participants, each a `chip` badge bound
              to their live profile cell (name + DID-hued seal dot, navigable). */
            }
            <cf-vstack gap="1">
              <span style={headerLabel}>
                In this room ({participantCount})
              </span>
              {
                /* Plain flex row (not cf-hstack) — cf-hstack's :host clips
                  overflow:hidden, which cuts the badges' verified glow. */
              }
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {participants.map((p) => (
                  <cf-profile-badge variant="chip" $profile={p.profile} />
                ))}
              </div>
            </cf-vstack>

            {
              /* Messages — classic chat layout: the sender's avatar as a
              `circle` profile badge (verified seal ring, navigable to their
              profile) in the gutter, with the name as a plain text label above
              the body. */
            }
            <cf-vstack gap="3" style={{ minHeight: "160px" }}>
              {messages.map((message) => (
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "flex-start",
                  }}
                >
                  <cf-profile-badge
                    variant="circle"
                    size="sm"
                    $profile={message.authorProfile}
                  />
                  <cf-vstack gap="0">
                    <span style={{ fontSize: "0.8125rem", fontWeight: "600" }}>
                      {message.author}
                    </span>
                    <span
                      style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap" }}
                    >
                      {message.body}
                    </span>
                  </cf-vstack>
                </div>
              ))}
            </cf-vstack>

            {/* Composer — disabled until the viewer has a resolvable profile. */}
            <cf-hstack gap="2" align="end">
              <cf-input
                $value={draft}
                placeholder="Message"
                aria-label="Message"
                timing-strategy="immediate"
                style={{ flex: "1" }}
              />
              <cf-button onClick={send} disabled={computed(() => !hasProfile)}>
                Send
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-screen>
      ),
      messages,
      draft,
      messageCount,
      sendMessage: send,
    };
  },
);
