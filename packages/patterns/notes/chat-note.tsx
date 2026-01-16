/// <cts-enable />
import {
  computed,
  type Default,
  derive,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

// Type for backlinks (inline to work around CLI path resolution bug)
type MentionableCharm = {
  [NAME]?: string;
  isHidden?: boolean;
  content?: string;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
};

type MinimalCharm = {
  [NAME]?: string;
};

// Default system prompt - based on leaked/inferred Claude system prompt style
const DEFAULT_SYSTEM_PROMPT =
  `You are Claude, a helpful AI assistant created by Anthropic. You are direct, helpful, and thoughtful in your responses. You aim to be truthful and you acknowledge uncertainty when relevant. You engage naturally with the human while maintaining appropriate boundaries.`;

// Available models for selection
const MODELS = [
  { id: "anthropic:claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "anthropic:claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "anthropic:claude-opus-4-1", label: "Opus 4.1" },
] as const;

type Input = {
  title?: Writable<Default<string, "Chat Note">>;
  content?: Writable<Default<string, "">>;
  isHidden?: Default<boolean, false>;
  noteId?: Default<string, "">;
  /** Pattern JSON for [[wiki-links]]. Defaults to creating new ChatNotes. */
  linkPattern?: Writable<Default<string, "">>;
  /** Parent notebook reference (passed via SELF from notebook.tsx) */
  parentNotebook?: any;
  /** Selected model for generation. Defaults to Sonnet 4.5 */
  model?: Writable<Default<string, "anthropic:claude-sonnet-4-5">>;
};

type LLMMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Represents a chat-enabled note with inline LLM conversations. */
type Output = {
  [NAME]?: string;
  [UI]: VNode;
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];
  parentNotebook: any;
  content: Default<string, "">;
  isHidden: Default<boolean, false>;
  noteId: Default<string, "">;
  isGenerating: boolean;
  editContent: Stream<{ detail: { value: string } }>;
};

