/// <cts-enable />
/**
 * Weekly Calendar Pattern (Refactored for PR #2466 validation rules)
 *
 * A configurable weekly calendar view showing days side-by-side
 * with hourly time slots and colored appointment blocks.
 *
 * Changes from original:
 * - All handler() calls moved to module scope
 * - Immediately-invoked lift() converted to computed()
 */
import {
  action,
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
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
  appointments: Cell<Default<Appointment[], []>>;
}

interface Output {
  appointments: Cell<Appointment[]>;
}

// ============ CONSTANTS ============

const HOUR_HEIGHT = 60;
const DAY_START = 6;
const DAY_END = 22;
const RESIZE_HANDLE_HEIGHT = 14;

const COLORS = [
  "#fef08a", // yellow
  "#bbf7d0", // green
  "#bfdbfe", // blue
  "#fbcfe8", // pink
  "#fed7aa", // orange
  "#ddd6fe", // purple
];

// ============ HELPERS ============

const formatDatePST = (d: Date): string => {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
};

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

const timeToMinutes = (time: string): number => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

const generateId = (): string => Math.random().toString(36).substring(2, 10);

const addHoursToTime = (time: string, hours: number): string => {
  const [h, m] = time.split(":").map(Number);
  const newHour = Math.min(23, Math.max(0, h + hours));
  return `${newHour.toString().padStart(2, "0")}:${
    (m || 0).toString().padStart(2, "0")
  }`;
};

const addMinutesToTime = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const totalMinutes = h * 60 + (m || 0) + minutes;
  const newHour = Math.min(23, Math.max(0, Math.floor(totalMinutes / 60)));
  const newMin = Math.max(0, totalMinutes % 60);
  return `${newHour.toString().padStart(2, "0")}:${
    newMin.toString().padStart(2, "0")
  }`;
};

const _SLOT_INTERVAL = 30;
const SLOT_HEIGHT = HOUR_HEIGHT / 2;

// ============ HANDLERS (MODULE SCOPE) ============

// Navigation handlers
const goPrevHandler = handler<
  unknown,
  { startDate: Cell<string>; visibleDays: Cell<number> }
>((_, state) => {
  const current = state.startDate.get();
  const days = state.visibleDays.get();
  if (current && days) {
    state.startDate.set(addDays(current, -days));
  }
});

const goNextHandler = handler<
  unknown,
  { startDate: Cell<string>; visibleDays: Cell<number> }
>((_, state) => {
  const current = state.startDate.get();
  const days = state.visibleDays.get();
  if (current && days) {
    state.startDate.set(addDays(current, days));
  }
});

const goTodayHandler = handler<
  unknown,
  { startDate: Cell<string>; visibleDays: Cell<number> }
>((_, state) => {
  const today = getTodayDate();
  if (state.visibleDays.get() === 1) {
    state.startDate.set(today);
  } else {
    state.startDate.set(getWeekStart(today));
  }
});

// Day count handlers
const setDays1Handler = handler<unknown, { visibleDays: Cell<number> }>(
  (_, state) => {
    state.visibleDays.set(1);
  },
);

const setDays5Handler = handler<unknown, { visibleDays: Cell<number> }>(
  (_, state) => {
    state.visibleDays.set(5);
  },
);

const setDays7Handler = handler<unknown, { visibleDays: Cell<number> }>(
  (_, state) => {
    state.visibleDays.set(7);
  },
);

// Color handlers
const setColor0Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[0]),
);
const setColor1Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[1]),
);
const setColor2Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[2]),
);
const setColor3Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[3]),
);
const setColor4Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[4]),
);
const setColor5Handler = handler<unknown, { formColor: Cell<string> }>(
  (_, s) => s.formColor.set(COLORS[5]),
);

// Form handlers
const openFormTodayHandler = handler<
  unknown,
  {
    editingId: Cell<string | null>;
    formTitle: Cell<string>;
    formDate: Cell<string>;
    formStartTime: Cell<string>;
    formEndTime: Cell<string>;
    formColor: Cell<string>;
    showForm: Cell<boolean>;
  }
>((_, state) => {
  state.editingId.set(null);
  state.formTitle.set("");
  state.formDate.set(getTodayDate());
  state.formStartTime.set("09:00");
  state.formEndTime.set("10:00");
  state.formColor.set(COLORS[0]);
  state.showForm.set(true);
});

