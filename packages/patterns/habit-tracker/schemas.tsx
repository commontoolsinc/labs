/// <cts-enable />
import { Default, NAME, Stream, UI, type VNode, Writable } from "commontools";

// === Domain Types ===

export interface Habit {
  name: string;
  icon: Default<string, "✓">;
  color: Default<string, "#3b82f6">;
}

export interface HabitLog {
  habitName: string;
  date: string; // YYYY-MM-DD
  completed: boolean;
}

// === Pattern Types ===

export interface HabitTrackerInput {
  habits: Writable<Default<Habit[], []>>;
  logs: Writable<Default<HabitLog[], []>>;
}

export interface HabitTrackerOutput {
  [NAME]: string;
  [UI]: VNode;
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
  toggleHabit: Stream<{ habitName: string }>;
  addHabit: Stream<{ name: string; icon: string }>;
  deleteHabit: Stream<{ habit: Habit }>;
}