// Parse document content into LLM messages
// Format:
// - First section starting with "## System" becomes the system prompt
// - Sections separated by --- horizontal rules
// - Sections with ## AI or ## Assistant header are assistant messages
// - Other sections are user messages
function parseContentToMessages(
  content: string,
  mentionable: MentionableCharm[],
): { system: string; messages: LLMMessage[] } {
  if (!content.trim()) {
    return { system: DEFAULT_SYSTEM_PROMPT, messages: [] };
  }

  // Expand wiki links before parsing
  const expandedContent = expandWikiLinks(content, mentionable);

  // Split by horizontal rules (--- on its own line)
  const sections = expandedContent.split(/\n---+\n/).map((s) => s.trim());

  let system = DEFAULT_SYSTEM_PROMPT;
  const messages: LLMMessage[] = [];

  let startIndex = 0;

  // Check if first section is a system prompt
  if (sections.length > 0 && sections[0].match(/^##\s*[Ss]ystem\b/)) {
    // Extract content after the header
    const systemContent = sections[0]
      .replace(/^##\s*[Ss]ystem\b\s*\n?/, "")
      .trim();
    if (systemContent) {
      system = systemContent;
    }
    startIndex = 1;
  }

  // Process remaining sections
  for (let i = startIndex; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;

    // Check if this is an assistant message (## AI or ## Assistant)
    const isAssistant = section.match(/^##\s*(?:AI|Assistant)\b/i);

    if (isAssistant) {
      // Remove the header and get the content
      const assistantContent = section
        .replace(/^##\s*(?:AI|Assistant)\b\s*\n?/i, "")
        .trim();
      if (assistantContent) {
        messages.push({ role: "assistant", content: assistantContent });
      }
    } else {
      // User message - use the whole section
      if (section) {
        messages.push({ role: "user", content: section });
      }
    }
  }

  // Coalesce adjacent same-role messages
  const coalescedMessages: LLMMessage[] = [];
  for (const msg of messages) {
    const last = coalescedMessages[coalescedMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n\n" + msg.content;
    } else {
      coalescedMessages.push({ ...msg });
    }
  }

  return { system, messages: coalescedMessages };
}

// Expand [[wiki links]] with the content of referenced notes
// Format: [[Name (id)]] -> ## [Name]\n[content of linked note]
function expandWikiLinks(
  text: string,
  mentionable: MentionableCharm[],
): string {
  // Match [[Name (id)]] pattern
  const wikiLinkRegex = /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g;

  return text.replace(wikiLinkRegex, (match, name, id) => {
    // Find the charm by ID
    const charm = mentionable?.find((c: any) => {
      // Check various ways the ID might be stored
      const charmId = c?.id || c?.noteId || (c as any)?.$id ||
        (c as any)?.["$ID"];
      return charmId === id;
    });

    if (charm && charm.content) {
      return `## ${name.trim()}\n${charm.content}`;
    }

    // If we can't find the content, keep the original link
    return match;
  });
}

const _updateContent = handler<
  { detail: { value: string } },
  { content: Writable<string> }
>((event, state) => {
  state.content.set(event.detail?.value ?? "");
});

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Writable<MentionableCharm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      charmId: any;
      charm: Writable<MentionableCharm>;
      navigate: boolean;
    };
  },
  {
    mentionable: Writable<MentionableCharm[]>;
    allCharms: Writable<MinimalCharm[]>;
  }
>(({ detail }, { mentionable, allCharms }) => {
  allCharms.push(detail.charm);

  if (detail.navigate) {
    return navigateTo(detail.charm);
  } else {
    mentionable.push(detail.charm);
  }
});

const handleEditContent = handler<
  { detail: { value: string }; result?: Writable<string> },
  { content: Writable<string> }
>(({ detail, result }, { content }) => {
  content.set(detail.value);
  result?.set("updated");
});

const handleCharmLinkClicked = handler<
  void,
  { charm: Writable<MentionableCharm> }
>((_, { charm }) => {
  return navigateTo(charm);
});

// Handler to start editing title
const startEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(true);
});

// Handler to stop editing title
const stopEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(false);
});

// Handler for keydown on title input (Enter to save)
const handleTitleKeydown = handler<
  { key?: string },
  { isEditingTitle: Writable<boolean> }
>((event, { isEditingTitle }) => {
  if (event?.key === "Enter") {
    isEditingTitle.set(false);
  }
});

// Handler for Generate button - triggers LLM generation
const handleGenerate = handler<
  void,
  {
    content: Writable<string>;
    llmSystem: Writable<string>;
    llmMessages: Writable<LLMMessage[]>;
    isGenerating: Writable<boolean>;
    mentionable: any;
  }
>((_, state) => {
  const currentContent = state.content.get();

  // Parse entire content into messages - get raw array from mentionable
  const mentionableArray = Array.isArray(state.mentionable)
    ? state.mentionable
    : state.mentionable?.get?.() ?? [];
  const { system, messages } = parseContentToMessages(
    currentContent,
    mentionableArray,
  );

  // If there are no messages, don't generate
  if (messages.length === 0) {
    return;
  }

  // Ensure last message is from user
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    // Don't generate if last message is already from assistant
    return;
  }

  // Add the AI response separator to content
  const separator = currentContent.endsWith("\n")
    ? "---\n## AI\n"
    : "\n---\n## AI\n";
  state.content.set(currentContent + separator);

  // Set up the LLM call
  state.llmSystem.set(system);
  state.llmMessages.set(messages);
  state.isGenerating.set(true);
});

// Handler to cancel generation
const handleCancelGeneration = handler<
  void,
  {
    isGenerating: Writable<boolean>;
    llmMessages: Writable<LLMMessage[]>;
  }
>((_, state) => {
  state.isGenerating.set(false);
  // Clear messages to stop the LLM
  state.llmMessages.set([]);
});

