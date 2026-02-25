/// <cts-enable />
import {
  type BuiltInLLMMessage,
  computed,
  handler,
  ifElse,
  llmDialog,
  NAME,
  pattern,
  patternTool,
  type Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";
import { type MentionablePiece } from "./backlinks-index.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";
import { listMentionable, listRecent } from "./common-tools.tsx";

// ===== Types =====

type SpaceOverviewResult = {
  headline: string;
  themes: Array<{ name: string; description: string; relatedPieces: string[] }>;
  recentActivity: string;
  connections: Array<{ description: string; pieceNames: string[] }>;
  suggestions: string[];
};

type SpaceOverviewInput = Record<string, never>;

interface SpaceOverviewOutput {
  [NAME]: string;
  [UI]: VNode;
  summary: string;
}

// ===== Handlers =====

const triggerAnalysis = handler<
  unknown,
  { addMessage: Stream<BuiltInLLMMessage> }
>((_, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{
      type: "text" as const,
      text:
        "Analyze this space and give me an overview of what's here and what's been happening recently.",
    }],
  });
});

// ===== Main Pattern =====

export default pattern<SpaceOverviewInput, SpaceOverviewOutput>(() => {
  // Fetch space data references for tools
  const mentionable = wish<MentionablePiece[]>({
    query: "#mentionable",
  }).result;
  const recentPieces = wish<MentionablePiece[]>({ query: "#recent" }).result;
  const { entries: summaryEntries } = wish<{ entries: SummaryIndexEntry[] }>({
    query: "#summaryIndex",
  }).result;
  const profileWish = wish<string>({ query: "#profile" });
  const profileText = computed(() => profileWish.result ?? "");

  const systemPrompt = computed(() => {
    const profile = profileText;
    const profileSection = profile
      ? `\n\n--- User Context ---\n${profile}\n---`
      : "";

    return `You are a space orientation assistant. When activated, you explore the user's knowledge space using your tools and produce a clear, insightful overview of what's going on.

Process:
1. Use searchSpace to browse the space contents — search for broad terms and specific topics
2. Use listRecent to see what's been active lately
3. Use listMentionable to get a full inventory
4. Synthesize what you find into a structured overview

After exploring, call the finalResult tool with your structured findings:
- headline: A punchy one-sentence summary of the space
- themes: 2-4 active themes or topic clusters you identified (each with name, description, and relatedPieces)
- recentActivity: A narrative of what's been captured/changed lately
- connections: Notable connections between pieces (each with description and pieceNames)
- suggestions: 2-3 suggested next actions or things to explore

Conventions:
- Notes are prefixed with "📝 ", notebooks with "📓 "
- "Transcript:" notes contain raw voice memo captures
- "Capture Summary:" notes are reflections on ingestion sessions
- The "📓 Capture Log" notebook groups transcripts and summaries
- [[Wiki-links]] in note content indicate intentional connections

Be concise and insightful. Focus on patterns and connections, not just listing things. Reference actual piece names.${profileSection}`;
  });

  const messages = Writable.of<BuiltInLLMMessage[]>([]);

  const llmTools = {
    searchSpace: patternTool(summarySearchPattern, {
      entries: summaryEntries,
    }),
    listMentionable: patternTool(listMentionable, { mentionable }),
    listRecent: patternTool(listRecent, { recentPieces }),
  };

  const dialogParams = {
    system: systemPrompt,
    messages,
    tools: llmTools,
    model: "anthropic:claude-haiku-4-5" as const,
    builtinTools: false,
    resultSchema: toSchema<SpaceOverviewResult>(),
  };
  const { addMessage, pending, result } = llmDialog(dialogParams);

  const overview = computed(() => result as SpaceOverviewResult | undefined);

  const hasResult = computed(() => !!overview);
  const summary = computed(() => overview?.headline ?? "Space Overview");

  return {
    [NAME]: "Space Overview",
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Space Overview</h2>
        </ct-toolbar>

        <ct-autostart onstart={triggerAnalysis({ addMessage })} />

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            <ct-message-beads
              label="overview"
              $messages={messages}
              pending={pending}
            />

            {ifElse(
              hasResult,
              <ct-vstack gap="4">
                <p
                  style={{
                    fontSize: "18px",
                    fontWeight: "600",
                    margin: 0,
                    lineHeight: "1.3",
                  }}
                >
                  {overview?.headline}
                </p>

                <ct-vstack gap="2">
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "14px",
                      color: "var(--ct-color-gray-500)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Themes
                  </h3>
                  {overview?.themes.map((theme) => (
                    <ct-vstack
                      gap="1"
                      style={{
                        padding: "0.75rem",
                        borderRadius: "8px",
                        background: "var(--ct-color-gray-50)",
                      }}
                    >
                      <strong style={{ fontSize: "14px" }}>{theme.name}</strong>
                      <p
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          color: "var(--ct-color-gray-600)",
                        }}
                      >
                        {theme.description}
                      </p>
                    </ct-vstack>
                  ))}
                </ct-vstack>

                <ct-vstack gap="1">
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "14px",
                      color: "var(--ct-color-gray-500)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Recent Activity
                  </h3>
                  <p style={{ margin: 0, fontSize: "14px", lineHeight: "1.5" }}>
                    {overview?.recentActivity}
                  </p>
                </ct-vstack>

                {ifElse(
                  computed(() => (overview?.connections?.length ?? 0) > 0),
                  <ct-vstack gap="1">
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        color: "var(--ct-color-gray-500)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Connections
                    </h3>
                    {overview?.connections.map((conn) => (
                      <p
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          lineHeight: "1.4",
                        }}
                      >
                        {conn.description}
                      </p>
                    ))}
                  </ct-vstack>,
                  <span />,
                )}

                <ct-vstack gap="1">
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "14px",
                      color: "var(--ct-color-gray-500)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Explore Next
                  </h3>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "1.2rem",
                      fontSize: "14px",
                      lineHeight: "1.6",
                    }}
                  >
                    {overview?.suggestions.map((s) => <li>{s}</li>)}
                  </ul>
                </ct-vstack>
              </ct-vstack>,
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                {ifElse(
                  pending,
                  <span>Exploring the space...</span>,
                  <span />,
                )}
              </div>,
            )}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    summary,
  };
});
