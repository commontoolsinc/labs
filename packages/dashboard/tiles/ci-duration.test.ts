// ci-duration's drill-down: the /ci page and the /ci-gantt.png image behind it.
// The image handler shells out to scripts/ci-gantt.ts and writes a temp file,
// neither of which the test permissions allow, so the subprocess and the three
// filesystem calls around it are replaced with stubs that record what the
// handler asked for and hand back a canned result.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, Route, Run } from "../types.ts";
import { CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "../config.ts";
import { labsCiDuration, loomCiDuration, median } from "./ci-duration.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // enough to tell the bytes apart

function ctx(runs: Run[]): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: () => Promise.resolve(runs),
    env: () => undefined,
  };
}

function run(over: Partial<Run>): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "sha",
    display_title: "t",
    run_started_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: "t (#1)" },
    ...over,
  };
}

function route(path: string): Route {
  const r = labsCiDuration.routes?.find((x) => x.path === path);
  assert(r, `ci-duration should own a ${path} route`);
  return r;
}

interface Fake {
  success?: boolean; // what the ci-gantt run reports
  stderr?: string; // what it printed on the way out
  throws?: Error; // the spawn itself blowing up
}

interface Result {
  res: Response;
  args: string[]; // the argv the handler built for scripts/ci-gantt.ts
  logged: string; // everything the handler wrote to console.error
  leftover: string[]; // temp files still on disk once the handler returned
}

async function gantt(query: string, fake: Fake = {}): Promise<Result> {
  const origTemp = Deno.makeTempFile, origRead = Deno.readFile, origRemove = Deno.remove;
  const origCommand = Object.getOwnPropertyDescriptor(Deno, "Command")!;
  const origError = console.error;
  const live = new Set<string>();
  const logged: string[] = [];
  let args: string[] = [];
  let seq = 0;
  try {
    Deno.makeTempFile = (opts?: Deno.MakeTempOptions) => {
      const path = `/fake-tmp/${opts?.prefix ?? ""}${++seq}${opts?.suffix ?? ""}`;
      live.add(path);
      return Promise.resolve(path);
    };
    Deno.readFile = (path: string | URL) => live.has(String(path)) ? Promise.resolve(PNG) : Promise.reject(new Deno.errors.NotFound(String(path)));
    Deno.remove = (path: string | URL) => {
      live.delete(String(path));
      return Promise.resolve();
    };
    Object.defineProperty(Deno, "Command", {
      configurable: true,
      value: class {
        constructor(_cmd: string, opts: { args: string[] }) {
          args = opts.args;
        }
        output() {
          if (fake.throws) return Promise.reject(fake.throws);
          return Promise.resolve({
            success: fake.success ?? true,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(fake.stderr ?? ""),
          });
        }
      },
    });
    console.error = (...parts: unknown[]) => void logged.push(parts.map(String).join(" "));
    const url = new URL(`http://d/ci-gantt.png${query}`);
    const res = await route("/ci-gantt.png").handler(new Request(url), url);
    return { res, args, logged: logged.join("\n"), leftover: [...live] };
  } finally {
    Deno.makeTempFile = origTemp;
    Deno.readFile = origRead;
    Deno.remove = origRemove;
    Object.defineProperty(Deno, "Command", origCommand);
    console.error = origError;
  }
}

