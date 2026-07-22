// ci duration: median wall-clock of recent completed runs, with a trend
// sparkline. One factory builds both the labs and loom instances against their
// own repo + workflow. Both instances drill down to their repository's history
// on /bench. The labs instance owns the Gantt image route. The Gantt view
// exposes scripts/ci-gantt.ts controls for both repositories.
import { fromFileUrl } from "@std/path";
import {
  runSource,
  type Route,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import { escapeHtml, friendlyError, SPARK_FADE, sparkline } from "../lib.ts";
import {
  CI_WORKFLOW,
  DUR_GOOD,
  DUR_MAX_AGE_HOURS,
  DUR_MIN_RUNS,
  DUR_WARN,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "../config.ts";
import {
  CI_FETCH_PROGRESS_STYLES,
  ciCommitGanttProgressResponse,
  ciFetchProgressPanel,
  type CiGanttInput,
  type CiGanttOptions,
  ciGanttOptions,
  ciGanttProgressResponse,
  ciHistoryDays,
  type CiHistorySource,
  ciHistorySource,
  collectCiGanttInput,
  collectCommitCiGanttInput,
  GANTT_MAX_RUNS,
} from "../ci-job-history.ts";
import { performanceViewNav } from "../performance-views.ts";

const CIGANTT = fromFileUrl(
  new URL("../../../scripts/ci-gantt.ts", import.meta.url),
);
const GANTT_REFRESH_MS = 30 * 60_000;

export type CiGanttDataProvider = (
  source: CiHistorySource,
  options: CiGanttOptions,
) => Promise<CiGanttInput>;

export async function renderGantt(
  p: URLSearchParams,
  dataProvider: CiGanttDataProvider = collectCiGanttInput,
  signal?: AbortSignal,
): Promise<Response> {
  const source = ciHistorySource(p.get("repo"));
  const options = ciGanttOptions(p);
  const { limit, mainOnly, allConclusions } = options;
  let out: string | undefined;
  let input: string | undefined;
  try {
    const data = await dataProvider(source, options);
    if (signal?.aborted) {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    }
    out = await Deno.makeTempFile({ prefix: "ci-gantt-", suffix: ".png" });
    input = await Deno.makeTempFile({
      prefix: "ci-gantt-input-",
      suffix: ".json",
    });
    await Deno.writeTextFile(input, JSON.stringify(data));
    const args = [
      "run",
      "--allow-read",
      `--allow-write=${out}`,
      "--allow-ffi",
      "--allow-sys=cpus,networkInterfaces,hostname",
      CIGANTT,
      "--input",
      input,
      "--repo",
      source.repo,
      "--workflow",
      source.workflow,
      "--limit",
      String(limit),
      "--scale",
      "2",
      "--theme",
      "dark",
      "--out",
      out,
    ];
    if (mainOnly) args.push("--main-only");
    if (allConclusions) args.push("--all-conclusions");
    for (const { runId } of options.selectedRuns ?? []) {
      args.push("--run-id", String(runId));
    }
    const defaultMinimum = options.selectedRuns?.length
      ? 1
      : mainOnly
      ? 2
      : Math.max(5, Math.round(0.1 * data.runs.length));
    args.push(
      "--min-runs",
      String(Math.min(defaultMinimum, Math.max(1, data.runs.length))),
    );
    const { success, stderr } = await new Deno.Command("deno", {
      args,
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
    if (signal?.aborted) {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    }
    if (!success) {
      console.error("ci-gantt failed:", new TextDecoder().decode(stderr));
      return new Response("ci-gantt failed (see server log)", { status: 500 });
    }
    return new Response(await Deno.readFile(out), {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (signal?.aborted) {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("ci-gantt render error:", message);
    const safeMessage = friendlyError(message);
    if (safeMessage === "rate limit hit") {
      return new Response("rate limit hit", {
        status: 429,
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response(safeMessage, {
      status: 500,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    if (out) await Deno.remove(out).catch(() => {});
    if (input) await Deno.remove(input).catch(() => {});
  }
}

export function renderGanttRoute(
  request: Request,
  url: URL,
  dataProvider: CiGanttDataProvider = collectCiGanttInput,
): Promise<Response> {
  return renderGantt(url.searchParams, dataProvider, request.signal);
}

export function ciGanttPage(url: URL): string {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const days = ciHistoryDays(url.searchParams.get("days"));
  const sort = url.searchParams.get("sort") ?? "job";
  const stat = url.searchParams.get("stat") ?? "p99";
  const viewNav = performanceViewNav("gantt", {
    repo: source.key,
    days,
    sort,
    stat,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CI run Gantt</title>
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1100px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a.back{color:#6ea8fe;text-decoration:none;font-size:13px}
  .views{display:flex;gap:6px;margin:0 0 14px}
  .views a{font-size:13px;color:#c7ccd4;text-decoration:none;border:1px solid #2f333c;border-radius:6px;padding:4px 10px}
  .views a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11}
  .controls{display:flex;flex-wrap:wrap;gap:20px;align-items:center;background:#16181d;border:1px solid #23262d;border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .controls label{font-size:13px;color:#c7ccd4;display:flex;align-items:center;gap:8px;flex:none}
  .controls input[type=range]{width:200px}
  .controls select{background:#0d0e11;color:#e7e9ee;border:1px solid #2f333c;border-radius:6px;padding:3px 6px}
  ${CI_FETCH_PROGRESS_STYLES}
  .imgwrap{background:#0c0d11;border:1px solid #23262d;border-radius:12px;padding:10px;overflow:auto;min-height:60px}
  #g{width:100%;height:auto;display:none}
  .hint{font-size:11px;color:#666c76;margin-top:12px}
  @media(max-width:640px){.controls{gap:14px}.controls label{flex:1 1 100%}.controls input[type=range]{width:auto;min-width:0;flex:1}}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>Performance history</b><span>${
    escapeHtml(source.repo)
  } · ${escapeHtml(source.workflow)} · scripts/ci-gantt.ts</span></div>
  ${viewNav}
  <div class="controls">
    <label>repository <select id="repo"><option value="labs"${
    source.key === "labs" ? " selected" : ""
  }>labs</option><option value="loom"${
    source.key === "loom" ? " selected" : ""
  }>loom</option></select></label>
    <label>runs to include <input type="range" id="limit" min="1" max="150" step="1" value="60"><b id="limitv">60</b></label>
    <label><input type="checkbox" id="mainOnly" checked> main pushes only</label>
    <label><input type="checkbox" id="allConcl"> include failed/cancelled in timing</label>
  </div>
  ${ciFetchProgressPanel(undefined, { ariaLabel: "CI Gantt fetch progress" })}
  <div class="imgwrap"><img id="g" alt="CI Gantt chart"></div>
  <p class="hint">Run, job, and step timings share the persistent server cache used by CI history. Regeneration reads cached past runs and fetches only missing runs or newer attempts.</p>
<script>
  const $ = (id) => document.getElementById(id);
  const g = $('g'), fetchProgress = $('fetch-progress'), title = $('fetch-title'), total = $('fetch-total'), detail = $('fetch-detail'), bar = $('fetch-bar');
  function parameters(){
    const p = new URLSearchParams();
    p.set('repo', $('repo').value);
    p.set('limit', $('limit').value);
    if ($('mainOnly').checked) p.set('mainOnly', '1');
    if ($('allConcl').checked) p.set('allConclusions', '1');
    return p;
  }
  function imageUrl(){
    const p = parameters();
    p.set('t', Date.now());
    return '/bench/gantt.png?' + p.toString();
  }
  function progressUrl(){
    return '/bench/gantt-progress?' + parameters().toString();
  }
  let renderSequence = 0, imageRequest = null, chartSrc = '', eventStream = null, collectionError = '', collectionWarning = '';
  const closeProgress = () => {
    eventStream?.close();
    eventStream = null;
  };
  const renderIdle = (message = 'No requests in progress.', warning = '') => {
    fetchProgress.classList.remove('error', 'warning');
    if (warning) fetchProgress.classList.add('warning');
    title.textContent = 'Idle';
    total.textContent = '0 outstanding';
    bar.max = 1;
    bar.value = 0;
    detail.textContent = message + (warning ? ' ' + warning : '');
  };
  const renderProgress = (state) => {
    fetchProgress.classList.remove('error', 'warning');
    collectionWarning = state.warning || '';
    if (state.phase === 'discovering') {
      title.textContent = 'Finding workflow runs…';
      total.textContent = state.discoveryOutstandingRequests + ' outstanding';
      bar.removeAttribute('value');
      detail.textContent = state.discoveryRequestsMade + ' workflow requests made · ' +
        state.discoveryResponsesReceived + ' responded · ' +
        state.discoveryOutstandingRequests + ' outstanding';
    } else {
      title.textContent = state.phase === 'saving'
        ? 'Saving completed responses…'
        : state.completedRuns + ' of ' + state.totalRuns + ' run checks complete';
      total.textContent = state.completedRuns + ' / ' + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
      detail.textContent = state.cachedRuns + ' cached · ' +
        state.requestsMade + ' run requests made · ' +
        state.sharedRequests + ' shared · ' +
        (state.responsesReceived + state.sharedResponses) + ' responded · ' +
        state.outstandingRequests + ' outstanding · ' +
        state.queuedRuns + ' queued' +
        (state.failedResponses ? ' · ' + state.failedResponses + ' failed' : '') +
        (collectionWarning ? ' · ' + collectionWarning : '');
    }
    if (state.phase === 'error') {
      closeProgress();
      collectionError = state.error || 'unknown error';
      collectionWarning = '';
      fetchProgress.classList.add('error');
      title.textContent = 'Idle';
      total.textContent = '0 outstanding';
      bar.max = 1;
      bar.value = 0;
      detail.textContent = 'Last collection stopped: ' + collectionError;
    } else if (state.phase === 'complete') {
      closeProgress();
      if (collectionWarning) fetchProgress.classList.add('warning');
      title.textContent = 'Generating chart image…';
      total.textContent = '0 outstanding';
      detail.textContent = (collectionWarning ? collectionWarning + ' ' : 'CI data is ready. ') +
        'Rendering the chart image.';
    }
  };
  const connectProgress = () => {
    closeProgress();
    const stream = new EventSource(progressUrl());
    eventStream = stream;
    stream.addEventListener('progress', (event) => {
      if (eventStream !== stream) return;
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        stream.close();
        eventStream = null;
        fetchProgress.classList.add('error');
        title.textContent = 'Could not read collection progress';
      }
    });
    stream.onerror = () => {
      if (eventStream !== stream) return;
      stream.close();
      eventStream = null;
      fetchProgress.classList.add('error');
      title.textContent = 'Progress connection closed; collection continues on the server';
    };
  };
  function regen(){
    const sequence = ++renderSequence;
    imageRequest?.abort();
    const controller = new AbortController();
    imageRequest = controller;
    const requestedLimit = $('limit').value;
    collectionError = '';
    collectionWarning = '';
    fetchProgress.classList.remove('error', 'warning');
    title.textContent = 'Starting CI Gantt collection…';
    total.textContent = 'starting';
    bar.removeAttribute('value');
    detail.textContent = 'Reading cached runs and checking GitHub for newer attempts.';
    connectProgress();
    const done = (kind, text, src) => {
      if (sequence !== renderSequence) {
        if (src) URL.revokeObjectURL(src);
        return;
      }
      imageRequest = null;
      closeProgress();
      if (chartSrc) URL.revokeObjectURL(chartSrc);
      chartSrc = kind === 'ok' ? src : '';
      if (kind === 'ok') {
        g.src = src;
        g.style.display = 'block';
        renderIdle(text, collectionWarning);
      } else {
        g.removeAttribute('src');
        g.style.display = 'none';
        fetchProgress.classList.add('error');
        title.textContent = 'Idle';
        total.textContent = '0 outstanding';
        bar.max = 1;
        bar.value = 0;
        detail.textContent = 'Last collection stopped: ' + (collectionError || text);
      }
    };
    fetch(imageUrl(), { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) {
        throw new Error((await response.text()).trim());
      }
      const src = URL.createObjectURL(await response.blob());
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(src);
        img.onerror = () => {
          URL.revokeObjectURL(src);
          reject(new Error('invalid chart image'));
        };
        img.src = src;
      });
    }).then((src) => {
      done(
        'ok',
        'No requests in progress. Chart updated with up to ' + requestedLimit + ' runs.',
        src,
      );
    }).catch((error) => {
      if (controller.signal.aborted || sequence !== renderSequence) return;
      const message = error instanceof Error && error.message
        ? error.message
        : 'failed to generate (check the server log)';
      done('err', message);
    });
  }
  $('repo').addEventListener('change', () => {
    const params = new URLSearchParams(location.search);
    params.set('view', 'gantt');
    params.set('repo', $('repo').value);
    location.href = '/bench?' + params.toString();
  });
  $('limit').addEventListener('input', () => { $('limitv').textContent = $('limit').value; });
  $('limit').addEventListener('change', regen);
  ['mainOnly','allConcl'].forEach((id) => $(id).addEventListener('change', regen));
  regen();
  setInterval(() => {
    if (document.visibilityState === 'visible') regen();
  }, ${GANTT_REFRESH_MS});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') regen();
  });
  window.addEventListener('pagehide', () => {
    renderSequence++;
    imageRequest?.abort();
    closeProgress();
  });
</script></body></html>`;
}

function commitGanttParameters(url: URL): URLSearchParams | null {
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
  const selected = new Map<number, { runId: number; runAttempt: number }>();
  for (const run of ciGanttOptions(url.searchParams).selectedRuns ?? []) {
    const current = selected.get(run.runId);
    if (!current || current.runAttempt < run.runAttempt) {
      selected.set(run.runId, run);
    }
  }
  if (!selected.size || selected.size > GANTT_MAX_RUNS) return null;
  const parameters = new URLSearchParams({
    repo: ciHistorySource(url.searchParams.get("repo")).key,
    sha: sha.toLowerCase(),
    limit: String(selected.size),
    mainOnly: "1",
  });
  for (const { runId, runAttempt } of selected.values()) {
    parameters.append("run", `${runId}:${runAttempt}`);
  }
  return parameters;
}

export function ciCommitGanttPage(url: URL): string {
  const source = ciHistorySource(url.searchParams.get("repo"));
  const parameters = commitGanttParameters(url);
  const sha = parameters?.get("sha") ?? url.searchParams.get("sha") ?? "";
  const shortSha = sha.slice(0, 7) || "unknown commit";
  const runCount = parameters?.getAll("run").length ?? 0;
  const commitUrl = `https://github.com/${source.repo}/commit/${sha}`;
  const imageUrl = parameters ? `/ci-gantt.png?${parameters}` : "";
  const progressUrl = parameters ? `/ci-gantt-progress?${parameters}` : "";
  const chart = parameters
    ? `<div class="imgwrap"><img id="g" alt="CI Gantt for ${
      escapeHtml(shortSha)
    }"></div>`
    : `<div class="empty">No successful main CI runs were supplied for this commit.</div>`;
  const script = parameters
    ? `<script>
  const fetchProgress = document.getElementById('fetch-progress');
  const title = document.getElementById('fetch-title');
  const total = document.getElementById('fetch-total');
  const detail = document.getElementById('fetch-detail');
  const bar = document.getElementById('fetch-bar');
  const chart = document.getElementById('g');
  let collectionWarning = '';
  let chartSettled = false;
  const stream = new EventSource(${JSON.stringify(progressUrl)});
  const idle = (message, warning = '', error = false) => {
    fetchProgress.classList.remove('error', 'warning');
    if (error) fetchProgress.classList.add('error');
    if (warning) fetchProgress.classList.add('warning');
    title.textContent = 'Idle';
    total.textContent = '0 outstanding';
    bar.max = 1;
    bar.value = 0;
    detail.textContent = message + (warning ? ' ' + warning : '');
  };
  stream.addEventListener('progress', (event) => {
    if (chartSettled) return;
    const state = JSON.parse(event.data);
    fetchProgress.classList.remove('error', 'warning');
    collectionWarning = state.warning || '';
    if (state.phase === 'discovering') {
      title.textContent = 'Finding selected workflow runs…';
      total.textContent = state.discoveryOutstandingRequests + ' outstanding';
      bar.removeAttribute('value');
      detail.textContent = state.discoveryRequestsMade + ' workflow requests made · ' +
        state.discoveryResponsesReceived + ' responded · ' +
        state.discoveryOutstandingRequests + ' outstanding';
    } else {
      title.textContent = state.phase === 'saving'
        ? 'Saving completed responses…'
        : state.completedRuns + ' of ' + state.totalRuns + ' run checks complete';
      total.textContent = state.completedRuns + ' / ' + state.totalRuns;
      bar.max = Math.max(1, state.totalRuns);
      bar.value = state.completedRuns;
      detail.textContent = state.cachedRuns + ' cached · ' +
        state.requestsMade + ' run requests made · ' +
        state.sharedRequests + ' shared · ' +
        (state.responsesReceived + state.sharedResponses) + ' responded · ' +
        state.outstandingRequests + ' outstanding · ' +
        state.queuedRuns + ' queued' +
        (state.failedResponses ? ' · ' + state.failedResponses + ' failed' : '') +
        (collectionWarning ? ' · ' + collectionWarning : '');
    }
    if (state.phase === 'error') {
      stream.close();
      idle('Last collection stopped: ' + (state.error || 'unknown error'), '', true);
    } else if (state.phase === 'complete') {
      stream.close();
      if (collectionWarning) fetchProgress.classList.add('warning');
      title.textContent = 'Generating chart image…';
      total.textContent = '0 outstanding';
      detail.textContent = (collectionWarning ? collectionWarning + ' ' : 'CI data is ready. ') +
        'Rendering the chart image.';
    }
  });
  stream.onerror = () => {
    if (chartSettled) return;
    stream.close();
    idle('Progress connection closed; collection continues on the server.', '', true);
  };
  let chartSrc = '';
  fetch(${
      JSON.stringify(imageUrl)
    }, { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim());
    const src = URL.createObjectURL(await response.blob());
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(src);
      image.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error('The chart image could not be decoded.'));
      };
      image.src = src;
    });
  }).then((src) => {
    chartSettled = true;
    stream.close();
    chartSrc = src;
    chart.src = src;
    chart.style.display = 'block';
    idle('Chart includes ${runCount} successful run${
      runCount === 1 ? "" : "s"
    } for this commit.', collectionWarning);
  }).catch((error) => {
    chartSettled = true;
    stream.close();
    idle('Last collection stopped: ' + (error.message || 'failed to generate chart'), '', true);
  });
  window.addEventListener('pagehide', () => {
    stream.close();
    if (chartSrc) URL.revokeObjectURL(chartSrc);
  });
</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CI Gantt · ${
    escapeHtml(shortSha)
  }</title>
<style>
  body{margin:0;background:#0d0e11;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:18px 20px 26px;max-width:1400px;margin:0 auto}
  .top{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .top b{font-size:16px;font-weight:600}.top span{font-size:12px;color:#6f757f}
  a{color:#6ea8fe;text-decoration:none}.back{font-size:13px}.commit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  ${CI_FETCH_PROGRESS_STYLES}
  .imgwrap{background:#0c0d11;border:1px solid #23262d;border-radius:12px;padding:10px;overflow:auto;min-height:60px}
  #g{width:100%;height:auto;display:none}
  .empty{background:#16181d;border:1px solid #2f333c;border-radius:12px;padding:18px;color:#9aa0ab}
</style></head><body>
  <div class="top"><a class="back" href="/">← dashboard</a><b>CI Gantt</b><span>${
    escapeHtml(source.repo)
  } · <a class="commit" href="${
    escapeHtml(commitUrl)
  }" target="_blank" rel="noopener">${escapeHtml(shortSha)} ↗</a></span></div>
  ${
    ciFetchProgressPanel(undefined, {
      ariaLabel: "Commit CI Gantt fetch progress",
    })
  }
  ${chart}
  ${script}
</body></html>`;
}

function commitGanttUrl(url: URL): URL | null {
  const parameters = commitGanttParameters(url);
  if (!parameters) return null;
  const normalized = new URL(url);
  normalized.search = parameters.toString();
  return normalized;
}

const ganttRoutes: Route[] = [
  {
    path: "/ci-gantt",
    handler(_request, url) {
      return new Response(ciCommitGanttPage(url), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  {
    path: "/ci-gantt.png",
    handler(request, url) {
      const normalized = commitGanttUrl(url);
      return normalized
        ? renderGanttRoute(request, normalized, collectCommitCiGanttInput)
        : Promise.resolve(
          new Response("invalid commit Gantt selection", {
            status: 400,
            headers: { "cache-control": "no-store" },
          }),
        );
    },
  },
  {
    path: "/ci-gantt-progress",
    handler(request, url) {
      const normalized = commitGanttUrl(url);
      return normalized
        ? ciCommitGanttProgressResponse(request, normalized)
        : new Response("invalid commit Gantt selection", { status: 400 });
    },
  },
  {
    path: "/bench/gantt.png",
    handler: renderGanttRoute,
  },
  {
    path: "/bench/gantt-progress",
    handler: ciGanttProgressResponse,
  },
];

function makeCiDuration(
  opts: {
    id: string;
    label: string;
    repo: string;
    workflow: string;
    href: string;
    hint: string;
    routes?: Route[];
  },
): Tile {
  return {
    id: opts.id,
    intervalMs: 30_000,
    runSources: [runSource(opts.repo, opts.workflow)],
    routes: opts.routes,
    async collect(ctx): Promise<TileView> {
      let runs: Run[];
      try {
        runs = await ctx.runsFor(opts.repo, opts.workflow);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          label: opts.label,
          status: "unknown",
          value: "—",
          sub: friendlyError(message),
          href: opts.href,
          hint: opts.hint,
        };
      }
      // Only runs that passed end to end: a failed/cancelled/timed-out run's
      // wall-clock time isn't a representative CI duration.
      const passed = runs.filter((r) =>
        r.status === "completed" && r.conclusion === "success"
      );
      const durMins = (r: Run) =>
        (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60000;
      // Median window = the successful runs in the last DUR_MAX_AGE_HOURS, or the
      // most recent DUR_MIN_RUNS — whichever has more runs.
      const cutoff = Date.now() - DUR_MAX_AGE_HOURS * 3_600_000;
      const inTimeCount =
        passed.filter((r) => Date.parse(r.run_started_at) >= cutoff).length;
      const usingTime = inTimeCount >= DUR_MIN_RUNS; // time window wins when it has enough runs
      // A count-based prefix (not the filter set itself) so the median runs are
      // always the newest slice of passed — which is what the sparkline
      // highlights. passed is created-at ordered, so a re-run can otherwise
      // make the filter set non-contiguous with the front.
      const window = passed.slice(0, usingTime ? inTimeCount : DUR_MIN_RUNS);
      const durs = window.map(durMins).sort((a, b) => a - b);
      const medianMins = Math.round(median(durs));
      // The sparkline spans every successful run (oldest -> newest). window is
      // always the newest slice of passed, so the runs feeding the median are the
      // trailing window.length points — drawn brighter over the dimmer long-run
      // trend.
      const series = [...passed].reverse().map(durMins);
      // How long the sparkline spans (oldest to newest run), for the corner label.
      const times = passed.map((r) => Date.parse(r.run_started_at)).filter((
        t,
      ) => !Number.isNaN(t));
      const spanMs = times.length >= 2
        ? Math.max(...times) - Math.min(...times)
        : 0;
      const s: Status = window.length === 0
        ? "unknown"
        : medianMins <= DUR_GOOD
        ? "good"
        : medianMins <= DUR_WARN
        ? "warn"
        : "bad";
      return {
        label: opts.label,
        status: s,
        value: window.length === 0 ? "—" : `${medianMins}m`,
        sub: usingTime
          ? `median · ${window.length} passing runs in the last ${DUR_MAX_AGE_HOURS}h`
          : `median · last ${window.length} passing runs`,
        extra: sparkline(series, "#727882", {
          count: window.length,
          color: "#c7ccd4",
        }, SPARK_FADE[s]),
        duration: spanMs,
        href: opts.href,
        hint: opts.hint,
      };
    },
  };
}

// The middle of a sorted series. An even count has no single middle run, so it is
// the mean of the two: taking the upper one alone reports a duration no run had,
// and always the higher of the pair. The default window is 20 runs, so even is the
// normal case rather than the edge. Exported for unit testing.
export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length / 2;
  return sorted.length % 2
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const labsCiDuration = makeCiDuration({
  id: "ci-duration",
  label: "labs ci duration",
  repo: REPO,
  workflow: CI_WORKFLOW,
  href: "/bench?view=ci&repo=labs",
  hint: "history ↗",
  routes: ganttRoutes,
});
export const loomCiDuration = makeCiDuration({
  id: "loom-ci-duration",
  label: "loom ci duration",
  repo: LOOM_REPO,
  workflow: LOOM_CI_WORKFLOW,
  href: "/bench?view=ci&repo=loom",
  hint: "history ↗",
});
