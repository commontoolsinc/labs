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
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";
import Note from "../notes/note.tsx";
import Notebook from "../notes/notebook.tsx";
import { generateId } from "../notes/schemas.tsx";
import {
  fetchAndRunPattern,
  listMentionable,
  listPatternIndex,
  listRecent,
} from "./common-tools.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";
import { type MentionablePiece } from "./backlinks-index.tsx";

// ===== Input/Output Types =====

interface QuickCaptureInput {
  allPieces: Writable<MentionablePiece[]>;
}

interface QuickCaptureOutput {
  [NAME]: string;
  [UI]: VNode;
  summary: string;
  capture: Stream<{ text: string; attachments?: Writable<any>[] }>;
}

// ===== Module-scope Handlers =====

const createNoteHandler = handler<
  { title: string; content: string },
  { allPieces: Writable<MentionablePiece[]> }
>(({ title, content }, { allPieces }) => {
  const note = Note({
    title,
    content,
    noteId: generateId(),
  });
  allPieces.push(note as any);
  return { created: title };
});

const createNotesHandler = handler<
  { notes: Array<{ title: string; content: string }> },
  { allPieces: Writable<MentionablePiece[]> }
>(({ notes: notesData }, { allPieces }) => {
  const created: any[] = [];
  for (const data of notesData) {
    const note = Note({
      title: data.title,
      content: data.content,
      noteId: generateId(),
    });
    created.push(note);
  }
  for (const note of created) {
    allPieces.push(note as any);
  }
  return { created: created.length };
});

const createNotebookHandler = handler<
  { title: string; notesData?: Array<{ title: string; content: string }> },
  { allPieces: Writable<MentionablePiece[]> }
>(({ title, notesData }, { allPieces }) => {
  const notebook = Notebook({ title });
  allPieces.push(notebook as any);
  if (notesData && notesData.length > 0) {
    notebook.createNotes.send({ notesData });
  }
  return { created: title };
});

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any;
  piece?: any;
};

const sendMessage = handler<
  { detail: { text: string; attachments?: PromptAttachment[] } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  const { text, attachments } = event.detail;

  // Resolve pasted content attachments inline so the LLM sees actual content
  // instead of just a reference like [Pasted content (4799 chars)](#attachment-xxx)
  let resolved = text;
  for (const att of attachments ?? []) {
    if (att.type === "clipboard" && typeof att.data === "string") {
      resolved = resolved.replace(`[${att.name}](#${att.id})`, att.data);
    }
  }

  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: resolved }],
  });
});

const captureHandler = handler<
  { text: string; attachments?: Writable<any>[] },
  { addMessage: Stream<BuiltInLLMMessage> }
>(({ text }, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text }],
  });
});

// ===== Main Pattern =====

