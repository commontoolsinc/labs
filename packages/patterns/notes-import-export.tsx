/// <cts-enable />
import {
  Cell,
  computed,
  type Default,
  handler,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
  wish,
} from "commontools";

import Note from "./note.tsx";

// Types for notes in the space
type NoteCharm = {
  [NAME]?: string;
  title?: string;
  content?: string;
};

type AllCharmsType = NoteCharm[];

interface Input {
  importMarkdown: Default<string, "">;
}

interface Output {
  exportedMarkdown: string;
  importMarkdown: string;
  noteCount: number;
}

// Delimiter used to separate notes in the exported markdown
const NOTE_DELIMITER = "\n\n---\n\n";
const NOTE_HEADER_PREFIX = "# ";

// Filter charms to only include notes and format as markdown
const filterAndFormatNotes = lift(
  (charms: NoteCharm[]): { notes: NoteCharm[]; markdown: string; count: number } => {
    // Filter to only note charms (have title and content properties)
    const notes = charms.filter(
      (charm) => charm?.title !== undefined && charm?.content !== undefined
    );

    if (notes.length === 0) {
      return { notes: [], markdown: "No notes found in this space.", count: 0 };
    }

    // Format each note as markdown
    const formatted = notes.map((note) => {
      const title = note?.title || "Untitled Note";
      const content = note?.content || "";
      return `${NOTE_HEADER_PREFIX}${title}\n\n${content}`;
    });

    return {
      notes,
      markdown: formatted.join(NOTE_DELIMITER),
      count: notes.length,
    };
  },
);

// Parse markdown into individual notes (plain function for use in handlers)
function parseMarkdownToNotesPlain(
  markdown: string
): Array<{ title: string; content: string }> {
  if (!markdown || markdown.trim() === "") return [];

  const notes: Array<{ title: string; content: string }> = [];
  const sections = markdown.split("\n\n---\n\n");

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract title from first line if it starts with #
    const lines = trimmed.split("\n");
    let title = "Imported Note";
    let contentStart = 0;

    if (lines[0]?.startsWith("# ")) {
      title = lines[0].slice(2).trim();
      contentStart = 1;
      // Skip empty line after title if present
      if (lines[contentStart]?.trim() === "") {
        contentStart++;
      }
    }

    const content = lines.slice(contentStart).join("\n").trim();
    notes.push({ title, content });
  }

  return notes;
}

// Handler to import notes from markdown
const importNotes = handler<
  Record<string, never>,
  { importMarkdown: Cell<string>; allCharms: Cell<NoteCharm[]> }
>((_, { importMarkdown, allCharms }) => {
  const markdown = importMarkdown.get();
  const parsed = parseMarkdownToNotesPlain(markdown);

  console.log("Parsed notes count:", parsed.length);

  if (parsed.length === 0) {
    console.log("No notes to import");
    return;
  }

  // Create all notes and push to allCharms to persist them
  const createdNotes = parsed.map((noteData, index) => {
    console.log(`Creating note ${index + 1}:`, noteData.title);
    const note = Note({
      title: noteData.title,
      content: noteData.content,
    });
    // Push to allCharms to persist the charm
    allCharms.push(note as unknown as NoteCharm);
    return note;
  });

  console.log("Created and persisted notes count:", createdNotes.length);

  // Clear the import field after importing
  importMarkdown.set("");

  // Navigate to the first note
  return navigateTo(createdNotes[0]);
});

// Note: Copy to clipboard is handled by the user selecting text from the code editor

export default pattern<Input, Output>(({ importMarkdown }) => {
  const { allCharms } = wish<{ allCharms: AllCharmsType }>("/");

  // Process all charms through a single lifted function
  const processed = filterAndFormatNotes(allCharms);

  // Extract values from processed result
  const exportedMarkdown = processed.markdown;
  const noteCount = processed.count;

  return {
    [NAME]: computed(() => `Notes Import/Export (${noteCount} notes)`),
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <div slot="start">
            <span style={{ fontWeight: "bold" }}>Notes Import/Export</span>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="6" padding="6">
            {/* Export Section */}
            <ct-card>
              <ct-vstack gap="4">
                <h2>Export Notes</h2>
                <p>
                  Found <strong>{noteCount}</strong> notes in this space.
                  Select all text below and copy to export.
                </p>
                <ct-code-editor
                  $value={exportedMarkdown}
                  language="text/markdown"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{ minHeight: "150px", maxHeight: "300px", overflow: "auto" }}
                  readonly
                />
              </ct-vstack>
            </ct-card>

            {/* Import Section */}
            <ct-card>
              <ct-vstack gap="4">
                <h2>Import Notes</h2>
                <p>
                  Paste markdown below with notes separated by <code>---</code>.
                  Each note should start with <code># Title</code>.
                </p>
                <ct-code-editor
                  $value={importMarkdown}
                  language="text/markdown"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{ minHeight: "150px", maxHeight: "300px", overflow: "auto" }}
                  placeholder="# Note Title

Note content here...

---

# Another Note

More content..."
                />
                <ct-button onClick={importNotes({ importMarkdown, allCharms })}>
                  Import Notes
                </ct-button>
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    exportedMarkdown,
    importMarkdown,
    noteCount,
  };
});
