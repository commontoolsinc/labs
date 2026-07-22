import { escapeHtml } from "./lib.ts";

export type PerformanceView = "runtime" | "ci" | "gantt";

export interface PerformanceViewState {
  repo: "labs" | "loom";
  days: number;
  sort: string;
  stat: string;
}

export const PERFORMANCE_CHECK_MS = 60_000;

const labels: Record<PerformanceView, string> = {
  runtime: "Runtime benchmarks",
  ci: "CI duration history",
  gantt: "CI run Gantt",
};

const runtimeSort = (sort: string): string =>
  sort === "duration" || sort === "trend" ? sort : "file";

const ciSort = (sort: string): string =>
  sort === "duration" || sort === "trend" ? sort : "job";

export function performanceViewHref(
  view: PerformanceView,
  state: PerformanceViewState,
): string {
  const params = new URLSearchParams({ view });
  params.set("repo", state.repo);
  params.set("days", String(state.days));
  params.set(
    "sort",
    view === "runtime" ? runtimeSort(state.sort) : ciSort(state.sort),
  );
  params.set("stat", state.stat);
  return `/bench?${escapeHtml(params.toString())}`;
}

export function performanceViewNav(
  active: PerformanceView,
  state: PerformanceViewState,
): string {
  const views: PerformanceView[] = ["runtime", "ci", "gantt"];
  return `<nav class="views" aria-label="Performance view">${
    views.map((view) =>
      `<a${view === active ? ' class="on"' : ""} href="${
        performanceViewHref(view, state)
      }"${view === active ? ' aria-current="page"' : ""}>${labels[view]}</a>`
    ).join("")
  }</nav>`;
}
