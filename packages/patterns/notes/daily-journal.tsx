/// <cts-enable />
import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";
import Note from "./note.tsx";
import { type MentionablePiece, type NotePiece } from "./schemas.tsx";

// ===== Pure utility functions =====

const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const DEFAULT_TEMPLATE = `# {{date}} - {{dayOfWeek}}

## Tasks
- [ ]

## Notes

## Reflection
`;

function applyTemplate(templateStr: string, dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  const monthName = d.toLocaleDateString("en-US", { month: "long" });
  const year = d.getFullYear().toString();
  return templateStr
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{dayOfWeek\}\}/g, dayOfWeek)
    .replace(/\{\{month\}\}/g, monthName)
    .replace(/\{\{year\}\}/g, year);
}

// ===== Module-scope handlers =====

/**
 * Handle calendar day selection: navigate to existing note or create a new one.
 */
const handleCalendarChange = handler<
  { detail: { value: string; oldValue: string } },
  {
    entries: Writable<NotePiece[]>;
    template: Writable<string>;
    selectedDate: Writable<string>;
    addPiece: Stream<{ piece: MentionablePiece }>;
  }
>(({ detail }, { entries, template, selectedDate, addPiece }) => {
  const dateStr = detail.value;
  selectedDate.set(dateStr);

  // Check if a note already exists for this date
  const all = entries.get();
  for (const entry of all) {
    if (entry?.noteId === `journal-${dateStr}`) {
      return navigateTo(entry as any);
    }
  }

  // Create a new daily note
  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  const noteTitle = `${dateStr} - ${dayOfWeek}`;
  const t = template.get();
  const content = applyTemplate(t || DEFAULT_TEMPLATE, dateStr);
  const note = Note({
    title: noteTitle,
    content,
    noteId: `journal-${dateStr}`,
  });
  entries.push(note as any);
  addPiece.send({ piece: note as any });
  return navigateTo(note as any);
});

/**
 * Handle "Go to Today" — navigate to today's note, creating it if needed.
 */
const handleGoToToday = handler<
  void,
  {
    entries: Writable<NotePiece[]>;
    template: Writable<string>;
    selectedDate: Writable<string>;
    addPiece: Stream<{ piece: MentionablePiece }>;
  }
>((_event, { entries, template, selectedDate, addPiece }) => {
  const dateStr = getTodayDate();
  selectedDate.set(dateStr);

  const all = entries.get();
  for (const entry of all) {
    if (entry?.noteId === `journal-${dateStr}`) {
      return navigateTo(entry as any);
    }
  }

  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  const noteTitle = `${dateStr} - ${dayOfWeek}`;
  const t = template.get();
  const content = applyTemplate(t || DEFAULT_TEMPLATE, dateStr);
  const note = Note({
    title: noteTitle,
    content,
    noteId: `journal-${dateStr}`,
  });
  entries.push(note as any);
  addPiece.send({ piece: note as any });
  return navigateTo(note as any);
});

// ===== Input / Output types =====

interface DailyJournalInput {
  title?: Writable<Default<string, "Daily Journal">>;
  entries?: Writable<Default<NotePiece[], []>>;
  template?: Writable<Default<string, "">>;
}

interface DailyJournalOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  entries: NotePiece[];
  template: string;
  isJournal: boolean;
  summary: string;
  mentionable: NotePiece[];
  goToToday: Stream<void>;
}

// ===== Pattern =====

export default pattern<DailyJournalInput, DailyJournalOutput>(
  ({ title, entries, template }) => {
    // Access default-app for addPiece (global piece registration)
    const { addPiece } = wish<{
      addPiece: Stream<{ piece: MentionablePiece }>;
    }>({ query: "#default" }).result;

    // UI state
    const showSettings = Writable.of(false);
    const selectedDate = Writable.of(getTodayDate());

    // Dates that already have a journal entry (for calendar markers)
    const datesWithNotes = computed(() => {
      const dates: string[] = [];
      for (const entry of entries.get()) {
        if (entry?.noteId) {
          const dateStr = (entry.noteId as string).replace("journal-", "");
          if (dateStr) dates.push(dateStr);
        }
      }
      return dates;
    });

    // Sorted entries — most recent first
    const sortedEntries = computed(() => {
      const arr: NotePiece[] = [];
      for (const entry of entries.get()) {
        if (entry) arr.push(entry);
      }
      return arr.sort((a, b) => (b.noteId ?? "").localeCompare(a.noteId ?? ""));
    });

    // Short summary for search/LLM
    const summary = computed(() => {
      const count = entries.get().length;
      const sorted = sortedEntries;
      const latest = sorted.length > 0
        ? (sorted[0].noteId ?? "").replace("journal-", "")
        : "none";
      return `Daily Journal — ${count} entries, last: ${latest}`;
    });

    // Settings visibility helpers
    const mainDisplay = computed(() => showSettings.get() ? "none" : "flex");
    const settingsDisplay = computed(() =>
      showSettings.get() ? "flex" : "none"
    );

    const toggleSettings = action(() => {
      showSettings.set(!showSettings.get());
    });

    const goToToday = handleGoToToday({
      entries,
      template,
      selectedDate,
      addPiece,
    });

    return {
      [NAME]: computed(() => `📅 ${title.get()}`),
      [UI]: (
        <ct-screen>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              minHeight: 0,
            }}
          >
            {/* Main view */}
            <ct-vstack
              gap="4"
              padding="6"
              style={{
                display: mainDisplay,
              }}
            >
              {/* Go to Today */}
              <ct-button
                variant="primary"
                onClick={handleGoToToday({
                  entries,
                  template,
                  selectedDate,
                  addPiece,
                })}
                style={{
                  width: "100%",
                  padding: "12px",
                  fontSize: "16px",
                  fontWeight: "bold",
                }}
              >
                Go to Today's Note
              </ct-button>

              {/* Mini calendar */}
              <ct-card>
                <ct-calendar
                  $value={selectedDate}
                  markedDates={datesWithNotes}
                  onct-change={handleCalendarChange({
                    entries,
                    template,
                    selectedDate,
                    addPiece,
                  })}
                />
              </ct-card>

              {/* Entries list */}
              <ct-vstack gap="2">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "16px" }}>Entries</h3>
                  <ct-button variant="ghost" onClick={toggleSettings}>
                    Settings
                  </ct-button>
                </div>
                {sortedEntries.map((entry: any) => (
                  <ct-cell-link $cell={entry} />
                ))}
              </ct-vstack>
            </ct-vstack>

            {/* Settings view */}
            <ct-vstack
              gap="4"
              padding="6"
              style={{
                display: settingsDisplay,
              }}
            >
              <h3 style={{ margin: 0 }}>Daily Note Template</h3>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "var(--ct-color-text-secondary)",
                }}
              >
                Available variables: {"{{date}}"}, {"{{dayOfWeek}}"},
                {"{{month}}"}, {"{{year}}"}
              </p>
              <ct-code-editor
                $value={template}
                language="text/markdown"
                wordWrap
                style={{ minHeight: "300px" }}
              />
              <ct-button variant="primary" onClick={toggleSettings}>
                Done
              </ct-button>
            </ct-vstack>
          </div>
        </ct-screen>
      ),
      title,
      entries,
      template,
      isJournal: true,
      summary,
      mentionable: entries,
      goToToday,
    };
  },
);