// The flag ci-gantt is given for a named option, or undefined when unset.
function opt(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

Deno.test("/ci serves the gantt page for the repo and workflow the tile charts", async () => {
  const url = new URL("http://d/ci");
  const res = await route("/ci").handler(new Request(url), url);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await res.text();
  assertStringIncludes(html, `${REPO} · ${CI_WORKFLOW}`);
  assertStringIncludes(html, `href="/"`); // a way back to the dashboard
  assertStringIncludes(html, "/ci-gantt.png?"); // the controls point at the image route
  // The runs slider offers only what the image route will honour, so dragging it
  // to either end can't ask for a limit that comes back silently clamped.
  assertStringIncludes(html, `id="limit" min="1" max="150"`);
  assertEquals((await gantt("?limit=150")).args.indexOf("150") >= 0, true);
});

Deno.test("loom ci duration links out to loom's run list and owns no drill-down route", async () => {
  assertEquals(loomCiDuration.routes, undefined);
  const v = await loomCiDuration.collect(ctx([run({})]));
  assertStringIncludes(v.href ?? "", `github.com/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}`);
  assertStringIncludes(v.href ?? "", "branch%3Amain"); // main only, matching what the tile measures
  assertEquals(v.hint, "runs ↗");
  // The labs tile is the one that drills into the local gantt view.
  assertEquals((await labsCiDuration.collect(ctx([run({})]))).href, "/ci");
});

Deno.test("/ci-gantt.png: a successful render returns the png bytes uncached", async () => {
  const { res, args, leftover } = await gantt("?limit=30");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/png");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(new Uint8Array(await res.arrayBuffer()), PNG);
  assertEquals(opt(args, "--repo"), REPO);
  assertEquals(opt(args, "--workflow"), CI_WORKFLOW);
  assertEquals(opt(args, "--limit"), "30");
  assert(args.includes("--allow-sys=cpus,networkInterfaces,hostname"));
  assertEquals(opt(args, "--out"), "/fake-tmp/ci-gantt-1.png"); // the bytes come from where it was told to write
  assertEquals(leftover, []); // the temp file is cleaned up on the way out
});

Deno.test("/ci-gantt.png: limit is clamped to the slider's range, junk falls back to 60", async () => {
  assertEquals(opt((await gantt("?limit=500")).args, "--limit"), "150");
  assertEquals(opt((await gantt("?limit=0")).args, "--limit"), "1");
  assertEquals(opt((await gantt("?limit=abc")).args, "--limit"), "60");
  assertEquals(opt((await gantt("")).args, "--limit"), "60");
});

Deno.test("/ci-gantt.png: the checkboxes are off unless set to 1", async () => {
  const off = (await gantt("?mainOnly=0&allConclusions=yes")).args;
  assert(!off.includes("--main-only"), "mainOnly=0 is not main-only");
  assert(!off.includes("--all-conclusions"));
  assert(!off.includes("--min-runs"), "without main-only, ci-gantt's own threshold stands");
  const on = (await gantt("?mainOnly=1&allConclusions=1")).args;
  assert(on.includes("--main-only"));
  assert(on.includes("--all-conclusions"));
});

Deno.test("/ci-gantt.png: main-only drops the min-runs floor to fit the window; a typed value wins", async () => {
  // A main-only window can be thin. The floor is capped at the run count so even a
  // one-run window still draws instead of having every job dropped.
  assertEquals(opt((await gantt("?mainOnly=1")).args, "--min-runs"), "2");
  assertEquals(opt((await gantt("?mainOnly=1&limit=1")).args, "--min-runs"), "1");
  // Anything the user typed is passed through, over the floor and without main-only.
  assertEquals(opt((await gantt("?mainOnly=1&minRuns=9")).args, "--min-runs"), "9");
  assertEquals(opt((await gantt("?minRuns=9")).args, "--min-runs"), "9");
  // Only digits count as typed; the rest leave the floor (or nothing) in place.
  assertEquals(opt((await gantt("?mainOnly=1&minRuns=-3")).args, "--min-runs"), "2");
  assertEquals(opt((await gantt("?minRuns=x")).args, "--min-runs"), undefined);
  assertEquals(opt((await gantt("?minRuns=")).args, "--min-runs"), undefined);
});

Deno.test("/ci-gantt.png: a failing ci-gantt is a 500, with its stderr in the server log only", async () => {
  const { res, logged, leftover } = await gantt("?limit=5", { success: false, stderr: "no runs matched --min-runs" });
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "ci-gantt failed (see server log)"); // the raw stderr stays server-side
  assertStringIncludes(logged, "no runs matched --min-runs");
  assertEquals(leftover, []);
});

Deno.test("/ci-gantt.png: a spawn that throws is a 500, not an unhandled rejection", async () => {
  const { res, logged, leftover } = await gantt("", { throws: new Error("deno: command not found") });
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "ci-gantt render error (see server log)");
  assertStringIncludes(logged, "deno: command not found");
  assertEquals(leftover, []); // the temp file is removed even on the error path
});

Deno.test("ci-duration: no passing runs is gray, never a false green", async () => {
  const v = await labsCiDuration.collect(ctx([run({ conclusion: "failure" }), run({ status: "in_progress", conclusion: null })]));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—"); // no data, like every other tile — not a zero-minute build
  assertEquals(v.duration, 0); // no span to label
  assertEquals(await labsCiDuration.collect(ctx([])).then((x) => x.status), "unknown");
});

Deno.test("ci-duration: the median minutes set the status against the thresholds", async () => {
  const mins = (m: number) =>
    run({
      run_started_at: new Date(Date.now() - m * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  assertEquals(await labsCiDuration.collect(ctx([mins(10)])).then((v) => [v.status, v.value]), ["good", "10m"]);
  assertEquals(await labsCiDuration.collect(ctx([mins(16)])).then((v) => [v.status, v.value]), ["warn", "16m"]);
  assertEquals(await labsCiDuration.collect(ctx([mins(45)])).then((v) => [v.status, v.value]), ["bad", "45m"]);
  // The median, not the mean: one long run among short ones doesn't move it.
  const v = await labsCiDuration.collect(ctx([mins(10), mins(10), mins(180)]));
  assertEquals([v.status, v.value], ["good", "10m"]);
  assertStringIncludes(v.sub ?? "", "last 3 passing runs"); // under the 20-run bar -> count window
});

Deno.test("ci-duration: an even window takes the mean of the two middle runs", () => {
  // The default window is 20 runs, so even is the normal case. Taking the upper
  // middle alone reports a duration no run had, and always the higher of the pair.
  assertEquals(median([2, 4, 6, 8]), 5);
  assertEquals(median([2, 4, 6, 10]), 5);
  assertEquals(median([1, 2, 3]), 2); // odd is the middle run itself
  assertEquals(median([7]), 7);
  assertEquals(median([]), 0);
  // The shape that made this matter: 20 runs where the two middle values differ.
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assertEquals(median(twenty), 10.5); // not 11
});
