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
  patternTool,
  Stream,
  UI,
  wish,
  Writable,
} from "commontools";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./system/summary-index.tsx";

// --- Helpers ---

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- Handlers ---

const sendTextMessage = handler<
  { detail: { text: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    messageSentAt: Writable<number | null>;
    sttDurationMs: Writable<number | null>;
  }
>((event, { addMessage, messageSentAt, sttDurationMs }) => {
  sttDurationMs.set(null);
  messageSentAt.set(Date.now());
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.text }],
  });
});

const sendVoiceMessage = handler<
  { detail: { transcription: { text: string; timestamp?: number } } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    messageSentAt: Writable<number | null>;
    sttDurationMs: Writable<number | null>;
  }
>((event, { addMessage, messageSentAt, sttDurationMs }) => {
  const { text, timestamp } = event.detail.transcription;
  if (text) {
    sttDurationMs.set(timestamp ? Date.now() - timestamp : null);
    messageSentAt.set(Date.now());
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text }],
    });
  }
});

const clearChat = handler(
  (_: never, ctx: {
    messages: Writable<Array<BuiltInLLMMessage>>;
    pending: Writable<boolean | undefined>;
    sttDurationMs: Writable<number | null>;
    messageSentAt: Writable<number | null>;
  }) => {
    ctx.messages.set([]);
    ctx.pending.set(false);
    ctx.sttDurationMs.set(null);
    ctx.messageSentAt.set(null);
  },
);

// --- Types ---

type Input = {
  messages?: Writable<Default<Array<BuiltInLLMMessage>, []>>;
  system?: string;
  voice?: Default<string, "f786b574-daa5-4673-aa0c-cbe3e8534c02">;
};

type Output = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
};

const VOICE_SYSTEM_PROMPT =
  "You are having a spoken conversation. Keep responses concise " +
  "and natural — 1-3 sentences unless asked for detail. No markdown, " +
  "no bullet points, no formatting. Speak like a person, not a document. " +
  "You have access to the user's notes via the searchNotes tool. When " +
  "asked about their notes, use this tool to find relevant information.";

// --- Debug panel styles ---

const rowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.375rem 0",
  borderBottom: "1px solid var(--ct-color-gray-100)",
  fontSize: "0.8125rem",
};

const labelStyle = {
  color: "var(--ct-color-gray-500)",
  fontWeight: "500",
};

const valueStyle = {
  fontFamily: "monospace",
  fontWeight: "600",
};

const totalRowStyle = {
  ...rowStyle,
  borderBottom: "none",
  borderTop: "2px solid var(--ct-color-gray-200)",
  marginTop: "0.25rem",
  paddingTop: "0.5rem",
};

// --- Pattern ---

