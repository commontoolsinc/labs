/// <cts-enable />
import { handler, NAME, pattern, UI, type VNode, Writable } from "commontools";
import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface VignetteZettelkastenWorkspaceInput {}
interface VignetteZettelkastenWorkspaceOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const initialEditor = `# 2026-03-19: Atomic Notes for Attention

## Fleeting note
Morning planning is smoother when each note captures one claim.

## Permanent note
A Zettelkasten stays useful when links are written as explicit questions.

## Candidate links
- [[attention-residue]]
- [[weekly-review-loops]]
- [[note-friction]]
`;

const mentionableData = [
  { [NAME]: "attention-residue" },
  { [NAME]: "weekly-review-loops" },
  { [NAME]: "note-friction" },
  { [NAME]: "capture-habits" },
];

const assistantMessages = [
  {
    role: "system",
    content:
      "You are a Zettelkasten assistant with access to personal notes and backlink search.",
  },
  {
    role: "user",
    content:
      "Can you suggest links for this note about attention and weekly reviews?",
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "search_notes",
        input: { query: "attention weekly review links" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "search_notes",
        output: {
          matches: [
            "attention-residue",
            "weekly-review-loops",
            "capture-habits",
          ],
        },
      },
    ],
  },
  {
    role: "assistant",
    content:
      "I found three strong backlinks. Add [[attention-residue]] and [[weekly-review-loops]] to the candidate links, then connect [[capture-habits]] as a supporting note.",
  },
];

const agentTools = [
  { name: "search_notes", description: "Search private note graph" },
  { name: "open_note", description: "Open a specific note by slug" },
  { name: "link_notes", description: "Create or suggest note backlinks" },
];

const sendMessage = handler<
  CustomEvent<{ text?: string }>,
  { messages: Writable<typeof assistantMessages> }
>((event, { messages }) => {
  const text = event?.detail?.text?.trim();
  if (!text) return;

  messages.set([...messages.get(), { role: "user", content: text }]);
});

export default pattern<
  VignetteZettelkastenWorkspaceInput,
  VignetteZettelkastenWorkspaceOutput
>(
  () => {
    const editorValue = Writable.of(initialEditor);
    const pending = Writable.of(false);
    const theme = Writable.of<"light" | "dark">("light");
    const messages = Writable.of(assistantMessages);
    const mentionable = Writable.of<typeof mentionableData | undefined>(
      mentionableData,
    );
    const mentioned = Writable.of<typeof mentionableData | undefined>(
      undefined,
    );
    const patternId = Writable.of("personal-zettelkasten");

    return {
      [NAME]: "Vignette: Zettelkasten Workspace",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <ct-vstack gap="3">
            <ct-toolbar>
              <ct-hstack
                slot="start"
                gap="2"
                align="center"
                style="min-height: 44px;"
              >
                <ct-heading level={5} style="margin: 0; line-height: 1;">
                  Personal Knowledge Workspace
                </ct-heading>
                <ct-badge variant="secondary">AI-assisted</ct-badge>
              </ct-hstack>
              <ct-hstack
                slot="end"
                gap="2"
                align="center"
                style="min-height: 44px;"
              >
                <ct-button variant="ghost" size="sm">Open graph</ct-button>
                <ct-button variant="primary" size="sm">Save note</ct-button>
              </ct-hstack>
            </ct-toolbar>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(520px, 1.25fr) minmax(420px, 1fr)",
                gap: "14px",
                minHeight: "560px",
              }}
            >
              <ct-card>
                <ct-vstack gap="2" style="height: 100%;">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>Working Note</ct-heading>
                    <ct-hstack gap="2" align="center">
                      <ct-badge variant="outline">markdown</ct-badge>
                      <ct-badge variant="outline">linked notes: 3</ct-badge>
                    </ct-hstack>
                  </ct-hstack>
                  <div
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      overflow: "hidden",
                      flex: "1",
                      minHeight: "460px",
                    }}
                  >
                    <ct-code-editor
                      $value={editorValue}
                      language="text/markdown"
                      mode="prose"
                      theme={theme}
                      lineNumbers
                      wordWrap
                      $mentionable={mentionable}
                      $mentioned={mentioned}
                      $pattern={patternId}
                      style="height: 100%;"
                    />
                  </div>
                </ct-vstack>
              </ct-card>

              <ct-card>
                <ct-vstack gap="2" style="height: 100%;">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>Agent Chat</ct-heading>
                    <ct-tools-chip tools={agentTools} />
                  </ct-hstack>

                  <ct-vscroll
                    style="padding: 0.75rem; flex: 1; min-height: 460px; border: 1px solid #e2e8f0; border-radius: 8px;"
                    flex
                    showScrollbar
                    fadeEdges
                    snapToBottom
                  >
                    <ct-chat $messages={messages} pending={pending} />
                  </ct-vscroll>

                  <ct-prompt-input
                    placeholder="Ask the assistant to suggest links or summarize clusters..."
                    pending={pending}
                    onct-send={sendMessage({ messages })}
                  />
                </ct-vstack>
              </ct-card>
            </div>
          </ct-vstack>
        </div>
      ),
      controls: (
        <Controls>
          <>
            <SelectControl
              label="theme"
              description="Editor visual theme"
              defaultValue="light"
              value={theme}
              items={[
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ]}
            />
            <SwitchControl
              label="pending"
              description="Show assistant loading state"
              defaultValue="false"
              checked={pending}
            />
          </>
        </Controls>
      ),
    };
  },
);