const closeFormHandler = handler<unknown, { showForm: Cell<boolean> }>(
  (_, state) => {
    state.showForm.set(false);
  },
);

const saveAppointment = handler<
  unknown,
  {
    appointments: Cell<Appointment[]>;
    editingId: Cell<string | null>;
    formTitle: Cell<string>;
    formDate: Cell<string>;
    formStartTime: Cell<string>;
    formEndTime: Cell<string>;
    formColor: Cell<string>;
    showForm: Cell<boolean>;
  }
>((_, state) => {
  const title = state.formTitle.get().trim() || "Untitled";
  const apt: Appointment = {
    id: state.editingId.get() || generateId(),
    title,
    date: state.formDate.get(),
    startTime: state.formStartTime.get(),
    endTime: state.formEndTime.get(),
    color: state.formColor.get(),
    notes: "",
  };
  const current = state.appointments.get();
  const existingIdx = current.findIndex((a) => a.id === apt.id);
  if (existingIdx >= 0) {
    const updated = [...current];
    updated[existingIdx] = apt;
    state.appointments.set(updated);
  } else {
    state.appointments.set([...current, apt]);
  }
  state.showForm.set(false);
});

const deleteAppointment = handler<
  unknown,
  {
    appointments: Cell<Appointment[]>;
    editingId: Cell<string | null>;
    showForm: Cell<boolean>;
  }
>((_, state) => {
  const id = state.editingId.get();
  if (!id) return;
  state.appointments.set(state.appointments.get().filter((a) => a.id !== id));
  state.showForm.set(false);
});

const openEditHandler = handler<
  unknown,
  {
    apt: Cell<Appointment>;
    editingId: Cell<string | null>;
    formTitle: Cell<string>;
    formDate: Cell<string>;
    formStartTime: Cell<string>;
    formEndTime: Cell<string>;
    formColor: Cell<string>;
    showForm: Cell<boolean>;
    lastDropTime: Cell<number>;
  }
>((_, state) => {
  if (Date.now() - state.lastDropTime.get() < 300) return;
  const a = state.apt.get();
  state.editingId.set(a.id);
  state.formTitle.set(a.title || "");
  state.formDate.set(a.date);
  state.formStartTime.set(a.startTime || "09:00");
  state.formEndTime.set(a.endTime || "10:00");
  state.formColor.set(a.color || COLORS[0]);
  state.showForm.set(true);
});

const onStartTimeChange = handler<
  { detail: { value: string } },
  { formStartTime: Cell<string>; formEndTime: Cell<string> }
>((e, state) => {
  const newStart = e?.detail?.value || state.formStartTime.get();
  if (newStart) {
    state.formEndTime.set(addHoursToTime(newStart, 1));
  }
});

// ============ PATTERN ============

