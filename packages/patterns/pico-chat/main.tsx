import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface ChatMessage {
  from: string;
  body: string;
}

const DEFAULT_MESSAGES: ChatMessage[] = [];
const DEFAULT_NAME = "";

type MessagesValue = Default<ChatMessage[], typeof DEFAULT_MESSAGES>;
type NameValue = Default<typeof DEFAULT_NAME>;

export type MessagesCell = Writable<MessagesValue>;
export type NameCell = Writable<NameValue>;

export interface SendEvent {
  detail?: {
    message?: string;
  };
}

export interface PicoChatInput {
  messages?: PerSpace<MessagesValue>;
  name?: PerUser<NameValue>;
}

export interface PicoChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<MessagesValue>;
  name: PerUser<NameValue>;
  send: Stream<SendEvent>;
}

const sendMessage = handler<SendEvent, {
  messages: MessagesCell;
  name: NameCell;
}>(({ detail }, { messages, name }) => {
  const from = name.get().trim();
  const body = detail?.message?.trim() ?? "";

  if (!from || !body) return;

  messages.push({ from, body });
});

const textStyle =
  "unicode-bidi: plaintext; white-space: pre-wrap; overflow-wrap: anywhere;";

export default pattern<PicoChatInput, PicoChatOutput>(
  ({ messages, name }) => {
    const send = sendMessage({ messages, name });
    const displayMessages = computed(() => [...messages].reverse());

    return {
      [NAME]: "Pico chat",
      [UI]: (
        <cf-screen>
          <cf-vstack gap="4" padding="6" style="max-width: 720px;">
            <cf-heading level={2}>Pico chat</cf-heading>

            <cf-vstack gap="2">
              <cf-label>Your name</cf-label>
              <cf-input
                id="chat-name"
                $value={name}
                placeholder="Name"
                timing-strategy="immediate"
              />
            </cf-vstack>

            <cf-card>
              <div
                slot="content"
                id="chat-messages"
                style="height: 320px; overflow-y: auto; display: flex; flex-direction: column-reverse;"
              >
                <div style="display: flex; flex-direction: column-reverse;">
                  {displayMessages.length === 0
                    ? <div style="color: #64748b;">No messages yet</div>
                    : displayMessages.map((message) => (
                      <div style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                        <strong dir="ltr" style={textStyle}>
                          {message.from}
                        </strong>
                        <div dir="ltr" style={textStyle}>{message.body}</div>
                      </div>
                    ))}
                </div>
              </div>
            </cf-card>

            <cf-message-input
              id="chat-message"
              placeholder="Message"
              button-text="Send"
              oncf-send={send}
            />
          </cf-vstack>
        </cf-screen>
      ),
      messages,
      name,
      send,
    };
  },
);
