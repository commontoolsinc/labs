/**
 * The pattern-index read path against a real deployment: the harness's own
 * client, signed with a real identity, searching and running a pattern that
 * was published to the index rather than written into the conversation.
 *
 * Gated on `CF_PATTERN_INDEX_LIVE_E2E=1` because it talks to a deployed
 * service. `CF_PATTERN_INDEX_LIVE_URL` names the deployment and defaults to
 * the standing one; `CF_PATTERN_INDEX_LIVE_IDENTITY` names the PKCS#8 keyfile
 * the index authorizes and has no default, so a run with the flag set and no
 * keyfile named fails rather than passing vacuously or signing with whatever
 * key happened to sit at a guessed path.
 *
 * A deployment and a keyfile it authorizes are not a continuous-integration
 * runner's to hold, so no job dispatches this file. `deno task
 * test:integration` loads it, a person runs that, and without the flag every
 * case is skipped. `deno task check` type-checks it whether or not anything
 * runs it.
 *
 * The pattern it runs is content-addressed, so `LIVE_PATTERN_ID` is the
 * identity of `DOUBLING_PATTERN_SOURCE` and nothing else. Publishing that
 * exact source again is a no-op on the index; changing the source here
 * without republishing makes the id name a different program.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  computeEntryIdentity,
  ensureCompilerStack,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import {
  createHarnessPatternIndexClientFactory,
  type PatternIndexClient,
} from "../src/pattern-index/client.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SearchPatternsToolOutput,
  SearchPatternsToolSuccessOutput,
} from "../src/tools/search-patterns.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const LIVE = Deno.env.get("CF_PATTERN_INDEX_LIVE_E2E") === "1";

const BASE_URL = Deno.env.get("CF_PATTERN_INDEX_LIVE_URL") ??
  "https://us-central1-pattern-index.cloudfunctions.net";

/**
 * The keyfile the index authorizes. No default: which identity a deployment
 * admits is a fact about that deployment, and a guessed path either does not
 * exist or is somebody's key that this test had no business signing with.
 */
const identityPath = (): string => {
  const path = Deno.env.get("CF_PATTERN_INDEX_LIVE_IDENTITY");
  if (path === undefined || path.trim() === "") {
    throw new Error(
      "CF_PATTERN_INDEX_LIVE_IDENTITY must name the PKCS#8 keyfile the pattern index authorizes",
    );
  }
  return path;
};

/** The tag the published pattern carries, and the one the search asks for. */
const LIVE_TAG = "e2e";

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "",
  "interface Input {",
  "  n: number;",
  "}",
  "",
  "interface Output {",
  "  doubled: number;",
  "}",
  "",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const LIVE_PATTERN_MAIN = "/main.tsx";

const LIVE_PATTERN_ID = "9lNyUbKGSncsQtxH_JsSjaClFBEtE4Oz_oY4tWk5tpI";

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

/**
 * A source composing the published doubler by its id, the way a model does it:
 * the specifier `search_patterns` reports, and nothing else. `marker` makes the
 * bytes unique to one run, so the identity it publishes under is new.
 */
const quadruplingPatternSource = (marker: string): string =>
  [
    "import { computed, pattern } from 'commonfabric';",
    `import doubler from "cf:pattern:${LIVE_PATTERN_ID}";`,
    `// ${marker}`,
    "",
    "interface Input {",
    "  n: number;",
    "}",
    "",
    "interface Output {",
    "  half: { doubled: number };",
    "  quadrupled: number;",
    "}",
    "",
    "export default pattern<Input, Output>(({ n }) => ({",
    "  half: doubler({ n }),",
    "  quadrupled: computed(() => n * 4),",
    "}));",
    "",
  ].join("\n");

const QUADRUPLED_RESULT_SCHEMA = {
  type: "object",
  properties: {
    half: {
      type: "object",
      properties: { doubled: { type: "number" } },
      required: ["doubled"],
    },
    quadrupled: { type: "number" },
  },
  required: ["half", "quadrupled"],
} as const;

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

/**
 * Wraps the live fetch so a test can await the event calls `run_pattern`
 * makes. Those calls are deliberately fire-and-forget — a run does not wait
 * on its own ranking signal — so the only honest way to observe one having
 * landed is to watch the call itself finish. `settled(fn, count)` resolves
 * when the `count`-th call to `fn` has answered, which is an event and not a
 * poll.
 */
interface FetchWatcher {
  fetchFn: HarnessFetch;
  settled(fn: string, count: number): Promise<void>;
}

const watchFetch = (): FetchWatcher => {
  const done: Record<string, number> = {};
  const waiters: {
    fn: string;
    count: number;
    resolve: () => void;
  }[] = [];
  const announce = (fn: string) => {
    done[fn] = (done[fn] ?? 0) + 1;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.fn === fn && done[fn] >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  };
  return {
    fetchFn: async (input, init) => {
      const fn = String(input instanceof Request ? input.url : input)
        .split("/").pop() ?? "";
      try {
        return await fetch(input as Request | URL | string, init);
      } finally {
        announce(fn);
      }
    },
    settled(fn, count) {
      if ((done[fn] ?? 0) >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ fn, count, resolve });
      });
    },
  };
};

