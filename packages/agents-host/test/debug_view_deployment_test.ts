// Agent-sessions debug view: deployment lifecycle. Shared fixtures live in
// `debug_view_support.ts`; see there for why the suite spans several files.

import type { Cell } from "../../runner/src/builder/types.ts";
import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
} from "../src/debug-view.ts";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  identity,
  installDefaultPattern,
  newSharedServer,
  registeredPieceIds,
  sessionSnapshot,
  SHALLOW_PIECE_LIST_SCHEMA,
  SHALLOW_PIECE_SCHEMA,
  SharedServerStorageManager,
  sourceDescriptor,
} from "./debug_view_support.ts";

Deno.test("debug deployment replaces a view when its pattern identity changes", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-pattern-replacement-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const [originalPieceId, alternatePieceId] = await Promise.all([
      deployAgentSessionsDebugView(manager, target),
      deployAgentSessionsDebugView(manager, target, alternateLocation),
    ]);

    assertNotEquals(alternatePieceId, originalPieceId);
    assertEquals(
      await deployAgentSessionsDebugView(
        manager,
        target,
        alternateLocation,
      ),
      alternatePieceId,
    );
    const registeredIds = await registeredPieceIds(
      defaultPattern,
      "pieceRegistry",
    );
    assertEquals(registeredIds.includes(originalPieceId), false);
    assertEquals(
      registeredIds.filter((id) => id === alternatePieceId).length,
      1,
    );
    const originalPiece = await manager.getPieceCell(
      originalPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    assertNotEquals(originalPiece.getRaw(), undefined);
    assertNotEquals(originalPiece.getMetaRaw("patternIdentity"), undefined);
    const alternatePiece = await manager.get(
      alternatePieceId,
      false,
    );
    assertEquals(alternatePiece.name(), "Alternate agent sessions");
    const reinsertResult = await runtime.editWithRetry((tx) => {
      for (const name of ["pieceRegistry", "recentPieces"] as const) {
        const list = defaultPattern.asSchema(undefined).key(name)
          .resolveAsCell().asSchema(SHALLOW_PIECE_LIST_SCHEMA) as Cell<
            Cell<unknown>[]
          >;
        const listWithTx = list.withTx(tx);
        const current = listWithTx.getRawUntyped({ frozen: false });
        if (!Array.isArray(current)) throw new Error(`${name} is not an array`);
        current.push(originalPiece.getAsLink({
          base: listWithTx,
          includeSchema: true,
        }));
        listWithTx.setRawUntyped(current);
      }
    });
    if (reinsertResult.error) throw reinsertResult.error;
    assertEquals(
      await deployAgentSessionsDebugView(manager, target, alternateLocation),
      alternatePieceId,
    );
    for (const name of ["pieceRegistry", "recentPieces"] as const) {
      assertEquals(
        (await registeredPieceIds(defaultPattern, name)).includes(
          originalPieceId,
        ),
        false,
      );
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment starts and restarts its registered view", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const debugPieceId = await deployAgentSessionsDebugView(manager, target);
    const piece = await manager.get(debugPieceId, false);

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    await manager.stopPiece(piece.getCell());
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      debugPieceId,
    );
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment removes a view that fails to start", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("debug start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern, "pieceRegistry"),
      [],
    );
    assertEquals(await registeredPieceIds(defaultPattern, "recentPieces"), []);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment preserves a view when its replacement fails", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-replacement-start-failure-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("replacement start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target, alternateLocation),
        Error,
        "replacement start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern, "pieceRegistry"),
      [originalPieceId],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    const originalPiece = await manager.get(originalPieceId, false);
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rolls back an aborted registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-aborted-registration-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const recentPieces = defaultPattern.asSchema(undefined)
      .key("recentPieces")
      .resolveAsCell();
    const abortRegistration = async (
      location: ReturnType<typeof defaultDebugPatternLocation>,
      options: {
        addCandidateToRecent?: boolean;
        commitNumber?: number;
        abortAfterCommit?: boolean;
      } = {},
    ): Promise<void> => {
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const controller = new AbortController();
      const originalStartPiece = manager.startPiece;
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      let candidatePiece: Cell<unknown> | undefined;
      let interceptRegistrationCommit = false;
      let commitCount = 0;
      manager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(manager, piece, options);
        if (typeof piece !== "string") candidatePiece = piece;
        interceptRegistrationCommit = true;
      }) as typeof manager.startPiece;
      runtime.editWithRetry = (async (action, maxRetries) => {
        if (interceptRegistrationCommit) commitCount++;
        const shouldIntercept = commitCount === (options.commitNumber ?? 1);
        const result = await originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (shouldIntercept) {
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              const result = await originalCommit();
              if (options.abortAfterCommit) {
                controller.abort(new Error("debug deployment cancelled"));
              }
              return result;
            };
          }
          return result;
        }, maxRetries);
        if (shouldIntercept && options.addCandidateToRecent && !result.error) {
          const candidate = candidatePiece;
          if (candidate === undefined) {
            throw new Error("candidate piece was not started");
          }
          const concurrentUpdate = await originalEditWithRetry(
            (transaction) => {
              const list = recentPieces.withTx(transaction);
              const current = list.getRawUntyped({ frozen: false });
              if (!Array.isArray(current)) {
                throw new Error("recentPieces is not an array");
              }
              list.setRawUntyped([
                ...current,
                candidate.getAsLink({ base: list, includeSchema: true }),
              ]);
            },
          );
          if (concurrentUpdate.error) throw concurrentUpdate.error;
        }
        return result;
      }) as typeof runtime.editWithRetry;
      try {
        const deployment = deployAgentSessionsDebugView(
          manager,
          target,
          location,
          controller.signal,
        );
        await commitEntered.promise;
        if (!options.abortAfterCommit) {
          controller.abort(new Error("debug deployment cancelled"));
        }
        releaseCommit.resolve();
        await assertRejects(
          () => deployment,
          Error,
          "debug deployment cancelled",
        );
      } finally {
        releaseCommit.resolve();
        manager.startPiece = originalStartPiece;
        runtime.editWithRetry = originalEditWithRetry;
      }
    };

    const originalPiece = await manager.get(originalPieceId, false);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await abortRegistration(alternateLocation, {
      addCandidateToRecent: true,
      abortAfterCommit: true,
    });
    assertEquals(
      await registeredPieceIds(defaultPattern, "pieceRegistry"),
      [originalPieceId],
    );
    assertEquals(
      await registeredPieceIds(defaultPattern, "recentPieces"),
      [],
    );
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);

    const addRecentResult = await runtime.editWithRetry((transaction) => {
      const list = recentPieces.withTx(transaction);
      const current = list.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error("recentPieces is not an array");
      }
      list.setRawUntyped([
        ...current,
        originalPiece.getCell().getAsLink({
          base: list,
          includeSchema: true,
        }),
      ]);
    });
    if (addRecentResult.error) throw addRecentResult.error;
    await abortRegistration(defaultLocation);
    assertEquals(
      await registeredPieceIds(defaultPattern, "recentPieces"),
      [originalPieceId],
    );

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects stale registration across runtimes", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-race-${crypto.randomUUID()}`;
  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const readerManager = new PiecesController(readerSession, readerRuntime);
    await readerManager.synced();
    const defaultPattern = await installDefaultPattern(readerManager);
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();

    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const writerManager = new PiecesController(writerSession, writerRuntime);
      await writerManager.synced();
      const registration = writerRuntime.getCell(
        writerSession.space,
        "agent-sessions-debug-registration-v1",
      );
      await registration.sync();
      const competingRegistration = {
        cause: "agent-sessions-debug:competing",
        pieceId: "fid1:competing-debug-piece",
        patternIdentity: "fid1:competing-debug-pattern",
        patternSymbol: "default",
        retiredCauses: [],
      };
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const originalStartPiece = readerManager.startPiece;
      const originalEditWithRetry = readerRuntime.editWithRetry.bind(
        readerRuntime,
      );
      let interceptRegistrationCommit = false;
      let intercepted = false;
      readerManager.startPiece = (async (piece, options) => {
        await originalStartPiece.call(readerManager, piece, options);
        interceptRegistrationCommit = true;
      }) as typeof readerManager.startPiece;
      readerRuntime.editWithRetry = ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptRegistrationCommit && !intercepted) {
            intercepted = true;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof readerRuntime.editWithRetry;
      try {
        const defaultLocation = defaultDebugPatternLocation();
        const deployment = deployAgentSessionsDebugView(
          readerManager,
          target,
          {
            rootPath: defaultLocation.rootPath,
            mainPath: fromFileUrl(
              new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
            ),
          },
        );
        await commitEntered.promise;
        const competingResult = await writerRuntime.editWithRetry((tx) => {
          registration.withTx(tx).setRawUntyped(competingRegistration);
        });
        if (competingResult.error) {
          throw competingResult.error;
        }
        releaseCommit.resolve();

        await assertRejects(
          () =>
            deployment,
          Error,
          "debug view registration changed during deployment",
        );
        assertEquals(registration.getRaw(), competingRegistration);
        const registeredIds = await registeredPieceIds(
          defaultPattern,
          "pieceRegistry",
        );
        assertEquals(registeredIds.includes(originalPieceId), true);
        assertEquals(registeredIds.length, 1);
        await target.publish([{
          source: sourceDescriptor(),
          sessions: [sessionSnapshot(1)],
          errors: [],
          complete: true,
        }]);
        await readerRuntime.settled();
        const originalPiece = await readerManager.get(originalPieceId, false);
        assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      } finally {
        releaseCommit.resolve();
        readerManager.startPiece = originalStartPiece;
        readerRuntime.editWithRetry = originalEditWithRetry;
      }
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});

