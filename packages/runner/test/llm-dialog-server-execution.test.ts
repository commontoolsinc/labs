// Wave G (serving gap): `llmDialog` must run server-side.
//
// Owner ruling 2026-07-29: "llmDialog should run entirely server-side. It does
// export handlers to the client to add a message etc., so those will for now
// have to run on the client. The server just waits for changes on the
// respective documents."
//
// That last clause is the whole contract this file pins. `addMessage` is an
// event handler, and handlers are client-inherent (client-passivity §1 point
// 1), so the peer that appends the user message is NOT the peer that must
// perform the model call. The dialog therefore has to be driven by DOCUMENT
// STATE — `result.pending` plus `internal.requestId` — and never by a closure
// variable the handler set in the same process.
//
// The end-to-end leg below runs two runtimes against ONE shared memory server,
// exactly like two real sessions. The "client" runtime declares
// `externalSinkDisposition: "suppress"` — which is also what a runtime gets by
// declaring nothing UNDER `serverPrimaryExecution`, so under that flag the
// declaration states the posture rather than selecting it. Declared here
// either way, because this file's topology is the server-primary one and the
// leg must not depend on a flag it never sets. The SERVER runtime has to say
// something regardless: it
// declares `"server-executor"`, the authority the terminal flip makes an
// executor earn. So the client can append the message but can never egress; if
// the dialog advances at all, the server runtime advanced it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm/client";
import { LLMClient } from "@commonfabric/llm";
import type { BuiltInLLMMessage, JSONSchema } from "@commonfabric/api";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import type { ServerBuiltinActionDescriptor } from "../src/builtins/server-execution.ts";

/**
 * Two storage managers over ONE in-process memory server model two real
 * sessions: a write by one reaches the other only through the server. Copied
 * from `array-push-mergeable.test.ts`, which introduced this shape.
 */
class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("llm-dialog server execution");
const space = signer.did();

