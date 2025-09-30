/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type AttendanceStatus = "present" | "absent";

interface StudentSeed {
  id?: string;
  name?: string;
}

interface StudentRecord {
  id: string;
  name: string;
  sortKey: string;
}

interface AttendanceMark {
  studentId?: string;
  status?: string;
  present?: boolean;
}

interface RecordAttendanceEvent {
  sessionId?: string;
  date?: string;
  topic?: string;
  attendance?: AttendanceMark[];
  marks?: AttendanceMark[];
}

interface AttendanceEntryInternal {
  sessionId: string;
  date: string;
  topic: string;
  presentIds: string[];
  absentIds: string[];
  recordedOrder: number;
}

interface AttendanceEntryView {
  sessionId: string;
  date: string;
  topic: string;
  presentIds: string[];
  absentIds: string[];
}

interface AbsentStudentSummary {
  id: string;
  name: string;
}

interface SessionSummary {
  sessionId: string;
  date: string;
  topic: string;
  presentCount: number;
  absentCount: number;
  absentStudents: AbsentStudentSummary[];
}

const defaultRoster: StudentSeed[] = [
  { id: "stu-alex", name: "Alex Morgan" },
  { id: "stu-blair", name: "Blair Nguyen" },
  { id: "stu-cody", name: "Cody Patel" },
  { id: "stu-dana", name: "Dana Kim" },
];

interface StudentAttendanceTrackerArgs {
  roster: Default<StudentSeed[], typeof defaultRoster>;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizeStudentName = (
  value: unknown,
  fallback: string,
): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const slugify = (value: string): string => {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const sanitizeStudentId = (
  value: unknown,
  fallback: string,
  name: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const slug = slugify(name);
  return slug.length > 0 ? `${slug}-${fallback}` : fallback;
};

const cloneRoster = (entries: readonly StudentSeed[]): StudentSeed[] =>
  entries.map((entry) => ({ ...entry }));

const sanitizeRoster = (
  value: readonly StudentSeed[] | undefined,
): StudentRecord[] => {
  if (!Array.isArray(value)) {
    return sanitizeRoster(cloneRoster(defaultRoster));
  }
  const seen = new Set<string>();
  const sanitized: StudentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const seed = value[index];
    const fallbackId = `student-${index + 1}`;
    const name = sanitizeStudentName(seed?.name, `Student ${index + 1}`);
    const id = sanitizeStudentId(seed?.id, fallbackId, name);
    if (seen.has(id)) continue;
    seen.add(id);
    sanitized.push({ id, name, sortKey: name.toLowerCase() });
  }
  if (sanitized.length === 0) {
    return sanitizeRoster(cloneRoster(defaultRoster));
  }
  sanitized.sort((left, right) => {
    const nameCompare = left.sortKey.localeCompare(right.sortKey);
    if (nameCompare !== 0) return nameCompare;
    return left.id.localeCompare(right.id);
  });
  return sanitized;
};

const sanitizeDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isoDatePattern.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return fallback;
};

const sanitizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeSessionId = (
  value: unknown,
  fallback: string,
  date: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (date.length > 0) {
    return `${date}-${fallback}`;
  }
  return fallback;
};

const toAttendanceList = (
  event: RecordAttendanceEvent | undefined,
): AttendanceMark[] => {
  if (Array.isArray(event?.attendance)) return event.attendance;
  if (Array.isArray(event?.marks)) return event.marks;
  return [];
};

const normalizeStudentIdRef = (
  value: unknown,
  roster: readonly StudentRecord[],
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  for (const student of roster) {
    if (student.id === trimmed) return student.id;
    if (student.id.toLowerCase() === trimmed.toLowerCase()) {
      return student.id;
    }
  }
  return null;
};

const interpretStatus = (
  mark: AttendanceMark | undefined,
): AttendanceStatus => {
  if (!mark) return "absent";
  if (typeof mark.present === "boolean") {
    return mark.present ? "present" : "absent";
  }
  const raw = mark.status;
  if (typeof raw !== "string") return "absent";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "present" || normalized === "p" || normalized === "yes") {
    return "present";
  }
  return "absent";
};

const computeAttendanceSets = (
  event: RecordAttendanceEvent | undefined,
  roster: readonly StudentRecord[],
): { present: Set<string> } => {
  const present = new Set<string>();
  const marks = toAttendanceList(event);
  for (const mark of marks) {
    const id = normalizeStudentIdRef(mark?.studentId, roster);
    if (!id) continue;
    if (interpretStatus(mark) === "present") {
      present.add(id);
    }
  }
  return { present };
};

const toOrderedAttendance = (
  roster: readonly StudentRecord[],
  present: Set<string>,
): { presentIds: string[]; absentIds: string[] } => {
  const presentIds: string[] = [];
  const absentIds: string[] = [];
  for (const student of roster) {
    if (present.has(student.id)) {
      presentIds.push(student.id);
    } else {
      absentIds.push(student.id);
    }
  }
  return { presentIds, absentIds };
};

