import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  setPatternSource,
  systemPatternSource,
} from "../src/index.ts";

const signer = await Identity.fromPassphrase("piece source reconciliation");
const PARENT_PATH = "/api/patterns/system/reconcile-parent.tsx";
// The `system:` ref that route path denotes — what a reconciled piece is
// stamped with, whichever legacy spelling it started from.
const PARENT_SOURCE = systemPatternSource("system/reconcile-parent.tsx");
const SOURCE_PATH = "/api/patterns/system/reconcile-target.tsx";
const SYMBOL = "TrackedPattern";

const parentSource = [
  `import { ${SYMBOL} } from "./reconcile-target.tsx";`,
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

function sourceWithRequiredInput(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<{ required: string }, { marker: string }>(() => ({ marker: computed(() => "${marker}") }));`,
    "",
  ].join("\n");
}

/** The same argument contract with a result the previous one does not carry. */
function sourceWithExtraResult(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<Record<string, never>, { marker: string; extra: string }>(() => ({ marker: computed(() => "${marker}"), extra: computed(() => "extra") }));`,
    "",
  ].join("\n");
}

/** A different contract the piece's empty stored argument still satisfies. */
function sourceWithChangedContract(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    `export const ${SYMBOL} = pattern<{ optional?: string }, { marker: string; extra: string }>(() => ({ marker: computed(() => "${marker}"), extra: computed(() => "extra") }));`,
    "",
  ].join("\n");
}

