import { escapeHtml } from "./lib.ts";

export type PerformanceView = "runtime" | "ci" | "gantt";

export interface PerformanceViewState {
  repo: "labs" | "loom";
  days: number;
  sort: string;
  stat: string;
}

export const PERFORMANCE_CHECK_MS = 60_000;
export const PERFORMANCE_HISTORY_SCALE_MIN_VALUES = 20;
export const PERFORMANCE_HISTORY_SCALE_TRIM = 2;

export const PERFORMANCE_PROGRESS_STYLES = `
  .fetch-progress{background:#16181d;border:1px solid #2f333c;border-radius:10px;padding:10px 12px;margin:0 0 12px}
  .fetch-progress.error,.fetch-progress.warning{border-color:rgba(224,168,82,.42)}
  .fetch-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:12px;color:#c7ccd4}
  .fetch-head strong{font-weight:600}.fetch-head span,#fetch-detail{font-variant-numeric:tabular-nums;color:#878d97}
  .fetch-progress progress{display:block;width:100%;height:7px;margin:7px 0 6px;accent-color:#6ea8fe}
  #fetch-detail{font-size:11px;margin:0}`;

export const PERFORMANCE_VIEW_STYLES = `
  body{box-sizing:border-box;width:100%;margin:0 auto;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back{color:#6ea8fe;text-decoration:none;font-size:13px}
  .views{display:flex;gap:6px;margin:0 0 14px}
  .views a,.controls a{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:4px 10px}
  .controls a{font-variant-numeric:tabular-nums}.controls a:hover{border-color:#3a4150}
  .views a.on,.controls a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11}
  .controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:12px 14px;margin-bottom:8px}
  .controls .lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#878d97;margin-right:6px}
  .controls .field{display:flex;align-items:center;gap:7px;font-size:12px;color:#9aa0ab;margin-right:8px}
  .controls .choice-group{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .controls select{background:#0d0e11;color:#c7ccd4;border:1px solid #2f333c;border-radius:6px;padding:4px 7px}
  .controls input[type=range]{width:150px}.controls output{color:#c7ccd4;min-width:46px;font-variant-numeric:tabular-nums}
  .controls label.check{font-size:13px;color:#c7ccd4;display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
  .controls label.trailing{margin-left:auto}
  .legend{font-size:11px;color:#777d87;margin:0 0 12px}
  ${PERFORMANCE_PROGRESS_STYLES}
  .axisrow{display:flex;gap:18px;margin:0 14px 4px}.timeaxis{flex:0 0 42%;display:flex;justify-content:space-between;color:#666c76;font-size:10px}
  h2{font-size:12px;letter-spacing:.04em;color:#878d97;font-weight:600;margin:20px 0 8px;font-family:ui-monospace,Menlo,monospace}
  .blist,.clist{display:flex;flex-direction:column;gap:7px}
  .brow,.crow{display:flex;align-items:center;gap:18px;background:#16181d;border:1px solid #23262d;border-radius:10px;padding:8px 14px}
  .brow.good,.crow.good{border-color:rgba(67,197,116,.34);background:rgba(67,197,116,.06)}
  .brow.warn,.crow.warn{border-color:rgba(224,168,82,.42);background:rgba(224,168,82,.07)}
  .brow.bad,.crow.bad{border-color:rgba(226,80,74,.5);background:rgba(226,80,74,.09)}
  .bspark,.cspark{flex:0 0 42%;min-width:0;position:relative}
  .bspark>div,.bspark>svg,.cspark>div,.cspark>svg{margin-top:0!important}
  .bmeta,.cmeta{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
  .bname,.cname{font-size:13px;color:#c7ccd4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bval,.cval{color:#e7e9ee;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .btrend,.ctrend{font-size:11px;font-weight:400;color:#9aa0ab}
  .empty,.refresh-error{color:#9aa0ab;font-size:14px}.refresh-error{color:#e0a852}
  .note{font-size:11px;color:#666c76;margin-top:22px}.note a{color:#6ea8fe;text-decoration:none}
  @media(max-width:640px){.timeaxis{flex:1}.brow,.crow{align-items:stretch;gap:7px;flex-wrap:wrap}.bspark,.cspark{flex:1 0 100%}.controls .field,.controls .choice-group{flex:1 1 100%}.controls input[type=range]{flex:1;width:auto;min-width:0}.controls label.trailing{margin-left:0}}`;

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
