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

// HTML comment markers for bulletproof note delimiting
const NOTE_START_MARKER = "<!-- COMMON_NOTE_START";
const NOTE_END_MARKER = "<!-- COMMON_NOTE_END -->";

// Filter charms to only include notes and format as markdown with HTML comment blocks
const filterAndFormatNotes = lift(
  (
    charms: NoteCharm[],
  ): { notes: NoteCharm[]; markdown: string; count: number } => {
    // Filter to only note charms (have title and content properties)
    const notes = charms.filter(
      (charm) => charm?.title !== undefined && charm?.content !== undefined,
    );

    if (notes.length === 0) {
      return { notes: [], markdown: "No notes found in this space.", count: 0 };
    }

    // Format each note with HTML comment block markers
    const formatted = notes.map((note) => {
      const title = note?.title || "Untitled Note";
      const content = note?.content || "";
      // Escape quotes in title for the attribute
      const escapedTitle = title.replace(/"/g, "&quot;");
      return `${NOTE_START_MARKER} title="${escapedTitle}" -->\n\n${content}\n\n${NOTE_END_MARKER}`;
    });

    return {
      notes,
      markdown: formatted.join("\n\n"),
      count: notes.length,
    };
  },
);

// Parse markdown with HTML comment blocks into individual notes (plain function for use in handlers)
function parseMarkdownToNotesPlain(
  markdown: string,
): Array<{ title: string; content: string }> {
  if (!markdown || markdown.trim() === "") return [];

  const notes: Array<{ title: string; content: string }> = [];

  // Regex to match COMMON_NOTE blocks with title attribute
  const noteBlockRegex =
    /<!-- COMMON_NOTE_START title="([^"]*)" -->([\s\S]*?)<!-- COMMON_NOTE_END -->/g;

  let match;
  while ((match = noteBlockRegex.exec(markdown)) !== null) {
    // Unescape HTML entities in title
    const title = match[1].replace(/&quot;/g, '"') || "Imported Note";
    const content = match[2].trim();
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
                  Found <strong>{noteCount}</strong>{" "}
                  notes in this space. Download or copy the markdown below.
                </p>
                <ct-file-download
                  $data={exportedMarkdown}
                  filename="notes-export.md"
                  mime-type="text/markdown"
                  variant="primary"
                >
                  Download Notes
                </ct-file-download>
                <ct-code-editor
                  $value={exportedMarkdown}
                  language="text/markdown"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{
                    minHeight: "150px",
                    maxHeight: "300px",
                    overflow: "auto",
                  }}
                  readonly
                />
              </ct-vstack>
            </ct-card>

            {/* Import Section */}
            <ct-card>
              <ct-vstack gap="4">
                <h2>Import Notes</h2>
                <p>
                  Paste exported markdown below. Notes are wrapped in{" "}
                  <code>&lt;!-- COMMON_NOTE_START --&gt;</code> blocks.
                </p>
                <ct-code-editor
                  $value={importMarkdown}
                  language="text/markdown"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{
                    minHeight: "150px",
                    maxHeight: "300px",
                    overflow: "auto",
                  }}
                  placeholder={`<!-- COMMON_NOTE_START title="Note Title" -->

Note content here with any markdown...
# Headings are fine
---
Separators too

<!-- COMMON_NOTE_END -->

<!-- COMMON_NOTE_START title="Another Note" -->

More content...

<!-- COMMON_NOTE_END -->`}
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
