/// <cts-enable />
/**
 * Weekly Calendar Pattern
 *
 * A configurable weekly calendar view showing days side-by-side
 * with hourly time slots and colored appointment blocks.
 *
 * Features:
 * - Day/Week view toggle
 * - Drag to move appointments between days/times
 * - Drag to resize appointment duration
 * - Click time slots to create new appointments
 * - Color-coded appointments
 */
import {
  action,
  Cell,
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// ============ TYPES ============

interface Appointment {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime: Default<string, "">; // HH:MM
  endTime: Default<string, "">; // HH:MM
  color: Default<string, "#fef08a">;
  notes: Default<string, "">;
}

interface Input {
  appointments: Writable<Default<Appointment[], []>>;
}

interface Output {
  appointments: Writable<Appointment[]>;
}

// ============ CONSTANTS ============

const HOUR_HEIGHT = 60;
const DAY_START = 6;
const DAY_END = 22;
const RESIZE_HANDLE_HEIGHT = 14;
const SLOT_HEIGHT = HOUR_HEIGHT / 2;

const COLORS: string[] = [
  "#fef08a", // yellow
  "#bbf7d0", // green
  "#bfdbfe", // blue
  "#fbcfe8", // pink
  "#fed7aa", // orange
  "#ddd6fe", // purple
];

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

const generateId = (): string => Math.random().toString(36).substring(2, 10);

// ============ HOUR DATA (Static - computed once) ============

const buildHours = (): Array<
  { idx: number; label: string; startTime: string }
> => {
  const hours: Array<{ idx: number; label: string; startTime: string }> = [];
  for (let h = DAY_START; h < DAY_END; h++) {
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    const startTime = `${h.toString().padStart(2, "0")}:00`;
    hours.push({ idx: h - DAY_START, label: `${hour} ${period}`, startTime });
  }
  return hours;
};

const HOURS = buildHours();
const GRID_HEIGHT = (DAY_END - DAY_START) * HOUR_HEIGHT;
const COLUMN_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;

// ============ PATTERN ============

export default pattern<Input, Output>(({ appointments }) => {
  // ===== Navigation State =====
  const startDate = Cell.of(getWeekStart(getTodayDate()));
  const visibleDays = Cell.of(7);

  // ===== Form State =====
  const showForm = Cell.of(false);
  const formTitle = Cell.of("");
  const formDate = Cell.of(getTodayDate());
  const formStartTime = Cell.of("09:00");
  const formEndTime = Cell.of("10:00");
  const formColor = Cell.of(COLORS[0]);
  const editingId = Cell.of<string | null>(null);

  // Track last drop time to prevent click firing after drag
  const lastDropTime = Cell.of(0);

  // ===== Computed Values =====
  const appointmentCount = computed(() => appointments.get().length);
  const weekDates = computed(() => getWeekDates(startDate.get(), 7));
  const todayDate = getTodayDate();

  // ===== Navigation Actions =====
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

  // ===== View Mode Actions =====
  const setDayView = action(() => visibleDays.set(1));
  const setWeekView = action(() => visibleDays.set(7));

  // ===== Form Actions =====
  const openNewForm = action(() => {
    editingId.set(null);
    formTitle.set("");
    formDate.set(getTodayDate());
    formStartTime.set("09:00");
    formEndTime.set("10:00");
    formColor.set(COLORS[0]);
    showForm.set(true);
  });

  const closeForm = action(() => showForm.set(false));

  const saveAppointment = action(() => {
    const title = formTitle.get().trim() || "Untitled";
    const apt: Appointment = {
      id: editingId.get() || generateId(),
      title,
      date: formDate.get(),
      startTime: formStartTime.get(),
      endTime: formEndTime.get(),
      color: formColor.get(),
      notes: "",
    };
    const current = appointments.get();
    const existingIdx = current.findIndex((a) => a.id === apt.id);
    if (existingIdx >= 0) {
      const updated = [...current];
      updated[existingIdx] = apt;
      appointments.set(updated);
    } else {
      appointments.set([...current, apt]);
    }
    showForm.set(false);
  });

  const deleteAppointment = action(() => {
    const id = editingId.get();
    if (!id) return;
    appointments.set(appointments.get().filter((a) => a.id !== id));
    showForm.set(false);
  });

  const onStartTimeChange = action((e: { detail: { value: string } }) => {
    const newStart = e?.detail?.value || formStartTime.get();
    if (newStart) {
      formEndTime.set(addHoursToTime(newStart, 1));
    }
  });

  // ===== Dynamic Color Selection (replaces 6 separate handlers) =====
  const colorActions = COLORS.map((color) =>
    action(() => formColor.set(color))
  );

  // ===== Computed Styles for View Toggle =====
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

  // ===== Render =====
  return {
    [NAME]: "Weekly Calendar",
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
              Calendar
            </span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({appointmentCount} events)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {/* View Mode Buttons */}
            <div style={{ display: "flex", gap: "4px" }}>
              <button type="button" style={dayButtonStyle} onClick={setDayView}>
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
              <button type="button" style={STYLES.button.base} onClick={goPrev}>
                &lt;
              </button>
              <button
                type="button"
                style={STYLES.button.base}
                onClick={goToday}
              >
                Today
              </button>
              <button type="button" style={STYLES.button.base} onClick={goNext}>
                &gt;
              </button>
            </div>
            {/* Add Button */}
            <button
              type="button"
              style={STYLES.button.primary}
              onClick={openNewForm}
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
          {/* Form Modal */}
          <ct-modal
            $open={showForm}
            dismissable
            size="sm"
            label="Appointment Form"
          >
            <span slot="header">
              {ifElse(
                computed(() => editingId.get() != null),
                "Edit",
                "New",
              )} Appointment
            </span>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              {/* Title Input */}
              <div>
                <label style={STYLES.label}>Title</label>
                <ct-input
                  $value={formTitle}
                  placeholder="Title..."
                  style={{ width: "100%" }}
                  onct-submit={saveAppointment}
                />
              </div>

              {/* Date Input */}
              <div>
                <label style={STYLES.label}>Date</label>
                <ct-input
                  $value={formDate}
                  type="date"
                  style={{ width: "100%" }}
                />
              </div>

              {/* Time Inputs */}
              <div style={{ display: "flex", gap: "8px" }}>
                <div style={{ flex: 1 }}>
                  <label style={STYLES.label}>Start</label>
                  <ct-input
                    $value={formStartTime}
                    type="time"
                    style={{ width: "100%" }}
                    onct-change={onStartTimeChange}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={STYLES.label}>End</label>
                  <ct-input
                    $value={formEndTime}
                    type="time"
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              {/* Color Picker - now using dynamic colorActions */}
              <div>
                <label style={STYLES.label}>Color</label>
                <div style={{ display: "flex", gap: "6px" }}>
                  {COLORS.map((c, idx) => (
                    <div
                      style={{
                        ...STYLES.colorSwatch,
                        backgroundColor: c,
                        border: ifElse(
                          computed(() => formColor.get() === c),
                          "2px solid #111",
                          "2px solid transparent",
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
              {ifElse(
                computed(() => editingId.get() != null),
                <button
                  type="button"
                  style={STYLES.button.danger}
                  onClick={deleteAppointment}
                >
                  Delete
                </button>,
                null,
              )}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                style={STYLES.button.base}
                onClick={closeForm}
              >
                Cancel
              </button>
              <button
                type="button"
                style={STYLES.button.primary}
                onClick={saveAppointment}
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
                style={{ display: "flex", minHeight: `${GRID_HEIGHT + 60}px` }}
              >
                {/* Time Labels Column */}
                <div
                  style={{ width: "50px", flexShrink: "0", paddingTop: "50px" }}
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
                  // Computed values for this column
                  const isToday = computed(() =>
                    weekDates[colIdx] === todayDate
                  );
                  const dateHeader = computed(() => {
                    const d = weekDates[colIdx];
                    return d ? formatDateHeader(d) : "";
                  });
                  const displayStyle = computed(() =>
                    colIdx < visibleDays.get() ? "flex" : "none"
                  );
                  const headerBg = computed(() =>
                    weekDates[colIdx] === todayDate ? "#eff6ff" : "transparent"
                  );
                  const headerColor = computed(() =>
                    weekDates[colIdx] === todayDate ? "#2563eb" : "#374151"
                  );

                  // Drop handler for moving/resizing appointments
                  const handleDayDrop = action((e: {
                    detail: {
                      sourceCell: Cell<Appointment>;
                      pointerY?: number;
                      dropZoneRect?: { top: number };
                      type?: string;
                    };
                  }) => {
                    const apt = e.detail.sourceCell.get();
                    const { pointerY, dropZoneRect, type: dragType } = e.detail;

                    if (pointerY === undefined || !dropZoneRect) return;

                    const relativeY = pointerY - dropZoneRect.top;
                    const slotIdx = Math.max(
                      0,
                      Math.floor(relativeY / SLOT_HEIGHT),
                    );
                    const newHour = DAY_START + Math.floor(slotIdx / 2);
                    const newMin = (slotIdx % 2) * 30;
                    const newTime = minutesToTime(
                      Math.min(DAY_END - 1, Math.max(DAY_START, newHour)) * 60 +
                        newMin,
                    );

                    const current = appointments.get();
                    const aptIdx = current.findIndex((a) => a.id === apt.id);
                    if (aptIdx < 0) return;

                    const updated = [...current];
                    const dateVal = getWeekDates(startDate.get(), 7)[colIdx];

                    if (dragType === "appointment-resize") {
                      const adjustedY = relativeY + SLOT_HEIGHT / 2;
                      const resizeSlotIdx = Math.max(
                        0,
                        Math.floor(adjustedY / SLOT_HEIGHT),
                      );
                      const resizeHour = DAY_START +
                        Math.floor(resizeSlotIdx / 2);
                      const resizeMin = (resizeSlotIdx % 2) * 30;
                      const startMin = timeToMinutes(apt.startTime || "09:00");
                      const newEndMin = Math.max(
                        startMin + 30,
                        resizeHour * 60 + resizeMin,
                      );
                      updated[aptIdx] = {
                        ...apt,
                        endTime: minutesToTime(
                          Math.min(DAY_END * 60, newEndMin),
                        ),
                      };
                    } else {
                      const duration = timeToMinutes(apt.endTime || "10:00") -
                        timeToMinutes(apt.startTime || "09:00");
                      updated[aptIdx] = {
                        ...apt,
                        date: dateVal,
                        startTime: newTime,
                        endTime: addMinutesToTime(newTime, duration),
                      };
                    }

                    appointments.set(updated);
                    lastDropTime.set(Date.now());
                  });

                  // Click handlers for creating appointments at specific hours
                  const hourClickActions = HOURS.map((hour) =>
                    action(() => {
                      if (Date.now() - lastDropTime.get() < 300) return;
                      editingId.set(null);
                      formTitle.set("");
                      formDate.set(getWeekDates(startDate.get(), 7)[colIdx]);
                      formStartTime.set(hour.startTime);
                      formEndTime.set(addHoursToTime(hour.startTime, 1));
                      formColor.set(COLORS[0]);
                      showForm.set(true);
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
                          <div style={{ fontSize: "0.6rem", color: "#3b82f6" }}>
                            Today
                          </div>,
                          null,
                        )}
                      </div>

                      {/* Time Grid with Drop Zone */}
                      <ct-drop-zone
                        accept="appointment,appointment-resize"
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

                {/* Appointment Blocks */}
                {appointments.map((apt) => {
                  // Compute position and visibility
                  const styles = computed(() => {
                    const weekStart = startDate.get();
                    const visibleCount = visibleDays.get();
                    const aptDate = apt.date;

                    const hidden = {
                      top: "0",
                      height: "0",
                      left: "0",
                      width: "0",
                      display: "none" as const,
                    };

                    if (!aptDate || !weekStart) return hidden;

                    const startMs = new Date(weekStart + "T00:00:00").getTime();
                    const aptMs = new Date(aptDate + "T00:00:00").getTime();
                    if (isNaN(startMs) || isNaN(aptMs)) return hidden;

                    const dayOffset = Math.floor(
                      (aptMs - startMs) / (24 * 60 * 60 * 1000),
                    );
                    if (dayOffset < 0 || dayOffset >= visibleCount) {
                      return hidden;
                    }

                    const startMin = timeToMinutes(apt.startTime || "09:00") -
                      DAY_START * 60;
                    const endMin = timeToMinutes(apt.endTime || "10:00") -
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

                  // Edit handler for this appointment
                  const openEdit = action(() => {
                    if (Date.now() - lastDropTime.get() < 300) return;
                    editingId.set(apt.id);
                    formTitle.set(apt.title || "");
                    formDate.set(apt.date);
                    formStartTime.set(apt.startTime || "09:00");
                    formEndTime.set(apt.endTime || "10:00");
                    formColor.set(apt.color || COLORS[0]);
                    showForm.set(true);
                  });

                  // Workaround: Use computed() with apt.id dependency for static children
                  const resizeHandleLines = computed(() => {
                    const _id = apt.id;
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
                    const _id = apt.id;
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
                        zIndex: "2",
                        backgroundColor: apt.color || COLORS[0],
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
                        {apt.title || "(untitled)"}
                      </div>

                      {/* Drag Source for Moving */}
                      <ct-drag-source
                        $cell={apt}
                        type="appointment"
                        onClick={openEdit}
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
                        $cell={apt}
                        type="appointment-resize"
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
          computed(() => appointments.get().length === 0),
          <div
            slot="footer"
            style={{
              textAlign: "center",
              padding: "16px",
              color: "#6b7280",
              fontSize: "0.875rem",
            }}
          >
            No appointments yet. Click "+ Add" or click on a time slot.
          </div>,
          null,
        )}
      </ct-screen>
    ),
    appointments,
  };
});