Deno.test("debug deployment reports malformed registration lists", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-error-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const recentPieces = defaultPattern.asSchema(undefined)
      .key("recentPieces")
      .resolveAsCell();
    const malformedResult = await runtime.editWithRetry((tx) => {
      recentPieces.withTx(tx).setRawUntyped({ malformed: true });
    });
    if (malformedResult.error) throw malformedResult.error;
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "recentPieces is not an array",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects a replaced default pattern", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-root-race-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const replacementRoot = runtime.getCell(
      session.space,
      `replacement-default-pattern-${crypto.randomUUID()}`,
    );
    const replacementResult = await runtime.editWithRetry((tx) => {
      replacementRoot.withTx(tx).setRawUntyped({ replacement: true });
    });
    if (replacementResult.error) throw replacementResult.error;

    const originalGetDefaultPattern = manager.getDefaultPattern;
    let replaced = false;
    manager.getDefaultPattern = (async (runIt = true) => {
      const found = await originalGetDefaultPattern.call(manager, runIt);
      if (!replaced) {
        replaced = true;
        await manager.linkDefaultPattern(replacementRoot);
      }
      return found;
    }) as typeof manager.getDefaultPattern;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern changed during debug view deployment",
      );
    } finally {
      manager.getDefaultPattern = originalGetDefaultPattern;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects an in-place registry change", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registry-race-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
    });
    const originalStartPiece = manager.startPiece;
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let injectRegistryChange = false;
    let registryChangeInjected = false;
    manager.startPiece = (async (piece, options) => {
      await originalStartPiece.call(manager, piece, options);
      injectRegistryChange = true;
    }) as typeof manager.startPiece;
    runtime.editWithRetry = (async (action, maxRetries) => {
      if (injectRegistryChange && !registryChangeInjected) {
        registryChangeInjected = true;
        const change = await originalEditWithRetry((tx) => {
          defaultPattern.withTx(tx).key("pieceRegistry").setRawUntyped([]);
        });
        if (change.error) throw change.error;
      }
      return await originalEditWithRetry(action, maxRetries);
    }) as typeof runtime.editWithRetry;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "default pattern registry changed during debug view deployment",
      );
    } finally {
      manager.startPiece = originalStartPiece;
      runtime.editWithRetry = originalEditWithRetry;
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