// Navigate to parent notebook
const goToParent = handler<Record<string, never>, { self: any }>(
  (_, { self }) => {
    const p = (self as any).parentNotebook;
    if (p) navigateTo(p);
  },
);

// Handler for model selection change
const handleModelChange = handler<
  { target: { value: string } },
  { model: Writable<string> }
>(({ target }, { model }) => {
  model.set(target.value);
});

const ChatNote = pattern<Input, Output>(
  ({
    title,
    content,
    isHidden,
    noteId,
    linkPattern,
    parentNotebook: parentNotebookProp,
    model,
    [SELF]: self,
  }) => {
    const { allCharms } = wish<{ allCharms: MinimalCharm[] }>("/");
    const mentionable = wish<Default<MentionableCharm[], []>>("#mentionable");
    const mentioned = Writable.of<MentionableCharm[]>([]);
    const backlinks = Writable.of<MentionableCharm[]>([]);

    // State for inline title editing
    const isEditingTitle = Writable.of<boolean>(false);

    // LLM state
    const isGenerating = Writable.of<boolean>(false);
    const llmSystem = Writable.of<string>("");
    const llmMessages = Writable.of<LLMMessage[]>([]);

    // LLM call - reactive based on llmMessages
    const llmResponse = generateText({
      system: llmSystem,
      messages: llmMessages,
      model: model,
    });

    // Watch for LLM streaming and completion, update content reactively
    const _llmWatcher = derive(
      [
        isGenerating,
        llmResponse.pending,
        llmResponse.result,
        llmResponse.partial,
      ],
      ([generating, pending, result, partial]) => {
        if (!generating) return null;

        const currentContent = content.get();

        // Find the position after "## AI\n" to insert streaming content
        const aiHeaderIndex = currentContent.lastIndexOf("## AI\n");
        if (aiHeaderIndex === -1) return null;

        const insertPos = aiHeaderIndex + "## AI\n".length;
        const beforeInsert = currentContent.slice(0, insertPos);

        // During streaming, show partial result
        if (pending && partial) {
          content.set(beforeInsert + partial);
        }

        // When complete, finalize with result and closing separator
        if (!pending && result && generating) {
          content.set(beforeInsert + result + "\n---\n");
          isGenerating.set(false);
          llmMessages.set([]);
        }

        return null;
      },
    );

    // Compute parent notebook
    const parentNotebook = computed(() => {
      const selfParent = (self as any)?.parentNotebook;
      if (selfParent) return selfParent;
      if (parentNotebookProp) return parentNotebookProp;
      return null;
    });

    // Use provided linkPattern or default to creating new ChatNotes
    const patternJson = computed(() => {
      const lpValue = (linkPattern as any)?.get?.() ?? linkPattern;
      const custom = typeof lpValue === "string" ? lpValue.trim() : "";
      return custom || JSON.stringify(ChatNote);
    });

    // Computed for generation state display
    const showGenerating = computed(
      () => isGenerating.get() && llmResponse.pending,
    );

    // Can generate when there's content and not already generating
    const canGenerate = computed(() => {
      if (isGenerating.get()) return false;
      const currentContent = content.get();
      if (!currentContent.trim()) return false;

      // Check if last section is from user (not AI)
      const sections = currentContent.split(/\n---+\n/);
      const lastSection = sections[sections.length - 1]?.trim();
      if (!lastSection) return false;

      // If last section starts with ## AI, we can't generate
      if (lastSection.match(/^##\s*(?:AI|Assistant)\b/i)) return false;

      return true;
    });

    // Handlers with state bindings
    const generateHandler = handleGenerate({
      content,
      llmSystem,
      llmMessages,
      isGenerating,
      mentionable,
    });

    const cancelHandler = handleCancelGeneration({
      isGenerating,
      llmMessages,
    });

    // Handler for Cmd+Enter from editor
    const submitHandler = handleGenerate({
      content,
      llmSystem,
      llmMessages,
      isGenerating,
      mentionable,
    });

    // Model change handler
    const modelChangeHandler = handleModelChange({ model });

    return {
      [NAME]: computed(() => `💬 ${title.get()}`),
      [UI]: (
        <ct-screen>
          <ct-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
            }}
          >
            {/* Parent notebook chip */}
            <ct-hstack
              gap="2"
              align="center"
              style={{
                display: computed(() => {
                  const p = (self as any).parentNotebook;
                  return p ? "flex" : "none";
                }),
                marginBottom: "4px",
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  color: "var(--ct-color-text-secondary)",
                }}
              >
                In:
              </span>
              <ct-chip
                label={computed(() => {
                  const p = (self as any).parentNotebook;
                  return p?.[NAME] ?? p?.title ?? "Notebook";
                })}
                interactive
                onct-click={goToParent({ self })}
              />
            </ct-hstack>

            <ct-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: computed(() =>
                    isEditingTitle.get() ? "none" : "flex"
                  ),
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flex: 1,
                }}
                onClick={startEditingTitle({ isEditingTitle })}
              >
                <span
                  style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                >
                  {title}
                </span>
              </div>
              <div
                style={{
                  display: computed(() =>
                    isEditingTitle.get() ? "flex" : "none"
                  ),
                  flex: 1,
                  marginRight: "12px",
                }}
              >
                <ct-input
                  $value={title}
                  placeholder="Chat note title..."
                  style={{ flex: 1 }}
                  onct-blur={stopEditingTitle({ isEditingTitle })}
                  onct-keydown={handleTitleKeydown({ isEditingTitle })}
                />
              </div>

              {/* Model selector */}
              <select
                value={model}
                onChange={modelChangeHandler}
                style={{
                  display: computed(() => (showGenerating ? "none" : "block")),
                  padding: "4px 8px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid var(--ct-color-border, #e5e5e7)",
                  background: "var(--ct-color-bg, white)",
                  cursor: "pointer",
                }}
              >
                {MODELS.map((m) => <option value={m.id}>{m.label}</option>)}
              </select>

              {/* Generate button - shown when not generating */}
              <ct-button
                variant="primary"
                size="sm"
                onClick={generateHandler}
                disabled={computed(() => !canGenerate)}
                style={{
                  display: computed(() => (showGenerating ? "none" : "flex")),
                }}
                title="Generate (Cmd+Enter)"
              >
                Generate
              </ct-button>

              {/* Generation status / Cancel button - shown when generating */}
              <ct-hstack
                gap="2"
                align="center"
                style={{
                  display: computed(() => (showGenerating ? "flex" : "none")),
                }}
              >
                <ct-loader show-elapsed />
                <ct-button
                  variant="secondary"
                  size="sm"
                  onClick={cancelHandler}
                >
                  Cancel
                </ct-button>
              </ct-hstack>
            </ct-hstack>
          </ct-vstack>

          {/* Editor */}
          <ct-code-editor
            $value={content}
            $mentionable={mentionable}
            $mentioned={mentioned}
            $pattern={patternJson}
            onbacklink-click={handleCharmLinkClick({})}
            onbacklink-create={handleNewBacklink({ mentionable, allCharms })}
            onct-submit={submitHandler}
            language="text/markdown"
            theme="light"
            wordWrap
            tabIndent
            lineNumbers
            readonly={isGenerating}
          />

          <ct-hstack slot="footer">
            {backlinks?.map((charm) => (
              <ct-button onClick={handleCharmLinkClicked({ charm })}>
                {charm?.[NAME]}
              </ct-button>
            ))}
          </ct-hstack>
        </ct-screen>
      ),
      title,
      content,
      mentioned,
      backlinks,
      parentNotebook,
      isHidden,
      noteId,
      isGenerating,
      editContent: handleEditContent({ content }),
    };
  },
);

export default ChatNote;