const resultSchema = {
  type: "object",
  properties: {
    addMessage: { ...LLMMessageSchema, asCell: ["stream"] },
    pending: { type: "boolean" },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  required: ["addMessage"],
} as const satisfies JSONSchema;

/**
 * Build the dialog pattern through a given runtime's builder. Two peers
 * running the same piece each build it locally; the pattern hashes from its
 * source, so both address the same instance documents.
 */
function dialogPattern(runtime: Runtime) {
  const { commonfabric } = createTrustedBuilder(runtime);
  const { pattern, llmDialog, Cell } = commonfabric;
  return pattern(
    () => {
      const messages = Cell.of<BuiltInLLMMessage[]>([]);
      const dialog = llmDialog({ messages });
      return {
        addMessage: dialog.addMessage,
        pending: dialog.pending,
        messages,
      };
    },
    false,
    resultSchema,
  );
}

/** Poll a peer's own view until the dialog carries `count` messages. */
async function waitForMessageCount(
  runtime: Runtime,
  cell: { key(k: "messages"): { pull(): Promise<unknown> } },
  count: number,
  timeoutMs = 8000,
): Promise<readonly BuiltInLLMMessage[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = (await cell.key("messages").pull()) as
      | readonly BuiltInLLMMessage[]
      | undefined;
    if ((messages?.length ?? 0) >= count) return messages ?? [];
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} dialog messages (saw ${
          messages?.length ?? 0
        })`,
      );
    }
    await runtime.idle();
    // `clock.tick` rather than a wall-clock sleep: the package's fake clock
    // freezes a positive-delay timer armed from a `test/` file, so a real
    // sleep here deadlocks (see `test/clock-preload.ts`).
    await clock.tick(25);
  }
}

describe("llmDialog server-side execution", () => {
  let server: MemoryV2Server.Server;
  let clientStorage: SharedServerStorageManager;
  let serverStorage: SharedServerStorageManager;
  let sendRequestCalls: number;
  let restoreSendRequest: (() => void) | undefined;

  beforeEach(() => {
    resetMockMode();
    enableMockMode();
    clearMockResponses();
    server = newSharedServer();
    clientStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    serverStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    sendRequestCalls = 0;
    const original = LLMClient.prototype.sendRequest;
    LLMClient.prototype.sendRequest = function (...args) {
      sendRequestCalls++;
      return original.apply(this, args as never);
    };
    restoreSendRequest = () => {
      LLMClient.prototype.sendRequest = original;
    };
  });

  afterEach(async () => {
    restoreSendRequest?.();
    restoreSendRequest = undefined;
    await clientStorage?.close();
    await serverStorage?.close();
    await server?.close();
    resetMockMode();
  });

  it("advances a dialog whose message was appended by another peer's handler", async () => {
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes("Hello")
        ),
      { role: "assistant", content: "Hi there!", id: "cross-peer-r1" },
    );

    // The passive client: it may run handlers, but its external sinks are
    // suppressed — the same disposition a claimed effect reaches on a client
    // once the server owns the claim.
    const clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorage,
      externalSinkDisposition: "suppress",
    });
    // The server peer: it is the party that must perform the model call, so
    // it declares that authority. Declaring nothing means "suppress" under
    // server-primary execution, and a suppressed pair would leave the dialog
    // stuck forever.
    const serverRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: serverStorage,
      externalSinkDisposition: "server-executor",
    });

    try {
      const clientPattern = dialogPattern(clientRuntime);
      const serverPattern = dialogPattern(serverRuntime);

      const tx = clientRuntime.edit();
      const clientResult = clientRuntime.getCell(
        space,
        "llmDialog-cross-peer",
        resultSchema,
        tx,
      );
      clientRuntime.run(tx, clientPattern, {}, clientResult);
      await tx.commit();
      await clientRuntime.idle();

      // The server peer adopts the same piece — no event, no handler, just the
      // documents.
      const serverResult = serverRuntime.getCell(
        space,
        "llmDialog-cross-peer",
        resultSchema,
      );
      await serverRuntime.runSynced(serverResult, serverPattern);
      await serverRuntime.idle();

      // The handler runs on the client. `send` queues into the LOCAL scheduler
      // event queue, so the server peer never sees the event — only the writes
      // it produces.
      const addMessage = await clientResult.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Hello" });
      await clientRuntime.idle();

      const messages = await waitForMessageCount(
        serverRuntime,
        serverResult,
        2,
      );
      expect(messages[0].content).toBe("Hello");
      expect(messages[1].content).toBe("Hi there!");
      // Exactly one issuance: the suppressed client must not have egressed.
      expect(sendRequestCalls).toBe(1);
    } finally {
      await clientRuntime.dispose();
      await serverRuntime.dispose();
    }
  });

  // The cost of making the trigger document-driven: the announcement is now
  // visible to EVERY peer running the piece, not just the one whose handler
  // ran. With no server claim in play (flag-off, two browser tabs) nothing
  // suppresses either of them, and a second issuance is not merely double spend
  // — `executeToolCalls` runs before the `safelyPerformUpdate` requestId guard,
  // so both peers would execute the turn's tool calls for real.
  //
  // The turn is therefore CLAIMED in the document by whichever unsuppressed
  // peer's transaction lands first; the loser's commit conflicts on `internal`,
  // re-runs, sees the claim and stands down. Suppressed peers never claim, so a
  // passive client cannot deadlock the turn by winning the race against the
  // server that is supposed to run it.
  it("issues one request even when two unsuppressed peers see the same announcement", async () => {
    addMockResponse(
      (req) =>
        req.messages.some((m) =>
          typeof m.content === "string" && m.content.includes("Hello")
        ),
      { role: "assistant", content: "Hi there!", id: "two-peer-r1" },
    );

    // BOTH peers declare egress authority — that is what "unsuppressed" means
    // in the server-primary configuration, where a runtime declaring nothing
    // is "suppress". The scenario the comment above describes (two browser
    // tabs, flag off) can still produce it — the flag-off default is
    // "claim-conditional" — but declaring it here keeps the guard from
    // depending on which default the flag selects, and the guard is unchanged
    // in substance and is if anything
    // more load-bearing: two runtimes that each MAY egress must still issue
    // exactly one request, and the only thing stopping the second is the
    // document-level turn claim. A suppressed peer here would satisfy
    // `sendRequestCalls === 1` without exercising that claim at all.
    const peerA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorage,
      externalSinkDisposition: "server-executor",
    });
    const peerB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: serverStorage,
      externalSinkDisposition: "server-executor",
    });

    try {
      const patternA = dialogPattern(peerA);
      const patternB = dialogPattern(peerB);

      const tx = peerA.edit();
      const resultA = peerA.getCell(
        space,
        "llmDialog-two-peers",
        resultSchema,
        tx,
      );
      peerA.run(tx, patternA, {}, resultA);
      await tx.commit();
      await peerA.idle();

      const resultB = peerB.getCell(space, "llmDialog-two-peers", resultSchema);
      await peerB.runSynced(resultB, patternB);
      await peerB.idle();

      const addMessage = await resultA.key("addMessage").pull();
      addMessage.send({ role: "user", content: "Hello" });
      await peerA.idle();

      const messages = await waitForMessageCount(peerA, resultA, 2);
      expect(messages[1].content).toBe("Hi there!");
      // Let the loser's conflict retry land before counting.
      await peerB.idle();
      await clock.tick(200);
      await peerA.idle();
      expect(sendRequestCalls).toBe(1);
    } finally {
      await peerA.dispose();
      await peerB.dispose();
    }
  });
});

describe("llmDialog server broker route", () => {
  beforeEach(() => {
    // This suite deliberately runs WITHOUT mock mode: reaching the real
    // `sendRequest` body is what proves the broker options were handed over.
    // The LLM client's test-environment guard throws unless the options are
    // `isInternalLLMBrokerRequestOptions`, so an unbrokered llmDialog fails
    // here rather than quietly dialing `globalThis.fetch`.
    resetMockMode();
  });

  it("routes the dialog's model call through the broker and declares what it writes", async () => {
    let descriptor: ServerBuiltinActionDescriptor | undefined;
    // Every document any llmDialog-authored commit touched, minus the ones the
    // same commit creates whole. The ASYNC writebacks count: the post-commit
    // outbox flush and the `runtime.editWithRetry` inside it run under
    // `runWithTransactionSourceAction`, so those transactions carry this action
    // as their sourceAction and the executor synthesizes a continuation
    // observation for them against this same descriptor
    // (`synthesizeBuiltinContinuationObservation`).
    const touchedDocuments = new Set<string>();
    const storageManager = StorageManager.emulate({
      as: signer,
      actionTransactionRouter: (input) => {
        const annotated = input.sourceAction as
          | { serverBuiltin?: ServerBuiltinActionDescriptor }
          | undefined;
        if (annotated?.serverBuiltin?.id === "llmDialog") {
          descriptor = annotated.serverBuiltin;
          for (const operation of input.commit.operations) {
            if (operation.op === "sqlite") continue;
            // Mirror the executor's own admissions rather than asserting a
            // stricter surface than it enforces: a canonical schema document
            // (`cid:`) and a fresh `of:` document the same commit creates whole
            // — the shape every split `[ID]` message doc takes — are admitted
            // by `canonicalSchemaDocumentWriteAddresses` /
            // `sameTransactionMaterializedDocuments`.
            if (operation.id.startsWith("cid:")) continue;
            const proofReads = input.commit.reads.confirmed.filter((read) =>
              read.id === operation.id &&
              (read.scope ?? "space") === (operation.scope ?? "space") &&
              read.seq === 0
            );
            const provesFresh = operation.op === "set" &&
              (proofReads.some((read) => read.path.length === 0) ||
                ["cfc", "value"].every((field) =>
                  proofReads.some((read) =>
                    read.path.length === 1 && read.path[0] === field
                  )
                ));
            if (provesFresh) continue;
            touchedDocuments.add(operation.id);
          }
        }
        return { disposition: "upstream" };
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      patternEnvironment: { apiUrl: new URL("http://host-a.test/") },
      storageManager,
      experimental: { serverPrimaryExecution: true },
      // Sole party performing the effect under test, so it declares that
      // authority; a runtime that declares nothing is "suppress" (runtime.ts).
      externalSinkDisposition: "server-executor",
    });
    const brokered: Array<{ builtinId: string; url: string }> = [];
    runtime.installServerBuiltinFetch((builtinId, url) => {
      brokered.push({ builtinId, url });
      return Promise.resolve(
        Response.json({ role: "assistant", content: "brokered" }),
      );
    });
    try {
      const testPattern = dialogPattern(runtime);
      const tx = runtime.edit();
      const result = runtime.getCell(
        space,
        "llmDialog-server-broker-route",
        resultSchema,
        tx,
      );
      runtime.run(tx, testPattern, {}, result);
      await tx.commit();
      await runtime.idle();

      const addMessage = await result.key("addMessage").pull();
      addMessage.send({ role: "user", content: "route me" });
      await runtime.idle();
      await waitForMessageCount(runtime, result, 2);

      expect(brokered).toEqual([
        { builtinId: "llmDialog", url: "/api/ai/llm" },
      ]);

      expect(descriptor).toBeDefined();
      const declared = new Set<string>([
        ...(descriptor?.writes ?? []).map((link) => link.id),
        ...(descriptor?.runtimeWrites ?? []).map((link) => link.id),
      ]);

      // The whole point of `serverBuiltinRuntimeWrites`: nothing here is a
      // registered output cell, so the generically minted descriptor cannot see
      // any of it. FOUR documents, not three — the three llmDialog mints
      // (result / internal / pinnedCells) plus the transcript, which is its
      // INPUT and also where every assistant turn and tool result is appended.
      const runtimeWriteIds = new Set<string>(
        (descriptor?.runtimeWrites ?? []).map((link) => link.id),
      );
      expect(runtimeWriteIds.size).toBe(4);
      // The transcript is the one that is simultaneously a declared read. Pin
      // it by that relation rather than by an opaque id: dropping it is the
      // regression that silently de-claims every dialog turn.
      const readIds = new Set<string>(
        (descriptor?.reads ?? []).map((link) => link.id),
      );
      expect(
        [...runtimeWriteIds].filter((id) => readIds.has(id)).length,
      ).toBe(1);

      // Nothing the action or its async writebacks touched falls outside the
      // declared surface, once the executor's own fresh-document admissions are
      // applied. An undeclared document here is a run that de-claims fail-closed
      // — which hands the dialog back to the client and re-opens double egress.
      expect([...touchedDocuments].filter((id) => !declared.has(id))).toEqual(
        [],
      );
      expect(touchedDocuments.size).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
