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
 * Profile group chat — a real multi-user chat that identifies participants by
 * their **shared profile** instead of a free-text name field.
 *
 * Demonstrates the CT-1649 roster approach in a genuine multiplayer pattern:
 *   - Messages live in a `PerSpace` array (shared by everyone in the space).
 *   - The sender's identity is resolved from THEIR shared profile via
 *     `wish({ query: "#profileName" / "#profileAvatar" })` and snapshotted onto
 *     each message at send time — so every other viewer renders it from plain
 *     strings already in the space (no cross-space profile resolution needed).
 *   - Each message + the participant strip render with `<cf-avatar>`; the
 *     current viewer's own live profile renders with the trusted
 *     `<cf-profile-badge>`.
 *
 * Compare to `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`, which
 * this is modeled on — the only change is sourcing name/avatar from the shared
 * profile rather than a typed-in name. See `docs/specs/shared-profile-rosters.md`.
 */

export interface ChatMessage {
  /** Sender's profile name, snapshotted at send time. */
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

// Append a message, snapshotting the sender's resolved profile name/avatar.
// `name`/`avatar` arrive as plain strings (named `computed` values auto-unwrap
// as handler state); `draft` is a live PerUser cell.
const sendMessage = handler<SendEvent, {
  messages: MessagesCell;
  draft: DraftCell;
  name: string;
  avatar: string;
}>((_event, { messages, draft, name, avatar }) => {
  const author = (name ?? "").trim();
  const body = (draft.get() ?? "").trim();
  if (!author || !body) return; // No profile yet, or empty message.
  messages.push({
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
    // result under PR #3830). `#profile` is the live cell for cf-profile-badge;
    // the field targets give the strings we snapshot onto each message.
    const profileWish = wish({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const myName = computed(() => profileNameWish.result ?? "");
    const myAvatar = computed(() => profileAvatarWish.result ?? "");
    const hasProfile = computed(() => (profileNameWish.result ?? "") !== "");

    const messageCount = messages.length;

    // Distinct participants (deduped by author), derived from the shared log —
    // the roster, rendered as a strip of cf-avatars.
    const participants = computed<{ name: string; avatar: string }[]>(() => {
      const seen = new Set<string>();
      const out: { name: string; avatar: string }[] = [];
      for (const m of messages ?? []) {
        if (m && m.author && !seen.has(m.author)) {
          seen.add(m.author);
          out.push({ name: m.author, avatar: m.avatar ?? "" });
        }
      }
      return out;
    });
    const participantCount = computed(() => participants.length);

    const send = sendMessage({
      messages,
      draft,
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

            {/* Roster strip — distinct participants by shared profile. */}
            <cf-vstack gap="1">
              <span style={headerLabel}>
                In this room ({participantCount})
              </span>
              <cf-hstack gap="2" align="center" style={{ flexWrap: "wrap" }}>
                {participants.map((p) => (
                  <cf-hstack gap="1" align="center">
                    <cf-avatar src={p.avatar} name={p.name} size="xs" />
                    <span style={{ fontSize: "0.8125rem" }}>{p.name}</span>
                  </cf-hstack>
                ))}
              </cf-hstack>
            </cf-vstack>

            {/* Messages — each shows the sender's snapshotted profile avatar. */}
            <cf-vstack gap="3" style={{ minHeight: "160px" }}>
              {messages.map((message) => (
                <cf-hstack gap="2" align="start">
                  <cf-avatar
                    src={message.avatar}
                    name={message.author}
                    size="sm"
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
                </cf-hstack>
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
