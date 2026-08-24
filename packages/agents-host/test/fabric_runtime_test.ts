/**
 * Startup cancellation for the agent host's fabric runtime. Every stage after
 * the runtime exists is cancellable through `stage()`; the stages before it
 * are cancellable only because each one is either synchronous or carries the
 * signal itself, and the deployment posture is the one that talks to the
 * network before anything has been allocated to clean up.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { openAgentFabricRuntime } from "../src/fabric-runtime.ts";

describe("fabric-runtime", () => {
  describe("openAgentFabricRuntime()", () => {
    let identityPath: string;
    let realFetch: typeof globalThis.fetch;

    beforeEach(async () => {
      identityPath = await Deno.makeTempFile({ suffix: ".key" });
      await Deno.writeFile(identityPath, await Identity.generatePkcs8());
      realFetch = globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = realFetch;
      await Deno.remove(identityPath);
    });

    it("hands the deployment-posture request its startup signal", async () => {
      // Cancelling while the deployment is silent has to surface as a
      // rejection. Without the signal on that request the host would sit here
      // for as long as the deployment stayed quiet, past the point where its
      // own shutdown asked it to stop, and with nothing yet allocated able to
      // notice.
      const controller = new AbortController();
      let sawSignal = false;
      globalThis.fetch = (_input, init) => {
        sawSignal = init?.signal === controller.signal;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
          );
          // The cancellation arrives with the request in flight.
          controller.abort(new Error("shutting down"));
        });
      };

      await expect(openAgentFabricRuntime({
        apiUrl: "https://deployment.example",
        identityPath,
        space: "a-space-of-its-own",
        signal: controller.signal,
      })).rejects.toThrow("shutting down");
      expect(sawSignal).toBe(true);
    });

    it("refuses an identity file it cannot read, before any request", async () => {
      let requested = false;
      globalThis.fetch = () => {
        requested = true;
        return Promise.resolve(new Response(null, { status: 503 }));
      };

      await expect(openAgentFabricRuntime({
        apiUrl: "https://deployment.example",
        identityPath: `${identityPath}.absent`,
        space: "a-space-of-its-own",
      })).rejects.toThrow(Deno.errors.NotFound);
      expect(requested).toBe(false);
    });
  });
});