export default pattern<Input, Output>(({ appointments }) => {
  // Navigation state
  const startDate = Cell.of(getWeekStart(getTodayDate()));
  const visibleDays = Cell.of(7);

  // Form state
  const showForm = Cell.of(false);
  const formTitle = Cell.of("");
  const formDate = Cell.of(getTodayDate());
  const formStartTime = Cell.of("09:00");
  const formEndTime = Cell.of("10:00");
  const formColor = Cell.of(COLORS[0]);
  const editingId = Cell.of<string | null>(null);

  // Track last drop time to prevent click firing after drag
  const lastDropTime = Cell.of(0);

  // Computed values
  const appointmentCount = computed(() => appointments.get().length);

  // Bound handlers
  const formState = {
    editingId,
    formTitle,
    formDate,
    formStartTime,
    formEndTime,
    formColor,
    showForm,
  };

  const boundGoPrev = goPrevHandler({ startDate, visibleDays });
  const boundGoNext = goNextHandler({ startDate, visibleDays });
  const boundGoToday = goTodayHandler({ startDate, visibleDays });
  const boundSetDay1 = setDays1Handler({ visibleDays });
  const _boundSetDay5 = setDays5Handler({ visibleDays });
  const boundSetDay7 = setDays7Handler({ visibleDays });
  const boundOpenFormToday = openFormTodayHandler(formState);
  const boundCloseForm = closeFormHandler({ showForm });
  const boundSave = saveAppointment({ ...formState, appointments });
  const boundDelete = deleteAppointment({ appointments, editingId, showForm });
  const boundColors = [
    setColor0Handler({ formColor }),
    setColor1Handler({ formColor }),
    setColor2Handler({ formColor }),
    setColor3Handler({ formColor }),
    setColor4Handler({ formColor }),
    setColor5Handler({ formColor }),
  ];
  const boundStartTimeChange = onStartTimeChange({
    formStartTime,
    formEndTime,
  });

  // Build hour data
  const hours: Array<{ idx: number; label: string; startTime: string }> = [];
  for (let h = DAY_START; h < DAY_END; h++) {
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    const startTime = `${h.toString().padStart(2, "0")}:00`;
    hours.push({ idx: h - DAY_START, label: `${hour} ${period}`, startTime });
  }

  const gridHeight = (DAY_END - DAY_START) * HOUR_HEIGHT;
  const columnIndices = [0, 1, 2, 3, 4, 5, 6];

  // Computed week dates (kept for potential future use)
  const _allWeekDates = computed(() => getWeekDates(startDate.get(), 7));

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
            <div style={{ display: "flex", gap: "4px" }}>
              <button
                type="button"
                style={{
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                  backgroundColor: ifElse(
                    computed(() => visibleDays.get() === 1),
                    "#3b82f6",
                    "#fff",
                  ),
                  color: ifElse(
                    computed(() => visibleDays.get() === 1),
                    "#fff",
                    "#374151",
                  ),
                  cursor: "pointer",
                }}
                onClick={boundSetDay1}
              >
                Day
              </button>
              <button
                type="button"
                style={{
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                  backgroundColor: ifElse(
                    computed(() => visibleDays.get() === 7),
                    "#3b82f6",
                    "#fff",
                  ),
                  color: ifElse(
                    computed(() => visibleDays.get() === 7),
                    "#fff",
                    "#374151",
                  ),
                  cursor: "pointer",
                }}
                onClick={boundSetDay7}
              >
                Week
              </button>
            </div>
            <div style={{ display: "flex", gap: "4px" }}>
              <button
                type="button"
                style={{
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                  backgroundColor: "#fff",
                  cursor: "pointer",
                }}
                onClick={boundGoPrev}
              >
                &lt;
              </button>
              <button
                type="button"
                style={{
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                  backgroundColor: "#fff",
                  cursor: "pointer",
                }}
                onClick={boundGoToday}
              >
                Today
              </button>
              <button
                type="button"
                style={{
                  padding: "4px 8px",
                  fontSize: "0.75rem",
                  border: "1px solid #d1d5db",
                  borderRadius: "4px",
                  backgroundColor: "#fff",
                  cursor: "pointer",
                }}
                onClick={boundGoNext}
              >
                &gt;
              </button>
            </div>
            <button
              type="button"
              style={{
                padding: "4px 12px",
                fontSize: "0.75rem",
                border: "none",
                borderRadius: "4px",
                backgroundColor: "#3b82f6",
                color: "#fff",
                cursor: "pointer",
              }}
              onClick={boundOpenFormToday}
            >
              + Add
            </button>
          </div>
        </div>

        {/* Main area */}
        <div
          style={{
            display: "flex",
            flex: "1",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Form modal */}
          {ifElse(
            showForm,
            <div
              style={{
                position: "fixed",
                top: "0",
                left: "0",
                right: "0",
                bottom: "0",
                backgroundColor: "rgba(0,0,0,0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: "1000",
              }}
            >
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fff",
                  borderRadius: "8px",
                  boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
                  minWidth: "280px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div style={{ fontWeight: "600" }}>
                  {ifElse(
                    computed(() => editingId.get() != null),
                    "Edit",
                    "New",
                  )} Appointment
                </div>
                <div>
                  <label
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: "500",
                      display: "block",
                      marginBottom: "4px",
                    }}
                  >
                    Title
                  </label>
                  <ct-input
                    $value={formTitle}
                    placeholder="Title..."
                    style={{ width: "100%" }}
                    onct-submit={boundSave}
                  />
                </div>
                <div>
                  <label
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: "500",
                      display: "block",
                      marginBottom: "4px",
                    }}
                  >
                    Date
                  </label>
                  <ct-input
                    $value={formDate}
                    type="date"
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <label
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: "500",
                        display: "block",
                        marginBottom: "4px",
                      }}
                    >
                      Start
                    </label>
                    <ct-input
                      $value={formStartTime}
                      type="time"
                      style={{ width: "100%" }}
                      onct-change={boundStartTimeChange}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: "500",
                        display: "block",
                        marginBottom: "4px",
                      }}
                    >
                      End
                    </label>
                    <ct-input
                      $value={formEndTime}
                      type="time"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
                <div>
                  <label
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: "500",
                      display: "block",
                      marginBottom: "4px",
                    }}
                  >
                    Color
                  </label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {COLORS.map((c, idx) => (
                      <div
                        style={{
                          width: "24px",
                          height: "24px",
                          backgroundColor: c,
                          borderRadius: "4px",
                          cursor: "pointer",
                          border: ifElse(
                            computed(() => formColor.get() === c),
                            "2px solid #111",
                            "2px solid transparent",
                          ),
                        }}
                        onClick={boundColors[idx]}
                      />
                    ))}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    justifyContent: "flex-end",
                    marginTop: "8px",
                  }}
                >
                  {ifElse(
                    computed(() => editingId.get() != null),
                    <button
                      type="button"
                      style={{
                        padding: "6px 12px",
                        fontSize: "0.75rem",
                        border: "none",
                        borderRadius: "4px",
                        backgroundColor: "#fee2e2",
                        color: "#dc2626",
                        cursor: "pointer",
                      }}
                      onClick={boundDelete}
                    >
                      Delete
                    </button>,
                    null,
                  )}
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    style={{
                      padding: "6px 12px",
                      fontSize: "0.75rem",
                      border: "1px solid #d1d5db",
                      borderRadius: "4px",
                      backgroundColor: "#fff",
                      cursor: "pointer",
                    }}
                    onClick={boundCloseForm}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: "6px 12px",
                      fontSize: "0.75rem",
                      border: "none",
                      borderRadius: "4px",
                      backgroundColor: "#3b82f6",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                    onClick={boundSave}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>,
            null,
          )}

          {/* Calendar grid */}
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
                style={{ display: "flex", minHeight: `${gridHeight + 60}px` }}
              >
                {/* Time labels column */}
                <div
                  style={{ width: "50px", flexShrink: "0", paddingTop: "50px" }}
                >
                  {hours.map((hour) => (
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

                {/* Day columns */}
                {columnIndices.map((colIdx) => {
                  // Use computed() for column data - closures capture cells automatically
                  const _columnDate = computed(() => {
                    const dates = getWeekDates(startDate.get(), 7);
                    return dates[colIdx] || "";
                  });
                  const _isVisible = computed(() => colIdx < visibleDays.get());
                  const isToday = computed(() => {
                    const dates = getWeekDates(startDate.get(), 7);
                    return dates[colIdx] === getTodayDate();
                  });
                  const dateHeader = computed(() => {
                    const dates = getWeekDates(startDate.get(), 7);
                    const d = dates[colIdx];
                    return d ? formatDateHeader(d) : "";
                  });

                  // Computed styles - reference cells directly, not computed values
                  const displayStyle = computed(() =>
                    colIdx < visibleDays.get() ? "flex" : "none"
                  );
                  const headerBg = computed(() => {
                    const dates = getWeekDates(startDate.get(), 7);
                    return dates[colIdx] === getTodayDate()
                      ? "#eff6ff"
                      : "transparent";
                  });
                  const headerColor = computed(() => {
                    const dates = getWeekDates(startDate.get(), 7);
                    return dates[colIdx] === getTodayDate()
                      ? "#2563eb"
                      : "#374151";
                  });

                  // Drop handler for moving appointments
                  const handleDayDrop = action(
                    (
                      e: {
                        detail: {
                          sourceCell: Cell;
                          pointerY?: number;
                          dropZoneRect?: { top: number };
                          type?: string;
                        };
                      },
                    ) => {
                      const sourceCell = e.detail.sourceCell;
                      const apt = sourceCell.get() as Appointment;
                      const pointerY = e.detail.pointerY;
                      const dropZoneRect = e.detail.dropZoneRect;
                      const dragType = e.detail.type;

                      if (pointerY === undefined || !dropZoneRect) return;

                      const relativeY = pointerY - dropZoneRect.top;
                      const slotIdx = Math.max(
                        0,
                        Math.floor(relativeY / SLOT_HEIGHT),
                      );
                      const newHour = DAY_START + Math.floor(slotIdx / 2);
                      const newMin = (slotIdx % 2) * 30;
                      const newTime = `${
                        Math.min(DAY_END - 1, Math.max(DAY_START, newHour))
                          .toString()
                          .padStart(2, "0")
                      }:${newMin.toString().padStart(2, "0")}`;

                      const current = appointments.get();
                      const aptIdx = current.findIndex(
                        (a: Appointment) => a.id === apt.id,
                      );
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
                        const startMin = timeToMinutes(
                          apt.startTime || "09:00",
                        );
                        const newEndMin = resizeHour * 60 + resizeMin;
                        const minEndMin = startMin + 30;
                        const finalEndMin = Math.max(minEndMin, newEndMin);
                        const finalEndHour = Math.floor(finalEndMin / 60);
                        const finalEndMinute = finalEndMin % 60;
                        const newEndTime = `${
                          Math.min(DAY_END, finalEndHour)
                            .toString()
                            .padStart(2, "0")
                        }:${finalEndMinute.toString().padStart(2, "0")}`;
                        updated[aptIdx] = { ...apt, endTime: newEndTime };
                      } else {
                        const oldStartMin = timeToMinutes(
                          apt.startTime || "09:00",
                        );
                        const oldEndMin = timeToMinutes(apt.endTime || "10:00");
                        const duration = oldEndMin - oldStartMin;
                        const newEndTime = addMinutesToTime(newTime, duration);
                        updated[aptIdx] = {
                          ...apt,
                          date: dateVal,
                          startTime: newTime,
                          endTime: newEndTime,
                        };
                      }

                      appointments.set(updated);
                      lastDropTime.set(Date.now());
                    },
                  );

                  // Click handlers for creating appointments
                  const createClickHandlers = hours.map((hour) =>
                    action(() => {
                      if (Date.now() - lastDropTime.get() < 300) return;
                      const dateVal = getWeekDates(startDate.get(), 7)[colIdx];
                      editingId.set(null);
                      formTitle.set("");
                      formDate.set(dateVal);
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
                      {/* Date header */}
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

                      {/* Time grid with clickable hour blocks */}
                      <ct-drop-zone
                        accept="appointment,appointment-resize"
                        onct-drop={handleDayDrop}
                        style={{ position: "relative", flex: "1" }}
                      >
                        {hours.map((hour, hourIdx) => (
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
                            onClick={createClickHandlers[hourIdx]}
                          />
                        ))}
                      </ct-drop-zone>
                    </div>
                  );
                })}

                {/* Draggable appointment blocks */}
                {appointments.map((apt) => {
                  // Compute all position/styles in one computed object
                  // This avoids chaining computed() calls which can't have .get() called
                  const styles = computed(() => {
                    const weekStart = startDate.get();
                    const visibleCount = visibleDays.get();
                    const aptDate = apt.date;
                    const aptStart = apt.startTime;
                    const aptEnd = apt.endTime;

                    // Default hidden styles
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

                    const startMin = timeToMinutes(aptStart || "09:00") -
                      DAY_START * 60;
                    const endMin = timeToMinutes(aptEnd || "10:00") -
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

                  // Bind the edit handler
                  const openEdit = openEditHandler({
                    apt,
                    editingId,
                    formTitle,
                    formDate,
                    formStartTime,
                    formEndTime,
                    formColor,
                    showForm,
                    lastDropTime,
                  });

                  // WORKAROUND: Use computed() with apt.id dependency for static children
                  // This ensures the runtime properly renders for dynamically added items
                  const resizeHandleLines = computed(() => {
                    const _id = apt.id; // Reference apt.id to create dependency
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
                    const _id = apt.id; // Reference apt.id to create dependency
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

                      {/* Drag source for moving */}
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

                      {/* Resize drag source */}
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

        {/* Empty state */}
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
