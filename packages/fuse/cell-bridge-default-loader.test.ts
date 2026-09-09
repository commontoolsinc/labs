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
        // The deployment's experimental posture first, because it decides
        // how the runtime is constructed; then the health probe that decides
        // whether to connect at all. The stub answers 503 to both, and a
        // non-OK posture response is read as an absent posture, which is why
        // the bridge goes on to the health probe and fails there.
        expect(requested).toEqual([
          "http://toolshed.test/api/meta",
          "http://toolshed.test/_health",
        ]);
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
