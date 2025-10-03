/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface StudentInput {
  id?: string;
  name?: string;
}

interface AssignmentInput {
  id?: string;
  title?: string;
  weight?: number;
  maxScore?: number;
}

interface GradeInput {
  studentId?: string;
  assignmentId?: string;
  score?: number;
}

interface StudentRecord {
  id: string;
  name: string;
}

interface AssignmentRecord {
  id: string;
  title: string;
  weight: number;
  maxScore: number;
}

interface GradeRecord {
  studentId: string;
  assignmentId: string;
  score: number;
}

interface AssignmentStatistic {
  assignmentId: string;
  assignmentTitle: string;
  averageScore: number;
  maxScore: number;
  averagePercent: number;
  submissions: number;
  completionPercent: number;
  weight: number;
}

interface StudentGradeCell {
  assignmentId: string;
  assignmentTitle: string;
  score: number;
  maxScore: number;
  percent: number;
  weight: number;
  completed: boolean;
}

interface StudentGradeRow {
  studentId: string;
  studentName: string;
  grades: StudentGradeCell[];
  averagePercent: number;
  weightedPercent: number;
  completionPercent: number;
}

interface GradeMatrixView {
  rows: StudentGradeRow[];
  assignmentStats: AssignmentStatistic[];
  classAveragePercent: number;
  studentCount: number;
  assignmentCount: number;
}

interface TopPerformer {
  studentId: string;
  studentName: string;
  weightedPercent: number;
  completionPercent: number;
}

interface AssignmentHighlight {
  assignmentId: string;
  assignmentTitle: string;
  averagePercent: number;
  completionPercent: number;
  submissions: number;
}

interface AssignmentGradingMatrixArgs {
  students: Default<StudentInput[], []>;
  assignments: Default<AssignmentInput[], []>;
  grades: Default<GradeInput[], []>;
}

