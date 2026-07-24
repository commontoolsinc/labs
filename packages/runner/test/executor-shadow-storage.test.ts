import { assertEquals } from "@std/assert";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

const SPACE = "did:key:z6Mk-executor-shadow-storage" as MemorySpace;
const PRINCIPAL = "did:key:z6Mk-executor-shadow-sponsor" as MemorySpace;
const OUTPUT = "of:executor-shadow-output" as URI;

Deno.test("executor shadow storage keeps derived values local and sends zero data operations", async () => {
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: {
      audience: "did:key:z6Mk-executor-shadow-audience",
    },
  });
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: PRINCIPAL },
    }),
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: PRINCIPAL,
    space: SPACE,
    shadowWrites: true,
  });

  try {
    const provider = storage.open(SPACE);
    const result = await provider.replica.commitNative!({
      operations: [{
        op: "set",
        id: OUTPUT,
        type: "application/json",
        value: { value: { doubled: 42 } },
      }],
    });

    assertEquals(result, { ok: {} });
    assertEquals(
      provider.replica.get({ id: OUTPUT, type: "application/json" })?.is,
      { value: { doubled: 42 } },
    );
    assertEquals(await server.readDocument(SPACE, OUTPUT), null);
  } finally {
    await storage.close();
    await channel.dispose();
    await server.close();
  }
});