describe("pattern index, live", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let watcher: FetchWatcher;
  let client: PatternIndexClient;

  beforeEach(async () => {
    if (!LIVE) return;
    const signer = await Identity.fromPassphrase(
      `cf-harness pattern index live ${crypto.randomUUID()}`,
    );
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `pattern-index-live-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    watcher = watchFetch();
    client = await createHarnessPatternIndexClientFactory(
      { baseUrl: BASE_URL },
      identityPath(),
      watcher.fetchFn,
    )();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const createEngine = (): CfHarnessEngine =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `pattern-index-live-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      patternIndexClientFactory: () => Promise.resolve(client),
    });

  it({
    name: "addresses the published pattern by the identity of its source",
    ignore: !LIVE,
    async fn() {
      await ensureCompilerStack();
      expect(
        computeEntryIdentity(LIVE_PATTERN_MAIN, [{
          name: LIVE_PATTERN_MAIN,
          contents: DOUBLING_PATTERN_SOURCE,
        }]),
      ).toBe(LIVE_PATTERN_ID);
      const pattern = await client.getPattern({
        patternId: LIVE_PATTERN_ID,
        includeSource: true,
      });
      expect(pattern.patternId).toBe(LIVE_PATTERN_ID);
      expect(pattern.program?.main).toBe(LIVE_PATTERN_MAIN);
      expect(pattern.program?.files[0].contents).toBe(DOUBLING_PATTERN_SOURCE);
    },
  });

  it({
    name: "finds the published pattern by its tag and reports its shapes",
    ignore: !LIVE,
    async fn() {
      const response = await client.searchPatterns({ tags: [LIVE_TAG] });
      expect(response.results.map((hit) => hit.patternId)).toContain(
        LIVE_PATTERN_ID,
      );

      const engine = createEngine();
      const output = await engine.invokeBuiltinTool("search_patterns", {
        tags: [LIVE_TAG],
      });
      const searchOutput = output.output as SearchPatternsToolOutput;
      expect(searchOutput.status).toBe("ok");
      const results = (searchOutput as SearchPatternsToolSuccessOutput).results;
      const hit = results.find((r) => r.patternId === LIVE_PATTERN_ID);
      expect(hit).toMatchObject({
        importHint: `import X from "cf:pattern:${LIVE_PATTERN_ID}"`,
        argumentType: "{\n  n: number\n}",
        resultType: "{\n  doubled: number\n}",
      });
      expect(JSON.stringify(output.output)).not.toContain(
        "export default pattern",
      );
    },
  });

  it({
    name: "runs the published pattern without its source reaching the model",
    ignore: !LIVE,
    async fn() {
      const before = await client.searchPatterns({ tags: [LIVE_TAG] });
      const usesBefore = before.results
        .find((hit) => hit.patternId === LIVE_PATTERN_ID)
        ?.signals?.uses ?? 0;

      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        patternId: LIVE_PATTERN_ID,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.resultRef).toContain("of:");
      expect((output.value as { doubled: number }).doubled).toBe(42);

      const rendered = JSON.stringify(result.output);
      expect(rendered).not.toContain("export default pattern");
      expect(rendered).not.toContain("computed(() => n * 2)");
      expect(rendered).not.toContain("interface Input");

      // Both the instantiation and the outcome are reported, so the index
      // ranks on what the run actually did.
      await watcher.settled("recordEvent", 2);
      const after = await client.searchPatterns({ tags: [LIVE_TAG] });
      const usesAfter = after.results
        .find((hit) => hit.patternId === LIVE_PATTERN_ID)
        ?.signals?.uses ?? 0;
      expect(usesAfter).toBeGreaterThan(usesBefore);
    },
  });

  it({
    name: "publishes the source it ran and reads it back under that identity",
    ignore: !LIVE,
    async fn() {
      // Source unique to this run, so the publication creates an entry rather
      // than meeting one the index already holds. It is still content
      // addressed, so the identity the run publishes under is a fact about
      // these bytes and is asserted as one.
      const marker = crypto.randomUUID().replaceAll("-", "");
      const source = DOUBLING_PATTERN_SOURCE.replace(
        "n * 2",
        `n * 2 /* ${marker} */`,
      );
      await ensureCompilerStack();
      const expectedId = computeEntryIdentity(LIVE_PATTERN_MAIN, [{
        name: LIVE_PATTERN_MAIN,
        contents: source,
      }]);

      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        sourceText: source,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
        description: `Doubles a number (${marker})`,
        hashtags: [LIVE_TAG],
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);

      // The publication and the created event that follows it are both
      // fire-and-forget, so the test waits on the calls answering.
      await watcher.settled("publishPattern", 1);
      await watcher.settled("recordEvent", 1);

      const published = await client.getPattern({
        patternId: expectedId,
        includeSource: true,
      });
      expect(published.description).toBe(`Doubles a number (${marker})`);
      expect(published.hashtags).toContain(LIVE_TAG);
      expect(published.program?.files[0].contents).toBe(source);
    },
  });

  it({
    name: "composes the published pattern into a source it compiles and runs",
    ignore: !LIVE,
    async fn() {
      const marker = crypto.randomUUID().replaceAll("-", "");
      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        sourceText: quadruplingPatternSource(marker),
        inputs: { n: 3 },
        resultSchema: QUADRUPLED_RESULT_SCHEMA,
        description: `Quadruples a number (${marker})`,
        hashtags: [LIVE_TAG],
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ half: { doubled: 6 }, quadrupled: 12 });

      // The imported pattern was fetched, compiled into the space, and run,
      // and none of it came back out.
      const rendered = JSON.stringify(result.output);
      expect(rendered).not.toContain("computed(() => n * 2)");
      expect(rendered).not.toContain("interface Input");

      await watcher.settled("publishPattern", 1);
      const search = await client.searchPatterns({
        tags: [LIVE_TAG],
        text: marker,
      });
      const hit = search.results.find((entry) =>
        entry.description.includes(marker)
      );
      expect(hit?.patternId).not.toBe(LIVE_PATTERN_ID);
      expect(hit?.dependencies).toContain(LIVE_PATTERN_ID);
    },
  });
});