const createAttendanceEntry = (
  event: RecordAttendanceEvent | undefined,
  roster: readonly StudentRecord[],
  order: number,
): AttendanceEntryInternal => {
  const date = sanitizeDate(event?.date, "1970-01-01");
  const topic = sanitizeTopic(event?.topic, `Session ${order}`);
  const sessionId = sanitizeSessionId(
    event?.sessionId,
    `session-${order}`,
    date,
  );
  const { present } = computeAttendanceSets(event, roster);
  const { presentIds, absentIds } = toOrderedAttendance(roster, present);
  return {
    sessionId,
    date,
    topic,
    presentIds,
    absentIds,
    recordedOrder: order,
  };
};

const compareEntries = (
  left: AttendanceEntryInternal,
  right: AttendanceEntryInternal,
): number => {
  if (left.date !== right.date) {
    return left.date.localeCompare(right.date);
  }
  if (left.sessionId !== right.sessionId) {
    return left.sessionId.localeCompare(right.sessionId);
  }
  return left.recordedOrder - right.recordedOrder;
};

const projectView = (
  entries: readonly AttendanceEntryInternal[],
): AttendanceEntryView[] => {
  return entries.map((entry) => ({
    sessionId: entry.sessionId,
    date: entry.date,
    topic: entry.topic,
    presentIds: [...entry.presentIds],
    absentIds: [...entry.absentIds],
  }));
};

const computeSummaries = (
  entries: readonly AttendanceEntryInternal[],
  roster: readonly StudentRecord[],
): SessionSummary[] => {
  const rosterById = new Map<string, StudentRecord>();
  for (const student of roster) {
    rosterById.set(student.id, student);
  }
  const sorted = [...entries].sort(compareEntries);
  return sorted.map((entry) => {
    const absentStudents: AbsentStudentSummary[] = entry.absentIds.map((id) => {
      const student = rosterById.get(id);
      return { id, name: student?.name ?? id };
    });
    return {
      sessionId: entry.sessionId,
      date: entry.date,
      topic: entry.topic,
      presentCount: entry.presentIds.length,
      absentCount: entry.absentIds.length,
      absentStudents,
    };
  });
};

const formatSessionLabel = (summary: SessionSummary): string => {
  if (summary.absentCount === 0) {
    return `${summary.date} ${summary.topic}: perfect attendance`;
  }
  const names = summary.absentStudents.map((student) => student.name).join(
    ", ",
  );
  const plural = summary.absentCount === 1 ? "absence" : "absences";
  return `${summary.date} ${summary.topic}: ${summary.absentCount} ${plural} (${names})`;
};

