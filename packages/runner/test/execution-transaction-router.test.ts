import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  type ActionTransactionRouteInput,
  type Options,
  type SessionFactory,
  StorageManager,
  toCanonicalExecutionUnservedCommit,
} from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase(
  "execution transaction router test principal",
);
const SPACE = signer.did() as MemorySpace;
const OUTPUT = "of:execution-router-output" as URI;

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: Server) {}

  async create(
    space: MemorySpace,
    activeSigner?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.server),
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: activeSigner?.did() },
      }),
    );
    return { client, session };
  }
}

class RoutedStorageManager extends StorageManager {
  static connect(
    server: Server,
    route: Options["actionTransactionRouter"],
  ): RoutedStorageManager {
    return new RoutedStorageManager(
      {
        as: signer,
        memoryHost: new URL("memory://execution-router"),
        shadowWrites: true,
        actionTransactionRouter: route,
      },
      new LoopbackSessionFactory(server),
    );
  }
}

async function withServer(
  route: Options["actionTransactionRouter"],
  run: (
    server: Server,
    storage: RoutedStorageManager,
  ) => Promise<void>,
): Promise<void> {
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-execution-router-audience" },
  });
  const storage = RoutedStorageManager.connect(server, route);
  try {
    await run(server, storage);
  } finally {
    await storage.close();
    await server.close();
  }
}

Deno.test("action transaction router keeps executor-shadow writes local", async () => {
  const routed: ActionTransactionRouteInput[] = [];
  await withServer((input) => {
    routed.push(input);
    return { disposition: "local", kind: "executor-shadow" };
  }, async (server, storage) => {
    const result = await storage.open(SPACE).replica.commitNative!({
      operations: [{
        op: "set",
        id: OUTPUT,
        type: "application/json",
        value: { value: { route: "shadow" } },
      }],
    });

    assertEquals(result, { ok: {} });
    assertEquals(routed.length, 1);
    assertEquals(routed[0]?.space, SPACE);
    assertEquals(routed[0]?.commit.operations.length, 1);
    assertEquals(await server.readDocument(SPACE, OUTPUT), null);
  });
});

Deno.test("action transaction router can send an exact action upstream", async () => {
  await withServer(
    () => ({ disposition: "upstream" }),
    async (server, storage) => {
      const result = await storage.open(SPACE).replica.commitNative!({
        operations: [{
          op: "set",
          id: OUTPUT,
          type: "application/json",
          value: { value: { route: "upstream" } },
        }],
      });

      assertEquals(result, { ok: {} });
      assertEquals(await server.readDocument(SPACE, OUTPUT), {
        value: { route: "upstream" },
      });
    },
  );
});

Deno.test("claimed rerun can discard only its earlier executor-shadow writes", async () => {
  const sourceAction = {};
  await withServer(
    () => ({ disposition: "local", kind: "executor-shadow" }),
    async (_server, storage) => {
      const tx = storage.edit();
      tx.sourceAction = sourceAction;
      const writer = tx.writer(SPACE);
      if (writer.error) throw writer.error;
      const written = writer.ok.write({
        id: OUTPUT,
        type: "application/json",
        path: ["value"],
      }, { route: "shadow" });
      if (written.error) throw written.error;
      assertEquals(await tx.commit(), { ok: {} });
      assertEquals(
        storage.open(SPACE).replica.get({
          id: OUTPUT,
          type: "application/json",
        })?.is,
        { value: { route: "shadow" } },
      );

      storage.discardShadowWritesForAction(SPACE, sourceAction);
      assertEquals(
        storage.open(SPACE).replica.get({
          id: OUTPUT,
          type: "application/json",
        })?.is,
        undefined,
      );
    },
  );
});

Deno.test("canonical unserved settlement strips rejected write and merge metadata", () => {
  const schedulerObservation = {
    actionId: "action:unserved-shape",
    executionClaimAssertion: {
      contextKey: "space",
      leaseGeneration: 3,
      claimGeneration: 5,
    },
  };
  const commit = toCanonicalExecutionUnservedCommit(
    {
      localSeq: 4,
      reads: {
        confirmed: [{ id: "of:input", path: "/value", seq: 7 }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: "of:output",
        value: { value: "must-not-land" },
      }],
      preconditions: [{ kind: "entity-absent", id: "of:output" }],
      schedulerObservation,
      schedulerObservationBatch: [{
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        schedulerObservation: { actionId: "batched" },
      }],
      merge: {
        sourceBranch: "source",
        sourceSeq: 6,
        baseBranch: "",
        baseSeq: 5,
      },
    },
    9,
    "dynamic-branch-merge",
  );

  assertEquals(commit, {
    localSeq: 9,
    reads: {
      confirmed: [{ id: "of:input", path: "/value", seq: 7 }],
      pending: [],
    },
    operations: [],
    schedulerObservation: {
      ...schedulerObservation,
      executionUnservedAttempt: {
        diagnosticCode: "dynamic-branch-merge",
      },
    },
  });
});
