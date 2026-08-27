import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  getPatternIdentityRef,
  getPatternSource,
  getPieceSourceSnapshot,
  Runtime,
  type RuntimeProgram,
  setPatternSource,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  readPieceSourceRevision,
  readPieceSourceState,
} from "../src/ops/piece-origin.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece source lifecycle");

function versionProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ seed?: string }>(() => ({",
        "  [NAME]: 'Source lifecycle',",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

// A pattern that reads a data file, with the file attached and classified as
// data. What the source state and a revision say about it is what a writer
// built on either would need to put the package back the way it came.
function dataFileProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "import { dataFile, NAME, pattern } from 'commonfabric';",
          "export default pattern(() => ({",
          "  [NAME]: 'Reads a data file',",
          "  cities: JSON.parse(dataFile('/data/cities.json')).cities,",
          "}));",
          "",
        ].join("\n"),
      },
      { name: "/data/cities.json", contents: '{ "cities": ["Oslo"] }\n' },
    ],
    dataFiles: ["/data/cities.json"],
  };
}

function incompatibleProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ required: number }>(({ required }) => ({",
        "  required: required ?? 0,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function incompatibleSeedProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ seed?: number }>(() => ({",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function optionalModeProgram(version: 1 | 2): RuntimeProgram {
  const input = version === 1
    ? "interface Input { value: number; }"
    : "interface Input { value: number; mode?: number; }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        input,
        "export default pattern<Input>(({ value }) => ({ value }));",
        "",
      ].join("\n"),
    }],
  };
}

function incompatibleOptionalModeProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Input { value: number; mode?: number; }",
        "export default pattern<Input, { value: string }>(() => ({",
        "  value: 'changed',",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

function unionValueProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Output { value: number | string; }",
        "export default pattern<{}, Output>(() => ({ value: 1 }));",
        "",
      ].join("\n"),
    }],
  };
}