const recordAttendance = handler(
  (
    event: RecordAttendanceEvent | undefined,
    context: {
      log: Cell<AttendanceEntryInternal[]>;
      roster: Cell<StudentRecord[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const roster = context.roster.get() ?? [];
    const order = (context.runtimeSeed.get() ?? 0) + 1;
    const nextEntry = createAttendanceEntry(event, roster, order);
    const existing = context.log.get() ?? [];
    const filtered = existing.filter((entry) =>
      entry.sessionId !== nextEntry.sessionId
    );
    const updated = [...filtered, nextEntry].sort(compareEntries);
    context.log.set(updated);
    context.runtimeSeed.set(order);
  },
);

// UI-specific handlers
const recordSessionFromUI = handler(
  (
    _event: undefined,
    context: {
      dateInput: Cell<string>;
      topicInput: Cell<string>;
      presentIdsInput: Cell<string>;
      log: Cell<AttendanceEntryInternal[]>;
      roster: Cell<StudentRecord[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const roster = context.roster.get() ?? [];
    const date = context.dateInput.get() ?? "";
    const topic = context.topicInput.get() ?? "";
    const presentIdsText = context.presentIdsInput.get() ?? "";

    // Parse present IDs from textarea (one per line)
    const presentIds = presentIdsText.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const presentSet = new Set(presentIds);

    const order = (context.runtimeSeed.get() ?? 0) + 1;

    // Create marks array from present set
    const marks: AttendanceMark[] = roster.map((student) => ({
      studentId: student.id,
      present: presentSet.has(student.id),
    }));

    const event: RecordAttendanceEvent = {
      date,
      topic,
      marks,
    };

    const nextEntry = createAttendanceEntry(event, roster, order);
    const existing = context.log.get() ?? [];
    const filtered = existing.filter((entry) =>
      entry.sessionId !== nextEntry.sessionId
    );
    const updated = [...filtered, nextEntry].sort(compareEntries);
    context.log.set(updated);
    context.runtimeSeed.set(order);

    // Clear form
    context.dateInput.set("");
    context.topicInput.set("");
    context.presentIdsInput.set("");
  },
);

export const studentAttendanceTrackerPattern = recipe<
  StudentAttendanceTrackerArgs
>(
  "Student Attendance Tracker",
  ({ roster }) => {
    const runtimeSeed = cell(0);

    const rosterView = lift((value: readonly StudentSeed[] | undefined) =>
      sanitizeRoster(value)
    )(roster);

    const attendanceLogInternal = cell<AttendanceEntryInternal[]>([]);

    const attendanceLog = lift((entries: readonly AttendanceEntryInternal[]) =>
      projectView(entries)
    )(attendanceLogInternal);

    const sessionSummaries = lift((inputs: {
      entries: AttendanceEntryInternal[];
      roster: StudentRecord[];
    }) => computeSummaries(inputs.entries, inputs.roster))({
      entries: attendanceLogInternal,
      roster: rosterView,
    });

    const latestSummary = lift((summaries: readonly SessionSummary[]) =>
      summaries.length === 0 ? null : summaries[summaries.length - 1]
    )(sessionSummaries);

    const sessionAbsenceLabels = lift((summaries: readonly SessionSummary[]) =>
      summaries.map((summary) => formatSessionLabel(summary))
    )(sessionSummaries);

    const totalAbsences = lift((summaries: readonly SessionSummary[]) =>
      summaries.reduce((sum, summary) => sum + summary.absentCount, 0)
    )(sessionSummaries);

    const totalSessions = lift((summaries: readonly SessionSummary[]) =>
      summaries.length
    )(sessionSummaries);

    const absenceWord = lift((count: number) =>
      count === 1 ? "absence" : "absences"
    )(totalAbsences);

    const sessionWord = lift((count: number) =>
      count === 1 ? "session" : "sessions"
    )(totalSessions);

    const absenceSummaryLabel =
      str`${totalAbsences} ${absenceWord} across ${totalSessions} ${sessionWord}`;

    // UI state
    const dateInput = cell("");
    const topicInput = cell("");
    const presentIdsInput = cell("");

    // Initialize date input to today
    compute(() => {
      const current = dateInput.get();
      if (current === "") {
        const today = new Date().toISOString().slice(0, 10);
        dateInput.set(today);
      }
    });

    // UI derives
    const studentCount = lift(
      (roster: StudentRecord[]) => roster.length,
    )(rosterView);

    const hasStudents = lift((count: number) => count > 0)(studentCount);

    const canSubmit = lift((inputs: {
      date: string;
      topic: string;
      hasStudents: boolean;
    }) => {
      const date = inputs.date ?? "";
      const topic = inputs.topic ?? "";
      const hasStudents = inputs.hasStudents ?? false;
      return date.length > 0 && topic.length > 0 && hasStudents;
    })({
      date: dateInput,
      topic: topicInput,
      hasStudents,
    });

    const name =
      str`Student Attendance: ${studentCount} students, ${totalSessions} sessions`;

    const ui = (
      <div
        style={{
          padding: "20px",
          fontFamily: "system-ui, sans-serif",
          maxWidth: "900px",
          margin: "0 auto",
        }}
      >
        <h1 style={{ marginBottom: "8px", fontSize: "24px" }}>
          Student Attendance Tracker
        </h1>
        <p style={{ color: "#666", marginBottom: "24px" }}>
          Track student attendance across class sessions
        </p>

        {/* Summary Card */}
        <ct-card style={{ marginBottom: "24px", padding: "16px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: "16px",
            }}
          >
            <div>
              <div
                style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}
              >
                Students
              </div>
              <div style={{ fontSize: "28px", fontWeight: "bold" }}>
                {studentCount}
              </div>
            </div>
            <div>
              <div
                style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}
              >
                Sessions
              </div>
              <div style={{ fontSize: "28px", fontWeight: "bold" }}>
                {totalSessions}
              </div>
            </div>
            <div>
              <div
                style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}
              >
                Total Absences
              </div>
              <div
                style={{
                  fontSize: "28px",
                  fontWeight: "bold",
                  color: "#dc2626",
                }}
              >
                {totalAbsences}
              </div>
            </div>
          </div>
        </ct-card>

        {/* Record Attendance Form */}
        <ct-card style={{ marginBottom: "24px", padding: "16px" }}>
          <h2 style={{ fontSize: "18px", marginBottom: "16px" }}>
            Record New Session
          </h2>

          <div style={{ marginBottom: "16px" }}>
            <label
              style={{
                display: "block",
                fontSize: "14px",
                fontWeight: "500",
                marginBottom: "4px",
              }}
            >
              Date
            </label>
            <ct-input
              $value={dateInput}
              type="date"
              style={{ width: "100%" }}
            />
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label
              style={{
                display: "block",
                fontSize: "14px",
                fontWeight: "500",
                marginBottom: "4px",
              }}
            >
              Topic
            </label>
            <ct-input
              $value={topicInput}
              placeholder="e.g., Introduction to Variables"
              style={{ width: "100%" }}
            />
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label
              style={{
                display: "block",
                fontSize: "14px",
                fontWeight: "500",
                marginBottom: "4px",
              }}
            >
              Students in Roster
            </label>
            {lift((roster: StudentRecord[]) => {
              if (roster.length === 0) {
                return (
                  <div
                    style={{ padding: "8px", fontSize: "14px", color: "#666" }}
                  >
                    No students in roster
                  </div>
                );
              }

              const students = [];
              for (const student of roster) {
                students.push(
                  <div
                    key={student.id}
                    style={{
                      padding: "4px 8px",
                      fontSize: "14px",
                      color: "#374151",
                      fontFamily: "monospace",
                    }}
                  >
                    {student.id}: {student.name}
                  </div>,
                );
              }

              return (
                <div
                  style={{
                    padding: "8px",
                    background: "#f9fafb",
                    borderRadius: "6px",
                    maxHeight: "120px",
                    overflowY: "auto",
                  }}
                >
                  {students}
                </div>
              );
            })(rosterView)}
          </div>

          <div style={{ marginBottom: "16px" }}>
            <label
              style={{
                display: "block",
                fontSize: "14px",
                fontWeight: "500",
                marginBottom: "4px",
              }}
            >
              Present Student IDs (one per line)
            </label>
            <ct-input
              $value={presentIdsInput}
              multiline
              rows="4"
              placeholder="e.g.,&#10;stu-alex&#10;stu-blair&#10;stu-cody"
              style={{ width: "100%", fontFamily: "monospace" }}
            />
          </div>

          <ct-button
            onClick={recordSessionFromUI(undefined, {
              dateInput,
              topicInput,
              presentIdsInput,
              log: attendanceLogInternal,
              roster: rosterView,
              runtimeSeed,
            })}
            disabled={lift((can: boolean) => !can)(canSubmit)}
            style={{
              width: "100%",
              padding: "12px",
              background: "#3b82f6",
              color: "white",
              borderRadius: "6px",
              fontWeight: "500",
            }}
          >
            Record Session
          </ct-button>
        </ct-card>

        {/* Session History */}
        <ct-card style={{ padding: "16px" }}>
          <h2 style={{ fontSize: "18px", marginBottom: "16px" }}>
            Session History
          </h2>
          {lift((summaries: SessionSummary[]) => {
            if (summaries.length === 0) {
              return (
                <div
                  style={{
                    padding: "32px",
                    textAlign: "center",
                    color: "#666",
                  }}
                >
                  No sessions recorded yet
                </div>
              );
            }

            const sessionCards = [];
            const reversed = summaries.slice().reverse();
            for (const summary of reversed) {
              const bgColor = summary.absentCount === 0 ? "#f0fdf4" : "#fef2f2";
              const borderColor = summary.absentCount === 0
                ? "#10b981"
                : "#dc2626";
              const cardStyle =
                "margin-bottom: 12px; padding: 16px; background: " +
                bgColor + "; border-left: 4px solid " + borderColor +
                "; border-radius: 6px;";

              const absentList = summary.absentStudents.length > 0
                ? (
                  <div
                    style={{
                      marginTop: "8px",
                      fontSize: "14px",
                      color: "#666",
                    }}
                  >
                    Absent:{" "}
                    {summary.absentStudents.map((s) => s.name).join(", ")}
                  </div>
                )
                : null;

              sessionCards.push(
                <div key={summary.sessionId} style={cardStyle}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontWeight: "600",
                          fontSize: "16px",
                          marginBottom: "4px",
                        }}
                      >
                        {summary.topic}
                      </div>
                      <div style={{ fontSize: "14px", color: "#666" }}>
                        {summary.date}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "14px", color: "#059669" }}>
                        Present: {String(summary.presentCount)}
                      </div>
                      <div style={{ fontSize: "14px", color: "#dc2626" }}>
                        Absent: {String(summary.absentCount)}
                      </div>
                    </div>
                  </div>
                  {absentList}
                </div>,
              );
            }

            return <div>{sessionCards}</div>;
          })(sessionSummaries)}
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      roster: rosterView,
      attendanceLog,
      sessionSummaries,
      latestSummary,
      sessionAbsenceLabels,
      totalAbsences,
      totalSessions,
      absenceSummaryLabel,
      recordAttendance: recordAttendance({
        log: attendanceLogInternal,
        roster: rosterView,
        runtimeSeed,
      }),
    };
  },
);

export type {
  AbsentStudentSummary,
  AttendanceEntryView,
  SessionSummary,
  StudentRecord,
};
