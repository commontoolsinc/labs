/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type DayName =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

interface WorkoutExerciseSeed {
  name?: string;
  muscleGroup?: string;
  defaultSets?: number;
  defaultReps?: number;
}

interface WorkoutExercise {
  name: string;
  muscleGroup: string;
  defaultSets: number;
  defaultReps: number;
}

interface WorkoutPlanSeed {
  day?: string;
  exercise?: string;
  sets?: number;
  reps?: number;
}

interface WorkoutPlanEntry {
  day: string;
  exercise: string;
  muscleGroup: string;
  sets: number;
  reps: number;
}

interface MuscleVolumeEntry {
  muscleGroup: string;
  sessionCount: number;
  totalSets: number;
  totalReps: number;
  totalVolume: number;
}

interface WorkoutRoutinePlannerArgs {
  days: Default<string[], typeof defaultDays>;
  catalog: Default<WorkoutExerciseSeed[], typeof defaultCatalog>;
  plan: Default<WorkoutPlanEntry[], []>;
}

interface ScheduleEvent {
  day?: string;
  exercise?: string;
  sets?: number;
  reps?: number;
}

interface RemovalEvent {
  day?: string;
  exercise?: string;
}

const defaultDays: DayName[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const defaultCatalog: WorkoutExerciseSeed[] = [
  {
    name: "Back Squat",
    muscleGroup: "Legs",
    defaultSets: 4,
    defaultReps: 6,
  },
  {
    name: "Bench Press",
    muscleGroup: "Chest",
    defaultSets: 3,
    defaultReps: 8,
  },
  {
    name: "Deadlift",
    muscleGroup: "Back",
    defaultSets: 3,
    defaultReps: 5,
  },
  {
    name: "Overhead Press",
    muscleGroup: "Shoulders",
    defaultSets: 3,
    defaultReps: 8,
  },
  {
    name: "Pull Up",
    muscleGroup: "Back",
    defaultSets: 3,
    defaultReps: 10,
  },
];

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const titleCase = (value: string): string => {
  return value
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const sanitizeDays = (
  value: readonly string[] | undefined,
): string[] => {
  if (!Array.isArray(value)) return [...defaultDays];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    const normalized = titleCase(text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [...defaultDays];
};

const sanitizeMuscleGroup = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "General";
  return titleCase(text);
};

const sanitizePositiveInt = (
  value: unknown,
  fallback: number,
  minimum = 1,
): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return Math.max(minimum, fallback);
  const rounded = Math.floor(numeric);
  return Math.max(minimum, rounded);
};

const sanitizeCatalog = (
  value: readonly WorkoutExerciseSeed[] | undefined,
): WorkoutExercise[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultCatalog.map((entry) => ({
      name: entry.name!,
      muscleGroup: entry.muscleGroup!,
      defaultSets: entry.defaultSets!,
      defaultReps: entry.defaultReps!,
    }));
  }
  const seen = new Set<string>();
  const catalog: WorkoutExercise[] = [];
  for (const seed of value) {
    const rawName = sanitizeText(seed?.name);
    if (!rawName) continue;
    const name = titleCase(rawName);
    if (seen.has(name)) continue;
    const muscleGroup = sanitizeMuscleGroup(seed?.muscleGroup);
    const defaultSets = sanitizePositiveInt(seed?.defaultSets, 3);
    const defaultReps = sanitizePositiveInt(seed?.defaultReps, 5);
    seen.add(name);
    catalog.push({
      name,
      muscleGroup,
      defaultSets,
      defaultReps,
    });
  }
  return catalog.length > 0 ? catalog : defaultCatalog.map((entry) => ({
    name: entry.name!,
    muscleGroup: entry.muscleGroup!,
    defaultSets: entry.defaultSets!,
    defaultReps: entry.defaultReps!,
  }));
};

const lookupExercise = (
  name: unknown,
  catalog: readonly WorkoutExercise[],
): WorkoutExercise | null => {
  const text = sanitizeText(name);
  if (!text) return null;
  const normalized = text.toLowerCase();
  for (const entry of catalog) {
    if (entry.name.toLowerCase() === normalized) {
      return entry;
    }
  }
  return null;
};

