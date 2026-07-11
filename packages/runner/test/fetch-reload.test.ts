import { expect } from "@std/expect";

import { isDataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("fetch reload preservation");
const space = signer.did();

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(spaceId: MemorySpace, sessionSigner?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      spaceId,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: sessionSigner?.did() },
      }),
    );
    return { client, session };
  }
}

class SharedServerStorageManager extends StorageManager {
  static overServer(
    as: Identity,
    server: MemoryV2Server.Server,
  ): SharedServerStorageManager {
    return new SharedServerStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      new LoopbackSessionFactory(server),
    );
  }
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { fetchProgram, fetchText, pattern } from 'commonfabric';",
      "export default pattern(() => ({",
      "  text: fetchText({ url: 'https://fetch.test/value.txt' }),",
      "  program: fetchProgram({ url: 'https://fetch.test/program.ts' }),",
      "}));",
    ].join("\n"),
  }],
};

Deno.test("fetch results and claims survive a cold runtime reload", async () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
  const storageA = SharedServerStorageManager.overServer(signer, server);
  const storageB = SharedServerStorageManager.overServer(signer, server);
  const originalFetch = globalThis.fetch;
  let phase: "create" | "reload" = "create";
  let createFetches = 0;
  let reloadFetches = 0;
  globalThis.fetch = (
    input: string | URL | Request,
  ): Promise<Response> => {
    if (phase === "create") createFetches++;
    else reloadFetches++;
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(
      url.endsWith("program.ts")
        ? new Response("export const durable = true;\n", { status: 200 })
        : new Response("durable text", { status: 200 }),
    );
  };

  const runtimeA = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storageA,
  });
  let runtimeB: Runtime | undefined;
  try {
    const compiled = await runtimeA.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = runtimeA.edit();
    const resultA = runtimeA.getCell(
      space,
      "fetch-reload-result",
      compiled.resultSchema,
      tx,
    );
    const runningA = runtimeA.run(tx, compiled, {}, resultA);
    await tx.commit();
    for (let index = 0; index < 6; index++) {
      await runningA.pull();
      await runtimeA.settled();
      await runtimeA.idle();
    }
    await runtimeA.patternManager.flushCompileCacheWrites();
    await storageA.synced();

    expect(resultA.key("text").getAsQueryResult()).toBe("durable text");
    expect(
      (resultA.key("program").getAsQueryResult() as {
        files?: Array<{ contents?: string }>;
      }).files?.[0]?.contents,
    ).toContain("durable = true");
    expect(createFetches).toBe(2);
    runtimeA.scheduler.dispose();

    phase = "reload";
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
    await runtimeB.patternManager.compilePattern(PROGRAM, { space });
    const reloadTx = runtimeB.edit();
    const resultB = runtimeB.getCell(
      space,
      "fetch-reload-result",
      compiled.resultSchema,
      reloadTx,
    );
    await reloadTx.commit();
    const reloadValues: unknown[] = [];
    const cancelText = resultB.key("text").sink((value) => {
      reloadValues.push(value);
    });
    const cancelProgram = resultB.key("program").sink((value) => {
      reloadValues.push(value);
    });
    try {
      expect(await runtimeB.start(resultB)).toBe(true);
      for (let index = 0; index < 6; index++) {
        await resultB.pull();
        await runtimeB.settled();
        await runtimeB.idle();
      }
    } finally {
      cancelText();
      cancelProgram();
    }

    expect(resultB.key("text").getAsQueryResult()).toBe("durable text");
    expect(
      (resultB.key("program").getAsQueryResult() as {
        files?: Array<{ contents?: string }>;
      }).files?.[0]?.contents,
    ).toContain("durable = true");
    expect(reloadFetches).toBe(0);
    // A cold replica may briefly publish pending while the builtin's private
    // cache/result cells load. It must not surface a false error/mismatch or
    // issue another request, and it must converge to the durable success.
    expect(
      reloadValues.filter(isDataUnavailable).every((value) =>
        value.reason === "pending"
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    await runtimeB?.dispose();
    await runtimeA.dispose();
    await storageA.close();
    await storageB.close();
    await server.close();
  }
});
