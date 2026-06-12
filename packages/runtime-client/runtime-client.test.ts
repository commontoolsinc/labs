import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { RuntimeClient } from "./runtime-client.ts";
import type { RuntimeTransport } from "./client/transport.ts";

describe("RuntimeClient.initialize option validation", () => {
  it("rejects an unknown renderDeclassificationPolicy loudly", async () => {
    // The policy is a security knob: a typo'd host config must surface as the
    // host's own error instead of silently flipping the worker to a fallback.
    // The check throws before the transport is used, so a stub suffices.
    const transport = {
      send: () => {
        throw new Error("transport must not be used");
      },
      dispose: () => Promise.resolve(),
      ready: () => Promise.resolve(),
      on: () => {},
      off: () => {},
    } as unknown as RuntimeTransport;
    const identity = await Identity.fromPassphrase(
      "runtime-client-option-validation",
    );

    await expect(
      RuntimeClient.initialize(transport, {
        apiUrl: new URL("http://localhost:9/"),
        identity,
        spaceDid: identity.did(),
        renderDeclassificationPolicy: "allow-all" as never,
      }),
    ).rejects.toThrow("Invalid renderDeclassificationPolicy");
  });
});