export default pattern<Input, Output>(({ messages, system, voice }) => {
  const model = Writable.of<string>("anthropic:claude-haiku-4-5");
  const transcription = Writable.of(null);

  // Timing cells
  const sttDurationMs = Writable.of<number | null>(null);
  const messageSentAt = Writable.of<number | null>(null);

  const { entries: summaryEntries } = wish<{ entries: SummaryIndexEntry[] }>({
    query: "#summaryIndex",
  }).result;

  const tools = {
    searchNotes: patternTool(summarySearchPattern, { entries: summaryEntries }),
  };

  const { addMessage, cancelGeneration, pending } = llmDialog({
    system: computed(() => system ?? VOICE_SYSTEM_PROMPT),
    messages,
    model,
    tools,
  });

  // --- TTS Playback ---
  //
  // When the LLM finishes responding (pending → false, last msg is assistant),
  // POST the text to /api/ai/voice/synthesize via fetchData.
  // The endpoint returns { audioUrl, timing } which we use for playback + debug.

  const ttsPayload = computed(() => {
    if (pending) return null;
    const msgs = messages?.get?.() ?? [];
    if (msgs.length === 0) return null;
    const last = msgs[msgs.length - 1];
    if (last.role !== "assistant") return null;
    // Skip assistant messages that contain tool calls — don't speak those
    if (
      Array.isArray(last.content) &&
      last.content.some((p: any) => p.type === "tool-call")
    ) return null;

    let text: string | null = null;
    if (typeof last.content === "string") {
      text = last.content;
    } else if (Array.isArray(last.content)) {
      const part = last.content.find((p: any) => p.type === "text");
      text = (part as any)?.text ?? null;
    }
    if (!text) return null;

    // Capture when LLM generation completed (pending → false)
    return { text, msgCount: msgs.length, completedAt: Date.now() };
  });

  const { result: ttsResult } = fetchData({
    url: computed(() => ttsPayload ? "/api/ai/voice/synthesize" : null),
    mode: "json",
    options: computed(() => {
      if (!ttsPayload) return null;
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: ttsPayload.text,
          voice: voice ?? "f786b574-daa5-4673-aa0c-cbe3e8534c02",
        }),
      };
    }),
  });

  const audioSrc = computed(() => (ttsResult as any)?.audioUrl ?? "");

  // --- Derived timing ---

  const llmDurationMs = computed(() => {
    if (!ttsPayload) return null;
    const sentAt = messageSentAt.get();
    if (!sentAt) return null;
    return ttsPayload.completedAt - sentAt;
  });

  const ttsTiming = computed(() => (ttsResult as any)?.timing ?? null);

  const totalDurationMs = computed(() => {
    const llm = llmDurationMs;
    if (llm == null) return null;
    const stt = sttDurationMs.get() ?? 0;
    const tts = ttsTiming?.totalMs ?? 0;
    return stt + llm + tts;
  });

  // Formatted display values
  const sttDisplay = computed(() => formatDuration(sttDurationMs.get()));
  const llmDisplay = computed(() => formatDuration(llmDurationMs));
  const ttsDisplay = computed(() => {
    if (!ttsTiming) return "—";
    const label = formatDuration(ttsTiming.totalMs);
    return ttsTiming.cached ? `${label} (cached)` : label;
  });
  const totalDisplay = computed(() => formatDuration(totalDurationMs));

  // Handler contexts
  const sendCtx = { addMessage, messageSentAt, sttDurationMs };
  const clearCtx = { messages, pending, sttDurationMs, messageSentAt };

  return {
    [NAME]: "Voice Chat",
    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack align="center" justify="between">
            <ct-heading level={4}>Voice Chat</ct-heading>
            <ct-button variant="pill" onClick={clearChat(clearCtx)}>
              Clear
            </ct-button>
          </ct-hstack>
        </div>

        <ct-resizable-panel-group direction="horizontal" style="flex: 1;">
          {/* Left: Chat */}
          <ct-resizable-panel default-size="70" min-size="50">
            <ct-vstack style="height: 100%;">
              <ct-vscroll
                style="padding: 1rem;"
                flex
                showScrollbar
                fadeEdges
                snapToBottom
              >
                <ct-chat $messages={messages} pending={pending} />
              </ct-vscroll>

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
                  onct-transcription-complete={sendVoiceMessage(sendCtx)}
                />
              </div>
            </ct-vstack>
          </ct-resizable-panel>

          <ct-resizable-handle />

          {/* Right: Debug Panel */}
          <ct-resizable-panel default-size="30" min-size="20" max-size="45">
            <ct-vstack
              style={{
                height: "100%",
                padding: "1rem",
                borderLeft: "1px solid var(--ct-color-gray-200)",
                backgroundColor: "var(--ct-color-gray-50)",
              }}
            >
              <ct-heading level={5} style="margin-bottom: 0.5rem;">
                Debug
              </ct-heading>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--ct-color-gray-400)",
                  fontFamily: "monospace",
                  marginBottom: "1rem",
                }}
              >
                {model}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--ct-color-gray-400)",
                  fontFamily: "monospace",
                  marginBottom: "1rem",
                }}
              >
                TTS: cartesia/sonic-turbo
              </div>

              <div style={rowStyle}>
                <span style={labelStyle}>STT</span>
                <span style={valueStyle}>{sttDisplay}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>LLM</span>
                <span style={valueStyle}>{llmDisplay}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>TTS</span>
                <span style={valueStyle}>{ttsDisplay}</span>
              </div>
              <div style={totalRowStyle}>
                <span style={labelStyle}>Total</span>
                <span style={valueStyle}>{totalDisplay}</span>
              </div>
            </ct-vstack>
          </ct-resizable-panel>
        </ct-resizable-panel-group>

        {/* Hidden audio — plays TTS when src updates */}
        {/* @ts-ignore autoplay must be lowercase for DOM property */}
        <audio autoplay src={audioSrc} />

        {/* Text input — type or dictate via SuperWhisper */}
        <ct-prompt-input
          slot="footer"
          placeholder="Say something..."
          pending={pending}
          onct-send={sendTextMessage(sendCtx)}
          onct-stop={cancelGeneration}
        />
      </ct-screen>
    ),
    messages,
    pending,
    addMessage,
  };
});
