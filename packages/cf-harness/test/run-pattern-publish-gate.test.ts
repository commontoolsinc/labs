import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness publish gate");

/**
 * The sortable table that is live in the pattern index, byte for byte as
 * `getPattern` answers for entry `HOS6wWQmBMK8ewPc239FZc4VS6jMpCKGLMt4rFPTr2k`.
 *
 * It published clean, it ranks first for its own query, a later session
 * composed it, and every data cell it renders reads `[object Object]`:
 * `row[column]` indexes a reactive row by a reactive key, which yields a
 * proxy, and `String(proxy)` is the default `toString`. Its data result was
 * genuinely correct, so nothing on the publish path could tell.
 */
const LIVE_BROKEN_SORTABLE_TABLE =
  `import { pattern, Writable, computed } from "commonfabric";

type Row = Record<string, unknown>;
type Input = { rows?: Row[]; columns?: string[] };

export default pattern<Input, object>(({ rows = [], columns = [] }) => {
  const sortColumn = new Writable<string | null>(null);
  const ascending = new Writable(true);
  const sortedRows = computed(() => {
    const column = sortColumn.get();
    const direction = ascending.get() ? 1 : -1;
    if (!column) return rows;
    return [...rows].sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? ""), undefined, { numeric: true }) * direction);
  });
  return {
    $NAME: "Sortable Table",
    rows: sortedRows,
    columns,
    sortColumn,
    ascending,
    $UI: <table>
      <thead><tr>{columns.map((column) => <th><button onClick={() => {
        if (sortColumn.get() === column) ascending.set(!ascending.get());
        else { sortColumn.set(column); ascending.set(true); }
      }}>{column} {sortColumn.get() === column ? (ascending.get() ? "▲" : "▼") : ""}</button></th>)}</tr></thead>
      <tbody>{sortedRows.map((row) => <tr>{columns.map((column) => <td>{String(row[column] ?? "")}</td>)}</tr>)}</tbody>
    </table>,
  };
});
`;

/** The same table with the cell read done properly, as a fix would write it. */
const WORKING_SORTABLE_TABLE =
  `import { pattern, computed } from "commonfabric";

type Row = { name: string; score: number };
type Input = { rows?: Row[] };

export default pattern<Input, object>(({ rows = [] }) => ({
  $NAME: "Sortable Table",
  rows,
  $UI: <table>
    <thead><tr><th>Name</th><th>Score</th></tr></thead>
    <tbody>{rows.map((row) => <tr><td>{row.name}</td><td>{row.score}</td></tr>)}</tbody>
  </table>,
}));
`;

/**
 * A pattern that declares its result type, as every self-describing component
 * in `packages/patterns` does — `pattern<Io, Io>` rather than `pattern<In,
 * object>`.
 *
 * This is the shape that caught the gate skipping its own check. A declared
 * result type does not name `$UI`, and an unschema'd read of the result cell
 * returns only the declared fields, so the `$UI` is invisible to it. The gate
 * read the raw result, saw no `$UI`, and recorded `no-ui` — "nothing to
 * check" — on a pattern with a perfectly good one. It went the wrong way on
 * the patterns most worth checking: the better the pattern declares itself,
 * the more certainly the check was skipped. Reading through `uiSchema` asks
 * for `$UI` by name, which is what `piece-render.ts` has always done.
 */
const DECLARED_RESULT_UI =
  `import { pattern, UI, Writable } from "commonfabric";

interface Io { rating: Writable<number> }

export default pattern<Io, Io>(({ rating }) => ({
  rating,
  [UI]: <div><span>rated</span></div>,
}));
`;

/** A pure computation. Nothing to render, and nothing the gate applies to. */
const DOUBLER = `import { computed, pattern } from "commonfabric";
interface Input { n: number; }
interface Output { doubled: number; }
export default pattern<Input, Output>(({ n }) => ({
  doubled: computed(() => n * 2),
}));
`;

