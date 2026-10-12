import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { UI } from "../src/builder/types.ts";
import { wish } from "../src/builtins/wish.ts";
import type { Cell } from "../src/cell.ts";
import { resolveSpaceRootPattern } from "../src/ensure-space-root.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
} from "../src/index.ts";
import { isSigilLink } from "../src/link-types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const user = await Identity.fromPassphrase("wish home root user");
const home = user.did() as MemorySpace;
const patternSpace = (await Identity.fromPassphrase("wish home root pattern"))
  .did();

const HOME_PATH = "/api/patterns/system/home.tsx";

/**
 * The served patterns route, in-process: a Home root owning the lists a wish
 * reaches, and a profile create surface that hands back the `profiles` it is
 * handed. A test may take a route away.
 */
let files: Map<string, string>;

function servedFiles(): Map<string, string> {
  return new Map([
    [
      HOME_PATH,
      [
        "import { pattern, Writable } from 'commonfabric';",
        "export default pattern<void>(() => ({",
        "  profiles: new Writable<string[]>([]).for('profiles'),",
        "  favorites: new Writable<string[]>([]).for('favorites'),",
        "}));",
        "",
      ].join("\n"),
    ],
    [
      "/api/patterns/system/profile-create.tsx",
      [
        "import { pattern, Writable } from 'commonfabric';",
        "export default pattern<{ profiles: Writable<string[]> }>(",
        "  ({ profiles }) => ({ profiles }),",
        ");",
        "",
      ].join("\n"),
    ],
  ]);
}

const fetchStub: RuntimeFetch = (input) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  );
  const body = files.get(url.pathname);
  if (body === undefined) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  if (url.searchParams.has("identity")) {
    return resolveEntryIdentity(url.pathname, (name) => {
      const contents = files.get(name);
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`not found: ${name}`));
    }).then((identity) => new Response(identity));
  }
  return Promise.resolve(new Response(body));
};

describe("wish-home-root", () => {
  beforeEach(() => {
    files = servedFiles();
  });

  describe("on a client runtime", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pattern: ReturnType<typeof createTrustedBuilder>["commonfabric"][
      "pattern"
    ];
    let wishFn: ReturnType<typeof createTrustedBuilder>["commonfabric"][
      "wish"
    ];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: user });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        fetch: fetchStub,
      });
      ({ pattern, wish: wishFn } = createTrustedBuilder(runtime).commonfabric);
    });

    afterEach(async () => {
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    });

    /** Runs `query` as a wish in a space other than Home, and demands it. */
    async function runWish(query: string, label: string) {
      const wishPattern = pattern(() => ({ found: wishFn({ query }) }));
      const tx = runtime.edit();
      const resultCell = runtime.getCell<Record<string, any>>(
        patternSpace,
        label,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      expect((await tx.commit().settled).error).toBeUndefined();
      const stop = result.key("found").sink(() => {});
      await result.pull();
      await runtime.idle();
      return { found: result.key("found"), stop };
    }

    /** The raw `defaultPattern` slot of the Home space cell. */
    function homeSlot(): unknown {
      return (runtime.getCell(home, home).getRaw() as
        | { defaultPattern?: unknown }
        | undefined)?.defaultPattern;
    }

    it("creates the Home root before offering the profile create surface, which writes under it", async () => {
      const { found, stop } = await runWish("#profile", "profile wish");
      try {
        expect(isSigilLink(homeSlot())).toBe(true);
        const root = await resolveSpaceRootPattern(runtime, home);
        expect(getPatternIdentityRef(root!)).toBeDefined();

        const surface = found.key(UI).key("props").key("$cell")
          .resolveAsCell() as Cell<any>;
        await surface.pull();
        await runtime.idle();
        const tx = runtime.edit();
        surface.key("profiles").withTx(tx).push("Ada");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();

        expect((root as Cell<any>).key("profiles").get()).toEqual(["Ada"]);
        expect(isSigilLink(homeSlot())).toBe(true);
      } finally {
        stop();
      }
    });

    it("creates the Home root before resolving `#favorites`, so a write through the result lands under it", async () => {
      const { found, stop } = await runWish("#favorites", "favorites wish");
      try {
        expect(found.get()?.error).toBeUndefined();
        expect(isSigilLink(homeSlot())).toBe(true);
        const root = await resolveSpaceRootPattern(runtime, home);
        expect(getPatternIdentityRef(root!)).toBeDefined();

        const tx = runtime.edit();
        (found.key("result").withTx(tx) as Cell<any>).push("a favorite");
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();

        expect((root as Cell<any>).key("favorites").get()).toEqual([
          "a favorite",
        ]);
        expect(isSigilLink(homeSlot())).toBe(true);
      } finally {
        stop();
      }
    });

    it("reports a Home root that could not be created as the wish's error", async () => {
      files.delete(HOME_PATH);
      const { found, stop } = await runWish("#favorites", "unservable home");
      try {
        expect(String(found.get()?.error)).toContain("404");
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });
  });

  it("reports a Home with no root on a serving runtime, and creates none", async () => {
    const service = await Identity.fromPassphrase("wish home root service");
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const holder = executionLeaseHolder(service.did());
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: service,
      id: holder,
    });
    const lease = new ExecutionLeaseCycle({
      engine: await server.engineForSpace(service.did()),
      space: service.did(),
      holder,
    });
    expect(lease.acquire()).toBe(true);
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: fetchStub,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const cancels: (() => void)[] = [];
    try {
      const setup = runtime.edit();
      const parent = runtime.getCell(
        service.did(),
        "favorites consumer",
        undefined,
        setup,
      );
      parent.set({});
      const inputs = runtime.getCell(
        service.did(),
        "favorites wish arguments",
        undefined,
        setup,
      );
      inputs.set({ query: "#favorites", headless: true });
      expect((await setup.commit().settled).error).toBeUndefined();
      const observed: unknown[] = [];
      const action = wish(
        inputs as Cell<[unknown, unknown]>,
        (tx, value) => {
          observed.push((value as Cell<{ error?: string }>).withTx(tx).get());
        },
        (cancel) => cancels.push(cancel),
        [parent],
        parent,
        runtime,
      );
      const run = async () => {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "favorites wish",
          kind: "derivation",
          attributionFromScope: true,
          scopeKeyIdentity: { principal: home, sessionId: home },
        });
        action.action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.storageManager.crossSpaceSettled?.();
      };
      // The first run waits on the load of the Home space cell, and the second
      // finds it absent.
      await run();
      await run();
      expect(String((observed.at(-1) as { error?: string })?.error))
        .toContain("a serving runtime does not create one");
      expect(
        (runtime.getCell(home, home).getRaw() as
          | { defaultPattern?: unknown }
          | undefined)?.defaultPattern,
      ).toBeUndefined();
    } finally {
      cancels.forEach((cancel) => cancel());
      await runtime.dispose({ closeStorage: false });
      lease.release();
      await storageManager.close();
      await server.close();
    }
  });
});
