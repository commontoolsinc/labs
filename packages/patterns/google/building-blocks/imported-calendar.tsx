/// <cts-enable />
/**
 * Imported Calendar Pattern
 *
 * A weekly calendar view that displays events from any source via wish().
 * Also supports creating and managing local events.
 *
 * Features:
 * - Display imported events from #importedEvents (read-only)
 * - Create local events with drag-to-move and resize
 * - Edit local events via modal
 * - Day/Week view toggle
 *
 * Event Schema (for sources to provide via #importedEvents):
 * {
 *   id: string;           // unique identifier
 *   title: string;        // event title
 *   date: string;         // YYYY-MM-DD
 *   startTime: string;    // HH:MM (24-hour format)
 *   endTime?: string;     // HH:MM - optional, defaults to startTime + 1hr
 *   color?: string;       // hex color for display
 *   icon?: string;        // emoji/icon to show (e.g., "✈️", "🏫")
 *   notes?: string;       // description or additional info
 *   link?: string;        // URL to open when clicked
 *   isHidden?: boolean;   // if true, event is not displayed
 * }
 */
import {
  action,
  Cell,
  computed,
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

/**
 * Unified event schema for imported events.
 * Any source pattern should normalize events to this format.
 */
type ImportedEvent = {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM (24-hour)
  endTime?: string; // HH:MM - optional, defaults to +1hr
  color?: string; // hex color
  icon?: string; // emoji or icon to display
  notes?: string; // description
  link?: string; // URL to open on click
  isHidden?: boolean; // hide from display
};

// Type for user-created local events (extends ImportedEvent)
type LocalEvent = {
  eventId: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  color: string;
  notes: string;
};

interface Input {
  title?: Default<string, "Imported Calendar">;
  localEvents?: Writable<Default<LocalEvent[], []>>;
  // Accept events from another source (enables chaining)
  sourceEvents?: ImportedEvent[];
}

interface Output {
  title: string;
  eventCount: number;
  localEvents: LocalEvent[];
  // Expose combined events for downstream chaining
  events: ImportedEvent[];
}

// ============ CONSTANTS ============

const HOUR_HEIGHT = 60;
const DAY_START = 6;
const DAY_END = 22;
const RESIZE_HANDLE_HEIGHT = 14;
const SLOT_HEIGHT = HOUR_HEIGHT / 2;

const COLORS = [
  "#93c5fd", // blue
  "#86efac", // green
  "#fca5a5", // red
  "#fcd34d", // yellow
  "#c4b5fd", // purple
  "#fdba74", // orange
  "#67e8f9", // cyan
  "#f9a8d4", // pink
];

// Simple random ID generator
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

// ============ STYLES ============

const STYLES = {
  button: {
    base: {
      padding: "4px 8px",
      fontSize: "0.75rem",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      backgroundColor: "#fff",
      cursor: "pointer",
    },
    primary: {
      padding: "4px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#3b82f6",
      color: "#fff",
      cursor: "pointer",
    },
    danger: {
      padding: "6px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#fee2e2",
      color: "#dc2626",
      cursor: "pointer",
    },
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: "500",
    display: "block",
    marginBottom: "4px",
  },
  colorSwatch: {
    width: "24px",
    height: "24px",
    borderRadius: "4px",
    cursor: "pointer",
  },
} as const;

// ============ DATE HELPERS ============

const formatDatePST = (d: Date): string =>
  d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

const getTodayDate = (): string => formatDatePST(new Date());

const getWeekStart = (date: string): string => {
  const d = new Date(date + "T12:00:00-08:00");
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDatePST(d);
};

const addDays = (date: string, days: number): string => {
  const d = new Date(date + "T12:00:00-08:00");
  d.setDate(d.getDate() + days);
  return formatDatePST(d);
};

const getWeekDates = (start: string, count: number): string[] => {
  const dates: string[] = [];
  const d = new Date(start + "T12:00:00-08:00");
  for (let i = 0; i < count; i++) {
    const nd = new Date(d);
    nd.setDate(d.getDate() + i);
    dates.push(formatDatePST(nd));
  }
  return dates;
};

const formatDateHeader = (date: string): string => {
  const d = new Date(date + "T12:00:00-08:00");
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

// ============ TIME HELPERS ============

const timeToMinutes = (time: string): number => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

const minutesToTime = (minutes: number): string => {
  const h = Math.min(23, Math.max(0, Math.floor(minutes / 60)));
  const m = Math.max(0, minutes % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
};

const addMinutesToTime = (time: string, minutes: number): string =>
  minutesToTime(timeToMinutes(time) + minutes);

const addHoursToTime = (time: string, hours: number): string =>
  addMinutesToTime(time, hours * 60);

// ============ HOUR DATA ============

const buildHours = (): Array<{ idx: number; label: string }> => {
  const hours: Array<{ idx: number; label: string }> = [];
  for (let h = DAY_START; h < DAY_END; h++) {
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    hours.push({ idx: h - DAY_START, label: `${hour} ${period}` });
  }
  return hours;
};

const HOURS = buildHours();
const GRID_HEIGHT = (DAY_END - DAY_START) * HOUR_HEIGHT;
const COLUMN_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;

// ============ MODULE-SCOPE HANDLERS ============

// Handler to show the new event modal
const showNewEventModal = handler<
  void,
  { showNewEventPrompt: Writable<boolean> }
>((_, { showNewEventPrompt }) => showNewEventPrompt.set(true));

// Handler to create event and close modal
const createEventHandler = handler<
  void,
  {
    newEventTitle: Writable<string>;
    newEventDate: Writable<string>;
    newEventStartTime: Writable<string>;
    newEventEndTime: Writable<string>;
    newEventColor: Writable<string>;
    showNewEventPrompt: Writable<boolean>;
    localEvents: Writable<LocalEvent[]>;
  }
>((
  _,
  {
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    showNewEventPrompt,
    localEvents,
  },
) => {
  const title = newEventTitle.get() || "New Event";
  const newEvent: LocalEvent = {
    eventId: generateId(),
    title,
    date: newEventDate.get(),
    startTime: newEventStartTime.get(),
    endTime: newEventEndTime.get(),
    color: newEventColor.get(),
    notes: "",
  };
  localEvents.push(newEvent);

  // Reset modal state
  showNewEventPrompt.set(false);
  newEventTitle.set("");
});

// Handler to create event and stay in modal
const createEventAndContinue = handler<
  void,
  {
    newEventTitle: Writable<string>;
    newEventDate: Writable<string>;
    newEventStartTime: Writable<string>;
    newEventEndTime: Writable<string>;
    newEventColor: Writable<string>;
    localEvents: Writable<LocalEvent[]>;
    usedCreateAnother: Writable<boolean>;
  }
>((
  _,
  {
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    localEvents,
    usedCreateAnother,
  },
) => {
  const title = newEventTitle.get() || "New Event";
  const newEvent: LocalEvent = {
    eventId: generateId(),
    title,
    date: newEventDate.get(),
    startTime: newEventStartTime.get(),
    endTime: newEventEndTime.get(),
    color: newEventColor.get(),
    notes: "",
  };
  localEvents.push(newEvent);
  usedCreateAnother.set(true);
  newEventTitle.set("");
});

// Handler to cancel new event prompt
const cancelNewEventPrompt = handler<
  void,
  {
    showNewEventPrompt: Writable<boolean>;
    newEventTitle: Writable<string>;
    usedCreateAnother: Writable<boolean>;
  }
>((_, { showNewEventPrompt, newEventTitle, usedCreateAnother }) => {
  showNewEventPrompt.set(false);
  newEventTitle.set("");
  usedCreateAnother.set(false);
});

// ============ PATTERN ============

const ImportedCalendar = pattern<Input, Output>(
  ({ title, localEvents, sourceEvents }) => {
    // ==========================================================================
    // IMPORTED EVENTS FROM MULTIPLE SOURCES
    // 1. sourceEvents: passed in via props (enables chaining)
    // 2. wishedEvents: discovered via wish("#importedEvents")
    // ==========================================================================
    const { events: wishedEvents } = wish<{ events: ImportedEvent[] }>(
      "#importedEvents",
    );

    // Combine all imported event sources
    const allImportedEvents = computed(() => {
      const source = sourceEvents || [];
      const wished = wishedEvents || [];
      return [...source, ...wished];
    });

    // Navigation State (Writable so navigation buttons work)
    const startDate = Writable.of(getWeekStart(getTodayDate()));
    const visibleDays = Writable.of(7);

    // Toggle to show/hide imported events
    const showImportedEvents = Writable.of<boolean>(true);

    // Create Form State
    const showNewEventPrompt = Writable.of<boolean>(false);
    const newEventTitle = Writable.of<string>("");
    const newEventDate = Writable.of<string>(getTodayDate());
    const newEventStartTime = Writable.of<string>("09:00");
    const newEventEndTime = Writable.of<string>("10:00");
    const newEventColor = Writable.of<string>(COLORS[0]);
    const usedCreateAnother = Writable.of<boolean>(false);

    // Edit Form State
    const showEditModal = Writable.of<boolean>(false);
    const editingEventIndex = Writable.of<number>(-1);
    const editEventTitle = Writable.of<string>("");
    const editEventDate = Writable.of<string>("");
    const editEventStartTime = Writable.of<string>("09:00");
    const editEventEndTime = Writable.of<string>("10:00");
    const editEventColor = Writable.of<string>(COLORS[0]);

    // Track last drop time to prevent click firing after drag
    const lastDropTime = Cell.of(0);

    // Computed Values
    const importedEventCount = computed(() =>
      allImportedEvents.filter((e) => !e.isHidden)?.length || 0
    );
    const localEventCount = computed(() => localEvents.get().length);
    const eventCount = computed(() => importedEventCount + localEventCount);
    const weekDates = computed(() => getWeekDates(startDate.get(), 7));
    const todayDate = getTodayDate();

    // Convert local events to ImportedEvent format for output
    const localAsImported = computed((): ImportedEvent[] =>
      localEvents.get().map((e): ImportedEvent => ({
        id: e.eventId,
        title: e.title,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        color: e.color,
        notes: e.notes,
      }))
    );

    // Combined events for downstream consumption (enables chaining)
    const combinedEvents = computed((): ImportedEvent[] => [
      ...allImportedEvents,
      ...localAsImported,
    ]);

    // Toggle action for imported events visibility
    const toggleImportedEvents = action(() =>
      showImportedEvents.set(!showImportedEvents.get())
    );

    // Navigation Actions
    const goPrev = action(() => {
      startDate.set(addDays(startDate.get(), -visibleDays.get()));
    });

    const goNext = action(() => {
      startDate.set(addDays(startDate.get(), visibleDays.get()));
    });

    const goToday = action(() => {
      const today = getTodayDate();
      startDate.set(visibleDays.get() === 1 ? today : getWeekStart(today));
    });

    // View Mode Actions
    const setDayView = action(() => visibleDays.set(1));
    const setWeekView = action(() => visibleDays.set(7));

    // Form helpers
    const onStartTimeChange = action((e: { detail: { value: string } }) => {
      const newStart = e?.detail?.value;
      if (newStart) {
        newEventEndTime.set(addHoursToTime(newStart, 1));
      }
    });

    // Color selection actions (for create modal)
    const colorActions = COLORS.map((color) =>
      action(() => newEventColor.set(color))
    );

    // Color selection actions (for edit modal)
    const editColorActions = COLORS.map((color) =>
      action(() => editEventColor.set(color))
    );

    // Edit form helpers
    const onEditStartTimeChange = action((e: { detail: { value: string } }) => {
      const newStart = e?.detail?.value;
      if (newStart) {
        editEventEndTime.set(addHoursToTime(newStart, 1));
      }
    });

    // Close edit modal
    const closeEditModal = action(() => {
      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Save edited event
    const saveEditedEvent = action(() => {
      const idx = editingEventIndex.get();
      if (idx < 0) return;

      const eventCell = localEvents.key(idx);
      eventCell.key("title").set(editEventTitle.get());
      eventCell.key("date").set(editEventDate.get());
      eventCell.key("startTime").set(editEventStartTime.get());
      eventCell.key("endTime").set(editEventEndTime.get());
      eventCell.key("color").set(editEventColor.get());

      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Delete event
    const deleteEvent = action(() => {
      const idx = editingEventIndex.get();
      if (idx < 0) return;

      const currentEvents = localEvents.get();
      const updated = [...currentEvents];
      updated.splice(idx, 1);
      localEvents.set(updated);

      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Computed Styles for View Toggle
    const dayButtonStyle = computed(() => ({
      ...STYLES.button.base,
      backgroundColor: visibleDays.get() === 1 ? "#3b82f6" : "#fff",
      color: visibleDays.get() === 1 ? "#fff" : "#374151",
    }));

    const weekButtonStyle = computed(() => ({
      ...STYLES.button.base,
      backgroundColor: visibleDays.get() === 7 ? "#3b82f6" : "#fff",
      color: visibleDays.get() === 7 ? "#fff" : "#374151",
    }));

    // Computed Style for Imported Events Toggle Chip
    const importedChipStyle = computed(() => ({
      padding: "2px 8px",
      fontSize: "0.65rem",
      border: "1px solid #d1d5db",
      borderRadius: "12px",
      backgroundColor: showImportedEvents.get() ? "#dbeafe" : "#f3f4f6",
      color: showImportedEvents.get() ? "#1d4ed8" : "#9ca3af",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    }));

    // ===== Render =====
    return {
      [NAME]: computed(() => `${title} (${eventCount})`),
      [UI]: (
        <ct-screen>
          {/* Header */}
          <div
            slot="header"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
                {title}
              </span>
              <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                ({eventCount} events)
              </span>
              {/* Imported Events Toggle */}
              {ifElse(
                computed(() => (allImportedEvents?.length || 0) > 0),
                <div style={importedChipStyle} onClick={toggleImportedEvents}>
                  <span>Imported</span>
                  <span>{importedEventCount}</span>
                </div>,
                null,
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {/* View Mode Buttons */}
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  style={dayButtonStyle}
                  onClick={setDayView}
                >
                  Day
                </button>
                <button
                  type="button"
                  style={weekButtonStyle}
                  onClick={setWeekView}
                >
                  Week
                </button>
              </div>
              {/* Navigation Buttons */}
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goPrev}
                >
                  &lt;
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goToday}
                >
                  Today
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goNext}
                >
                  &gt;
                </button>
              </div>
              {/* Add Button */}
              <button
                type="button"
                style={STYLES.button.primary}
                onClick={showNewEventModal({ showNewEventPrompt })}
              >
                + Add
              </button>
            </div>
          </div>

          {/* Main Calendar Area */}
          <div
            style={{
              display: "flex",
              flex: "1",
              overflow: "hidden",
              position: "relative",
            }}
          >
            {/* New Event Modal */}
            <ct-modal
              $open={showNewEventPrompt}
              dismissable
              size="sm"
              label="New Event"
            >
              <span slot="header">New Event</span>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {/* Title Input */}
                <div>
                  <label style={STYLES.label}>Title</label>
                  <ct-input
                    $value={newEventTitle}
                    placeholder="Event title..."
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Date Input */}
                <div>
                  <label style={STYLES.label}>Date</label>
                  <ct-input
                    $value={newEventDate}
                    type="date"
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Time Inputs */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>Start</label>
                    <ct-input
                      $value={newEventStartTime}
                      type="time"
                      style={{ width: "100%" }}
                      onct-change={onStartTimeChange}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>End</label>
                    <ct-input
                      $value={newEventEndTime}
                      type="time"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>

                {/* Color Picker */}
                <div>
                  <label style={STYLES.label}>Color</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {COLORS.map((c, idx) => (
                      <div
                        style={{
                          ...STYLES.colorSwatch,
                          backgroundColor: c,
                          border: computed(() =>
                            newEventColor.get() === c
                              ? "2px solid #111"
                              : "2px solid transparent"
                          ),
                        }}
                        onClick={colorActions[idx]}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div
                slot="footer"
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                  width: "100%",
                }}
              >
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={cancelNewEventPrompt({
                    showNewEventPrompt,
                    newEventTitle,
                    usedCreateAnother,
                  })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={createEventAndContinue({
                    newEventTitle,
                    newEventDate,
                    newEventStartTime,
                    newEventEndTime,
                    newEventColor,
                    localEvents,
                    usedCreateAnother,
                  })}
                >
                  Create Another
                </button>
                <button
                  type="button"
                  style={STYLES.button.primary}
                  onClick={createEventHandler({
                    newEventTitle,
                    newEventDate,
                    newEventStartTime,
                    newEventEndTime,
                    newEventColor,
                    showNewEventPrompt,
                    localEvents,
                  })}
                >
                  Create
                </button>
              </div>
            </ct-modal>

            {/* Edit Event Modal */}
            <ct-modal
              $open={showEditModal}
              dismissable
              size="sm"
              label="Edit Event"
            >
              <span slot="header">Edit Event</span>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {/* Title Input */}
                <div>
                  <label style={STYLES.label}>Title</label>
                  <ct-input
                    $value={editEventTitle}
                    placeholder="Event title..."
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Date Input */}
                <div>
                  <label style={STYLES.label}>Date</label>
                  <ct-input
                    $value={editEventDate}
                    type="date"
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Time Inputs */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>Start</label>
                    <ct-input
                      $value={editEventStartTime}
                      type="time"
                      style={{ width: "100%" }}
                      onct-change={onEditStartTimeChange}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>End</label>
                    <ct-input
                      $value={editEventEndTime}
                      type="time"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>

                {/* Color Picker */}
                <div>
                  <label style={STYLES.label}>Color</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {COLORS.map((c, idx) => (
                      <div
                        style={{
                          ...STYLES.colorSwatch,
                          backgroundColor: c,
                          border: computed(() =>
                            editEventColor.get() === c
                              ? "2px solid #111"
                              : "2px solid transparent"
                          ),
                        }}
                        onClick={editColorActions[idx]}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div
                slot="footer"
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                  width: "100%",
                }}
              >
                <button
                  type="button"
                  style={STYLES.button.danger}
                  onClick={deleteEvent}
                >
                  Delete
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={closeEditModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={STYLES.button.primary}
                  onClick={saveEditedEvent}
                >
                  Save
                </button>
              </div>
            </ct-modal>

            {/* Calendar Grid */}
            <div
              style={{
                flex: "1",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                userSelect: "none",
              }}
            >
              <ct-vscroll flex showScrollbar fadeEdges>
                <div
                  style={{
                    display: "flex",
                    minHeight: `${GRID_HEIGHT + 60}px`,
                  }}
                >
                  {/* Time Labels Column */}
                  <div
                    style={{
                      width: "50px",
                      flexShrink: "0",
                      paddingTop: "50px",
                    }}
                  >
                    {HOURS.map((hour) => (
                      <div
                        style={{
                          height: `${HOUR_HEIGHT}px`,
                          fontSize: "0.65rem",
                          color: "#6b7280",
                          textAlign: "right",
                          paddingRight: "8px",
                        }}
                      >
                        {hour.label}
                      </div>
                    ))}
                  </div>

                  {/* Day Columns */}
                  {COLUMN_INDICES.map((colIdx) => {
                    // Use computed() to properly extract values from the computed array
                    const columnDate = computed(() => weekDates[colIdx] || "");
                    const isToday = derive(
                      weekDates,
                      (dates) => dates?.[colIdx] === todayDate,
                    );
                    const dateHeader = derive(weekDates, (dates) => {
                      const d = dates?.[colIdx];
                      return d ? formatDateHeader(d) : "";
                    });
                    const displayStyle = computed(() =>
                      colIdx < visibleDays.get() ? "flex" : "none"
                    );
                    const headerBg = derive(
                      weekDates,
                      (dates) =>
                        dates?.[colIdx] === todayDate
                          ? "#eff6ff"
                          : "transparent",
                    );
                    const headerColor = derive(
                      weekDates,
                      (dates) =>
                        dates?.[colIdx] === todayDate ? "#2563eb" : "#374151",
                    );

                    // Drop handler for moving/resizing local events
                    const handleDayDrop = action((e: {
                      detail: {
                        sourceCell: Cell<LocalEvent>;
                        pointerY?: number;
                        dropZoneRect?: { top: number };
                        type?: string;
                      };
                    }) => {
                      const evt = e.detail.sourceCell.get();
                      const { pointerY, dropZoneRect, type: dragType } =
                        e.detail;

                      if (pointerY === undefined || !dropZoneRect) {
                        return;
                      }

                      const relativeY = pointerY - dropZoneRect.top;
                      const slotIdx = Math.max(
                        0,
                        Math.floor(relativeY / SLOT_HEIGHT),
                      );
                      const newHour = DAY_START + Math.floor(slotIdx / 2);
                      const newMin = (slotIdx % 2) * 30;
                      const newTime = minutesToTime(
                        Math.min(DAY_END - 1, Math.max(DAY_START, newHour)) *
                            60 +
                          newMin,
                      );

                      const current = localEvents.get();
                      const evtId = evt?.eventId;
                      const evtIdx = current.findIndex((a) =>
                        a?.eventId === evtId
                      );
                      if (evtIdx < 0) {
                        return;
                      }

                      const dateVal = weekDates[colIdx];
                      const eventCell = localEvents.key(evtIdx);

                      if (dragType === "local-event-resize") {
                        const adjustedY = relativeY + SLOT_HEIGHT / 2;
                        const resizeSlotIdx = Math.max(
                          0,
                          Math.floor(adjustedY / SLOT_HEIGHT),
                        );
                        const resizeHour = DAY_START +
                          Math.floor(resizeSlotIdx / 2);
                        const resizeMin = (resizeSlotIdx % 2) * 30;
                        const startMin = timeToMinutes(
                          evt.startTime || "09:00",
                        );
                        const newEndMin = Math.max(
                          startMin + 30,
                          resizeHour * 60 + resizeMin,
                        );
                        eventCell.key("endTime").set(
                          minutesToTime(Math.min(DAY_END * 60, newEndMin)),
                        );
                      } else {
                        const duration = timeToMinutes(evt.endTime || "10:00") -
                          timeToMinutes(evt.startTime || "09:00");
                        eventCell.key("date").set(dateVal);
                        eventCell.key("startTime").set(newTime);
                        eventCell.key("endTime").set(
                          addMinutesToTime(newTime, duration),
                        );
                      }

                      lastDropTime.set(Date.now());
                    });

                    // Click handlers for creating events at specific hours
                    const hourClickActions = HOURS.map((hour) =>
                      action(() => {
                        if (Date.now() - lastDropTime.get() < 300) {
                          return;
                        }
                        newEventTitle.set("");
                        newEventDate.set(columnDate);
                        newEventStartTime.set(
                          `${
                            (hour.idx + DAY_START).toString().padStart(2, "0")
                          }:00`,
                        );
                        newEventEndTime.set(
                          addHoursToTime(
                            `${
                              (hour.idx + DAY_START).toString().padStart(2, "0")
                            }:00`,
                            1,
                          ),
                        );
                        newEventColor.set(COLORS[0]);
                        showNewEventPrompt.set(true);
                      })
                    );

                    return (
                      <div
                        style={{
                          flex: "1",
                          minWidth: "100px",
                          borderRight: "1px solid #e5e7eb",
                          boxSizing: "border-box",
                          display: displayStyle,
                          flexDirection: "column",
                        }}
                      >
                        {/* Date Header */}
                        <div
                          style={{
                            height: "50px",
                            padding: "8px 4px",
                            textAlign: "center",
                            borderBottom: "1px solid #e5e7eb",
                            boxSizing: "border-box",
                            backgroundColor: headerBg,
                          }}
                        >
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: "600",
                              color: headerColor,
                            }}
                          >
                            {dateHeader}
                          </div>
                          {ifElse(
                            isToday,
                            <div
                              style={{ fontSize: "0.6rem", color: "#3b82f6" }}
                            >
                              Today
                            </div>,
                            null,
                          )}
                        </div>

                        {/* Time Grid with Drop Zone */}
                        <ct-drop-zone
                          accept="local-event,local-event-resize"
                          onct-drop={handleDayDrop}
                          style={{ position: "relative", flex: "1" }}
                        >
                          {HOURS.map((hour, hourIdx) => (
                            <div
                              style={{
                                position: "absolute",
                                top: `${hour.idx * HOUR_HEIGHT}px`,
                                left: "0",
                                right: "0",
                                height: `${HOUR_HEIGHT}px`,
                                borderTop: "1px solid #e5e7eb",
                                cursor: "pointer",
                              }}
                              onClick={hourClickActions[hourIdx]}
                            />
                          ))}
                        </ct-drop-zone>
                      </div>
                    );
                  })}

                  {/* Imported Event Blocks (from sourceEvents and #importedEvents) */}
                  {allImportedEvents.map((evt) => {
                    const evtTitle = derive(
                      evt,
                      (e) => e?.title || "(No title)",
                    );
                    const evtColor = derive(evt, (e) => e?.color || "#3b82f6");
                    const evtIcon = derive(evt, (e) => e?.icon || "");
                    const evtNotes = derive(evt, (e) => e?.notes || "");
                    const evtLink = derive(evt, (e) => e?.link || "");
                    const hasLink = derive(evt, (e) => !!(e?.link));
                    const hasIcon = derive(evt, (e) => !!(e?.icon));
                    const evtTimeRange = derive(evt, (e) => {
                      if (!e) return "";
                      const start = e.startTime || "09:00";
                      const end = e.endTime || addHoursToTime(start, 1);
                      return `${start} - ${end}`;
                    });

                    const styles = derive(evt, (e) => {
                      const hidden = {
                        top: "0",
                        height: "0",
                        left: "0",
                        width: "0",
                        display: "none" as const,
                      };

                      // Check visibility toggle and isHidden flag
                      if (!showImportedEvents.get()) return hidden;
                      if (e?.isHidden) return hidden;

                      const weekStart = startDate.get();
                      const visibleCount = visibleDays.get();
                      const eventDate = e?.date;
                      if (!eventDate || !weekStart) return hidden;

                      const startMs = new Date(weekStart + "T00:00:00")
                        .getTime();
                      const evtMs = new Date(eventDate + "T00:00:00").getTime();
                      if (isNaN(startMs) || isNaN(evtMs)) return hidden;

                      const dayOffset = Math.floor(
                        (evtMs - startMs) / (24 * 60 * 60 * 1000),
                      );
                      if (dayOffset < 0 || dayOffset >= visibleCount) {
                        return hidden;
                      }

                      const startTime = e.startTime || "09:00";
                      const endTime = e.endTime || addHoursToTime(startTime, 1);
                      const startMin = timeToMinutes(startTime) -
                        DAY_START * 60;
                      const endMin = timeToMinutes(endTime) - DAY_START * 60;
                      const top = (startMin / 60) * HOUR_HEIGHT;
                      const height = Math.max(
                        30,
                        ((endMin - startMin) / 60) * HOUR_HEIGHT,
                      );

                      return {
                        top: `${50 + top}px`,
                        height: `${height}px`,
                        left:
                          `calc(50px + (100% - 50px) * ${dayOffset} / ${visibleCount} + 2px)`,
                        width: `calc((100% - 50px) / ${visibleCount} - 4px)`,
                        display: "block" as const,
                      };
                    });

                    // Render as link if event has a link, otherwise as div
                    const eventContent = (
                      <>
                        <div
                          style={{
                            padding: "4px",
                            fontSize: "0.7rem",
                            fontWeight: "500",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          {ifElse(
                            hasIcon,
                            <span style={{ fontSize: "0.6rem" }}>
                              {evtIcon}
                            </span>,
                            null,
                          )}
                          {evtTitle}
                        </div>
                        <div
                          style={{
                            padding: "0 4px 4px",
                            fontSize: "0.6rem",
                            color: "rgba(0,0,0,0.6)",
                            overflow: "hidden",
                          }}
                        >
                          {evtTimeRange}
                        </div>
                      </>
                    );

                    return ifElse(
                      hasLink,
                      <a
                        href={evtLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          position: "absolute",
                          top: styles.top,
                          left: styles.left,
                          width: styles.width,
                          height: styles.height,
                          minHeight: styles.height,
                          zIndex: "2",
                          backgroundColor: evtColor,
                          borderRadius: "4px",
                          borderLeft: "3px solid rgba(0,0,0,0.2)",
                          overflow: "hidden",
                          display: styles.display,
                          cursor: "pointer",
                          textDecoration: "none",
                          color: "inherit",
                        }}
                        title={evtNotes}
                      >
                        {eventContent}
                      </a>,
                      <div
                        style={{
                          position: "absolute",
                          top: styles.top,
                          left: styles.left,
                          width: styles.width,
                          height: styles.height,
                          minHeight: styles.height,
                          zIndex: "2",
                          backgroundColor: evtColor,
                          borderRadius: "4px",
                          borderLeft: "3px solid rgba(0,0,0,0.2)",
                          overflow: "hidden",
                          display: styles.display,
                        }}
                        title={evtNotes}
                      >
                        {eventContent}
                      </div>,
                    );
                  })}

                  {/* Local Event Blocks - with drag/drop support */}
                  {localEvents.map((evt, evtIndex) => {
                    // Compute position and visibility
                    const styles = computed(() => {
                      const weekStart = startDate.get();
                      const visibleCount = visibleDays.get();
                      const evtDate = evt.date;

                      const hidden = {
                        top: "0",
                        height: "0",
                        left: "0",
                        width: "0",
                        display: "none" as const,
                      };

                      if (!evtDate || !weekStart) {
                        return hidden;
                      }

                      const startMs = new Date(weekStart + "T00:00:00")
                        .getTime();
                      const evtMs = new Date(evtDate + "T00:00:00").getTime();
                      if (isNaN(startMs) || isNaN(evtMs)) {
                        return hidden;
                      }

                      const dayOffset = Math.floor(
                        (evtMs - startMs) / (24 * 60 * 60 * 1000),
                      );
                      if (dayOffset < 0 || dayOffset >= visibleCount) {
                        return hidden;
                      }

                      const startMin = timeToMinutes(evt.startTime || "09:00") -
                        DAY_START * 60;
                      const endMin = timeToMinutes(evt.endTime || "10:00") -
                        DAY_START * 60;
                      const top = (startMin / 60) * HOUR_HEIGHT;
                      const height = Math.max(
                        30,
                        ((endMin - startMin) / 60) * HOUR_HEIGHT,
                      );

                      return {
                        top: `${50 + top}px`,
                        height: `${height}px`,
                        left:
                          `calc(50px + (100% - 50px) * ${dayOffset} / ${visibleCount} + 2px)`,
                        width: `calc((100% - 50px) / ${visibleCount} - 4px)`,
                        display: "block" as const,
                      };
                    });

                    // Click action to open edit modal
                    const openEvent = action(() => {
                      if (Date.now() - lastDropTime.get() < 300) {
                        return;
                      }
                      // Populate edit form with event data
                      editingEventIndex.set(evtIndex);
                      editEventTitle.set(evt.title || "");
                      editEventDate.set(evt.date || "");
                      editEventStartTime.set(evt.startTime || "09:00");
                      editEventEndTime.set(evt.endTime || "10:00");
                      editEventColor.set(evt.color || COLORS[0]);
                      showEditModal.set(true);
                    });

                    // Workaround: Use computed() with evt.eventId dependency for static children
                    const resizeHandleLines = computed(() => {
                      const _id = evt.eventId;
                      return (
                        <div
                          style={{
                            width: "20px",
                            height: "4px",
                            borderTop: "1px solid rgba(0,0,0,0.2)",
                            borderBottom: "1px solid rgba(0,0,0,0.2)",
                            pointerEvents: "none",
                          }}
                        />
                      );
                    });

                    const dragAreaContent = computed(() => {
                      const _id = evt.eventId;
                      return (
                        <div
                          style={{
                            width: "100%",
                            minHeight: "200px",
                            touchAction: "none",
                          }}
                        />
                      );
                    });

                    return (
                      <div
                        style={{
                          position: "absolute",
                          top: styles.top,
                          left: styles.left,
                          width: styles.width,
                          height: styles.height,
                          minHeight: styles.height,
                          zIndex: "3",
                          backgroundColor: evt.color || COLORS[0],
                          borderRadius: "4px",
                          borderLeft: "3px solid rgba(0,0,0,0.2)",
                          overflow: "hidden",
                          display: styles.display,
                        }}
                      >
                        {/* Title */}
                        <div
                          style={{
                            padding: "4px",
                            fontSize: "0.7rem",
                            fontWeight: "500",
                            overflow: "hidden",
                            pointerEvents: "none",
                          }}
                        >
                          {evt.title || "(untitled)"}
                        </div>

                        {/* Drag Source for Moving */}
                        <ct-drag-source
                          $cell={evt}
                          type="local-event"
                          onClick={openEvent}
                          style={{
                            position: "absolute",
                            top: "0",
                            left: "0",
                            right: "0",
                            bottom: `${RESIZE_HANDLE_HEIGHT}px`,
                            cursor: "grab",
                            zIndex: "1",
                          }}
                        >
                          {dragAreaContent}
                        </ct-drag-source>

                        {/* Resize Drag Source */}
                        <ct-drag-source
                          $cell={evt}
                          type="local-event-resize"
                          style={{
                            position: "absolute",
                            bottom: "0",
                            left: "0",
                            right: "0",
                            height: `${RESIZE_HANDLE_HEIGHT}px`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "ns-resize",
                            zIndex: "10",
                          }}
                        >
                          {resizeHandleLines}
                        </ct-drag-source>
                      </div>
                    );
                  })}
                </div>
              </ct-vscroll>
            </div>
          </div>

          {/* Empty State */}
          {ifElse(
            computed(() => eventCount === 0),
            <div
              slot="footer"
              style={{
                textAlign: "center",
                padding: "16px",
                color: "#6b7280",
                fontSize: "0.875rem",
              }}
            >
              No events yet. Click "+ Add" or click on a time slot to create
              one.
            </div>,
            null,
          )}
        </ct-screen>
      ),
      title,
      eventCount,
      localEvents,
      events: combinedEvents,
    };
  },
);

export default ImportedCalendar;
