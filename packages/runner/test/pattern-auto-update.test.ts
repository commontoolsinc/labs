import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  setPatternSource,
} from "../src/index.ts";

const signer = await Identity.fromPassphrase("lazy system pattern updates");
const PARENT_PATH = "/api/patterns/system/lazy-update-parent.tsx";
const SOURCE_PATH = "/api/patterns/system/lazy-update-test.tsx";
const SYMBOL = "TrackedPattern";

const parentSource = [
  `import { ${SYMBOL} } from "./lazy-update-test.tsx";`,
  `export { ${SYMBOL} };`,
  `export default ${SYMBOL};`,
  "",
].join("\n");

function source(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<Record<string, never>, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

function parentProgram(contents: string): RuntimeProgram {
  return {
    main: PARENT_PATH,
    mainExport: SYMBOL,
    files: [{
      name: PARENT_PATH,
      contents: parentSource,
    }, { name: SOURCE_PATH, contents }],
  };
}

function identityFor(contents: string): Promise<string> {
  const files = new Map(
    parentProgram(contents).files.map(({ name, contents }) => [name, contents]),
  );
  return resolveEntryIdentity(
    PARENT_PATH,
    (name) =>
      files.has(name)
        ? Promise.resolve(files.get(name)!)
        : Promise.reject(new Error(`not found: ${name}`)),
  );
}

describe("lazy system-pattern auto-update", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let identityGate: Deferred<void> | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    identityGate?.resolve();
    await runtime?.patternUpdater.idle();
    await runtime?.dispose();
  });

  function createRuntime(
    fetch: RuntimeFetch,
    systemPatternAutoUpdate = true,
  ): Runtime {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
      experimental: systemPatternAutoUpdate
        ? { systemPatternAutoUpdate: true }
        : { systemPatternAutoUpdate: false },
    });
    return runtime;
  }

  async function preparePiece(fetch: RuntimeFetch) {
    createRuntime(fetch);
    const space = signer.did();
    const initialIdentity = await identityFor(source("v1"));
    const initial = await runtime.patternManager.compilePattern(
      parentProgram(source("v1")),
      { space },
    );
    const recovered = await runtime.patternManager
      .getPatternSourceProgramByIdentity(initialIdentity, space);
    expect(recovered?.main).toBe(PARENT_PATH);
    const piece = runtime.getCell<{ marker?: string }>(
      space,
      `lazy-update-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, initial, {}, piece);
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: initialIdentity,
      symbol: SYMBOL,
    });
    return piece;
  }

  it("honors disabled and disposed updater lifecycle gates", async () => {
    createRuntime(
      () => Promise.reject(new Error("disabled updater fetched source")),
      false,
    );
    const cell = runtime.getCell(signer.did(), crypto.randomUUID());

    expect(
      await runtime.patternUpdater.checkDefaultPattern(cell, PARENT_PATH),
    ).toBe("skipped-disabled");

    runtime.experimental.systemPatternAutoUpdate = true;
    await runtime.patternUpdater.dispose();
    expect(
      await runtime.patternUpdater.checkDefaultPattern(cell, PARENT_PATH),
    ).toBe("current");
  });

  it("contains synchronous and asynchronous scheduling failures", async () => {
    createRuntime(() => Promise.reject(new Error("unexpected fetch")));
    const space = signer.did();
    const synchronousFailure = {
      space,
      getAsNormalizedFullLink: () => {
        throw new Error("link unavailable");
      },
    } as unknown as Cell<unknown>;
    expect(() => runtime.patternUpdater.schedule(synchronousFailure)).not
      .toThrow();

    let spaceReads = 0;
    const asynchronousFailure = {
      get space() {
        spaceReads++;
        if (spaceReads === 1) throw new Error("space unavailable");
        return space;
      },
      getAsNormalizedFullLink: () => ({
        space,
        id: "of:async-pattern-update-schedule-failure",
      }),
    } as unknown as Cell<unknown>;
    runtime.patternUpdater.schedule(asynchronousFailure);
    await runtime.patternUpdater.idle();

    expect(spaceReads).toBe(2);
  });

  it("shares one in-flight check for duplicate schedules", async () => {
    const v1Identity = await identityFor(source("v1"));
    const identityRequested = defer();
    identityGate = defer();
    let identityFetches = 0;
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.searchParams.has("identity")) {
        identityFetches++;
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v1Identity);
      }
      return new Response("not found", { status: 404 });
    });

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    runtime.patternUpdater.schedule(piece);
    expect(identityFetches).toBe(1);

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    expect(identityFetches).toBe(1);
    expect(getPatternSource(piece)).toBe(PARENT_PATH);
  });

  it("aborts an in-flight identity request during disposal", async () => {
    const identityRequested = defer<AbortSignal | undefined>();
    const abortObserved = defer();
    const piece = await preparePiece((_input, init) => {
      const signal = init?.signal ?? undefined;
      identityRequested.resolve(signal);
      if (signal === undefined) {
        return Promise.reject(
          new Error("identity request had no abort signal"),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortObserved.resolve();
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });

    const start = runtime.start(piece);
    const signal = await identityRequested.promise;
    expect(signal).toBeDefined();
    expect(await start).toBe(true);
    const dispose = runtime.patternUpdater.dispose();
    await abortObserved.promise;
    await dispose;

    expect(signal!.aborted).toBe(true);
    expect(getPatternSource(piece)).toBeUndefined();
    expect(
      await runtime.patternUpdater.checkDefaultPattern(piece, PARENT_PATH),
    ).toBe("current");
  });

  it("does not resolve source after disposal aborts a completed identity fetch", async () => {
    const v2Identity = await identityFor(source("v2"));
    const identityRequested = defer<AbortSignal | undefined>();
    let bodyController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const piece = await preparePiece((_input, init) => {
      const signal = init?.signal ?? undefined;
      identityRequested.resolve(signal);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
            },
          }),
        ),
      );
    });

    const start = runtime.start(piece);
    const signal = await identityRequested.promise;
    expect(signal).toBeDefined();
    expect(await start).toBe(true);
    const dispose = runtime.patternUpdater.dispose();
    expect(signal!.aborted).toBe(true);
    bodyController!.enqueue(new TextEncoder().encode(v2Identity));
    bodyController!.close();
    await dispose;

    expect(getPatternSource(piece)).toBeUndefined();
    expect((await piece.pull())?.marker).toBe("v1");
  });

  it("skips a sourceless pattern whose compiled source cannot be recovered", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const originalGetSource = runtime.patternManager
      .getPatternSourceProgramByIdentity;
    runtime.patternManager.getPatternSourceProgramByIdentity =
      (() => Promise.resolve(undefined)) as typeof originalGetSource;

    try {
      runtime.patternUpdater.schedule(piece);
      await runtime.patternUpdater.idle();
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity =
        originalGetSource;
    }

    expect(fetches).toBe(0);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("leaves cf sources to their own resolver", async () => {
    let fetches = 0;
    const piece = await preparePiece(() => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    });
    const update = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, "cf:published-pattern");
    });
    expect(update.error).toBeUndefined();

    runtime.patternUpdater.schedule(piece);
    await runtime.patternUpdater.idle();

    expect(fetches).toBe(0);
    expect(getPatternSource(piece)).toBe("cf:published-pattern");
  });

  it("does not repair provenance after the piece becomes the default", async () => {
    const v1Identity = await identityFor(source("v1"));
    const identityRequested = defer();
    identityGate = defer();
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.searchParams.has("identity")) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v1Identity);
      }
      return new Response("not found", { status: 404 });
    });

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    const promoted = await runtime.editWithRetry((tx) => {
      runtime.getSpaceCell(piece.space).withTx(tx).key("defaultPattern")
        .set(piece.withTx(tx));
    });
    expect(promoted.error).toBeUndefined();

    identityGate.resolve();
    await runtime.patternUpdater.idle();

    expect(getPatternSource(piece)).toBeUndefined();
    expect(getPatternIdentityRef(piece)?.symbol).toBe(SYMBOL);
  });

  it("does not swap identity after the piece becomes the default", async () => {
    const v2Identity = await identityFor(source("v2"));
    const identityRequested = defer();
    identityGate = defer();
    const piece = await preparePiece(async (input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v2Identity);
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v2")
        : undefined;
      return new Response(contents ?? "not found", {
        status: contents === undefined ? 404 : 200,
      });
    });
    const originalRef = getPatternIdentityRef(piece);

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    const promoted = await runtime.editWithRetry((tx) => {
      runtime.getSpaceCell(piece.space).withTx(tx).key("defaultPattern")
        .set(piece.withTx(tx));
    });
    expect(promoted.error).toBeUndefined();

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
    expect((await piece.pull())?.marker).toBe("v1");
  });

  it("starts immediately, then updates a non-root pattern in the background", async () => {
    const v2Identity = await identityFor(source("v2"));
    const identityRequested = defer();
    identityGate = defer();
    const requested: Array<{ href: string; cache?: RequestCache }> = [];
    const piece = await preparePiece(async (input, init) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      requested.push({ href: url.href, cache: init?.cache });
      if (
        url.pathname === PARENT_PATH &&
        url.searchParams.has("identity")
      ) {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(v2Identity);
      }
      const contents = url.pathname === PARENT_PATH
        ? parentSource
        : url.pathname === SOURCE_PATH
        ? source("v2")
        : undefined;
      return new Response(contents ?? "not found", {
        status: contents === undefined ? 404 : 200,
        headers: { "content-type": "text/typescript-jsx" },
      });
    });
    const v1Ref = getPatternIdentityRef(piece)!;

    const start = runtime.start(piece);
    await identityRequested.promise;
    expect(await start).toBe(true);
    await runtime.idle();
    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(v1Ref);

    identityGate.resolve();
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v2");
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: v2Identity,
      symbol: SYMBOL,
    });
    expect(getPatternSource(piece)).toBe(PARENT_PATH);
    expect(requested).toContainEqual({
      href: `http://toolshed.test${PARENT_PATH}?identity=`,
      cache: "no-cache",
    });
    expect(requested).toContainEqual({
      href: `http://toolshed.test${PARENT_PATH}`,
      cache: "no-cache",
    });
    expect(requested).toContainEqual({
      href: `http://toolshed.test${SOURCE_PATH}`,
      cache: "no-cache",
    });
  });

  it("records a proven system source when its identity is already current", async () => {
    const v1Identity = await identityFor(source("v1"));
    let sourceFetches = 0;
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname !== PARENT_PATH) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (!url.searchParams.has("identity")) sourceFetches++;
      return Promise.resolve(
        url.searchParams.has("identity")
          ? new Response(v1Identity)
          : new Response(parentSource),
      );
    });
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();

    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBe(PARENT_PATH);
    expect(sourceFetches).toBe(0);
  });

  it("leaves an ordinary pattern alone when its source has no identity route", async () => {
    const piece = await preparePiece(() =>
      Promise.resolve(new Response("not found", { status: 404 }))
    );
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
  });

  it("keeps the running pattern when the advertised source does not compile", async () => {
    const invalidSource = [
      "import { pattern } from 'commonfabric';",
      `export const ${SYMBOL} = pattern(() => ({ marker: ; }));`,
      "",
    ].join("\n");
    const invalidIdentity = await identityFor(invalidSource);
    const piece = await preparePiece((input) => {
      const href = input instanceof Request
        ? input.url
        : input instanceof URL
        ? input.href
        : input;
      const url = new URL(href);
      if (url.pathname === PARENT_PATH && url.searchParams.has("identity")) {
        return Promise.resolve(new Response(invalidIdentity));
      }
      if (url.pathname === PARENT_PATH) {
        return Promise.resolve(new Response(parentSource));
      }
      if (url.pathname === SOURCE_PATH) {
        return Promise.resolve(new Response(invalidSource));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const originalRef = getPatternIdentityRef(piece);

    await runtime.start(piece);
    await runtime.patternUpdater.idle();
    await runtime.idle();

    expect((await piece.pull())?.marker).toBe("v1");
    expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    expect(getPatternSource(piece)).toBeUndefined();
  });
});
