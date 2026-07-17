import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getPatternIdentityRef,
  getPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import {
  DEFAULT_APP_PATTERN_URL,
  deriveSystemPatternUrl,
  HOME_PATTERN_URL,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("pattern source provenance");

// A minimal, self-contained pattern the fetch stub serves as the "default app".
const DEFAULT_APP_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
  "",
].join("\n");

/**
 * Override globalThis.fetch to serve pattern source from memory (no network, so
 * no --allow-net needed). HttpProgramResolver and runtime.fetch both route
 * through globalThis.fetch.
 */
function installFetchStub(
  sources: Record<string, string>,
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

describe("deriveSystemPatternUrl", () => {
  it("returns home.tsx for the home space, default-app.tsx otherwise", () => {
    const runtime = {
      userIdentityDID: "did:key:home",
    } as unknown as Runtime;
    expect(deriveSystemPatternUrl("did:key:home" as never, runtime)).toBe(
      HOME_PATTERN_URL,
    );
    expect(deriveSystemPatternUrl("did:key:other" as never, runtime)).toBe(
      DEFAULT_APP_PATTERN_URL,
    );
  });
});

describe("ensureDefaultPattern stamps patternSource", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;
  let restoreFetch: () => void;

  beforeEach(async () => {
    restoreFetch = installFetchStub({
      "/api/patterns/system/default-app.tsx": DEFAULT_APP_SOURCE,
    });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "provenance-space-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    restoreFetch();
  });

  it("stamps the default-app source path on a non-home root", async () => {
    const piece = await controller.ensureDefaultPattern();
    const source = getPatternSource(piece.getCell());
    expect(source).toBe(DEFAULT_APP_PATTERN_URL);
    const identityRef = getPatternIdentityRef(piece.getCell())!;
    expect(await piece.getPatternRef()).toEqual({
      ...identityRef,
      source: {
        ref: `cf:pattern:${identityRef.identity}`,
        origin: DEFAULT_APP_PATTERN_URL,
      },
    });
  });
});