function parentProgram(contents: string): RuntimeProgram {
  return {
    main: PARENT_PATH,
    mainExport: SYMBOL,
    files: [
      { name: PARENT_PATH, contents: parentSource },
      { name: SOURCE_PATH, contents },
    ],
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

describe("piece source reconciliation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let identityGate: Deferred<void> | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    identityGate?.resolve();
    await runtime?.sourceReconciler.idle();
    await runtime?.dispose();
  });

  function createRuntime(fetch: RuntimeFetch): Runtime {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
    });
    return runtime;
  }

  /** A piece running v1 of the tracked pattern, with no origin yet. */
  async function preparePiece(fetch: RuntimeFetch) {
    createRuntime(fetch);
    const space = signer.did();
    const initialIdentity = await identityFor(source("v1"));
    const initial = await runtime.patternManager.compilePattern(
      parentProgram(source("v1")),
      { space },
    );
    const piece = runtime.getCell<{ marker?: string }>(
      space,
      `reconcile-${crypto.randomUUID()}`,
    );
    await runtime.setup(undefined, initial, {}, piece);
    expect(getPatternIdentityRef(piece)).toEqual({
      identity: initialIdentity,
      symbol: SYMBOL,
    });
    return piece;
  }

  async function compileMarkerPattern(marker: string) {
    return await runtime.patternManager.compilePattern(
      parentProgram(source(marker)),
      { space: signer.did() },
    );
  }

  async function stampSource(piece: Cell<unknown>, origin: string) {
    const result = await runtime.editWithRetry((tx) => {
      setPatternSource(piece, tx, origin);
    });
    expect(result.error).toBeUndefined();
  }

  function reconcile(piece: Cell<unknown>) {
    return runtime.sourceReconciler.reconcile(piece);
  }

  /** Serves the tracked pattern's route, advertising `identity` for it. */
  function servingFetch(
    identity: () => string,
    contents: () => string,
    record?: (url: URL, init?: RequestInit) => void,
  ): RuntimeFetch {
    return (input, init) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
          ? input.href
          : input,
      );
      record?.(url, init);
      if (url.pathname === PARENT_PATH) {
        return Promise.resolve(
          url.searchParams.has("identity")
            ? new Response(identity())
            : new Response(parentSource),
        );
      }
      if (url.pathname === SOURCE_PATH) {
        return Promise.resolve(new Response(contents()));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
  }

  const refuseEveryFetch: RuntimeFetch = () =>
    Promise.reject(new Error("this origin must not be fetched"));

  describe("origins nothing follows", () => {
    it("reports a piece with no recorded origin as detached", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      expect(await reconcile(piece)).toBe("detached");
      expect(getPatternSource(piece)).toBeUndefined();
    });

    it("does not fetch a rooted path that names no pattern route", async () => {
      // Resolving such a path against the host reaches whatever the site
      // serves for an unrouted path — the shell answers 200 with its own HTML
      // for any of them — so it names no source at all.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, "/participant-identity-card.tsx");

      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPatternSource(piece)).toBe("/participant-identity-card.tsx");
    });

    it("does not follow a string that is no URL at all", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, "custom");
      expect(await reconcile(piece)).toBe("unusable");
      expect(getPatternSource(piece)).toBe("custom");
    });

    it("does not follow a URL whose scheme serves no program", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, "file:///etc/passwd");
      expect(await reconcile(piece)).toBe("unusable");
    });
  });

  describe("a legacy rooted path", () => {
    it("becomes the system ref naming the same file, and then follows it", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_PATH);

      expect(await reconcile(piece)).toBe("migrated");
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      // Re-spelling the origin is an origin change to the history, which is
      // the accepted cost of migrating in place: this pair is what a reader of
      // the source panel sees once, per piece, and never again.
      expect(getPieceSourceRevisions(piece).map((entry) => entry.operation))
        .toEqual(["baseline", "origin-update"]);
      // The baseline keeps the path the piece actually carried, alongside the
      // absolute URL it resolved to, so the panel can show a reader what the
      // piece stored before the migration rewrote it.
      expect(getPieceSourceRevisions(piece).map((entry) => entry.origin))
        .toEqual([
          new URL(PARENT_PATH, runtime.apiUrl).href,
          PARENT_SOURCE,
        ]);
      expect(getPieceSourceRevisions(piece)[0].recordedOrigin).toBe(
        PARENT_PATH,
      );
    });

    it("becomes the system ref from the absolute spelling on its own host", async () => {
      const v1Identity = await identityFor(source("v1"));
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1")),
      );
      // The spelling a piece carries once a source transition recorded its
      // route path against the space's host.
      const legacyOrigin = new URL(PARENT_PATH, runtime.apiUrl).href;
      await stampSource(piece, legacyOrigin);

      expect(await reconcile(piece)).toBe("migrated");
      expect(getPatternSource(piece)).toBe(PARENT_SOURCE);
    });

    it("keeps the same path on another host as the web URL it is", async () => {
      // Re-pointing it at this toolshed would change which host the piece
      // follows, which is a change of source rather than of spelling. Nothing
      // follows a web origin yet, so the piece keeps what it runs.
      const foreign = `https://elsewhere.test${PARENT_PATH}`;
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, foreign);

      expect(await reconcile(piece)).toBe("unsupported");
      expect(getPatternSource(piece)).toBe(foreign);
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });
  });

  describe("a system pattern this deployment serves", () => {
    it("asks the identity route first, and stops there when nothing moved", async () => {
      const v1Identity = await identityFor(source("v1"));
      const requested: Array<{ href: string; cache?: RequestCache }> = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          (url, init) => requested.push({ href: url.href, cache: init?.cache }),
        ),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("current");
      // One conditional request, and no source downloaded behind it.
      expect(requested).toEqual([{
        href: `http://toolshed.test${PARENT_PATH}?identity=`,
        cache: "no-cache",
      }]);
    });

    it("adopts newer source and stages it over the document", async () => {
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect(getPieceSourceRevisions(piece).at(-1)?.operation).toBe(
        "origin-update",
      );
      // The piece was not running, so nothing else would have staged the new
      // pattern over its document: reading it must now produce v2.
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();
      expect((await piece.pull())?.marker).toBe("v2");
    });

    it("moves a running piece's pointer and lets its watcher re-instantiate", async () => {
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      await stampSource(piece, PARENT_SOURCE);
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();
      expect((await piece.pull())?.marker).toBe("v1");

      expect(await reconcile(piece)).toBe("updated");
      await runtime.idle();
      // Staging belongs to the transaction that moves the pointer whether or
      // not the piece is running, so the completion marker names the candidate
      // and the watcher re-instantiates over a document already set up for it.
      expect(getPatternSetupIdentityRef(piece)).toEqual({
        identity: v2Identity,
        symbol: SYMBOL,
      });
      expect((await piece.pull())?.marker).toBe("v2");
    });

    it("treats a pattern index that errors as an artifact that will not load", async () => {
      // Asking whether the running pattern still loads is a question that can
      // fail rather than answer. A failure is read as "it will not load",
      // which sends the pass on to compile the source again.
      const v1Identity = await identityFor(source("v1"));
      const fetched: string[] = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          (url) => fetched.push(url.pathname),
        ),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef!.identity
          ? Promise.reject(new Error("the pattern index is unreadable"))
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("current");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(fetched).toContain(PARENT_PATH);
    });

    it("keeps the running source when the candidate compiles to no identity", async () => {
      // Nothing can point a piece at source that has no identity to point at,
      // so a candidate the compiler produces without one is refused rather
      // than adopted under whatever the piece already records.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const entryRef = manager.getArtifactEntryRef.bind(manager);
      manager.getArtifactEntryRef = () => undefined;
      try {
        expect(await reconcile(piece)).toBe("unavailable");
      } finally {
        manager.getArtifactEntryRef = entryRef;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("records the pattern it displaced when its source is gone", async () => {
      // A piece whose own source this space no longer holds has nothing left
      // to protect: it cannot be set up again at all, so the origin's source
      // is a rescue. What the rescue replaced is recorded, because after the
      // pointer moves nothing else names it.
      const v2Identity = await identityFor(source("v2"));
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece)!;
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const program = manager.getPatternSourceProgramByIdentity.bind(manager);
      manager.getPatternSourceProgramByIdentity = (
        ...args: Parameters<typeof program>
      ) =>
        args[0] === originalRef.identity
          ? Promise.resolve(undefined)
          : program(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.getPatternSourceProgramByIdentity = program;
      }

      expect(getPatternIdentityRef(piece)?.identity).toBe(v2Identity);
      expect(piece.getMetaRaw("displacedPattern")).toMatchObject({
        identity: originalRef.identity,
        symbol: originalRef.symbol,
      });
    });

    it("keeps the running source when the route cannot be reached", async () => {
      const piece = await preparePiece(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when the served source does not compile to the identity it advertises", async () => {
      const v2Identity = await identityFor(source("v2"));
      // Advertises v2 while serving v3: the source is not what the origin says
      // it is, so nothing about it can be trusted.
      const piece = await preparePiece(
        servingFetch(() => v2Identity, () => source("v3")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when the identity route names no identity", async () => {
      const piece = await preparePiece(
        servingFetch(() => "", () => source("v2")),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("compiles the advertised source again when the artifact is gone", async () => {
      // The identity route settles only whether the SOURCE moved. A space that
      // no longer holds the compiled artifact for an unchanged identity cannot
      // start the piece, so reconciliation downloads and compiles that source
      // rather than stopping at the identity comparison — which puts the
      // artifact back under the identity the piece already points at.
      const v1Identity = await identityFor(source("v1"));
      const fetched: string[] = [];
      const piece = await preparePiece(
        servingFetch(
          () => v1Identity,
          () => source("v1"),
          (url) => fetched.push(url.pathname),
        ),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef!.identity
          ? Promise.resolve(undefined)
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("current");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(fetched).toContain(PARENT_PATH);
    });

    it("adopts a candidate that changes the piece contract", async () => {
      // This deployment gates its own patterns where they are released, so a
      // candidate from its own route is taken as it stands.
      const changed = sourceWithChangedContract("v2");
      const changedIdentity = await identityFor(changed);
      const piece = await preparePiece(
        servingFetch(() => changedIdentity, () => changed),
      );
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)?.identity).toBe(changedIdentity);
    });

    it("keeps a RUNNING piece's pointer when the candidate refuses its data", async () => {
      // Staging the candidate is part of the transition for a running piece
      // too. Were it left to the pattern watcher, the pointer would commit,
      // the watcher's setup would fail, and the next open would find the
      // pointer matching what the origin offers and call the piece current —
      // with the old graph still running and nothing able to undo it.
      const demanding = sourceWithRequiredInput("v2");
      const demandingIdentity = await identityFor(demanding);
      const piece = await preparePiece(
        servingFetch(() => demandingIdentity, () => demanding),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();

      expect(await reconcile(piece)).toBe("unavailable");
      await runtime.idle();
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect((await piece.pull())?.marker).toBe("v1");
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("keeps the running source when the candidate refuses this piece's data", async () => {
      // Nothing compares the contracts for this origin, so what discovers the
      // problem is staging the candidate over the document: its setup rejects
      // a stored argument the new schema cannot read, the transition fails,
      // and the piece stays on what it has.
      const demanding = sourceWithRequiredInput("v2");
      const demandingIdentity = await identityFor(demanding);
      const piece = await preparePiece(
        servingFetch(() => demandingIdentity, () => demanding),
      );
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });
  });

  describe("an external web URL", () => {
    it("recognizes the origin and does not follow it yet", async () => {
      // Resolving a source outside this deployment is specified and not built,
      // so the piece keeps what it runs and nothing is fetched on its behalf.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const origin = `https://programs.test${PARENT_PATH}`;
      await stampSource(piece, origin);

      expect(await reconcile(piece)).toBe("unsupported");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPatternSource(piece)).toBe(origin);
    });
  });

  describe("source inside the fabric", () => {
    it("adopts the pattern another piece currently runs", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstream = await compileMarkerPattern("v2");
      const upstreamRef = runtime.patternManager.getArtifactEntryRef(upstream)!;
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(undefined, upstream, {}, upstreamPiece);
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual(upstreamRef);
    });

    it("follows a later change made by the piece it is following", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstreamPiece,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      // The subscription the reconciliation installed is what carries this.
      const moved = await compileMarkerPattern("v2");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === movedRef.identity) reached.resolve();
      });
      try {
        await runtime.setup(undefined, moved, {}, upstreamPiece);
        await reached.promise;
      } finally {
        cancel();
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("follows the new target when the piece's own origin is repointed", async () => {
      // Changing where a piece looks is a change the piece's own watcher
      // carries, so the update lands without anyone opening the piece again.
      const piece = await preparePiece(refuseEveryFetch);
      const first = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        first,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${first.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      const second = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      const moved = await compileMarkerPattern("v2");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      await runtime.setup(undefined, moved, {}, second);

      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === movedRef.identity) reached.resolve();
      });
      try {
        await stampSource(
          piece,
          `cf:/${piece.space}/${second.getAsNormalizedFullLink().id}`,
        );
        await reached.promise;
      } finally {
        cancel();
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("picks up a source that moves while a pass is running", async () => {
      // A pass reads its target once. A move that lands after that read could
      // not have been seen by it, so another pass has to follow the one in
      // flight rather than the move being lost.
      const piece = await preparePiece(refuseEveryFetch);
      const upstream = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstream,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstream.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");

      const entered = defer<void>();
      const held = defer<void>();
      const manager = runtime.patternManager;
      const program = manager.getPatternSourceProgramByIdentity.bind(manager);
      manager.getPatternSourceProgramByIdentity = async (
        ...args: Parameters<typeof program>
      ) => {
        entered.resolve();
        await held.promise;
        return await program(...args);
      };

      const third = await compileMarkerPattern("v3");
      const thirdRef = runtime.patternManager.getArtifactEntryRef(third)!;
      const reached = defer<void>();
      const cancel = piece.sinkMeta("patternIdentity", (value) => {
        const ref = value as { identity?: string } | undefined;
        if (ref?.identity === thirdRef.identity) reached.resolve();
      });
      try {
        // The watcher starts a pass, which blocks in its source lookup.
        await runtime.setup(
          undefined,
          await compileMarkerPattern("v2"),
          {},
          upstream,
        );
        await entered.promise;
        // The source moves again while that pass is held.
        await runtime.setup(undefined, third, {}, upstream);
        held.resolve();
        await reached.promise;
      } finally {
        cancel();
        manager.getPatternSourceProgramByIdentity = program;
      }
      await runtime.sourceReconciler.idle();
      expect(getPatternIdentityRef(piece)).toEqual(thirdRef);
    });

    it("stops following once the piece stops", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-upstream-${crypto.randomUUID()}`,
      );
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v1"),
        {},
        upstreamPiece,
      );
      await stampSource(
        piece,
        `cf:/${piece.space}/${upstreamPiece.getAsNormalizedFullLink().id}`,
      );
      expect(await reconcile(piece)).toBe("current");
      const followingRef = getPatternIdentityRef(piece);

      runtime.sourceReconciler.unwatch(piece);
      await runtime.setup(
        undefined,
        await compileMarkerPattern("v2"),
        {},
        upstreamPiece,
      );
      await runtime.sourceReconciler.idle();
      await runtime.idle();

      expect(getPatternIdentityRef(piece)).toEqual(followingRef);
    });

    it("adopts exact pinned source once, and never reports a move again", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const target = await compileMarkerPattern("v2");
      const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
      await stampSource(piece, `cf:pattern:${targetRef.identity}`);

      expect(await reconcile(piece)).toBe("updated");
      expect(getPatternIdentityRef(piece)).toEqual(targetRef);
      // The URL names one content identity, so resolving it again can only
      // find the same one.
      expect(await reconcile(piece)).toBe("current");
    });

    it("refuses a candidate that moves the piece's contract", async () => {
      // Nobody gated the release behind this origin, so an unattended update
      // requires the contract not to move.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      expect(await reconcile(piece)).toBe("incompatible");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("refuses a candidate whose result grows past the accepted one", async () => {
      // The argument the piece already stores still fits, so only the reads
      // its result promises have moved — which is a contract change like any
      // other where nobody gated the release.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const grown = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithExtraResult("v2")),
        { space: piece.space },
      );
      const grownRef = runtime.patternManager.getArtifactEntryRef(grown)!;
      await stampSource(piece, `cf:pattern:${grownRef.identity}`);

      expect(await reconcile(piece)).toBe("incompatible");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("adopts a contract-moving candidate when the running pattern is gone", async () => {
      // The comparison an ungated origin has to satisfy is made against the
      // pattern the piece runs. A piece whose own pattern can no longer be
      // loaded has nothing left to protect — it cannot run at all — so the
      // origin's source is a rescue and is taken without a comparison there
      // is no way to make.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece)!;
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef.identity
          ? Promise.reject(new Error("the running pattern is gone"))
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(changedRef);
    });

    it("adopts a contract-moving candidate when the running pattern is absent", async () => {
      // The same waiver as above, for a pattern index that answers rather than
      // fails: no pattern to compare against is no comparison either way.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece)!;
      const changed = await runtime.patternManager.compilePattern(
        parentProgram(sourceWithChangedContract("v2")),
        { space: piece.space },
      );
      const changedRef = runtime.patternManager.getArtifactEntryRef(changed)!;
      await stampSource(piece, `cf:pattern:${changedRef.identity}`);

      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === originalRef.identity
          ? Promise.resolve(undefined)
          : load(...args);
      try {
        expect(await reconcile(piece)).toBe("updated");
      } finally {
        manager.loadPatternByIdentity = load;
      }
      expect(getPatternIdentityRef(piece)).toEqual(changedRef);
    });

    it("keeps the running source when the target runs no pattern", async () => {
      // An entity is only a source while it names a pattern. One that holds
      // ordinary data names nothing to adopt, so the piece keeps what it has
      // and the entity is not followed.
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const plain = runtime.getCell<{ note: string }>(
        piece.space,
        `reconcile-plain-${crypto.randomUUID()}`,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ note: "not a pattern" });
      });
      expect(error).toBeUndefined();
      await stampSource(
        piece,
        `cf:/${piece.space}/${plain.getAsNormalizedFullLink().id}`,
      );

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("keeps the running source when a pinned target is unavailable", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(
        piece,
        "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      );

      expect(await reconcile(piece)).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("refuses a reference that names no update authority", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      const originalRef = getPatternIdentityRef(piece);
      const target = await compileMarkerPattern("v2");
      const targetRef = runtime.patternManager.getArtifactEntryRef(target)!;
      const upstreamPiece = runtime.getCell(
        piece.space,
        `reconcile-unauthorized-${crypto.randomUUID()}`,
      );
      await runtime.setup(undefined, target, {}, upstreamPiece);
      const upstreamId = upstreamPiece.getAsNormalizedFullLink().id;
      expect(targetRef).not.toEqual(originalRef);

      for (
        const [origin, outcome] of [
          // A subpath names a file inside a program, not a program.
          [`cf:pattern:${targetRef.identity}/nested.ts`, "unusable"],
          // A name is not a stable identifier.
          [`cf:/friendly-space/${upstreamId}`, "unusable"],
          // A host that does not serve the space it claims to route to.
          [`cf://other.test/${piece.space}/${upstreamId}`, "unavailable"],
        ] as const
      ) {
        await stampSource(piece, origin);
        expect(await reconcile(piece)).toBe(outcome);
        expect(getPatternIdentityRef(piece)).toEqual(originalRef);
        expect(getPatternSource(piece)).toBe(origin);
      }
    });
  });

  describe("guarding the write", () => {
    it("shares one reconciliation between concurrent openings", async () => {
      const v1Identity = await identityFor(source("v1"));
      let identityRequests = 0;
      identityGate = defer();
      const piece = await preparePiece(
        servingFetch(() => v1Identity, () => source("v1"), (url) => {
          if (url.searchParams.has("identity")) identityRequests++;
        }),
      );
      await stampSource(piece, PARENT_SOURCE);

      const both = Promise.all([reconcile(piece), reconcile(piece)]);
      identityGate.resolve();
      expect(await both).toEqual(["current", "current"]);
      expect(identityRequests).toBe(1);
    });

    it("starts a fresh pass for a piece reopened as its abandoned one unwinds", async () => {
      // Stopping a piece abandons the pass in flight for it. Opening it again
      // before that pass has finished unwinding must not be answered by the
      // abandoned one: the piece would start on source its origin had already
      // replaced, which is the whole thing reconciling before a start prevents.
      const v2Identity = await identityFor(source("v2"));
      const identityRequested = defer<void>();
      identityGate = defer();
      let identityRequests = 0;
      const piece = await preparePiece(async (input) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
            ? input.href
            : input,
        );
        if (url.searchParams.has("identity")) {
          identityRequests++;
          identityRequested.resolve();
          await identityGate!.promise;
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      await stampSource(piece, PARENT_SOURCE);

      const abandoned = reconcile(piece);
      await identityRequested.promise;
      runtime.sourceReconciler.unwatch(piece);
      const reopened = reconcile(piece);
      identityGate.resolve();
      await abandoned;
      await reopened;
      await runtime.sourceReconciler.idle();

      expect(identityRequests).toBe(2);
      expect(getPatternIdentityRef(piece)?.identity).toBe(v2Identity);
    });

    it("does not apply an update once the recorded origin has changed", async () => {
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
        if (url.searchParams.has("identity")) {
          identityRequested.resolve();
          await identityGate!.promise;
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const running = reconcile(piece);
      await identityRequested.promise;
      // A detach lands while the update is resolving. The transition it was
      // going to write names an origin the piece no longer follows.
      await runtime.editWithRetry((tx) => {
        piece.withTx(tx).setMetaRaw("patternSource", undefined);
      });
      identityGate.resolve();

      expect(await running).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
      expect(getPieceSourceRevisions(piece)).toEqual([]);
    });

    it("does not apply an update once the piece's pattern has moved", async () => {
      // The candidate was compared against the pattern the piece was running
      // when the pass began. A piece that has moved to a different pattern
      // since is not the piece that comparison was about, so the transition
      // is dropped rather than applied over it.
      const v2Identity = await identityFor(source("v2"));
      const identityRequested = defer<void>();
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
          return new Response(v2Identity);
        }
        return new Response(
          url.pathname === SOURCE_PATH ? source("v2") : parentSource,
        );
      });
      await stampSource(piece, PARENT_SOURCE);

      const pass = reconcile(piece);
      await identityRequested.promise;
      const moved = await compileMarkerPattern("v3");
      const movedRef = runtime.patternManager.getArtifactEntryRef(moved)!;
      const { error } = await runtime.editWithRetry((tx) => {
        piece.withTx(tx).setMetaRaw("patternIdentity", movedRef);
      });
      expect(error).toBeUndefined();
      identityGate.resolve();

      expect(await pass).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(movedRef);
    });

    it("abandons an in-flight reconciliation on disposal", async () => {
      const identityRequested = defer();
      identityGate = defer();
      const piece = await preparePiece(async () => {
        identityRequested.resolve();
        await identityGate!.promise;
        return new Response(await identityFor(source("v2")));
      });
      const originalRef = getPatternIdentityRef(piece);
      await stampSource(piece, PARENT_SOURCE);

      const running = reconcile(piece);
      await identityRequested.promise;
      const disposed = runtime.sourceReconciler.dispose();
      identityGate.resolve();
      await disposed;

      expect(await running).toBe("unavailable");
      expect(getPatternIdentityRef(piece)).toEqual(originalRef);
    });

    it("reports a reconciliation requested after disposal as detached", async () => {
      const piece = await preparePiece(refuseEveryFetch);
      await stampSource(piece, PARENT_SOURCE);
      await runtime.sourceReconciler.dispose();
      expect(await reconcile(piece)).toBe("detached");
    });
  });
});
