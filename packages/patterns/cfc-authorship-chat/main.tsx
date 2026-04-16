import { type Cfc, computed, NAME, pattern, UI, Writable } from "commonfabric";

type AuthorshipIntegrity<Author extends string> = {
  readonly kind: "authored-by";
  readonly subject: Author;
};

type AuthorClaim<Author extends string> = {
  readonly id: Author;
  readonly name: string;
  readonly avatar: string;
};

type AuthoredMessage<Sender extends string> = {
  readonly id: string;
  readonly channel: string;
  readonly sender: AuthorClaim<Sender>;
  readonly body: string;
};

type AuthoredMessageWithIntegrity<
  IntegrityAuthor extends string,
  Sender extends string,
> = Cfc<
  AuthoredMessage<Sender>,
  { integrity: readonly [AuthorshipIntegrity<IntegrityAuthor>] }
>;

type AuthoredBlockProps = {
  title: string;
  summary: string;
  message: Writable<AuthoredMessage<string>>;
  surface: string;
};

type AuthorshipChatOutput = {
  [NAME]: string;
  [UI]: unknown;
  verifiedAuthor: string;
  forgedClaim: string;
  unsignedState: string;
};

function AuthoredBlock(
  { title, summary, message, surface }: AuthoredBlockProps,
) {
  return (
    <cf-card data-authorship-card={surface}>
      <cf-vstack slot="content" gap="2">
        <cf-heading level={3}>{title}</cf-heading>
        <cf-label>{summary}</cf-label>
        <cf-cfc-authorship
          data-authorship-surface={surface}
          $value={message}
          author={message.key("sender")}
          avatar={message.key("sender").key("avatar")}
        >
          <div className="authorship-content-block">
            <cf-label>{message.key("channel")}</cf-label>
            <cf-chat-message
              role="assistant"
              name={message.key("sender").key("name")}
              content={message.key("body")}
            />
          </div>
        </cf-cfc-authorship>
      </cf-vstack>
    </cf-card>
  );
}

export default pattern<unknown, AuthorshipChatOutput>(() => {
  const verifiedMessage: Writable<
    AuthoredMessageWithIntegrity<"alice", "alice">
  > = Writable.of<AuthoredMessageWithIntegrity<"alice", "alice">>(
    {
      id: "msg-verified",
      channel: "Project chat",
      sender: {
        id: "alice",
        name: "Alice Nguyen",
        avatar:
          "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&fit=crop",
      },
      body:
        "I reviewed the launch copy and signed off on the customer-facing wording.",
    } as AuthoredMessageWithIntegrity<"alice", "alice">,
  );

  const forgedMessage: Writable<
    AuthoredMessageWithIntegrity<"alice", "bob">
  > = Writable.of<AuthoredMessageWithIntegrity<"alice", "bob">>(
    {
      id: "msg-forged",
      channel: "Project chat",
      sender: {
        id: "bob",
        name: "Bob Patel",
        avatar:
          "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&fit=crop",
      },
      body:
        "I definitely authored Alice's approval, and the UI should not certify this claim.",
    } as AuthoredMessageWithIntegrity<"alice", "bob">,
  );

  const unsignedMessage = Writable.of<AuthoredMessage<"casey">>(
    {
      id: "msg-unsigned",
      channel: "Imported ticket thread",
      sender: {
        id: "casey",
        name: "Casey Morgan",
        avatar:
          "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=96&h=96&fit=crop",
      },
      body:
        "This imported comment has no persisted authorship integrity yet, so it stays uncertified.",
    },
  );

  const verifiedAuthor = computed(() =>
    verifiedMessage.key("sender").key("name").get()
  );
  const forgedClaim = computed(() =>
    forgedMessage.key("sender").key("name").get()
  );
  const unsignedState = computed(() =>
    unsignedMessage.key("sender").key("name").get()
  );

  return {
    [NAME]: "CFC authorship chat demo",
    [UI]: (
      <cf-screen title="CFC authorship chat demo">
        <cf-vstack gap="4" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={2}>
                Verified authorship for user content
              </cf-heading>
              <cf-label>
                Each block is rendered by untrusted pattern code, but the
                cf-cfc-authorship component verifies the bound content cell
                against its persisted CFC integrity label before rendering a
                trusted avatar state.
              </cf-label>
            </cf-vstack>
          </cf-card>
          {AuthoredBlock({
            title: "Matching content and author claim",
            summary:
              "The rendered block claims Alice, and the whole message object carries authored-by Alice integrity.",
            surface: "verified",
            message: verifiedMessage,
          })}
          {AuthoredBlock({
            title: "Forged author claim",
            summary:
              "The rendered block claims Bob, but the message object only carries authored-by Alice integrity.",
            surface: "forged",
            message: forgedMessage,
          })}
          {AuthoredBlock({
            title: "Unsigned imported content",
            summary:
              "The content has no authorship integrity label, so the trusted avatar is withheld.",
            surface: "unsigned",
            message: unsignedMessage,
          })}
        </cf-vstack>
      </cf-screen>
    ),
    verifiedAuthor,
    forgedClaim,
    unsignedState,
  };
});
