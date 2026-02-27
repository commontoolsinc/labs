/// <cts-enable />
import {
  BuiltInLLMMessage,
  computed,
  Default,
  fetchData,
  handler,
  llmDialog,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

// --- Handlers ---

const sendTextMessage = handler<
  { detail: { text: string } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.text }],
  });
});

const sendVoiceMessage = handler<
  { detail: { transcription: { text: string } } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  const text = event.detail.transcription.text;
  if (text) {
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text }],
    });
  }
});

const clearChat = handler(
  (_: never, { messages, pending }: {
    messages: Writable<Array<BuiltInLLMMessage>>;
    pending: Writable<boolean | undefined>;
  }) => {
    messages.set([]);
    pending.set(false);
  },
);

// --- Types ---

type Input = {
  messages?: Writable<Default<Array<BuiltInLLMMessage>, []>>;
  system?: string;
  voice?: Default<string, "nova">;
};

type Output = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
};

const VOICE_SYSTEM_PROMPT =
  "You are having a spoken conversation. Keep responses concise " +
  "and natural — 1-3 sentences unless asked for detail. No markdown, " +
  "no bullet points, no formatting. Speak like a person, not a document.";

// --- Pattern ---

export default pattern<Input, Output>(({ messages, system, voice }) => {
  const model = Writable.of<string>("anthropic:claude-sonnet-4-5");
  const transcription = Writable.of(null);

  const { addMessage, cancelGeneration, pending } = llmDialog({
    system: computed(() => system ?? VOICE_SYSTEM_PROMPT),
    messages,
    model,
  });

  // --- TTS Playback ---
  //
  // When the LLM finishes responding (pending → false, last msg is assistant),
  // POST the text to /api/ai/voice/synthesize via fetchData.
  // The endpoint returns { audioUrl } which we set on <audio autoPlay>.

  // Extract latest assistant text only when generation is complete.
  // Include message count so the computed updates on each new message.
  const ttsPayload = computed(() => {
    if (pending) return null;
    const msgs = messages?.get?.() ?? [];
    if (msgs.length === 0) return null;
    const last = msgs[msgs.length - 1];
    if (last.role !== "assistant") return null;

    let text: string | null = null;
    if (typeof last.content === "string") {
      text = last.content;
    } else if (Array.isArray(last.content)) {
      const part = last.content.find((p: any) => p.type === "text");
      text = (part as any)?.text ?? null;
    }
    if (!text) return null;

    // Include msg count as a cache-buster so fetchData re-fires
    // for each new assistant message, even if the text happened
    // to be the same.
    return { text, msgCount: msgs.length };
  });

  const { result: ttsResult } = fetchData({
    url: computed(() => ttsPayload ? "/api/ai/voice/synthesize" : null),
    mode: "json",
    options: computed(() => {
      if (!ttsPayload) return undefined;
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: ttsPayload.text,
          voice: voice ?? "nova",
        }),
      };
    }),
  });

  // The audio URL that <audio> will stream from
  const audioSrc = computed(() => (ttsResult as any)?.audioUrl ?? "");

  return {
    [NAME]: "Voice Chat",
    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack align="center" justify="between">
            <ct-heading level={4}>Voice Chat</ct-heading>
            <ct-button
              variant="pill"
              onClick={clearChat({ messages, pending })}
            >
              Clear
            </ct-button>
          </ct-hstack>
        </div>

        {/* Conversation transcript */}
        <ct-vscroll
          style="padding: 1rem;"
          flex
          showScrollbar
          fadeEdges
          snapToBottom
        >
          <ct-chat $messages={messages} pending={pending} />
        </ct-vscroll>

        {/* Hidden audio — plays TTS when src updates */}
        <audio autoPlay src={audioSrc} />

        {/* Voice input — hold mic to record */}
        <div
          style={{
            padding: "0.5rem 1rem",
            borderTop: "1px solid var(--ct-color-gray-200)",
          }}
        >
          <ct-voice-input
            $transcription={transcription}
            recordingMode="hold"
            autoTranscribe
            maxDuration={120}
            showWaveform
            onct-transcription-complete={sendVoiceMessage({ addMessage })}
          />
        </div>

        {/* Text input — type or dictate via SuperWhisper */}
        <ct-prompt-input
          slot="footer"
          placeholder="Say something..."
          pending={pending}
          onct-send={sendTextMessage({ addMessage })}
          onct-stop={cancelGeneration}
        />
      </ct-screen>
    ),
    messages,
    pending,
    addMessage,
  };
});
