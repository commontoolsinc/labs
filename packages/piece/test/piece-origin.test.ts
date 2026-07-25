import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type MemorySpace, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
  PiecesController,
} from "../src/ops/pieces-controller.ts";
import {
  classifyOrigin,
  PieceOriginError,
  readPieceSourceState,
} from "../src/ops/piece-origin.ts";

const signer = await Identity.fromPassphrase("piece origin");

const COUNTER_SOURCE = [
  "import { pattern, Writable, NAME } from 'commonfabric';",
  "export default pattern<{ label: string }>(({ label }) => {",
  "  const count = new Writable(0).for('count');",
  "  return { [NAME]: 'Counter', label, count };",
  "});",
  "",
].join("\n");

const DEFAULT_APP_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
  "",
].join("\n");

/**
 * Serve pattern source from memory, so the resolver and runtime.fetch need no
 * network. Mirrors the stub in pattern-source-provenance.test.ts.
 */
function installFetchStub(sources: Record<string, string>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const source = sources[url.pathname];
    if (source === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SPACE = "did:key:z6MkspaceAAAA" as MemorySpace;

describe("classifyOrigin", () => {
  const runtime = {
    hostForSpace: () => new URL("https://toolshed.test"),
  } as unknown as Runtime;

  it("resolves a toolshed-relative path against the space's host", () => {
    expect(classifyOrigin(runtime, SPACE, "/api/patterns/system/home.tsx"))
      .toEqual({
        url: "https://toolshed.test/api/patterns/system/home.tsx",
        kind: "web",
        recorded: "/api/patterns/system/home.tsx",
      });
  });

  it("keeps an absolute web URL as it is", () => {
    expect(classifyOrigin(runtime, SPACE, "https://example.test/p.tsx"))
      .toEqual({ url: "https://example.test/p.tsx", kind: "web" });
  });

  it("reads an unpinned entity reference as a mutable piece origin", () => {
    expect(classifyOrigin(runtime, SPACE, `cf:/${SPACE}/of:fid1:${HASH}`))
      .toEqual({ url: `cf:/${SPACE}/of:fid1:${HASH}`, kind: "fabric-piece" });
  });

  it("reads a content-addressed pattern reference as immutable", () => {
    expect(classifyOrigin(runtime, SPACE, `cf:pattern:${HASH}`))
      .toEqual({ url: `cf:pattern:${HASH}`, kind: "fabric-pattern" });
  });

  it("reads a pinned entity reference as immutable", () => {
    const url = `cf:/${SPACE}/of:fid1:${HASH}@${HASH}`;
    expect(classifyOrigin(runtime, SPACE, url))
      .toEqual({ url, kind: "fabric-pattern" });
  });

  it("rejects a string that names no place source can be fetched from", () => {
    expect(() => classifyOrigin(runtime, SPACE, "")).toThrow(PieceOriginError);
    expect(() => classifyOrigin(runtime, SPACE, "counter.tsx")).toThrow(
      PieceOriginError,
    );
    expect(() => classifyOrigin(runtime, SPACE, "file:///tmp/p.tsx")).toThrow(
      PieceOriginError,
    );
  });
});

describe("reading a piece's source state", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;
  let restoreFetch: () => void;

  beforeEach(async () => {
    restoreFetch = installFetchStub({
      [DEFAULT_APP_PATTERN_URL]: DEFAULT_APP_SOURCE,
    });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    manager = new PieceManager(
      await createSession({
        identity: signer,
        spaceName: `source-state-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await manager.synced();
    controller = new PiecesController(manager);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager?.close();
    restoreFetch();
  });

  it("reports a directly-created piece as detached, with its source", async () => {
    const piece = await controller.create({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    });

    const state = await readPieceSourceState(runtime, piece.getCell());
    // A piece pushed from local code records no origin: it is the only durable
    // reference to the source it runs.
    expect(state.origin).toBeUndefined();
    expect(state.name).toBe("Counter");
    expect(state.pattern?.symbol).toBe("default");
    expect(state.entry).toBe("/main.tsx");
    expect(state.files.map((file) => file.name)).toEqual(["/main.tsx"]);
    expect(state.space).toBe(manager.getSpace());
  });

  it("reports a space root's stamped path as an absolute web origin", async () => {
    const root = await controller.ensureDefaultPattern();

    const state = await readPieceSourceState(runtime, root.getCell());
    // The root is stamped with a toolshed-relative path; the origin that comes
    // back is absolute, with the recorded form kept alongside it.
    expect(state.origin).toEqual({
      url: `http://toolshed.test${DEFAULT_APP_PATTERN_URL}`,
      kind: "web",
      recorded: DEFAULT_APP_PATTERN_URL,
    });
    expect(state.files.length).toBeGreaterThan(0);
    expect(state.files[0].name).toBe(state.entry);
  });
});
