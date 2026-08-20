// cell-bridge-default-loader.test.ts — the loader a bridge uses when the
// caller injected none: the identity file the mount was started with, opened
// against the mount's API.
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { CellBridge } from "./cell-bridge.ts";
import { FsTree } from "./tree.ts";

describe("CellBridge", () => {
  describe("instance members", () => {
    describe("connectSpace()", () => {
      const apiUrl = "http://toolshed.test/";
      let identityPath: string;
      let requested: string[];
      let realFetch: typeof globalThis.fetch;

      beforeEach(async () => {
        identityPath = await Deno.makeTempFile({ suffix: ".key" });
        await Deno.writeFile(identityPath, await Identity.generatePkcs8());
        requested = [];
        realFetch = globalThis.fetch;
        globalThis.fetch = (input: string | URL | Request) => {
          requested.push(
            input instanceof Request ? input.url : input.toString(),
          );
          return Promise.resolve(new Response(null, { status: 503 }));
        };
      });

      afterEach(async () => {
        globalThis.fetch = realFetch;
        await Deno.remove(identityPath);
      });

      it("connects through the mount's API when no loader was injected", async () => {
        const bridge = new CellBridge(new FsTree());
        bridge.init({ apiUrl, identity: identityPath });
        await expect(bridge.connectSpace("home")).rejects.toThrow(
          'Could not connect to "http://toolshed.test/".',
        );
        expect(requested).toEqual(["http://toolshed.test/_health"]);
      });

      it("throws when the identity file is not readable", async () => {
        const bridge = new CellBridge(new FsTree());
        bridge.init({ apiUrl, identity: `${identityPath}.absent` });
        await expect(bridge.connectSpace("home")).rejects.toThrow(
          Deno.errors.NotFound,
        );
        expect(requested).toEqual([]);
      });
    });
  });
});
