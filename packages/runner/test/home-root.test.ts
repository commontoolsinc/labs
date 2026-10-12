import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { bringUpHomeRootForWrites } from "../src/home-root.ts";
import { Runtime, type RuntimeFetch } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const user = await Identity.fromPassphrase("home root user");
const home = user.did() as MemorySpace;
const service = await Identity.fromPassphrase("home root service");
const elsewhere = (await Identity.fromPassphrase("home root elsewhere"))
  .did() as MemorySpace;

describe("home-root", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  /** The URLs fetched so far. Nothing is served, so each fetch is a 404. */
  let fetched: string[];

  const fetch: RuntimeFetch = (input) => {
    fetched.push(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  /** A runtime acting as `as`, serving or not. */
  function makeRuntime(as: Identity, servingPosture: boolean): Runtime {
    fetched = [];
    storageManager = StorageManager.emulate({ as });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
      ...(servingPosture
        ? { servingPosture, experimental: { serverExecution: true } }
        : {}),
    });
    return runtime;
  }

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /** A cell beneath the empty `defaultPattern` slot of `space`'s space cell. */
  function beneathSlot(rt: Runtime, space: MemorySpace): Cell<unknown> {
    return (rt.getSpaceCell(space) as Cell<any>).key("defaultPattern")
      .key("profiles");
  }

  it("starts the Home root's creation for handler state beneath Home's empty slot", async () => {
    const rt = makeRuntime(user, false);
    const tx = rt.edit();

    await expect(
      bringUpHomeRootForWrites(
        rt,
        { $ctx: { profiles: beneathSlot(rt, home) }, $event: {} },
        tx,
      ),
    ).rejects.toThrow("404");
    tx.abort();

    expect(fetched.some((url) => url.includes("/system/home.tsx"))).toBe(true);
  });

  it("fetches nothing for handler state that reaches no Home slot", async () => {
    const rt = makeRuntime(user, false);
    const tx = rt.edit();

    await bringUpHomeRootForWrites(
      rt,
      { $ctx: { profiles: beneathSlot(rt, elsewhere) }, $event: {} },
      tx,
    );
    tx.abort();

    expect(fetched).toEqual([]);
  });

  it("fetches nothing on a serving runtime, which creates no Home root", async () => {
    const rt = makeRuntime(service, true);
    const tx = rt.edit();

    await bringUpHomeRootForWrites(
      rt,
      { $ctx: { profiles: beneathSlot(rt, service.did() as MemorySpace) } },
      tx,
    );
    tx.abort();

    expect(fetched).toEqual([]);
  });
});
