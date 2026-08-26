import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  type PerSpace,
  UI,
  type VNode,
  wish,
} from "commonfabric";

const DEFAULT_NOTE = "# Collaborative note\n\nStart writing together.";

export interface CollaborativeNoteInput {
  /** Note body shared by every viewer of this piece. */
  note?: PerSpace<string | Default<typeof DEFAULT_NOTE>>;

  /** Opaque high-entropy room shared by this piece's co-presence sessions. */
  presenceRoom: PerSpace<string>;
}

export interface CollaborativeNoteOutput {
  [NAME]: string;
  [UI]: VNode;
  note: PerSpace<string | Default<typeof DEFAULT_NOTE>>;
  presenceRoom: PerSpace<string>;
  participantName: string;
}

/**
 * A minimal shared note that pairs Memory-backed text with ephemeral cursors.
 * The host supplies the co-presence service URL; this pattern supplies the
 * shared room and derives each viewer's label from their Fabric profile.
 */
export default pattern<CollaborativeNoteInput, CollaborativeNoteOutput>(
  ({ note, presenceRoom }) => {
    // `#profile` owns the create/pick UI and live profile identity. The field
    // wish is the profile-backed plain-text label expected by cf-code-editor.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const participantName = computed(() =>
      Array.from((profileNameWish.result ?? "").trim()).slice(0, 80).join("")
    );
    const hasProfile = computed(() =>
      (profileNameWish.result ?? "").trim() !== "" &&
      profileWish.result !== undefined
    );

    return {
      [NAME]: "Collaborative note",
      [UI]: (
        <cf-screen>
          <cf-vstack
            gap="4"
            style={{ padding: "1rem", maxWidth: "760px", margin: "0 auto" }}
          >
            <cf-hstack justify="between" align="center" gap="4">
              <cf-vstack gap="1">
                <cf-heading level={2}>Collaborative note</cf-heading>
                <cf-text tone="muted">
                  The note is durable; names and live selections are ephemeral.
                </cf-text>
              </cf-vstack>
              {ifElse(
                hasProfile,
                <cf-profile-badge
                  variant="chip"
                  $profile={profileWish.result}
                />,
                <div id="collaborative-note-profile-setup">
                  {profileWish[UI]}
                </div>,
              )}
            </cf-hstack>

            <cf-code-editor
              $value={note}
              collaborative
              presenceRoom={presenceRoom}
              participantName={participantName}
              language="text/markdown"
              mode="prose"
              wordWrap
              placeholder="Write something together…"
              style={{ minHeight: "24rem" }}
            />
          </cf-vstack>
        </cf-screen>
      ),
      note,
      presenceRoom,
      participantName,
    };
  },
);
