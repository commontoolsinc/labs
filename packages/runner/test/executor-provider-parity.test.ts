import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

Deno.test("executor host provider commits through authenticated memory without a Worker key", async () => {
  const hostSigner = await Identity.fromPassphrase(
    `executor host provider ${crypto.randomUUID()}`,
  );
  const space = hostSigner.did();
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-provider-test",
    },
  });
  const channel = createHostProviderChannel({
    server,
    space,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: hostSigner.did() },
    }),
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: hostSigner.did(),
    space,
  });

  try {
    const signing = await storage.as.sign(new Uint8Array() as never);
    assert(signing.error instanceof Error);
    assertEquals(
      signing.error.message,
      "executor provider principal has no Worker signing key",
    );

    const replica = storage.open(space).replica;
    assert(replica.commitNative);
    const result = await replica.commitNative({
      operations: [{
        op: "set",
        id: "of:executor-provider:test",
        type: "application/json",
        value: { value: { authenticated: true } },
      }],
    });
    assertEquals(result.error, undefined);
    assertEquals(
      await server.readDocument(space, "of:executor-provider:test"),
      { value: { authenticated: true } },
    );
  } finally {
    await storage.close();
    await channel.dispose();
    await server.close();
  }
});