const pickDay = (
  value: unknown,
  days: readonly string[],
): string | null => {
  if (days.length === 0) return null;
  const text = sanitizeText(value);
  if (!text) {
    return days[0] ?? null;
  }
  const normalized = text.toLowerCase();
  for (const day of days) {
    if (day.toLowerCase() === normalized) return day;
  }
  return null;
};

const keyForPlanEntry = (entry: WorkoutPlanEntry): string => {
  return `${entry.day}__${entry.exercise}`;
};

const sanitizePlan = (
  value:
    | readonly WorkoutPlanSeed[]
    | readonly WorkoutPlanEntry[]
    | undefined,
  days: readonly string[],
  catalog: readonly WorkoutExercise[],
): WorkoutPlanEntry[] => {
  if (!Array.isArray(value)) return [];
  const dayOrder = new Map<string, number>();
  days.forEach((day, index) => dayOrder.set(day, index));
  const dedup = new Map<string, WorkoutPlanEntry>();
  for (const seed of value) {
    const day = pickDay(seed?.day, days);
    if (!day) continue;
    const exercise = lookupExercise(seed?.exercise, catalog);
    if (!exercise) continue;
    const sets = sanitizePositiveInt(seed?.sets, exercise.defaultSets);
    const reps = sanitizePositiveInt(seed?.reps, exercise.defaultReps);
    const entry: WorkoutPlanEntry = {
      day,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      sets,
      reps,
    };
    dedup.set(keyForPlanEntry(entry), entry);
  }
  const entries = Array.from(dedup.values());
  entries.sort((a, b) => {
    const dayA = dayOrder.get(a.day) ?? 0;
    const dayB = dayOrder.get(b.day) ?? 0;
    if (dayA === dayB) {
      return a.exercise.localeCompare(b.exercise);
    }
    return dayA - dayB;
  });
  return entries;
};

const buildScheduleByDay = (
  days: readonly string[],
  plan: readonly WorkoutPlanEntry[],
): Record<string, WorkoutPlanEntry[]> => {
  const schedule: Record<string, WorkoutPlanEntry[]> = {};
  for (const day of days) {
    schedule[day] = [];
  }
  for (const entry of plan) {
    if (!schedule[entry.day]) {
      schedule[entry.day] = [];
    }
    schedule[entry.day].push(entry);
  }
  for (const day of days) {
    schedule[day].sort((a, b) => a.exercise.localeCompare(b.exercise));
  }
  return schedule;
};

const computeVolumeByGroup = (
  plan: readonly WorkoutPlanEntry[],
): MuscleVolumeEntry[] => {
  const buckets = new Map<string, MuscleVolumeEntry>();
  for (const entry of plan) {
    const bucket = buckets.get(entry.muscleGroup) ?? {
      muscleGroup: entry.muscleGroup,
      sessionCount: 0,
      totalSets: 0,
      totalReps: 0,
      totalVolume: 0,
    };
    bucket.sessionCount += 1;
    bucket.totalSets += entry.sets;
    bucket.totalReps += entry.reps;
    bucket.totalVolume += entry.sets * entry.reps;
    buckets.set(entry.muscleGroup, bucket);
  }
  return Array.from(buckets.values()).sort((a, b) =>
    a.muscleGroup.localeCompare(b.muscleGroup)
  );
};

const describeSchedule = (
  entry: WorkoutPlanEntry,
): string => {
  return `${entry.exercise} for ${entry.day} (${entry.sets}x${entry.reps})`;
};

const scheduleWorkout = handler(
  (
    event: ScheduleEvent | undefined,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exercise = lookupExercise(event?.exercise, catalog);
    if (!exercise) return;
    const day = pickDay(event?.day, days);
    if (!day) return;

    const sets = sanitizePositiveInt(event?.sets, exercise.defaultSets);
    const reps = sanitizePositiveInt(event?.reps, exercise.defaultReps);

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const nextEntry: WorkoutPlanEntry = {
      day,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      sets,
      reps,
    };
    const keyed = new Map<string, WorkoutPlanEntry>();
    for (const entry of current) {
      keyed.set(keyForPlanEntry(entry), entry);
    }
    keyed.set(keyForPlanEntry(nextEntry), nextEntry);
    const sorted = sanitizePlan(Array.from(keyed.values()), days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Scheduled ${describeSchedule(nextEntry)}`);
  },
);

const removeWorkout = handler(
  (
    event: RemovalEvent | undefined,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exercise = lookupExercise(event?.exercise, catalog);
    if (!exercise) return;
    const day = pickDay(event?.day, days);
    if (!day) return;

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const filtered = current.filter((entry) =>
      !(entry.day === day && entry.exercise === exercise.name)
    );
    if (filtered.length === current.length) return;

    const sorted = sanitizePlan(filtered, days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Removed ${exercise.name} on ${day}`);
  },
);

