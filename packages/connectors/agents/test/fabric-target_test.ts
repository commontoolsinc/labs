import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { AgentFabricTarget } from "../src/fabric.ts";
import {
  pushStableCellGraph,
  readStableCellGraphValue,
} from "../src/fabric-graph.ts";
import {
  materializeStableArrayCells,
  planStableArrayCells,
} from "../src/array-cell-identity.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "../src/protocol.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SourceDescriptor,
} from "../src/types.ts";
import { commandReceiptCause, sessionCause } from "../src/session-contract.ts";

Deno.test("Fabric target publishes sessions and command receipts", async () => {
  const signer = await Identity.fromPassphrase("agent connector target test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const writeReceiptIndex = async (value: Record<string, unknown>) => {
      const plan = await planStableArrayCells(value, {
        spaceDid: space,
        agentConnector: "receipt-index-test-array-elements",
        version: 1,
      });
      await pushStableCellGraph(connection, [{
        cell: target.cells.receipts,
        value: (materializeCell) =>
          materializeStableArrayCells(
            plan,
            materializeCell,
          ) as Record<string, unknown>,
      }]);
    };
    const source: SourceDescriptor = {
      id: "codex:test",
      driver: "codex-app-server",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    };
    const snapshot: NativeSessionSnapshot = {
      summary: {
        nativeSessionId: "session-1",
        title: "First session",
        cwd: null,
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: new Date().toISOString(),
        archived: false,
        active: false,
        raw: { id: "session-1", title: "First session" },
      },
      events: [{ type: "message", text: "hello" }],
      normalizedMessages: [{
        id: "message-1",
        role: "user",
        kind: "message",
        createdAt: "2026-07-17T10:00:00.000Z",
        textPreview: "hello",
        rawIndex: 0,
      }],
      complete: true,
      revision: "1",
    };

    const collected = [{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }];
    assertEquals(await target.publish(collected), 1);
    const index = await readStableCellGraphValue(
      connection,
      target.cells.index,
    ) as Record<string, unknown>;
    assertEquals(index.schema, AGENT_CONNECTOR_SCHEMAS.sessionIndex);
    assertEquals(
      (index.sessions as Array<Record<string, unknown>>).map((session) => ({
        key: session.key,
        driver: session.driver,
        title: session.title,
        archived: session.archived,
        active: session.active,
        syncStatus: session.syncStatus,
      })),
      [{
        key: "codex%3Atest/session-1",
        driver: "codex-app-server",
        title: "First session",
        archived: false,
        active: false,
        syncStatus: "complete",
      }],
    );
    const publishedSession =
      (index.sessions as Array<Record<string, unknown>>)[0];
    const publishedManifest = publishedSession.manifest as Record<
      string,
      unknown
    >;
    assertEquals(publishedManifest.nativeSessionId, "session-1");
    assertEquals(publishedManifest.driver, "codex-app-server");
    const publishedChunk = (publishedManifest.chunks as Array<
      Record<string, unknown>
    >)[0].link as Record<string, unknown>;
    assertEquals(publishedChunk.events, [{ type: "message", text: "hello" }]);
    assertEquals(await target.publish(collected), 1);

    const reconfiguredSource: SourceDescriptor = {
      ...source,
      driver: "acp",
    };
    assertEquals(
      await target.publish([{
        source: reconfiguredSource,
        sessions: [snapshot],
        errors: [],
        complete: true,
      }]),
      1,
    );
    const reconfiguredIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const reconfiguredSession =
      (reconfiguredIndex.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(reconfiguredSession.driver, "acp");
    assertEquals(
      (reconfiguredSession.manifest as Record<string, unknown>).driver,
      "acp",
    );

    assertEquals(
      await target.publish([{
        source,
        sessions: [],
        errors: [{
          nativeSessionId: snapshot.summary.nativeSessionId,
          message: "session read failed",
        }],
        complete: false,
      }]),
      1,
    );
    const partialIndex = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (partialIndex.sessions as Array<Record<string, unknown>>).map((
        entry,
      ) => ({
        nativeSessionId: entry.nativeSessionId,
        syncStatus: entry.syncStatus,
      })),
      [{ nativeSessionId: "session-1", syncStatus: "partial" }],
    );

    await target.publishReceipt({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "command-1",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "succeeded",
      claimedAt: "2026-07-17T10:01:00.000Z",
      completedAt: "2026-07-17T10:01:01.000Z",
    });
    assertEquals((await target.readReceipt("command-1"))?.status, "succeeded");
    assertEquals(await target.readReceipt("missing-command"), undefined);
    const receipts = await readStableCellGraphValue(
      connection,
      target.cells.receipts,
    ) as Record<string, unknown>;
    assertEquals(
      (receipts.receipts as Array<Record<string, unknown>>).map((receipt) => ({
        commandId: receipt.commandId,
        status: receipt.status,
      })),
      [{ commandId: "command-1", status: "succeeded" }],
    );

    const malformedReceipt = runtime.getCell(
      space,
      commandReceiptCause(space, "malformed-command"),
    );
    const malformedReceiptTx = runtime.edit();
    malformedReceipt.withTx(malformedReceiptTx).set({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "malformed-command",
      sourceId: source.id,
      nativeSessionId: snapshot.summary.nativeSessionId,
      status: "not-a-status",
    });
    const malformedReceiptCommit = await malformedReceiptTx.commit();
    if (malformedReceiptCommit.error) throw malformedReceiptCommit.error;
    await assertRejects(
      () => target.readReceipt("malformed-command"),
      Error,
      "command receipt status is invalid",
    );

    const malformedIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      receipts: "not-an-array",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await writeReceiptIndex(malformedIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index has an invalid shape",
    );
    assertEquals(
      await readStableCellGraphValue(connection, target.cells.receipts),
      malformedIndex,
    );

    const validRow = structuredClone(
      (receipts.receipts as Array<Record<string, unknown>>)[0],
    );
    const malformedRows: Array<{
      value: Record<string, unknown>;
      message: string;
    }> = [
      {
        value: { ...validRow, status: "not-a-status" },
        message: "command receipt index row 0 status is invalid",
      },
      {
        value: { ...validRow, receipt: {} },
        message: "command receipt index row receipt link is invalid",
      },
      {
        value: { ...validRow, error: { code: "broken" } },
        message: "command receipt index row 0 error is invalid",
      },
      {
        value: { ...validRow, nativeSessionId: " session-1 " },
        message: "nativeSessionId is not normalized",
      },
    ];
    for (const malformed of malformedRows) {
      const malformedRowIndex = {
        schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
        receipts: [malformed.value],
        updatedAt: "2026-07-20T00:00:00.000Z",
      };
      await writeReceiptIndex(malformedRowIndex);
      await assertRejects(
        () =>
          target.publishReceipt({
            schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
            commandId: "command-2",
            sourceId: source.id,
            nativeSessionId: snapshot.summary.nativeSessionId,
            status: "succeeded",
          }),
        Error,
        malformed.message,
      );
      assertEquals(
        await readStableCellGraphValue(connection, target.cells.receipts),
        malformedRowIndex,
      );
    }

    const malformedTimestampIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      receipts: [validRow],
      updatedAt: "not-a-timestamp",
    };
    await writeReceiptIndex(malformedTimestampIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index has an invalid shape",
    );

    const oversizedIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      receipts: Array.from({ length: 201 }, () => structuredClone(validRow)),
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    await writeReceiptIndex(oversizedIndex);
    await assertRejects(
      () =>
        target.publishReceipt({
          schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
          commandId: "command-2",
          sourceId: source.id,
          nativeSessionId: snapshot.summary.nativeSessionId,
          status: "succeeded",
        }),
      Error,
      "command receipt index exceeds 200 rows",
    );

    const receivedCommands = Promise.withResolvers<unknown[]>();
    const cancel = await target.subscribeCommands((commands) => {
      if (commands.length > 0) receivedCommands.resolve(commands);
    });
    try {
      const tx = runtime.edit();
      target.cells.commands.withTx(tx).set([{ id: "command-2" }]);
      const result = await tx.commit();
      if (result.error) throw result.error;
      assertEquals(await receivedCommands.promise, [{ id: "command-2" }]);
      assertEquals(await target.pollCommands(), [{ id: "command-2" }]);
    } finally {
      cancel();
    }

    const firstHealthCommitStarted = Promise.withResolvers<void>();
    const releaseFirstHealthCommit = Promise.withResolvers<void>();
    const originalEdit = runtime.edit;
    let blockNextCommit = true;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      if (blockNextCommit) {
        blockNextCommit = false;
        const originalCommit = tx.commit.bind(tx);
        tx.commit = async () => {
          firstHealthCommitStarted.resolve();
          await releaseFirstHealthCommit.promise;
          return await originalCommit();
        };
      }
      return tx;
    };
    let firstHealth: Promise<void> | undefined;
    let secondHealth: Promise<void> | undefined;
    try {
      firstHealth = target.publishHealth({ generation: "first" });
      await firstHealthCommitStarted.promise;
      let secondHealthStarted = false;
      const secondHealthValue: Record<string, unknown> = {};
      Object.defineProperty(secondHealthValue, "generation", {
        enumerable: true,
        get() {
          secondHealthStarted = true;
          return "second";
        },
      });
      secondHealth = target.publishHealth(secondHealthValue);
      assertFalse(secondHealthStarted);
    } finally {
      releaseFirstHealthCommit.resolve();
      await Promise.allSettled(
        [firstHealth, secondHealth].filter(
          (operation): operation is Promise<void> => operation !== undefined,
        ),
      );
      runtime.edit = originalEdit;
    }
    await Promise.all([firstHealth!, secondHealth!]);
    const serializedHealth = await readStableCellGraphValue(
      connection,
      target.cells.health,
    ) as Record<string, unknown>;
    assertEquals(serializedHealth.generation, "second");

    const invalidIndexScope = {
      spaceDid: space,
      agentConnector: "invalid-index-test-array-elements",
      version: 1,
    };
    const writeInvalidIndex = async (session: Record<string, unknown>) => {
      const invalidIndex = { ...index, sessions: [session] };
      const [invalidRecentPlan, invalidAllPlan] = await Promise.all([
        planStableArrayCells(
          { ...invalidIndex, bucket: "recent" },
          invalidIndexScope,
        ),
        planStableArrayCells(
          { ...invalidIndex, bucket: "all" },
          invalidIndexScope,
        ),
      ]);
      await pushStableCellGraph(connection, [{
        cell: target.cells.index,
        value: (materializeCell) =>
          materializeStableArrayCells(
            invalidRecentPlan,
            materializeCell,
          ) as Record<string, unknown>,
      }, {
        cell: target.cells.allIndex,
        value: (materializeCell) =>
          materializeStableArrayCells(
            invalidAllPlan,
            materializeCell,
          ) as Record<string, unknown>,
      }]);
    };
    const { driver: _driver, ...driverlessSession } = publishedSession;
    await writeInvalidIndex(driverlessSession);
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has no driver",
    );
    const { formatVersion: _formatVersion, ...unversionedSession } =
      publishedSession;
    await writeInvalidIndex(unversionedSession);
    await assertRejects(
      () => target.publish(collected),
      Error,
      "agent session index row 0 has an invalid formatVersion",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("an interrupted publication leaves the prior session graph intact", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector interrupted graph test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot = (
    title: string,
    events: unknown[],
  ): NativeSessionSnapshot => ({
    summary: {
      nativeSessionId: "session-1",
      title,
      cwd: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1", title },
    },
    events,
    normalizedMessages: [],
    complete: true,
  });
  try {
    const target = await AgentFabricTarget.open(connection);
    const sharedDetail = { value: 1 };
    await target.publish([{
      source,
      sessions: [snapshot("Before", [{
        id: "event-1",
        type: "message",
        detail: sharedDetail,
      }, {
        id: "event-2",
        type: "message",
        detail: sharedDetail,
      }])],
      errors: [],
      complete: true,
    }]);
    const manifest = runtime.getCell(
      space,
      sessionCause(space, source.id, "session-1"),
    );

    const originalEdit = runtime.edit;
    const manifestId = manifest.getAsNormalizedFullLink().id;
    runtime.edit = function () {
      const tx = originalEdit.call(this);
      let writesManifest = false;
      const originalWrite = tx.writeOrThrow.bind(tx);
      tx.writeOrThrow = (...args) => {
        if (args[0].id === manifestId) writesManifest = true;
        return originalWrite(...args);
      };
      const originalCommit = tx.commit.bind(tx);
      tx.commit = () => {
        if (!writesManifest) return originalCommit();
        const failure = Object.assign(
          new Error("manifest commit interrupted"),
          {
            name: "PreconditionFailedError" as const,
            precondition: "origin-committed" as const,
          },
        );
        tx.abort(failure);
        return Promise.resolve({ error: failure });
      };
      return tx;
    };
    try {
      await assertRejects(
        () =>
          target.publish([{
            source,
            sessions: [snapshot("After", [{
              id: "event-1",
              type: "message",
              detail: { value: 1 },
            }, {
              id: "event-2",
              type: "message",
              detail: linkRefFrom({ path: ["0", "detail"] }),
            }])],
            errors: [],
            complete: true,
          }]),
        Error,
        "manifest commit interrupted",
      );
    } finally {
      runtime.edit = originalEdit;
    }

    const retained = await readStableCellGraphValue(
      connection,
      manifest,
    ) as Record<string, unknown>;
    assertEquals(
      (retained.summary as Record<string, unknown>).title,
      "Before",
    );
    const descriptor = (retained.chunks as Array<Record<string, unknown>>)[0];
    const chunk = descriptor.link as Record<string, unknown>;
    assertEquals(descriptor.contentHash, chunk.contentHash);
    assertEquals(chunk.events, [{
      id: "event-1",
      type: "message",
      detail: { value: 1 },
    }, {
      id: "event-2",
      type: "message",
      detail: { value: 1 },
    }]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("session publication captures native values once", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector native value capture test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  let conversions = 0;
  const sharedNativeValue = {
    toJSON() {
      conversions++;
      return { value: `captured-${conversions}` };
    },
  };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Native values",
      cwd: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1" },
    },
    events: [{
      id: "event-1",
      first: sharedNativeValue,
      second: sharedNativeValue,
    }],
    normalizedMessages: [],
    complete: true,
  };
  try {
    const target = await AgentFabricTarget.open(connection);
    await target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
    assertEquals(conversions, 1);

    const manifest = runtime.getCell(
      space,
      sessionCause(space, source.id, "session-1"),
    );
    const published = await readStableCellGraphValue(
      connection,
      manifest,
    ) as Record<string, unknown>;
    const descriptor = (published.chunks as Array<
      Record<string, unknown>
    >)[0];
    const chunk = descriptor.link as Record<string, unknown>;
    assertEquals(chunk.events, [{
      id: "event-1",
      first: { value: "captured-1" },
      second: { value: "captured-1" },
    }]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("newer session refresh wins over an older full collection", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector observation ordering test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  try {
    const target = await AgentFabricTarget.open(connection);
    const source: SourceDescriptor = {
      id: "claude-code:test",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
      },
    };
    const snapshot = (
      active: boolean | null,
      title: string,
      nativeSessionId = "session-1",
    ): NativeSessionSnapshot => ({
      summary: {
        nativeSessionId,
        title,
        cwd: null,
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:01:00.000Z",
        archived: null,
        active,
        raw: { id: nativeSessionId, title },
      },
      events: [],
      normalizedMessages: [],
      complete: true,
      revision: title,
    });

    const olderObservation = target.beginSessionObservation();
    const olderCollectionObserved = Promise.withResolvers<void>();
    const releaseOlderCollection = Promise.withResolvers<void>();
    const olderPublication = (async () => {
      const collected = [{
        source,
        sessions: [snapshot(true, "Running snapshot")],
        errors: [],
        complete: true,
      }];
      olderCollectionObserved.resolve();
      await releaseOlderCollection.promise;
      return await target.publish(collected, {
        observationSequence: olderObservation,
      });
    })();

    await olderCollectionObserved.promise;
    const refreshedSource: SourceDescriptor = {
      ...source,
      capabilities: {
        ...source.capabilities,
        setMode: false,
        modes: [],
      },
    };
    const driver = {
      source: refreshedSource,
      readSession: () => Promise.resolve(snapshot(null, "Terminal snapshot")),
    } as unknown as AgentDriver;
    try {
      await target.refreshSession(driver, "session-1");
    } finally {
      releaseOlderCollection.resolve();
    }
    await olderPublication;

    const index = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    const published = (index.sessions as Array<Record<string, unknown>>)[0];
    assertEquals(published.active, null);
    assertEquals(published.title, "Terminal snapshot");
    assertEquals(published.syncStatus, "complete");
    assertEquals(
      (published.capabilities as Record<string, unknown>).setMode,
      false,
    );
    assertEquals(
      ((index.sources as Array<Record<string, unknown>>)[0]
        .capabilities as Record<string, unknown>).setMode,
      false,
    );
    const manifest = published.manifest as Record<string, unknown>;
    const summary = manifest.summary as Record<string, unknown>;
    assertEquals(summary.active, null);
    assertEquals(summary.title, "Terminal snapshot");

    const olderCompleteObservation = target.beginSessionObservation();
    const newerCompleteObservation = target.beginSessionObservation();
    await target.publish([{
      source,
      sessions: [],
      errors: [],
      complete: true,
    }], { observationSequence: newerCompleteObservation });
    await target.publish([{
      source,
      sessions: [snapshot(true, "Obsolete snapshot", "session-2")],
      errors: [],
      complete: true,
    }], { observationSequence: olderCompleteObservation });
    const afterOlderCollection = await readStableCellGraphValue(
      connection,
      target.cells.allIndex,
    ) as Record<string, unknown>;
    assertEquals(
      (afterOlderCollection.sessions as Array<Record<string, unknown>>).map(
        (session) => ({
          nativeSessionId: session.nativeSessionId,
          syncStatus: session.syncStatus,
        }),
      ),
      [{ nativeSessionId: "session-1", syncStatus: "deleted" }],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