export default pattern<QuickCaptureInput, QuickCaptureOutput>(
  ({ allPieces }) => {
    // Wishes for space data
    const mentionable = wish<MentionablePiece[]>({
      query: "#mentionable",
    }).result;
    const recentPieces = wish<MentionablePiece[]>({ query: "#recent" }).result;
    const { entries: summaryEntries } = wish<{ entries: SummaryIndexEntry[] }>({
      query: "#summaryIndex",
    }).result;

    // Optional wishes — these may not resolve (e.g. no #system piece yet).
    // Extract into their own computeds so a failed wish can't kill the base prompt.
    const systemWish = wish<{ text: string }>({ query: "#system" });
    const profileWish = wish<string>({ query: "#profile" });

    const customSystemText = computed(() => systemWish.result?.text ?? "");
    const profileText = computed(() => profileWish.result ?? "");

    const systemPrompt = computed(() => {
      const customSystem = customSystemText;
      const profile = profileText;
      const systemSection = customSystem
        ? `\n\n--- Custom Instructions ---\n${customSystem}\n---`
        : "";
      const profileSection = profile
        ? `\n\n--- User Context ---\n${profile}\n---`
        : "";

      return `You are a quick capture assistant. The user will paste freeform text — voice memo transcripts, meeting notes, ideas, research, brain dumps. Your job is to turn this into well-linked notes in their knowledge base.

Process:
1. SEARCH FIRST — before creating anything, use searchSpace to understand what already exists. Look for topics, people, projects, and themes mentioned in the input. This is critical so you can link new notes to existing ones.
2. Break the input into discrete, atomic notes — one idea, concept, decision, or action per note.
3. Give each note a clear, concise title.
4. Write note content in markdown. Use [[Title]] wiki-link syntax to link to:
   - Other notes you're creating in this batch
   - Existing notes you found via searchSpace
   IMPORTANT: Backlinks work on EXACT title matches. All pieces have an emoji prefix in their display title:
   - Notes: "📝 " (📝 + space) — e.g. a note titled "Meeting with Alice" displays as "📝 Meeting with Alice"
   - Notebooks: "📓 " (📓 + space) — e.g. "📓 Capture Log (3)"
   When creating wiki-links, you MUST include the emoji prefix for the link to resolve. Example: [[📝 Meeting with Alice]], NOT [[Meeting with Alice]]. Always match the exact title format you see in searchSpace results for existing content.
5. Use createNotes to batch-create the notes.
6. After creating content notes, create a capture log entry: a final note titled something like "Capture: [brief topic summary] — [date]" that contains:
   - The original raw transcript/text (preserved verbatim in a blockquote or code block)
   - A list of all notes created from it, with [[Title]] links to each
   - Brief reflection on how the content was organized
   Put this capture log note in the "Capture Log" notebook using createNotebook (create the notebook if it doesn't exist, or just create the note if the notebook already exists — check searchSpace first).

Guidelines:
- Prefer several small atomic notes over one large note
- Link generously — notes gain value from connections. Always link to existing content found via searchSpace.
- Use wiki-link syntax [[Title]] to cross-reference between notes
- If the input is a single quick thought, one note is fine (still create the capture log entry)
- Do NOT create notebooks by default. Only create a notebook when there's a clear, obvious reason (e.g. the input covers a multi-part project, a course with chapters, etc.). Individual notes are the default.
- The "Capture Log" notebook is the one exception — always use it for capture log entries.
${systemSection}${profileSection}`;
    });

    const messages = Writable.of<BuiltInLLMMessage[]>([]);

    const llmTools = {
      searchSpace: patternTool(summarySearchPattern, {
        entries: summaryEntries,
      }),
      listMentionable: patternTool(listMentionable, { mentionable }),
      listRecent: patternTool(listRecent, { recentPieces }),
      listPatternIndex: patternTool(listPatternIndex),
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      createNote: {
        handler: createNoteHandler({ allPieces }),
        description:
          "Create a single note with a title and markdown content. Returns the created note.",
      },
      createNotes: {
        handler: createNotesHandler({ allPieces }),
        description:
          "Create multiple notes at once. Each note has a title and content. More efficient than calling createNote repeatedly.",
      },
      createNotebook: {
        handler: createNotebookHandler({ allPieces }),
        description:
          "Create a notebook, optionally with initial notes. Use sparingly — only when there's a clear reason to group notes (e.g. multi-part project, course chapters). Always use for the 'Capture Log' notebook for capture log entries.",
      },
    };
    const dialogParams = {
      system: systemPrompt,
      messages,
      tools: llmTools,
      model: "anthropic:claude-sonnet-4-5" as const,
      builtinTools: false,
    };

    const { addMessage, pending } = llmDialog(dialogParams);

    const hasMessages = computed(() => messages.get().length > 0);

    const summary = computed(() => {
      const msgs = messages.get();
      if (msgs.length === 0) {
        return "Quick capture — paste text to organize into notes";
      }
      return `Quick Capture (${msgs.length} messages)`;
    });

    return {
      [NAME]: "Quick Capture",
      [UI]: (
        <ct-screen>
          <ct-toolbar slot="header" sticky>
            <h2 style={{ margin: 0, fontSize: "18px" }}>Quick Capture</h2>
          </ct-toolbar>

          <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
            <ct-vstack gap="3" style="padding: 1rem;">
              <ct-message-beads
                label="capture"
                $messages={messages}
                pending={pending}
              />
              {ifElse(
                hasMessages,
                <ct-chat $messages={messages} pending={pending} />,
                <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                  Paste text, meeting notes, or ideas below. The agent will
                  break them into linked notes.
                </div>,
              )}
            </ct-vstack>
          </ct-vscroll>

          <div slot="footer" style="padding: 0.5rem 1rem 1rem;">
            <ct-prompt-input
              placeholder="Paste text to capture..."
              pending={pending}
              $mentionable={mentionable}
              onct-send={sendMessage({ addMessage })}
            />
          </div>
        </ct-screen>
      ),
      summary,
      capture: captureHandler({ addMessage }),
    };
  },
);
