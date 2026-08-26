import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { getPatternSource, setPatternSource } from "../src/runner.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { NAME, UI } from "../src/builder/types.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";

// A wish sidecar (the profile create/picker surface, the suggestion surface)
// is minted by the wish builtin through `runtime.runner.run`, not through the
// controller paths that stamp `patternSource` — so without the stamp threaded
// through `RunnerRunOptions.patternSource`, the minted piece carries only its
// content-addressed compile identity and the pattern updater has no route to
// follow: the piece stays pinned to the compile of the day it was minted.
// Pinned here: the sidecar piece is born carrying the `system:` ref of the
// route its pattern was fetched from, and a piece that already carries a
// source keeps it.
const signer = await Identity.fromPassphrase("wish-sidecar-pattern-source");
const homeSpace = signer.did();

const read = (name: string) =>
  Deno.readTextFileSync(
    fromFileUrl(new URL("../../patterns/system/", import.meta.url)) + name,
  );

const WISH_SRC = [
  "import { pattern, wish } from 'commonfabric';",
  "export default pattern(() => ({",
  "  profile: wish({ query: '#profile' }),",
  "}));",
].join("\n");

const WISH_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: WISH_SRC }],
};

const PLAIN_SRC = [
  "import { pattern } from 'commonfabric';",
  "export default pattern(() => ({ ok: true }));",
].join("\n");

const PLAIN_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: PLAIN_SRC }],
};

describe("wish sidecar patternSource stamp", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: ReturnType<typeof getPatternEnvironment>;

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    originalFetch = globalThis.fetch;
    originalEnvironment = getPatternEnvironment();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalEnvironment);
    await manager?.close();
    await server?.close();
  });

  it("stamps the minted create-surface piece with the system: ref of the pattern it runs", async () => {
    // A unique pattern-environment origin keys this test's entry in the
    // module-global sidecar cache (the cache memoizes per URL).
    setPatternEnvironment({
      apiUrl: new URL("https://sidecar-pattern-source.test/"),
    });

    // Serve the REAL profile-create.tsx (+ its profile-home.tsx import).
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("profile-create.tsx")) {
        return Promise.resolve(
          new Response(read("profile-create.tsx"), { status: 200 }),
        );
      }
      if (url.includes("profile-home.tsx")) {
        return Promise.resolve(
          new Response(read("profile-home.tsx"), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    const rt = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
    });
    try {
      // Home space with a profile-less default pattern: `#profile` resolves
      // to the missing-profile state, whose UI is the create surface.
      const setupTx = rt.edit();
      const homeSpaceCell = rt.getSpaceCell(homeSpace);
      const homeDefault = rt.getCell(
        homeSpace,
        "pattern-source-home-default",
        undefined,
        setupTx,
      );
      homeDefault.key("marker").set("home");
      // deno-lint-ignore no-explicit-any
      (homeSpaceCell.withTx(setupTx) as any).key("defaultPattern").set(
        homeDefault,
      );
      rt.prepareTxForCommit(setupTx);
      const setupCommit = await setupTx.commit();
      expect(setupCommit.error).toBeUndefined();

      const tx = rt.edit();
      const wishPattern = await rt.patternManager.compilePattern(WISH_PROGRAM, {
        space: homeSpace,
        tx,
      });
      const result = rt.getCell<Record<string, unknown>>(
        homeSpace,
        "wish-sidecar-pattern-source-result",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const run = rt.run(tx, wishPattern as any, {}, result);
      rt.prepareTxForCommit(tx);
      const commit = await tx.commit();
      expect(commit.error).toBeUndefined();

      // Demand drives the wish action, which launches the create sidecar;
      // the tracked launch is covered by idle().
      await run.pull();
      await rt.idle();
      await run.pull();

      const createCell = run.key("profile").key(UI).key("props").key("$cell")
        .resolveAsCell();
      await createCell.sync();
      await createCell.pull();

      // Vacuity killer: the sidecar actually materialized — the stamp
      // assertion below is about a piece that exists.
      const surface = createCell.get() as Record<string | symbol, unknown>;
      expect(surface?.[NAME]).toBe("Create Profile");

      expect(getPatternSource(createCell)).toBe(
        "system:system/profile-create.tsx",
      );
    } finally {
      await rt.dispose();
    }
  });

  it("keeps a piece's existing patternSource over the run option's ref", async () => {
    const rt = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
    });
    try {
      const tx = rt.edit();
      const plainPattern = await rt.patternManager.compilePattern(
        PLAIN_PROGRAM,
        { space: homeSpace, tx },
      );

      const stamped = rt.getCell<Record<string, unknown>>(
        homeSpace,
        "pattern-source-already-stamped",
        undefined,
        tx,
      );
      setPatternSource(stamped, tx, "cf:existing/ref");
      // deno-lint-ignore no-explicit-any
      rt.run(tx, plainPattern as any, {}, stamped, {
        patternSource: "system:system/profile-create.tsx",
      });

      const detached = rt.getCell<Record<string, unknown>>(
        homeSpace,
        "pattern-source-detached",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      rt.run(tx, plainPattern as any, {}, detached, {
        patternSource: "system:system/profile-create.tsx",
      });

      rt.prepareTxForCommit(tx);
      const commit = await tx.commit();
      expect(commit.error).toBeUndefined();

      expect(getPatternSource(stamped)).toBe("cf:existing/ref");
      expect(getPatternSource(detached)).toBe(
        "system:system/profile-create.tsx",
      );
    } finally {
      await rt.dispose();
    }
  });
});