/** Declares a `$UI` and renders nothing at all under any input. */
const EMPTY_UI = `import { pattern } from "commonfabric";
export default pattern<Record<string, never>, object>(() => ({
  $UI: <></>,
}));
`;

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: { fn: string; body: Record<string, unknown> }[];
}

/** An index that accepts every publication and records every event. */
const stubIndex = (): IndexStub => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    if (fn === "publishPattern") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ patternId: body.patternId, created: true }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  };
  return { fetchFn, calls };
};

describe("run_pattern publish render gate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `publish-gate-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const createEngine = (index: IndexStub): CfHarnessEngine =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    });

  /**
   * Runs `sourceText` and then sends what the session staged, which is what
   * the prompt loop does when a session ends.
   */
  const runAndFlush = async (
    index: IndexStub,
    input: Record<string, unknown>,
  ): Promise<RunPatternToolSuccessOutput> => {
    const engine = createEngine(index);
    const result = await engine.invokeBuiltinTool("run_pattern", input);
    await engine.flushPatternIndexPublications();
    return result.output as RunPatternToolSuccessOutput;
  };

  const published = (index: IndexStub) =>
    index.calls.filter((call) => call.fn === "publishPattern");

  it("has no publication ledger when the run has no index", async () => {
    // The engine hands the ledger over with the index client, so a run
    // without a client has neither — and `run_pattern` then records nothing
    // rather than reaching for a second publish path.
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
    expect(engine.patternIndexPublications).toBeUndefined();
    await engine.flushPatternIndexPublications();

    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.patternPublication).toBeUndefined();
  });

  it("reports the run's outcome even when the index refuses the event", async () => {
    // Usage events are a contribution to a shared catalog, not part of the
    // tool's result: a rejected one is logged and the run stands.
    const calls: { fn: string }[] = [];
    const failingFetch: HarnessFetch = (input) => {
      const fn = String(input).split("/").pop() ?? "";
      calls.push({ fn });
      return Promise.resolve(
        new Response(JSON.stringify({ error: "index is down" }), {
          status: 500,
        }),
      );
    };
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: failingFetch,
            signer,
          }),
        ),
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    await engine.flushPatternIndexPublications();
    expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
    expect(calls.some((call) => call.fn === "publishPattern")).toBe(true);
  });

  it("keeps the sortable table that is live in the index out of search", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
      hashtags: ["table", "sort"],
    });

    expect(output.patternPublication?.status).toBe("recorded");
    expect(output.patternPublication?.reason).toBe("ui-default-tostring");
    // Recorded in full: `getPattern` answers for it and a `cf:pattern:`
    // import resolves it. Only search is denied it.
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
    // The index refuses a hidden entry with no reason, and a person reading
    // it later needs to know what was found rather than only that it was hid.
    expect(published(index)[0].body.discoverabilityReason).toContain(
      "[object Object]",
    );
    expect(published(index)[0].body.program).toEqual({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LIVE_BROKEN_SORTABLE_TABLE }],
    });
  });

  it("lets the run that authored it succeed anyway", async () => {
    // A publication has never been allowed to bear on the run that made it,
    // and a gate verdict must not start.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
    });
    expect(output.status).toBe("ok");
    expect(output.resultRef).toBeDefined();
    expect(output.pieceId).toBeDefined();
  });

  it("keeps the rendered output in the artifact and out of what the model reads", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: LIVE_BROKEN_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }], columns: ["name"] },
      description: "Reusable sortable table component",
    });
    // The DOM the probe produced, which is what a browser showed for this
    // very pattern. `rawCauseMessage` is the field the prompt loop strips
    // from the model-facing rendering; the artifact keeps it.
    expect(output.rawCauseMessage).toContain("<td>[object Object]</td>");
    // Nothing the model reads carries any of it.
    const modelFacing = JSON.stringify(output.patternPublication);
    expect(modelFacing).not.toContain("<td");
    expect(modelFacing).not.toContain("alpha");
  });

  it("offers a table that renders its cells to search", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
      hashtags: ["table"],
    });

    expect(output.patternPublication?.status).toBe("discoverable");
    expect(output.patternPublication?.reason).toBe("ui-rendered");
    expect(published(index)).toHaveLength(1);
    // Absent rather than `true`: a caller that does not set it produces the
    // request every caller produced before the gate existed.
    expect(published(index)[0].body.discoverable).toBeUndefined();
    // A pass keeps no DOM. There is no verdict to adjudicate, and the run
    // artifact is readable through `bash` (CT-2117), so a passing run writes
    // nothing there that it does not need.
    expect(output.rawCauseMessage).toBeUndefined();
  });

  it("finds the $UI of a pattern that declares its result type", async () => {
    // Reading the raw result returns only the declared fields, so this
    // reported `no-ui` — a skipped check dressed as a clean run — for 20 of
    // the 24 seed components. Left as a raw read, this test fails.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: DECLARED_RESULT_UI,
      inputs: {},
      description: "Renders a rating",
    });

    expect(output.patternPublication?.reason).toBe("ui-rendered");
    expect(output.patternPublication?.status).toBe("discoverable");
    expect(output.rawCauseMessage).toBeUndefined();
  });

  it("offers a pure computation, which has no $UI to check", async () => {
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });

    expect(output.patternPublication?.status).toBe("discoverable");
    expect(output.patternPublication?.reason).toBe("no-ui");
    expect(output.patternPublication?.syntheticInputsComplete).toBe(true);
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBeUndefined();
  });

  it("records a $UI that rendered no text without condemning it", async () => {
    // An absence of text is what an empty-state list looks like and what a
    // UI built from images looks like, so it is not read as a defect — but
    // it is not read as a pass either.
    const index = stubIndex();
    const output = await runAndFlush(index, {
      sourceText: EMPTY_UI,
      inputs: {},
      description: "Renders nothing",
    });

    expect(output.patternPublication?.status).toBe("recorded");
    expect(output.patternPublication?.reason).toBe("ui-rendered-empty");
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
  });

  it("publishes nothing and reports cancelled when the run aborts during the gate", async () => {
    // An index entry is a claim about a run that finished. The abort is fired
    // from inside the second `runPersistent` — the probe's — so the gate is
    // interrupted at a determined point rather than after a wait.
    const index = stubIndex();
    const controller = new AbortController();
    let instantiations = 0;
    const abortingPieces = new Proxy(pieces, {
      get(target, property) {
        if (property === "runPersistent") {
          return (...args: unknown[]) => {
            if (++instantiations === 2) controller.abort();
            return (target.runPersistent as (
              ...a: unknown[]
            ) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PiecesController;
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces: abortingPieces }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    });
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    }, { signal: controller.signal });
    await engine.flushPatternIndexPublications();

    const output = result.output as unknown as {
      status: string;
      message: string;
    };
    expect(output.status).toBe("cancelled");
    // The piece the run created is not undone, and the output says so.
    expect(output.message).toContain("not undone");
    expect(published(index)).toEqual([]);
  });

  /**
   * The session's pieces controller with `runPersistent` intercepted on the
   * PROBE — its second call — so a test can decide what happens at the joint
   * the gate runs through, without waiting on a clock.
   */
  const piecesWithProbe = (
    onProbe: (probe: () => Promise<unknown>) => Promise<unknown>,
  ): PiecesController => {
    let calls = 0;
    return new Proxy(pieces, {
      get(target, property) {
        if (property === "runPersistent") {
          return (...args: unknown[]) => {
            const run = () =>
              (target.runPersistent as (...a: unknown[]) => Promise<unknown>)
                .apply(target, args);
            return ++calls === 2 ? onProbe(run) : run();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PiecesController;
  };

  const engineWith = (index: IndexStub, own: PiecesController) =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `publish-gate-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces: own }),
      patternIndexClientFactory: () =>
        Promise.resolve(
          new PatternIndexClient({
            baseUrl: "https://index.test",
            fetchFn: index.fetchFn,
            signer,
          }),
        ),
    });

  const cancelledRun = async (
    index: IndexStub,
    own: PiecesController,
    signal: AbortSignal,
  ) => {
    const engine = engineWith(index, own);
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    }, { signal });
    await engine.flushPatternIndexPublications();
    return result.output as unknown as { status: string; message: string };
  };

  it("publishes nothing when the abort lands after the probe's result loads", async () => {
    // The joint between the settle race and the render race. An abort here
    // does not throw and is not raced, so it is checked for explicitly.
    const index = stubIndex();
    const controller = new AbortController();
    const output = await cancelledRun(
      index,
      piecesWithProbe(async (run) => {
        const cell = await run();
        controller.abort();
        return cell;
      }),
      controller.signal,
    );
    expect(output.status).toBe("cancelled");
    expect(published(index)).toEqual([]);
  });

  it("publishes nothing when the probe fails to start under an abort", async () => {
    // An abort inside an await the gate does not race arrives as an ordinary
    // throw. Reading it as "no verdict" would record an entry for a run that
    // was cancelled.
    const index = stubIndex();
    const controller = new AbortController();
    const output = await cancelledRun(
      index,
      piecesWithProbe(() => {
        controller.abort();
        return Promise.reject(new Error("probe start interrupted"));
      }),
      controller.signal,
    );
    expect(output.status).toBe("cancelled");
    expect(published(index)).toEqual([]);
  });

  it("records without a verdict when the probe throws for its own reasons", async () => {
    // No abort: the throw is the pattern's or the gate's, and either way it
    // is no evidence about the rendering. The text is kept for the artifact.
    const index = stubIndex();
    const engine = engineWith(
      index,
      piecesWithProbe(() =>
        Promise.reject(new Error("probeExplodedForItsOwnReasons"))
      ),
    );
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    await engine.flushPatternIndexPublications();
    const output = result.output as RunPatternToolSuccessOutput;

    expect(output.status).toBe("ok");
    expect(output.patternPublication?.status).toBe("recorded");
    expect(output.patternPublication?.reason).toBe("probe-failed");
    // Artifact-only, and not in what the model reads.
    expect(output.rawCauseMessage).toContain("probeExplodedForItsOwnReasons");
    expect(JSON.stringify(output.patternPublication)).not.toContain(
      "probeExplodedForItsOwnReasons",
    );
    expect(published(index)).toHaveLength(1);
    expect(published(index)[0].body.discoverable).toBe(false);
  });

  it("offers only the last iteration of a capability a session authored", async () => {
    // The duplicate flood, fixed where it is made: a pattern-author that
    // iterates leaves one search result and a record of every attempt.
    const index = stubIndex();
    const engine = createEngine(index);
    for (const label of ["Name", "Player"]) {
      await engine.invokeBuiltinTool("run_pattern", {
        sourceText: WORKING_SORTABLE_TABLE.replace("Name", label),
        inputs: { rows: [{ name: "Avery", score: 12 }] },
        description: "Sortable table that reads its cells",
        hashtags: ["table"],
      });
    }
    await engine.flushPatternIndexPublications();

    const calls = published(index);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.discoverable).toBe(false);
    expect(calls[0].body.discoverabilityReason).toContain("superseded");
    expect(calls[1].body.discoverable).toBeUndefined();
    expect(calls[1].body.discoverabilityReason).toBeUndefined();
    // Distinct entries: each iteration is its own content identity, and both
    // are recorded.
    expect(calls[0].body.patternId).not.toBe(calls[1].body.patternId);
  });

  it("offers both of two capabilities one session authored", async () => {
    const index = stubIndex();
    const engine = createEngine(index);
    await engine.invokeBuiltinTool("run_pattern", {
      sourceText: WORKING_SORTABLE_TABLE,
      inputs: { rows: [{ name: "Avery", score: 12 }] },
      description: "Sortable table that reads its cells",
    });
    await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLER,
      inputs: { n: 21 },
      description: "Doubles a number",
    });
    await engine.flushPatternIndexPublications();

    const calls = published(index);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.body.discoverable)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