interface RecordGradeEvent {
  studentId?: string;
  assignmentId?: string;
  score?: number;
  delta?: number;
}

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const formatPercent = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(1)}%`;
};

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length > 0) return normalized;
  }
  return fallback;
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return fallback;
  const first = trimmed.charAt(0).toUpperCase();
  return `${first}${trimmed.slice(1)}`;
};

const sanitizePositive = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = roundToTwo(value);
  if (normalized <= 0) return fallback;
  return normalized;
};

const sanitizeScore = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return roundToTwo(value);
};

const clampScore = (score: number, maxScore: number): number => {
  if (maxScore <= 0) return 0;
  if (score <= 0) return 0;
  if (score >= maxScore) return roundToTwo(maxScore);
  return roundToTwo(score);
};

const claimIdentifier = (
  used: Set<string>,
  candidate: string,
  fallback: string,
): string => {
  const base = candidate.length > 0 ? candidate : fallback;
  let next = base;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(next);
  return next;
};

const buildOrderMap = (ids: readonly string[]): Map<string, number> => {
  const order = new Map<string, number>();
  ids.forEach((value, index) => {
    order.set(value, index);
  });
  return order;
};

const sanitizeStudents = (value: unknown): StudentRecord[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: StudentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as StudentInput | undefined;
    const fallbackId = `student-${index + 1}`;
    const idCandidate = sanitizeIdentifier(raw?.id, fallbackId);
    const id = claimIdentifier(used, idCandidate, fallbackId);
    const nameFallback = `Student ${index + 1}`;
    const name = sanitizeName(raw?.name, nameFallback);
    sanitized.push({ id, name });
  }
  return sanitized;
};

const sanitizeAssignments = (value: unknown): AssignmentRecord[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: AssignmentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as AssignmentInput | undefined;
    const fallbackId = `assignment-${index + 1}`;
    const idCandidate = sanitizeIdentifier(raw?.id, fallbackId);
    const id = claimIdentifier(used, idCandidate, fallbackId);
    const titleFallback = `Assignment ${index + 1}`;
    const title = sanitizeName(raw?.title, titleFallback);
    const weight = sanitizePositive(raw?.weight, 1);
    const maxScore = sanitizePositive(raw?.maxScore, 100);
    sanitized.push({ id, title, weight, maxScore });
  }
  return sanitized;
};

const sanitizeGrades = (
  value: unknown,
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeRecord[] => {
  if (!Array.isArray(value)) return [];
  const studentOrder = buildOrderMap(students.map((student) => student.id));
  const assignmentOrder = buildOrderMap(
    assignments.map((assignment) => assignment.id),
  );
  const assignmentById = new Map<string, AssignmentRecord>();
  for (const assignment of assignments) {
    assignmentById.set(assignment.id, assignment);
  }
  const map = new Map<string, GradeRecord>();
  for (const entry of value as GradeInput[]) {
    if (!entry) continue;
    const studentId = sanitizeIdentifier(entry.studentId, "");
    const assignmentId = sanitizeIdentifier(entry.assignmentId, "");
    if (!studentOrder.has(studentId)) continue;
    const assignment = assignmentById.get(assignmentId);
    if (!assignment) continue;
    const scoreValue = sanitizeScore(entry.score) ?? 0;
    const clamped = clampScore(scoreValue, assignment.maxScore);
    const key = `${studentId}::${assignmentId}`;
    map.set(key, { studentId, assignmentId, score: clamped });
  }
  const sanitized = Array.from(map.values());
  sanitized.sort((left, right) => {
    const studentDiff = (studentOrder.get(left.studentId) ?? 0) -
      (studentOrder.get(right.studentId) ?? 0);
    if (studentDiff !== 0) return studentDiff;
    return (assignmentOrder.get(left.assignmentId) ?? 0) -
      (assignmentOrder.get(right.assignmentId) ?? 0);
  });
  return sanitized;
};

const buildGradeMatrix = (
  entries: readonly GradeRecord[],
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeMatrixView => {
  const entryMap = new Map<string, GradeRecord>();
  for (const entry of entries) {
    const key = `${entry.studentId}::${entry.assignmentId}`;
    entryMap.set(key, entry);
  }
  const rows: StudentGradeRow[] = [];
  let weightedTotal = 0;
  let weightedCount = 0;
  for (const student of students) {
    const cells: StudentGradeCell[] = [];
    let percentSum = 0;
    let weightedSum = 0;
    let weightTotal = 0;
    let completed = 0;
    for (const assignment of assignments) {
      const key = `${student.id}::${assignment.id}`;
      const grade = entryMap.get(key);
      const score = grade?.score ?? 0;
      const percent = assignment.maxScore === 0
        ? 0
        : roundToTwo((score / assignment.maxScore) * 100);
      const isCompleted = grade !== undefined;
      if (isCompleted) completed += 1;
      percentSum += percent;
      weightedSum += percent * assignment.weight;
      weightTotal += assignment.weight;
      cells.push({
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        score: roundToTwo(score),
        maxScore: assignment.maxScore,
        percent,
        weight: assignment.weight,
        completed: isCompleted,
      });
    }
    const averagePercent = assignments.length === 0
      ? 0
      : roundToTwo(percentSum / assignments.length);
    const weightedPercent = weightTotal === 0
      ? 0
      : roundToTwo(weightedSum / weightTotal);
    const completionPercent = assignments.length === 0
      ? 0
      : roundToTwo((completed / assignments.length) * 100);
    rows.push({
      studentId: student.id,
      studentName: student.name,
      grades: cells,
      averagePercent,
      weightedPercent,
      completionPercent,
    });
    weightedTotal += weightedPercent;
    weightedCount += 1;
  }
  const classAveragePercent = weightedCount === 0
    ? 0
    : roundToTwo(weightedTotal / weightedCount);
  const assignmentStats: AssignmentStatistic[] = assignments.map(
    (assignment) => {
      let totalScore = 0;
      let submissions = 0;
      for (const student of students) {
        const key = `${student.id}::${assignment.id}`;
        const grade = entryMap.get(key);
        if (!grade) continue;
        totalScore += grade.score;
        submissions += 1;
      }
      const averageScore = submissions === 0
        ? 0
        : roundToTwo(totalScore / submissions);
      const averagePercent = assignment.maxScore === 0
        ? 0
        : roundToTwo((averageScore / assignment.maxScore) * 100);
      const completionPercent = students.length === 0
        ? 0
        : roundToTwo((submissions / students.length) * 100);
      return {
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        averageScore,
        maxScore: assignment.maxScore,
        averagePercent,
        submissions,
        completionPercent,
        weight: assignment.weight,
      };
    },
  );
  return {
    rows,
    assignmentStats,
    classAveragePercent,
    studentCount: rows.length,
    assignmentCount: assignments.length,
  };
};

const identifyTopPerformer = (matrix: GradeMatrixView): TopPerformer => {
  if (matrix.rows.length === 0) {
    return {
      studentId: "none",
      studentName: "none",
      weightedPercent: 0,
      completionPercent: 0,
    };
  }
  let best = matrix.rows[0];
  for (let index = 1; index < matrix.rows.length; index += 1) {
    const current = matrix.rows[index];
    if (current.weightedPercent > best.weightedPercent) {
      best = current;
      continue;
    }
    if (current.weightedPercent === best.weightedPercent) {
      if (current.completionPercent > best.completionPercent) {
        best = current;
        continue;
      }
      if (
        current.completionPercent === best.completionPercent &&
        current.studentName.localeCompare(best.studentName) < 0
      ) {
        best = current;
      }
    }
  }
  return {
    studentId: best.studentId,
    studentName: best.studentName,
    weightedPercent: best.weightedPercent,
    completionPercent: best.completionPercent,
  };
};

const highlightAssignment = (
  stats: readonly AssignmentStatistic[],
): AssignmentHighlight => {
  if (stats.length === 0) {
    return {
      assignmentId: "none",
      assignmentTitle: "none",
      averagePercent: 0,
      completionPercent: 0,
      submissions: 0,
    };
  }
  let best = stats[0];
  for (let index = 1; index < stats.length; index += 1) {
    const current = stats[index];
    if (current.averagePercent > best.averagePercent) {
      best = current;
      continue;
    }
    if (current.averagePercent === best.averagePercent) {
      if (current.completionPercent > best.completionPercent) {
        best = current;
        continue;
      }
      if (
        current.completionPercent === best.completionPercent &&
        current.assignmentTitle.localeCompare(best.assignmentTitle) < 0
      ) {
        best = current;
      }
    }
  }
  return {
    assignmentId: best.assignmentId,
    assignmentTitle: best.assignmentTitle,
    averagePercent: best.averagePercent,
    completionPercent: best.completionPercent,
    submissions: best.submissions,
  };
};

const updateGradeEntries = (
  list: readonly GradeRecord[],
  event: RecordGradeEvent | undefined,
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeRecord[] => {
  if (!event) return [...list];
  const studentId = sanitizeIdentifier(event.studentId, "");
  const assignmentId = sanitizeIdentifier(event.assignmentId, "");
  if (studentId.length === 0 || assignmentId.length === 0) {
    return [...list];
  }
  const studentExists = students.some((student) => student.id === studentId);
  if (!studentExists) return [...list];
  const assignment = assignments.find((item) => item.id === assignmentId);
  if (!assignment) return [...list];
  const absolute = sanitizeScore(event.score);
  const delta = sanitizeScore(event.delta);
  let nextScore: number | null = null;
  if (absolute !== null) {
    nextScore = clampScore(absolute, assignment.maxScore);
  } else if (delta !== null && delta !== 0) {
    const current = list.find((entry) =>
      entry.studentId === studentId && entry.assignmentId === assignmentId
    );
    const base = current?.score ?? 0;
    nextScore = clampScore(base + delta, assignment.maxScore);
  }
  if (nextScore === null) return [...list];
  const updated: GradeRecord[] = [];
  let replaced = false;
  for (const entry of list) {
    if (entry.studentId === studentId && entry.assignmentId === assignmentId) {
      if (!replaced) {
        updated.push({ studentId, assignmentId, score: nextScore });
        replaced = true;
      }
      continue;
    }
    updated.push(entry);
  }
  if (!replaced) {
    updated.push({ studentId, assignmentId, score: nextScore });
  }
  const studentOrder = buildOrderMap(students.map((student) => student.id));
  const assignmentOrder = buildOrderMap(
    assignments.map((assignment) => assignment.id),
  );
  updated.sort((left, right) => {
    const studentDiff = (studentOrder.get(left.studentId) ?? 0) -
      (studentOrder.get(right.studentId) ?? 0);
    if (studentDiff !== 0) return studentDiff;
    return (assignmentOrder.get(left.assignmentId) ?? 0) -
      (assignmentOrder.get(right.assignmentId) ?? 0);
  });
  return updated;
};

const recordGrade = handler(
  (
    event: RecordGradeEvent | undefined,
    context: {
      rawGrades: Cell<GradeInput[]>;
      students: Cell<StudentRecord[]>;
      assignments: Cell<AssignmentRecord[]>;
    },
  ) => {
    const students = context.students.get();
    const assignments = context.assignments.get();
    const studentList = Array.isArray(students) ? students : [];
    const assignmentList = Array.isArray(assignments) ? assignments : [];
    const existing = sanitizeGrades(
      context.rawGrades.get(),
      studentList,
      assignmentList,
    );
    const next = updateGradeEntries(
      existing,
      event,
      studentList,
      assignmentList,
    );
    context.rawGrades.set(next.map((entry) => ({ ...entry })));
  },
);

/** Pattern demonstrating an assignment grading matrix with UX. */
export const assignmentGradingMatrixUx = recipe<AssignmentGradingMatrixArgs>(
  "Assignment Grading Matrix (UX)",
  ({ students, assignments, grades }) => {
    const sanitizedStudents = lift(sanitizeStudents)(students);
    const sanitizedAssignments = lift(sanitizeAssignments)(assignments);
    const gradeEntries = lift((input: {
      entries: GradeInput[] | undefined;
      students: StudentRecord[];
      assignments: AssignmentRecord[];
    }) => {
      const baseEntries = Array.isArray(input.entries) ? input.entries : [];
      return sanitizeGrades(baseEntries, input.students, input.assignments);
    })({
      entries: grades,
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
    });
    lift((entries: GradeRecord[]) => {
      grades.set(entries.map((entry) => ({ ...entry })));
      return entries;
    })(gradeEntries);
    const gradeMatrix = lift((input: {
      entries: GradeRecord[];
      students: StudentRecord[];
      assignments: AssignmentRecord[];
    }) => {
      return buildGradeMatrix(input.entries, input.students, input.assignments);
    })({
      entries: gradeEntries,
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
    });
    const topPerformer = derive(gradeMatrix, identifyTopPerformer);
    const standoutAssignment = derive(
      gradeMatrix,
      (matrix) => highlightAssignment(matrix.assignmentStats),
    );
    const classAverageText = lift((matrix: GradeMatrixView) =>
      formatPercent(matrix.classAveragePercent)
    )(gradeMatrix);
    const studentCountText = lift((matrix: GradeMatrixView) =>
      `${matrix.studentCount}`
    )(gradeMatrix);
    const assignmentCountText = lift((matrix: GradeMatrixView) =>
      `${matrix.assignmentCount}`
    )(gradeMatrix);
    const summaryLabel =
      str`Class average ${classAverageText} across ${studentCountText} students for ${assignmentCountText} assignments`;

    // UI form cells
    const studentIdField = cell<string>("");
    const assignmentIdField = cell<string>("");
    const scoreField = cell<string>("");

    // UI handler for recording grades
    const recordGradeUI = handler<
      unknown,
      {
        studentIdField: Cell<string>;
        assignmentIdField: Cell<string>;
        scoreField: Cell<string>;
        rawGrades: Cell<GradeInput[]>;
        students: Cell<StudentRecord[]>;
        assignments: Cell<AssignmentRecord[]>;
      }
    >((_event, ctx) => {
      const studentIdStr = ctx.studentIdField.get();
      const assignmentIdStr = ctx.assignmentIdField.get();
      const scoreStr = ctx.scoreField.get();

      if (
        typeof studentIdStr !== "string" || studentIdStr.trim() === "" ||
        typeof assignmentIdStr !== "string" || assignmentIdStr.trim() === "" ||
        typeof scoreStr !== "string" || scoreStr.trim() === ""
      ) {
        return;
      }

      const score = Number(scoreStr.trim());
      if (!Number.isFinite(score)) {
        return;
      }

      const students = ctx.students.get();
      const assignments = ctx.assignments.get();
      const studentList = Array.isArray(students) ? students : [];
      const assignmentList = Array.isArray(assignments) ? assignments : [];
      const existing = sanitizeGrades(
        ctx.rawGrades.get(),
        studentList,
        assignmentList,
      );
      const next = updateGradeEntries(
        existing,
        {
          studentId: studentIdStr.trim(),
          assignmentId: assignmentIdStr.trim(),
          score,
        },
        studentList,
        assignmentList,
      );
      ctx.rawGrades.set(next.map((entry) => ({ ...entry })));
      ctx.studentIdField.set("");
      ctx.assignmentIdField.set("");
      ctx.scoreField.set("");
    })({
      studentIdField,
      assignmentIdField,
      scoreField,
      rawGrades: grades,
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
    });

    const name =
      str`Grading Matrix (${studentCountText} students, ${assignmentCountText} assignments)`;

    // Render student/assignment lists
    const studentsDisplay = lift((students: StudentRecord[]) => {
      const elements = [];
      for (const s of students) {
        elements.push(
          h(
            "div",
            {
              style:
                "font-size: 0.85rem; font-family: monospace; color: #334155;",
            },
            s.id + " - " + s.name,
          ),
        );
      }
      return h(
        "div",
        {
          style:
            "display: flex; flex-direction: column; gap: 0.5rem; background: #f8fafc; padding: 0.75rem; border-radius: 0.5rem; max-height: 12rem; overflow-y: auto;",
        },
        ...elements,
      );
    })(sanitizedStudents);

    const assignmentsDisplay = lift((assignments: AssignmentRecord[]) => {
      const elements = [];
      for (const a of assignments) {
        elements.push(
          h(
            "div",
            {
              style:
                "font-size: 0.85rem; font-family: monospace; color: #334155;",
            },
            a.id + " - " + a.title + " (max: " + String(a.maxScore) +
              ", weight: " + String(a.weight) + ")",
          ),
        );
      }
      return h(
        "div",
        {
          style:
            "display: flex; flex-direction: column; gap: 0.5rem; background: #f8fafc; padding: 0.75rem; border-radius: 0.5rem; max-height: 12rem; overflow-y: auto;",
        },
        ...elements,
      );
    })(sanitizedAssignments);

    // Render student grade rows
    const matrixRows = lift((matrix: GradeMatrixView) => {
      const rowElements = [];
      for (const row of matrix.rows) {
        const gradeCellElements = [];
        for (const g of row.grades) {
          const completed = g.completed;
          const bgColor = completed
            ? (g.percent >= 90
              ? "#dcfce7"
              : g.percent >= 70
              ? "#fef9c3"
              : "#fee2e2")
            : "#f1f5f9";
          const borderColor = completed
            ? (g.percent >= 90
              ? "#22c55e"
              : g.percent >= 70
              ? "#eab308"
              : "#ef4444")
            : "#cbd5e1";

          gradeCellElements.push(
            h(
              "div",
              {
                style: "background: " + bgColor + "; border: 2px solid " +
                  borderColor +
                  "; border-radius: 0.375rem; padding: 0.5rem; font-size: 0.8rem;",
              },
              h(
                "div",
                { style: "font-weight: 600; color: #1e293b;" },
                g.assignmentTitle,
              ),
              h(
                "div",
                {
                  style:
                    "font-family: monospace; color: #475569; margin-top: 0.25rem;",
                },
                String(g.score) + " / " + String(g.maxScore),
              ),
              h(
                "div",
                {
                  style:
                    "font-weight: 600; color: #0f172a; margin-top: 0.25rem;",
                },
                String(g.percent) + "%",
              ),
            ),
          );
        }

        const gradesCells = h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.5rem; margin-top: 0.5rem;",
          },
          ...gradeCellElements,
        );

        const weightedStyle =
          "background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 0.75rem; border-radius: 0.5rem; font-weight: 600;";
        const completionStyle =
          "background: #f1f5f9; color: #475569; padding: 0.5rem; border-radius: 0.25rem; font-size: 0.85rem;";

        rowElements.push(
          h(
            "ct-card",
            null,
            h(
              "div",
              {
                slot: "content",
                style: "display: flex; flex-direction: column; gap: 0.75rem;",
              },
              h(
                "div",
                { style: "display: flex; align-items: center; gap: 0.75rem;" },
                h(
                  "h3",
                  { style: "margin: 0; font-size: 1.1rem; color: #0f172a;" },
                  row.studentName,
                ),
                h(
                  "span",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; font-family: monospace;",
                  },
                  "(" + row.studentId + ")",
                ),
              ),
              h(
                "div",
                {
                  style:
                    "display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;",
                },
                h(
                  "div",
                  { style: weightedStyle },
                  h(
                    "div",
                    { style: "font-size: 0.75rem; opacity: 0.9;" },
                    "Weighted",
                  ),
                  h(
                    "div",
                    { style: "font-size: 1.5rem; font-family: monospace;" },
                    String(row.weightedPercent) + "%",
                  ),
                ),
                h(
                  "div",
                  { style: completionStyle },
                  h("div", { style: "font-size: 0.75rem;" }, "Completion"),
                  h(
                    "div",
                    { style: "font-size: 1.25rem; font-weight: 600;" },
                    String(row.completionPercent) + "%",
                  ),
                ),
              ),
              gradesCells,
            ),
          ),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column; gap: 0.5rem;" },
        ...rowElements,
      );
    })(gradeMatrix);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 60rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Assignment Grading Matrix
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Class Grade Management
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Track student grades across multiple assignments with weighted
                  scoring and completion tracking.
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 0.75rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    border-radius: 0.5rem;
                    padding: 1rem;
                    color: white;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Class Average
                  </div>
                  <div style="
                      font-size: 2rem;
                      font-weight: 700;
                    ">
                    {classAverageText}
                  </div>
                </div>
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.5rem;
                    padding: 1rem;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Students
                  </div>
                  <div style="
                      font-size: 2rem;
                      font-weight: 700;
                      color: #0f172a;
                    ">
                    {studentCountText}
                  </div>
                </div>
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.5rem;
                    padding: 1rem;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Assignments
                  </div>
                  <div style="
                      font-size: 2rem;
                      font-weight: 700;
                      color: #0f172a;
                    ">
                    {assignmentCountText}
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1rem;
                  color: #0f172a;
                ">
                Record a Grade
              </h3>
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 1rem;
                ">
                <div>
                  <label
                    for="student-list"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      display: block;
                      margin-bottom: 0.5rem;
                    "
                  >
                    Students
                  </label>
                  {studentsDisplay}
                </div>
                <div>
                  <label
                    for="assignment-list"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      display: block;
                      margin-bottom: 0.5rem;
                    "
                  >
                    Assignments
                  </label>
                  {assignmentsDisplay}
                </div>
              </div>
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr 1fr auto;
                  gap: 0.5rem;
                  align-items: flex-end;
                ">
                <div>
                  <label
                    for="student-id"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      display: block;
                      margin-bottom: 0.4rem;
                    "
                  >
                    Student ID
                  </label>
                  <ct-input
                    id="student-id"
                    type="text"
                    placeholder="e.g., student-1"
                    $value={studentIdField}
                  >
                  </ct-input>
                </div>
                <div>
                  <label
                    for="assignment-id"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      display: block;
                      margin-bottom: 0.4rem;
                    "
                  >
                    Assignment ID
                  </label>
                  <ct-input
                    id="assignment-id"
                    type="text"
                    placeholder="e.g., assignment-1"
                    $value={assignmentIdField}
                  >
                  </ct-input>
                </div>
                <div>
                  <label
                    for="score"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      display: block;
                      margin-bottom: 0.4rem;
                    "
                  >
                    Score
                  </label>
                  <ct-input
                    id="score"
                    type="number"
                    step="0.5"
                    placeholder="Enter score"
                    $value={scoreField}
                  >
                  </ct-input>
                </div>
                <ct-button onClick={recordGradeUI}>Record</ct-button>
              </div>
            </div>
          </ct-card>

          {matrixRows}
        </div>
      ),
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
      gradeEntries,
      gradeMatrix,
      topPerformer,
      standoutAssignment,
      summaryLabel,
      controls: {
        recordGrade: recordGrade({
          rawGrades: grades,
          students: sanitizedStudents,
          assignments: sanitizedAssignments,
        }),
      },
    };
  },
);

export default assignmentGradingMatrixUx;
