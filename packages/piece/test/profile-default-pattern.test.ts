import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { deriveProfileSpaceDID } from "../src/profile-space.ts";

const signer = await Identity.fromPassphrase("test profile default pattern");

const patternSource = (name: string) =>
  [
    "/// <cf-disable-transform />",
    "import { NAME, pattern } from 'commonfabric';",
    `export default pattern(() => ({ [NAME]: ${JSON.stringify(name)} }));`,
  ].join("\n");

const sourcesByPath = new Map([
  ["/api/patterns/system/home.tsx", patternSource("Home")],
  ["/api/patterns/system/default-app.tsx", patternSource("DefaultPieceList")],
  ["/api/patterns/system/profile-home.tsx", patternSource("ProfileHome")],
]);

describe("PiecesController profile default patterns", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controllers: PiecesController[] = [];
  let fetchedPaths: string[] = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://patterns.local"),
      storageManager,
    });
    controllers = [];
    fetchedPaths = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      fetchedPaths.push(url.pathname);
      const source = sourcesByPath.get(url.pathname);
      if (source === undefined) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(source, {
          status: 200,
          headers: { "content-type": "text/typescript" },
        }),
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const controller of controllers) {
      try {
        await controller.dispose();
      } catch {
        // Already disposed.
      }
    }
    await storageManager?.close();
  });

  const controllerForSpace = async (spaceDid: string) => {
    const session = await createSession({
      identity: signer,
      spaceDid: spaceDid as any,
    });
    const manager = new PieceManager(session, runtime);
    await manager.synced();
    const controller = new PiecesController(manager);
    controllers.push(controller);
    return controller;
  };

  it("creates profile spaces with the profile default pattern", async () => {
    const profileDID = await deriveProfileSpaceDID(signer);
    const controller = await controllerForSpace(profileDID);

    const profileDefault = await controller.ensureProfileDefaultPattern();
    const value = profileDefault.getCell().get();

    expect(value?.[NAME]).toBe("ProfileHome");
    expect(fetchedPaths).toContain("/api/patterns/system/profile-home.tsx");
  });

  it("repairs profile spaces that already have an ordinary default pattern", async () => {
    const profileDID = await deriveProfileSpaceDID(signer);
    const controller = await controllerForSpace(profileDID);

    const ordinaryDefault = await controller.ensureDefaultPattern();
    expect(ordinaryDefault.getCell().get()?.[NAME]).toBe("DefaultPieceList");

    const profileDefault = await controller.ensureProfileDefaultPattern();
    expect(profileDefault.getCell().get()?.[NAME]).toBe("ProfileHome");
    expect(fetchedPaths).toContain("/api/patterns/system/default-app.tsx");
    expect(fetchedPaths).toContain("/api/patterns/system/profile-home.tsx");
  });

  it("keeps ordinary and home default pattern selection unchanged", async () => {
    const ordinarySession = await createSession({
      identity: signer,
      spaceName: "ordinary-default-" + crypto.randomUUID(),
    });
    const ordinaryManager = new PieceManager(ordinarySession, runtime);
    await ordinaryManager.synced();
    const ordinaryController = new PiecesController(ordinaryManager);
    controllers.push(ordinaryController);

    const ordinaryDefault = await ordinaryController.ensureDefaultPattern();
    expect(ordinaryDefault.getCell().get()?.[NAME]).toBe("DefaultPieceList");

    const homeController = await controllerForSpace(signer.did());
    const homeDefault = await homeController.ensureDefaultPattern();
    expect(homeDefault.getCell().get()?.[NAME]).toBe("Home");

    expect(fetchedPaths).toContain("/api/patterns/system/default-app.tsx");
    expect(fetchedPaths).toContain("/api/patterns/system/home.tsx");
    expect(fetchedPaths).not.toContain("/api/patterns/system/profile-home.tsx");
  });
});