function installFetchStub(
  sources: Record<string, RuntimeProgram>,
  onFetch: () => void = () => {},
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    onFetch();
    const program = sources[url.pathname];
    if (program === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const entry = program.files.find((file) => file.name === program.main);
    return Promise.resolve(
      new Response(entry?.contents ?? "not found", {
        status: entry === undefined ? 404 : 200,
        headers: { "content-type": "text/typescript-jsx" },
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("piece source lifecycle", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let webSources: Record<string, RuntimeProgram>;
  let webFetches: number;
  let restoreFetch: () => void;

  beforeEach(async () => {
    webSources = {};
    webFetches = 0;
    restoreFetch = installFetchStub(webSources, () => webFetches++);
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `piece-source-lifecycle-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    restoreFetch();
  });

  async function stampOrigin(
    piece: Awaited<ReturnType<PiecesController["create"]>>,
    origin: string,
  ): Promise<void> {
    const { error } = await runtime.editWithRetry((tx) => {
      setPatternSource(piece.getCell(), tx, origin);
    });
    if (error !== undefined) throw error;
  }

  it("preloads source verification before creating a piece", async () => {
    const worker = new Worker(
      new URL(
        "./fixtures/piece-source-compiler-preload.ts",
        import.meta.url,
      ).href,
      { type: "module" },
    );
    const result = await new Promise<{
      history?: string[];
      error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) =>
        reject(event.error ?? new Error(event.message));
    }).finally(() => worker.terminate());

    expect(result.error).toBeUndefined();
    expect(result.history).toEqual(["create"]);
  });

  it("preloads source verification before an unavailable-baseline transition", async () => {
    const worker = new Worker(
      new URL(
        "./fixtures/piece-source-transition-compiler-preload.ts",
        import.meta.url,
      ).href,
      { type: "module" },
    );
    const result = await new Promise<{
      baseline?: string;
      history?: string[];
      error?: string;
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) =>
        reject(event.error ?? new Error(event.message));
    }).finally(() => worker.terminate());

    expect(result.error).toBeUndefined();
    expect(result.baseline).toBe("unavailable");
    expect(result.history).toEqual(["repoint"]);
  });

  it("keeps a directly-created same-host piece detached", async () => {
    runtime.experimental.systemPatternAutoUpdate = true;
    const path = "/api/patterns/system/manual-piece.tsx";
    const program = {
      ...versionProgram("local"),
      main: path,
      files: [{
        ...versionProgram("local").files[0],
        name: path,
      }],
    };
    webSources[path] = versionProgram("remote");

    const piece = await pieces.create(program, { input: {} });
    await runtime.patternUpdater.idle();

    expect(webFetches).toBe(0);
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    const sourceState = await readPieceSourceState(runtime, piece.getCell());
    expect(sourceState.history.map((revision) => revision.operation)).toEqual([
      "create",
    ]);
    const revisionSource = await readPieceSourceRevision(
      runtime,
      piece.getCell(),
      sourceState.history[0].revisionId,
    );
    expect(revisionSource.files).toEqual(program.files);
    await expect(
      readPieceSourceRevision(runtime, piece.getCell(), "missing-revision"),
    ).rejects.toThrow("source revision missing-revision was not found");
    expect(await piece.result.get(["version"])).toBe("local");
  });

  it("says which of a piece's source files carry data", async () => {
    const program = dataFileProgram();
    const piece = await pieces.create(program, { input: {} });
    const sourceState = await readPieceSourceState(runtime, piece.getCell());
    expect(sourceState.files.map((file) => file.name).sort()).toEqual([
      "/data/cities.json",
      "/main.tsx",
    ]);
    // Without this the two entries are indistinguishable, and rebuilding the
    // package from them compiles the JSON as TypeScript.
    expect(sourceState.dataFiles).toEqual(["/data/cities.json"]);
    const revisionSource = await readPieceSourceRevision(
      runtime,
      piece.getCell(),
      sourceState.history[0].revisionId,
    );
    expect(revisionSource.dataFiles).toEqual(["/data/cities.json"]);
  });

  it("rejects malformed actions and actions that do not apply", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const state = await readPieceSourceState(runtime, piece.getCell());

    await expect(
      piece.changeSource(null as never),
    ).rejects.toThrow("unsupported piece source action");
    await expect(
      piece.changeSource({ kind: "unsupported" } as never),
    ).rejects.toThrow("unsupported piece source action");
    await expect(
      piece.changeSource({ kind: "detach" }),
    ).rejects.toThrow("piece is not following a source");
    await expect(
      piece.changeSource({ kind: "restore", revisionId: "missing" }),
    ).rejects.toThrow("source revision missing does not exist");
    await expect(
      piece.changeSource({
        kind: "follow",
        revisionId: state.history[0].revisionId,
      }),
    ).rejects.toThrow("has no origin to follow");
  });

  it("rejects a source action if its pattern identity disappears while loading", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const cell = piece.getCell();
    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let cleared = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const pattern = await loadPattern(identity, symbol, space);
      if (!cleared) {
        cleared = true;
        const tx = runtime.edit();
        cell.withTx(tx).setMetaRaw("patternIdentity", undefined);
        await tx.commit();
      }
      return pattern;
    };

    try {
      await expect(
        piece.changeSource({ kind: "detach" }),
      ).rejects.toThrow("piece missing source state");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("rejects an edit if its pattern identity disappears while loading", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const cell = piece.getCell();
    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let cleared = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const pattern = await loadPattern(identity, symbol, space);
      if (!cleared) {
        cleared = true;
        const tx = runtime.edit();
        cell.withTx(tx).setMetaRaw("patternIdentity", undefined);
        await tx.commit();
      }
      return pattern;
    };

    try {
      await expect(
        piece.setPattern(versionProgram("candidate")),
      ).rejects.toThrow("piece missing source state");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("does not accept compatibility confirmation for detach", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, "https://source.test/current.tsx");
    const expected = getPieceSourceSnapshot(piece.getCell())!;
    const action = { kind: "detach" } as const;

    await expect(
      piece.changeSource(action, {
        confirmedChange: {
          action,
          expected,
          candidate: expected.pattern,
          origin: null,
          operation: "detach",
          baseline: { kind: "retain", revisionId: "unused" },
          review: { argumentEvidence: "unused", issues: {} },
        },
      }),
    ).rejects.toThrow("detach does not use compatibility confirmation");
  });

  it("surfaces a detach transaction failure without changing source state", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const origin = "https://source.test/current.tsx";
    await stampOrigin(piece, origin);
    const editWithRetry = runtime.editWithRetry;
    runtime.editWithRetry = (() =>
      Promise.resolve({
        ok: false,
        error: "source commit rejected",
      })) as unknown as typeof runtime.editWithRetry;

    let reason: unknown;
    try {
      await piece.changeSource({ kind: "detach" });
    } catch (error) {
      reason = error;
    } finally {
      runtime.editWithRetry = editWithRetry;
    }

    expect(reason).toBe("source commit rejected");
    expect(getPatternSource(piece.getCell())).toBe(origin);
  });

  it("preserves the commit error when source history becomes unreadable", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, "https://source.test/current.tsx");
    const cell = piece.getCell();
    const editWithRetry = runtime.editWithRetry;
    runtime.editWithRetry = (async () => {
      const tx = runtime.edit();
      cell.withTx(tx).setMetaRaw("pieceSourceHistory", "invalid");
      await tx.commit();
      return {
        ok: false,
        error: new Error("source commit rejected"),
      };
    }) as unknown as typeof runtime.editWithRetry;

    try {
      await expect(
        piece.changeSource({ kind: "detach" }),
      ).rejects.toThrow("source commit rejected");
    } finally {
      runtime.editWithRetry = editWithRetry;
    }
  });

  it("rejects an edit when recorded source is unavailable", async () => {
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    const before = await readPieceSourceState(runtime, piece.getCell());
    const originalLookup = runtime.patternManager
      .getPatternSourceProgramByIdentity;
    runtime.patternManager.getPatternSourceProgramByIdentity = () =>
      Promise.resolve(undefined);

    try {
      await expect(piece.setPattern(versionProgram("candidate"))).rejects
        .toThrow("the piece's current source is not available");
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLookup;
    }

    const after = await readPieceSourceState(runtime, piece.getCell());
    expect(after.pattern).toEqual(before.pattern);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.history).toEqual(before.history);
    expect(await piece.result.get(["version"])).toBe("current");
  });

  it("rejects a different pattern at an existing creation identity", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const secondPattern = await runtime.patternManager.compilePattern(
      versionProgram("second"),
      { space: pieces.getSpace() },
    );
    const cause = "piece-creation-collision-" + crypto.randomUUID();
    const piece = await pieces.setupPersistent(firstPattern, {}, cause);
    const firstRef = getPatternIdentityRef(piece);

    await expect(
      pieces.setupPersistent(secondPattern, {}, cause),
    ).rejects.toThrow("piece already exists with a different pattern");

    await piece.sync();
    expect(getPatternIdentityRef(piece)).toEqual(firstRef);
    expect(
      (await readPieceSourceState(runtime, piece)).history.map((revision) =>
        revision.pattern
      ),
    ).toEqual([firstRef]);
  });

  it("allows only one pattern to win a concurrent creation identity", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const secondPattern = await runtime.patternManager.compilePattern(
      versionProgram("second"),
      { space: pieces.getSpace() },
    );
    const cause = "concurrent-piece-creation-" + crypto.randomUUID();

    const results = await Promise.allSettled([
      pieces.setupPersistent(firstPattern, {}, cause),
      pieces.setupPersistent(secondPattern, {}, cause),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "piece already exists with a different pattern",
    );

    const piece = (fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof pieces.setupPersistent>>
    >).value;
    await piece.sync();
    const current = getPatternIdentityRef(piece);
    const history = (await readPieceSourceState(runtime, piece)).history;
    expect(history).toHaveLength(1);
    expect(history[0].pattern).toEqual(current);
  });

  it("validates initialized history when the same creation identity is reused", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      versionProgram("first"),
      { space: pieces.getSpace() },
    );
    const cause = "reused-piece-creation-" + crypto.randomUUID();
    const first = await pieces.setupPersistent(pattern, {}, cause);
    const second = await pieces.setupPersistent(pattern, {}, cause);
    expect(second.entityId).toEqual(first.entityId);

    const tx = runtime.edit();
    first.withTx(tx).setMetaRaw("patternIdentity", undefined);
    await tx.commit();
    await expect(
      pieces.setupPersistent(pattern, {}, cause),
    ).rejects.toThrow(
      "piece source history exists without a pattern identity",
    );
  });

  it("detaches, restores exact source, and follows a web origin again", async () => {
    const origin = "https://source.test/pattern.tsx";
    webSources["/pattern.tsx"] = versionProgram("web-v3");
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, origin);
    const originalRef = getPatternIdentityRef(piece.getCell())!;

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(getPatternIdentityRef(piece.getCell())).toEqual(originalRef);
    expect(await piece.result.get(["version"])).toBe("v1");

    let state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.map((revision) => revision.operation)).toEqual([
      "create",
      "baseline",
      "detach",
    ]);
    const originalRevision = state.history.find((revision) =>
      revision.origin?.url === origin
    )!;
    expect(originalRevision.operation).toBe("baseline");
    const originalRevisionId = originalRevision.revisionId;

    await piece.setPattern(versionProgram("v2"));
    expect(await piece.result.get(["version"])).toBe("v2");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)?.operation).toBe("edit");

    expect(
      await piece.changeSource({
        kind: "restore",
        revisionId: originalRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(getPatternIdentityRef(piece.getCell())).toEqual(originalRef);
    expect(await piece.result.get(["version"])).toBe("v1");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({
      operation: "revert",
      selectedRevisionId: originalRevisionId,
    });

    expect(
      await piece.changeSource({
        kind: "follow",
        revisionId: originalRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(piece.getCell())).toBe(origin);
    expect(await piece.result.get(["version"])).toBe("web-v3");
    state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)).toMatchObject({
      operation: "repoint",
      selectedRevisionId: originalRevisionId,
    });
  });

  it("freezes a legacy relative origin before recording source history", async () => {
    const origin = "/api/patterns/system/example.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);

    expect(await piece.changeSource({ kind: "detach" })).toEqual({
      status: "applied",
    });

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(
      state.history.find((revision) => revision.operation === "baseline")
        ?.origin,
    ).toEqual({
      url: "http://toolshed.test/api/patterns/system/example.tsx",
      kind: "web",
      recorded: origin,
    });
  });

  it("follows the latest source of a mutable fabric piece", async () => {
    const source = await pieces.create(versionProgram("source-v1"), {
      input: {},
    });
    const target = await pieces.create(versionProgram("target-v1"), {
      input: {},
    });
    const origin = `cf:/${pieces.getSpace()}/${source.id}`;
    await stampOrigin(target, origin);
    await target.changeSource({ kind: "detach" });
    const detachedState = await readPieceSourceState(
      runtime,
      target.getCell(),
    );
    const followedRevisionId =
      detachedState.history.find((revision) => revision.origin?.url === origin)!
        .revisionId;

    await source.setPattern(versionProgram("source-v2"));
    expect(await source.result.get(["version"])).toBe("source-v2");

    expect(
      await target.changeSource({
        kind: "follow",
        revisionId: followedRevisionId,
      }),
    ).toEqual({ status: "applied" });
    expect(getPatternSource(target.getCell())).toBe(origin);
    expect(await target.result.get(["version"])).toBe("source-v2");
  });

  it("returns an incompatibility warning without changing lifecycle state", async () => {
    const origin = "https://source.test/incompatible.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const before = await readPieceSourceState(runtime, piece.getCell());
    webSources["/incompatible.tsx"] = incompatibleSeedProgram("candidate");

    const result = await piece.changeSource({
      kind: "follow",
      revisionId: before.history.find((revision) =>
        revision.origin?.url === origin
      )!.revisionId,
    });

    expect(result.status).toBe("incompatible");
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(await piece.result.get(["version"])).toBe("current");
    const after = await readPieceSourceState(runtime, piece.getCell());
    expect(after.pattern).toEqual(before.pattern);
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.history).toEqual(before.history);
  });

  it("validates every compatibility confirmation against current state", async () => {
    const origin = "https://source.test/confirmation.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    webSources["/confirmation.tsx"] = incompatibleSeedProgram("candidate");
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    await expect(
      piece.changeSource(
        { kind: "restore", revisionId: revision.revisionId },
        { confirmedChange: warning.prepared },
      ),
    ).rejects.toThrow("source changed after compatibility was checked");
    await expect(
      piece.changeSource(action, {
        confirmedChange: {
          ...warning.prepared,
          expected: { ...warning.prepared.expected, origin: "changed" },
        },
      }),
    ).rejects.toThrow("source changed after compatibility was checked");
    await expect(
      piece.changeSource(action, {
        confirmedChange: { ...warning.prepared, review: undefined },
      }),
    ).rejects.toThrow("compatibility confirmation is incomplete");

    const loadPattern = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    runtime.patternManager.loadPatternByIdentity = (
      identity,
      symbol,
      space,
    ) =>
      identity === warning.prepared.candidate.identity
        ? Promise.resolve(undefined)
        : loadPattern(identity, symbol, space);
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow("confirmed source version is not available");
    } finally {
      runtime.patternManager.loadPatternByIdentity = loadPattern;
    }
  });

  it("rejects an exact revision whose retained source is unavailable", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await piece.setPattern(versionProgram("v2"));
    const state = await readPieceSourceState(runtime, piece.getCell());
    const oldRevision = state.history.find((revision) =>
      revision.pattern.identity !== state.pattern?.identity
    )!;
    const getProgram = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);
    runtime.patternManager.getPatternSourceProgramByIdentity = (
      identity,
      space,
    ) =>
      identity === oldRevision.pattern.identity
        ? Promise.resolve(undefined)
        : getProgram(identity, space);

    try {
      await expect(
        piece.changeSource({
          kind: "restore",
          revisionId: oldRevision.revisionId,
        }),
      ).rejects.toThrow(
        `source revision ${oldRevision.revisionId} is not available`,
      );
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = getProgram;
    }
  });

  it("rejects a compiled candidate without an entry identity", async () => {
    const origin = "https://source.test/no-entry.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/no-entry.tsx"] = versionProgram("candidate");
    const getEntryRef = runtime.patternManager.getArtifactEntryRef.bind(
      runtime.patternManager,
    );
    runtime.patternManager.getArtifactEntryRef = () => undefined;

    try {
      await expect(
        piece.changeSource({
          kind: "follow",
          revisionId: revision.revisionId,
        }),
      ).rejects.toThrow("candidate source has no pattern identity");
    } finally {
      runtime.patternManager.getArtifactEntryRef = getEntryRef;
    }
  });

  it("rejects a source that cannot use the retained argument", async () => {
    const origin = "https://source.test/required-argument.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const selected = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) => revision.origin?.url === origin)!;
    const action = {
      kind: "follow" as const,
      revisionId: selected.revisionId,
    };
    webSources["/required-argument.tsx"] = incompatibleProgram();

    await expect(piece.changeSource(action)).rejects.toThrow(
      "missing required property required",
    );
    expect(getPatternSource(piece.getCell())).toBeUndefined();
    expect(await piece.result.get(["version"])).toBe("current");
  });

  it("applies the exact candidate that produced a compatibility warning", async () => {
    const origin = "https://source.test/changing.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) => revision.origin?.url === origin)!;
    const action = {
      kind: "follow" as const,
      revisionId: baseline.revisionId,
    };

    webSources["/changing.tsx"] = incompatibleSeedProgram("reviewed");
    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    webSources["/changing.tsx"] = incompatibleSeedProgram("not-reviewed");
    expect(
      await piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).toEqual({ status: "applied" });
    expect(await piece.result.get(["version"])).toBe("reviewed");
  });

  it("offers confirmation for a retained-link incompatibility", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const sourceResult = await source.result.getCell();
    await piece.input.set(sourceResult.key("value"), ["mode"]);

    const origin = "https://source.test/linked.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((revision) => revision.origin?.url === origin)!;
    webSources["/linked.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: baseline.revisionId,
    };

    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.message).toContain(
      "piece source is incompatible with retained input",
    );

    expect(
      await piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).toEqual({ status: "applied" });
    expect(await piece.result.get(["value"])).toBe(4);
  });

  it("records evidence for a retained link without a durable contract", async () => {
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "https://source.test/contractless-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    const argument = pieces.getArgument(piece.getCell());
    const contractless = runtime.getCell(
      pieces.getSpace(),
      `contractless-${crypto.randomUUID()}`,
    );
    await runtime.editWithRetry((tx) => {
      contractless.withTx(tx).setRawUntyped(3);
      argument.withTx(tx).setRawUntyped({
        value: 4,
        mode: contractless.getAsLink(),
      });
    });
    webSources["/contractless-link.tsx"] = optionalModeProgram(2);

    const warning = await piece.changeSource({
      kind: "follow",
      revisionId: revision.revisionId,
    });
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.prepared.review?.argumentEvidence).toBeDefined();
  });

  it("hashes malformed retained-link evidence without failing the review", async () => {
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "https://source.test/malformed-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    const argument = pieces.getArgument(piece.getCell());
    const getArgument = pieces.getArgument;
    const getRaw = argument.getRaw;
    pieces.getArgument = (() => argument) as typeof pieces.getArgument;
    argument.getRaw = (() => {
      return {
        value: 4,
        mode: linkRefFrom({ path: "not an array" } as never),
      };
    }) as typeof argument.getRaw;
    webSources["/malformed-link.tsx"] = optionalModeProgram(2);

    try {
      const result = await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
      expect(result.status).toBe("incompatible");
      if (result.status === "incompatible") {
        expect(result.prepared.review?.argumentEvidence).toBeDefined();
      }
    } finally {
      argument.getRaw = getRaw;
      pieces.getArgument = getArgument;
    }
  });

  it("reports schema and retained-link incompatibilities together", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await piece.input.set(
      (await source.result.getCell()).key("value"),
      ["mode"],
    );

    const origin = "https://source.test/combined-warning.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/combined-warning.tsx"] = incompatibleOptionalModeProgram();

    const warning = await piece.changeSource({
      kind: "follow",
      revisionId: revision.revisionId,
    });
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    expect(warning.message).toContain(
      "Pattern schemas are not backward compatible",
    );
    expect(warning.message).toContain(
      "piece source is incompatible with retained input",
    );
  });

  it("requires a fresh confirmation after a retained link changes", async () => {
    const firstSource = await pieces.create(unionValueProgram(), { input: {} });
    const secondSource = await pieces.create(unionValueProgram(), {
      input: {},
    });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await piece.input.set(
      (await firstSource.result.getCell()).key("value"),
      ["mode"],
    );

    const origin = "https://source.test/changed-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/changed-link.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };

    const firstWarning = await piece.changeSource(action);
    expect(firstWarning.status).toBe("incompatible");
    if (firstWarning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }
    await piece.input.set(
      (await secondSource.result.getCell()).key("value"),
      ["mode"],
    );

    const secondWarning = await piece.changeSource(action, {
      confirmedChange: firstWarning.prepared,
    });
    expect(secondWarning.status).toBe("incompatible");
    if (secondWarning.status !== "incompatible") {
      throw new Error("expected a fresh incompatibility warning");
    }
    expect(secondWarning.prepared.review?.argumentEvidence).not.toBe(
      firstWarning.prepared.review?.argumentEvidence,
    );
    expect(getPatternSource(piece.getCell())).toBeUndefined();

    expect(
      await piece.changeSource(action, {
        confirmedChange: secondWarning.prepared,
      }),
    ).toEqual({ status: "applied" });
  });

  it("rejects a confirmation when its earlier link issue has disappeared", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await piece.input.set(
      (await source.result.getCell()).key("value"),
      ["mode"],
    );
    const origin = "https://source.test/resolved-link.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/resolved-link.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    await piece.input.set({ value: 4 });

    await expect(
      piece.changeSource(action, {
        confirmedChange: warning.prepared,
      }),
    ).rejects.toThrow(
      "retained piece input changed after compatibility was checked",
    );
  });

  it("rejects a confirmation when retained input changes during execution", async () => {
    const firstSource = await pieces.create(unionValueProgram(), { input: {} });
    const secondSource = await pieces.create(unionValueProgram(), {
      input: {},
    });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await piece.input.set(
      (await firstSource.result.getCell()).key("value"),
      ["mode"],
    );
    const origin = "https://source.test/execution-race.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/execution-race.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    mutablePieces.runWithPattern = async (...args) => {
      await piece.input.set(
        (await secondSource.result.getCell()).key("value"),
        ["mode"],
      );
      return await runWithPattern(...args);
    };
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow(
        "retained piece input changed after compatibility was checked",
      );
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }
  });

  it("rejects a confirmation when its argument link disappears during execution", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    await piece.input.set(
      (await source.result.getCell()).key("value"),
      ["mode"],
    );
    const origin = "https://source.test/missing-argument.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/missing-argument.tsx"] = optionalModeProgram(2);
    const action = {
      kind: "follow" as const,
      revisionId: revision.revisionId,
    };
    const warning = await piece.changeSource(action);
    if (warning.status !== "incompatible") {
      throw new Error("expected an incompatibility warning");
    }

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    mutablePieces.runWithPattern = async (...args) => {
      const tx = runtime.edit();
      piece.getCell().withTx(tx).setMetaRaw("argument", undefined);
      await tx.commit();
      return await runWithPattern(...args);
    };
    try {
      await expect(
        piece.changeSource(action, {
          confirmedChange: warning.prepared,
        }),
      ).rejects.toThrow("piece missing its current argument");
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }
  });

  it("returns a warning for a retained link added during execution", async () => {
    const source = await pieces.create(unionValueProgram(), { input: {} });
    const piece = await pieces.create(optionalModeProgram(1), {
      input: { value: 4 },
    });
    const origin = "https://source.test/new-link-race.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/new-link-race.tsx"] = optionalModeProgram(2);

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    mutablePieces.runWithPattern = async (...args) => {
      await piece.input.set(
        (await source.result.getCell()).key("value"),
        ["mode"],
      );
      return await runWithPattern(...args);
    };
    try {
      const result = await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
      expect(result.status).toBe("incompatible");
      if (result.status === "incompatible") {
        expect(result.message).toContain(
          "piece source is incompatible with retained input",
        );
      }
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }
  });

  it("does not replace an execution error with a clean compatibility review", async () => {
    const origin = "https://source.test/spurious-runtime-error.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/spurious-runtime-error.tsx"] = versionProgram("candidate");

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern;
    mutablePieces.runWithPattern = () => {
      throw new Error(
        "piece source is incompatible with retained input: synthetic",
      );
    };
    try {
      await expect(
        piece.changeSource({
          kind: "follow",
          revisionId: revision.revisionId,
        }),
      ).rejects.toThrow("retained input: synthetic");
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }
  });

  it("preserves a non-error execution rejection", async () => {
    const origin = "https://source.test/non-error.tsx";
    const piece = await pieces.create(versionProgram("current"), { input: {} });
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const revision = (await readPieceSourceState(runtime, piece.getCell()))
      .history.find((entry) => entry.origin?.url === origin)!;
    webSources["/non-error.tsx"] = versionProgram("candidate");

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern;
    mutablePieces.runWithPattern =
      (() =>
        Promise.reject("raw execution rejection")) as typeof runWithPattern;
    let reason: unknown;
    try {
      await piece.changeSource({
        kind: "follow",
        revisionId: revision.revisionId,
      });
    } catch (error) {
      reason = error;
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }
    expect(reason).toBe("raw execution rejection");
  });

  it("reports a saved transition separately from a later refresh failure", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    const origin = "https://source.test/post-commit.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history[0];
    await piece.setPattern(versionProgram("v2"));

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    mutablePieces.runWithPattern = async (...args) => {
      await runWithPattern(...args);
      throw new Error("post-commit refresh failed");
    };
    try {
      expect(
        await piece.changeSource({
          kind: "restore",
          revisionId: baseline.revisionId,
        }),
      ).toEqual({
        status: "applied",
        executionWarning: "post-commit refresh failed",
      });
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(state.history.at(-1)?.operation).toBe("revert");
    expect(
      state.history.filter((revision) => revision.operation === "revert"),
    ).toHaveLength(1);
  });

  it("reports a committed detach after a concurrent refresh fails", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    await stampOrigin(piece, "https://source.test/detach-refresh.tsx");
    const cell = piece.getCell();
    const mutableCell = cell as unknown as { sync: typeof cell.sync };
    const originalSync = cell.sync.bind(cell);
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const heldSyncEntered = defer<void>();
    const releaseHeldSync = defer<void>();
    let interceptDetach = true;
    // Only awaited, never read: this test is about what the newer edit does
    // to the detach beside it, not about what it returns.
    let newerEdit: Promise<unknown> | undefined;

    runtime.editWithRetry = (async (action, maxRetries) => {
      const result = await originalEditWithRetry(action, maxRetries);
      if (!interceptDetach) return result;
      interceptDetach = false;
      let holdNextSync = true;
      mutableCell.sync = (() => {
        if (holdNextSync) {
          holdNextSync = false;
          heldSyncEntered.resolve();
          return releaseHeldSync.promise.then(() => originalSync());
        }
        return Promise.reject(
          new Error("detach post-commit refresh failed"),
        );
      }) as typeof cell.sync;
      newerEdit = piece.setPattern(versionProgram("v2"));
      await heldSyncEntered.promise;
      return result;
    }) as typeof runtime.editWithRetry;

    try {
      expect(await piece.changeSource({ kind: "detach" })).toEqual({
        status: "applied",
        executionWarning: "detach post-commit refresh failed",
      });
    } finally {
      mutableCell.sync = originalSync;
      runtime.editWithRetry = originalEditWithRetry;
      releaseHeldSync.resolve();
    }
    await newerEdit;

    const history = (await readPieceSourceState(runtime, cell)).history;
    expect(
      history.filter((revision) => revision.operation === "detach"),
    ).toHaveLength(1);
    expect(history.at(-1)?.operation).toBe("edit");
  });

  it("does not report a direct edit as unsaved after its refresh fails", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    mutablePieces.runWithPattern = async (...args) => {
      await runWithPattern(...args);
      throw new Error("direct edit refresh failed");
    };
    try {
      await piece.setPattern(versionProgram("v2"));
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }

    expect(
      (await readPieceSourceState(runtime, piece.getCell())).history.at(-1)
        ?.operation,
    ).toBe("edit");
    expect(await piece.result.get(["version"])).toBe("v2");
  });

  it("recognizes a saved transition even after a newer source change", async () => {
    const piece = await pieces.create(versionProgram("v1"), { input: {} });
    const origin = "https://source.test/concurrent-post-commit.tsx";
    await stampOrigin(piece, origin);
    await piece.changeSource({ kind: "detach" });
    const baseline = (await readPieceSourceState(runtime, piece.getCell()))
      .history[0];
    await piece.setPattern(versionProgram("v2"));

    const mutablePieces = pieces as unknown as {
      runWithPattern: typeof pieces.runWithPattern;
    };
    const runWithPattern = pieces.runWithPattern.bind(pieces);
    let changedAgain = false;
    mutablePieces.runWithPattern = async (...args) => {
      await runWithPattern(...args);
      if (!changedAgain) {
        changedAgain = true;
        mutablePieces.runWithPattern = runWithPattern;
        await piece.setPattern(versionProgram("v3"));
      }
      throw new Error("older post-commit refresh failed");
    };
    try {
      expect(
        await piece.changeSource({
          kind: "restore",
          revisionId: baseline.revisionId,
        }),
      ).toEqual({
        status: "applied",
        executionWarning: "older post-commit refresh failed",
      });
    } finally {
      mutablePieces.runWithPattern = runWithPattern;
    }

    const state = await readPieceSourceState(runtime, piece.getCell());
    expect(
      state.history.filter((revision) => revision.operation === "revert"),
    ).toHaveLength(1);
    expect(state.history.at(-1)?.operation).toBe("edit");
    expect(await piece.result.get(["version"])).toBe("v3");
  });
});