const addWorkoutHandler = handler(
  (
    _event: unknown,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
      dayField: Cell<string>;
      exerciseField: Cell<string>;
      setsField: Cell<string>;
      repsField: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exerciseName = context.exerciseField.get();
    const exercise = lookupExercise(exerciseName, catalog);
    if (!exercise) return;

    const dayName = context.dayField.get();
    const day = pickDay(dayName, days);
    if (!day) return;

    const setsText = context.setsField.get();
    const sets = sanitizePositiveInt(
      setsText,
      exercise.defaultSets,
    );

    const repsText = context.repsField.get();
    const reps = sanitizePositiveInt(
      repsText,
      exercise.defaultReps,
    );

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const nextEntry: WorkoutPlanEntry = {
      day,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      sets,
      reps,
    };
    const keyed = new Map<string, WorkoutPlanEntry>();
    for (const entry of current) {
      keyed.set(keyForPlanEntry(entry), entry);
    }
    keyed.set(keyForPlanEntry(nextEntry), nextEntry);
    const sorted = sanitizePlan(Array.from(keyed.values()), days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Added ${describeSchedule(nextEntry)}`);

    context.dayField.set("");
    context.exerciseField.set("");
    context.setsField.set("");
    context.repsField.set("");
  },
);

const removeWorkoutHandler = handler(
  (
    _event: unknown,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
      removeDayField: Cell<string>;
      removeExerciseField: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exerciseName = context.removeExerciseField.get();
    const exercise = lookupExercise(exerciseName, catalog);
    if (!exercise) return;

    const dayName = context.removeDayField.get();
    const day = pickDay(dayName, days);
    if (!day) return;

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const filtered = current.filter((entry) =>
      !(entry.day === day && entry.exercise === exercise.name)
    );
    if (filtered.length === current.length) return;

    const sorted = sanitizePlan(filtered, days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Removed ${exercise.name} on ${day}`);

    context.removeDayField.set("");
    context.removeExerciseField.set("");
  },
);

export const workoutRoutinePlannerUx = recipe<WorkoutRoutinePlannerArgs>(
  "Workout Routine Planner (UX)",
  ({ days, catalog, plan }) => {
    const lastAction = cell("initialized");

    const daysView = lift(sanitizeDays)(days);
    const catalogView = lift(sanitizeCatalog)(catalog);
    const planView = lift((inputs: {
      plan: WorkoutPlanSeed[] | undefined;
      days: string[];
      catalog: WorkoutExercise[];
    }) => sanitizePlan(inputs.plan, inputs.days, inputs.catalog))({
      plan,
      days: daysView,
      catalog: catalogView,
    });

    const scheduleByDay = lift((inputs: {
      days: string[];
      plan: WorkoutPlanEntry[];
    }) => buildScheduleByDay(inputs.days, inputs.plan))({
      days: daysView,
      plan: planView,
    });

    const volumeByGroup = lift((entries: WorkoutPlanEntry[]) =>
      computeVolumeByGroup(entries)
    )(planView);

    const totalVolume = lift((entries: MuscleVolumeEntry[]) =>
      entries.reduce((sum, entry) => sum + entry.totalVolume, 0)
    )(volumeByGroup);

    const groupCount = lift((entries: MuscleVolumeEntry[]) => entries.length)(
      volumeByGroup,
    );

    const focusGroup = lift((entries: MuscleVolumeEntry[]) => {
      if (entries.length === 0) return "None";
      let candidate = entries[0];
      for (const entry of entries) {
        if (entry.totalVolume > candidate.totalVolume) {
          candidate = entry;
        } else if (
          entry.totalVolume === candidate.totalVolume &&
          entry.muscleGroup.localeCompare(candidate.muscleGroup) < 0
        ) {
          candidate = entry;
        }
      }
      return `${candidate.muscleGroup} (${candidate.totalVolume} reps)`;
    })(volumeByGroup);

    const status =
      str`${totalVolume} total reps across ${groupCount} muscle groups`;
    const focusSummary = str`Top focus: ${focusGroup}`;

    const dayField = cell("");
    const exerciseField = cell("");
    const setsField = cell("");
    const repsField = cell("");

    const removeDayField = cell("");
    const removeExerciseField = cell("");

    const addWorkout = addWorkoutHandler({
      plan,
      daysView,
      catalogView,
      lastAction,
      dayField,
      exerciseField,
      setsField,
      repsField,
    });

    const removeWorkoutFromPlan = removeWorkoutHandler({
      plan,
      daysView,
      catalogView,
      lastAction,
      removeDayField,
      removeExerciseField,
    });

    const name = str`Workout Routine Planner`;

    const ui = (
      <div style="padding: 1.5rem; max-width: 1200px; margin: 0 auto; font-family: system-ui, sans-serif;">
        <h1 style="margin: 0 0 0.5rem 0; font-size: 1.75rem; font-weight: 700; color: #1e293b;">
          Workout Routine Planner
        </h1>
        <p style="margin: 0 0 1.5rem 0; color: #64748b; font-size: 0.95rem;">
          Design your weekly workout schedule
        </p>

        <div
          style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;"
          data-testid="summary-stats"
        >
          <ct-card style="padding: 1rem; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border: none;">
            <div style="color: #fff;">
              <div style="font-size: 0.85rem; font-weight: 500; margin-bottom: 0.25rem; opacity: 0.9;">
                Total Volume
              </div>
              <div
                style="font-size: 2rem; font-weight: 700;"
                data-testid="total-volume"
              >
                {totalVolume}
              </div>
              <div style="font-size: 0.8rem; opacity: 0.8;">
                reps across {groupCount} muscle groups
              </div>
            </div>
          </ct-card>

          <ct-card style="padding: 1rem; background: linear-gradient(135deg, #ec4899 0%, #f43f5e 100%); border: none;">
            <div style="color: #fff;">
              <div style="font-size: 0.85rem; font-weight: 500; margin-bottom: 0.25rem; opacity: 0.9;">
                Primary Focus
              </div>
              <div
                style="font-size: 1.25rem; font-weight: 700;"
                data-testid="focus-group"
              >
                {focusGroup}
              </div>
            </div>
          </ct-card>
        </div>

        <ct-card style="padding: 1.25rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">
            Add Workout
          </h2>

          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.75rem; margin-bottom: 1rem;">
            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="day-input"
              >
                Day
              </label>
              <ct-input
                id="day-input"
                $value={dayField}
                placeholder="Monday"
                style="width: 100%;"
                data-testid="day-input"
              />
            </div>

            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="exercise-input"
              >
                Exercise
              </label>
              <ct-input
                id="exercise-input"
                $value={exerciseField}
                placeholder="Bench Press"
                style="width: 100%;"
                data-testid="exercise-input"
              />
            </div>

            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="sets-input"
              >
                Sets
              </label>
              <ct-input
                id="sets-input"
                $value={setsField}
                placeholder="3"
                style="width: 100%;"
                data-testid="sets-input"
              />
            </div>

            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="reps-input"
              >
                Reps
              </label>
              <ct-input
                id="reps-input"
                $value={repsField}
                placeholder="8"
                style="width: 100%;"
                data-testid="reps-input"
              />
            </div>
          </div>

          <ct-button
            onClick={addWorkout}
            style="padding: 0.625rem 1.25rem; background: #6366f1; color: #fff; border: none; border-radius: 0.375rem; font-weight: 500; cursor: pointer;"
            data-testid="add-workout-button"
          >
            Add to Schedule
          </ct-button>
        </ct-card>

        <ct-card style="padding: 1.25rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">
            Weekly Schedule
          </h2>

          {lift(
            (
              inputs: {
                days: string[];
                schedule: Record<string, WorkoutPlanEntry[]>;
              },
            ) => {
              const scheduleElements = [];
              const dayColors = [
                "#3b82f6",
                "#8b5cf6",
                "#ec4899",
                "#f59e0b",
                "#10b981",
                "#06b6d4",
                "#6366f1",
              ];

              for (let i = 0; i < inputs.days.length; i++) {
                const day = inputs.days[i];
                const workouts = inputs.schedule[day] || [];
                const color = dayColors[i % dayColors.length];
                const borderStyle = "border-left: 4px solid " + color + ";";

                const workoutElements = [];
                for (const workout of workouts) {
                  const workoutStyle =
                    "padding: 0.75rem; background: #f8fafc; border-radius: 0.375rem; margin-bottom: 0.5rem;";
                  workoutElements.push(
                    h("div", { style: workoutStyle, key: workout.exercise }, [
                      h(
                        "div",
                        {
                          style:
                            "font-weight: 600; color: #1e293b; margin-bottom: 0.25rem;",
                        },
                        [workout.exercise],
                      ),
                      h(
                        "div",
                        { style: "font-size: 0.85rem; color: #64748b;" },
                        [
                          h(
                            "span",
                            {
                              style:
                                "display: inline-block; background: #e0e7ff; color: #4338ca; padding: 0.125rem 0.5rem; border-radius: 0.25rem; margin-right: 0.5rem; font-weight: 500;",
                            },
                            [workout.muscleGroup],
                          ),
                          h("span", { style: "font-family: monospace;" }, [
                            String(workout.sets) + "×" + String(workout.reps),
                          ]),
                        ],
                      ),
                    ]),
                  );
                }

                const dayCardStyle =
                  "padding: 1rem; margin-bottom: 0.75rem; border-radius: 0.5rem; background: #fff; " +
                  borderStyle;

                scheduleElements.push(
                  h("div", { style: dayCardStyle, key: day }, [
                    h(
                      "div",
                      {
                        style:
                          "font-weight: 700; font-size: 1.1rem; margin-bottom: 0.75rem; color: " +
                          color + ";",
                      },
                      [day],
                    ),
                    workouts.length === 0
                      ? h(
                        "div",
                        { style: "color: #94a3b8; font-style: italic;" },
                        ["Rest day"],
                      )
                      : h("div", {}, workoutElements),
                  ]),
                );
              }

              return h(
                "div",
                { "data-testid": "schedule-by-day" },
                scheduleElements,
              );
            },
          )({ days: daysView, schedule: scheduleByDay })}
        </ct-card>

        <ct-card style="padding: 1.25rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">
            Muscle Volume Analysis
          </h2>

          {lift((volumes: MuscleVolumeEntry[]) => {
            if (volumes.length === 0) {
              return h(
                "div",
                { style: "color: #94a3b8; font-style: italic;" },
                ["No workouts scheduled yet"],
              );
            }

            const elements = [];
            const colors = [
              "#3b82f6",
              "#8b5cf6",
              "#ec4899",
              "#f59e0b",
              "#10b981",
            ];

            for (let i = 0; i < volumes.length; i++) {
              const volume = volumes[i];
              const color = colors[i % colors.length];
              const cardStyle = "padding: 1rem; border-left: 4px solid " +
                color +
                "; background: #f8fafc; border-radius: 0.375rem;";

              elements.push(
                h("div", { style: cardStyle, key: volume.muscleGroup }, [
                  h(
                    "div",
                    {
                      style:
                        "font-weight: 700; font-size: 1.1rem; margin-bottom: 0.5rem; color: #1e293b;",
                    },
                    [volume.muscleGroup],
                  ),
                  h(
                    "div",
                    {
                      style:
                        "display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem;",
                    },
                    [
                      h("div", {}, [
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.75rem; color: #64748b; margin-bottom: 0.125rem;",
                          },
                          ["Sessions"],
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 1.25rem; font-weight: 700; color: " +
                              color +
                              ";",
                          },
                          [String(volume.sessionCount)],
                        ),
                      ]),
                      h("div", {}, [
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.75rem; color: #64748b; margin-bottom: 0.125rem;",
                          },
                          ["Total Sets"],
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 1.25rem; font-weight: 700; color: " +
                              color +
                              ";",
                          },
                          [String(volume.totalSets)],
                        ),
                      ]),
                      h("div", {}, [
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.75rem; color: #64748b; margin-bottom: 0.125rem;",
                          },
                          ["Total Reps"],
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 1.25rem; font-weight: 700; color: " +
                              color +
                              ";",
                          },
                          [String(volume.totalReps)],
                        ),
                      ]),
                      h("div", {}, [
                        h(
                          "div",
                          {
                            style:
                              "font-size: 0.75rem; color: #64748b; margin-bottom: 0.125rem;",
                          },
                          ["Volume"],
                        ),
                        h(
                          "div",
                          {
                            style:
                              "font-size: 1.25rem; font-weight: 700; color: " +
                              color +
                              ";",
                          },
                          [String(volume.totalVolume)],
                        ),
                      ]),
                    ],
                  ),
                ]),
              );
            }

            return h(
              "div",
              {
                style: "display: grid; gap: 0.75rem;",
                "data-testid": "volume-by-group",
              },
              elements,
            );
          })(volumeByGroup)}
        </ct-card>

        <ct-card style="padding: 1.25rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">
            Available Exercises
          </h2>

          {lift((exercises: WorkoutExercise[]) => {
            const elements = [];
            const groupColors: Record<string, string> = {
              "Legs": "#3b82f6",
              "Chest": "#ec4899",
              "Back": "#8b5cf6",
              "Shoulders": "#f59e0b",
            };

            for (const exercise of exercises) {
              const color = groupColors[exercise.muscleGroup] || "#10b981";
              const cardStyle =
                "padding: 0.75rem 1rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 0.375rem; display: flex; justify-content: space-between; align-items: center;";

              elements.push(
                h("div", { style: cardStyle, key: exercise.name }, [
                  h("div", {}, [
                    h(
                      "div",
                      {
                        style:
                          "font-weight: 600; color: #1e293b; margin-bottom: 0.25rem;",
                      },
                      [exercise.name],
                    ),
                    h(
                      "span",
                      {
                        style: "display: inline-block; background: " +
                          color +
                          "; color: #fff; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 500;",
                      },
                      [exercise.muscleGroup],
                    ),
                  ]),
                  h(
                    "div",
                    { style: "font-family: monospace; color: #64748b;" },
                    [
                      String(exercise.defaultSets) +
                      "×" +
                      String(exercise.defaultReps),
                    ],
                  ),
                ]),
              );
            }

            return h(
              "div",
              {
                style: "display: grid; gap: 0.5rem;",
                "data-testid": "exercise-catalog",
              },
              elements,
            );
          })(catalogView)}
        </ct-card>

        <ct-card style="padding: 1.25rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;">
            Remove Workout
          </h2>

          <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end;">
            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="remove-day-input"
              >
                Day
              </label>
              <ct-input
                id="remove-day-input"
                $value={removeDayField}
                placeholder="Monday"
                style="width: 100%;"
                data-testid="remove-day-input"
              />
            </div>

            <div>
              <label
                style="display: block; font-size: 0.85rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;"
                for="remove-exercise-input"
              >
                Exercise
              </label>
              <ct-input
                id="remove-exercise-input"
                $value={removeExerciseField}
                placeholder="Bench Press"
                style="width: 100%;"
                data-testid="remove-exercise-input"
              />
            </div>

            <ct-button
              onClick={removeWorkoutFromPlan}
              style="padding: 0.625rem 1.25rem; background: #ef4444; color: #fff; border: none; border-radius: 0.375rem; font-weight: 500; cursor: pointer;"
              data-testid="remove-workout-button"
            >
              Remove
            </ct-button>
          </div>
        </ct-card>

        <div
          style="margin-top: 1rem; padding: 0.75rem; background: #f1f5f9; border-radius: 0.375rem; font-size: 0.85rem; color: #475569;"
          data-testid="last-action"
        >
          Last action: {lastAction}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      plan: planView,
      scheduleByDay,
      volumeByGroup,
      totalVolume,
      status,
      focusSummary,
      lastAction,
      scheduleWorkout: scheduleWorkout({
        plan,
        daysView,
        catalogView,
        lastAction,
      }),
      removeWorkout: removeWorkout({
        plan,
        daysView,
        catalogView,
        lastAction,
      }),
    };
  },
);

export type { MuscleVolumeEntry, WorkoutPlanEntry };
